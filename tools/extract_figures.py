#!/usr/bin/env python3
"""从 PDF 中提取真正的配图：优先内嵌图片，否则按「Figure N」图注定位区域裁剪。

用法: python3 tools/extract_figures.py <pdf> <outdir> [--scale 2.0]
输出: <outdir>/figures/*.png + <outdir>/figures.json
      [{file, page, caption, kind}]
"""
import json, os, re, shutil, subprocess, sys
from io import BytesIO
from pathlib import Path
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "vendor"))

PIL = None
try:
    from PIL import Image
    PIL = Image
except Exception:
    PIL = None

# 编号后面必须是空白/冒号/句点或行尾，否则 "Figure 3identical…" 这种正文引用会被当成图注
CAP = re.compile(r"^(Figure|Fig\.?|FIGURE|Table|TABLE)\s*([0-9]+[a-z]?)(?=[\s:.]|$)\s*[:.]?\s*(.*)$")
HERE = Path(__file__).resolve().parent


def _has(cmd):
    return shutil.which(cmd) is not None


def render_pages(pdf, out, scale):
    """macOS 用 swift(PDFKit)，Linux 用 poppler(pdftoppm)。"""
    if _has("swift"):
        try:
            subprocess.run(
                ["swift", str(HERE / "render_pages.swift"), str(pdf), str(out), str(scale)],
                check=True, capture_output=True
            )
            return
        except Exception:
            pass
    if _has("pdftoppm"):
        dpi = int(72 * scale)
        subprocess.run(["pdftoppm", "-png", "-r", str(dpi), str(pdf), str(Path(out) / "page")],
                       check=True, capture_output=True)
        return
    raise RuntimeError("缺少页面渲染器：macOS 需要 swift(PDFKit)，Linux 需要 poppler 的 pdftoppm")


def main():
    if len(sys.argv) < 3:
        print(__doc__); return
    pdf, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    scale = 2.0
    if "--scale" in sys.argv:
        scale = float(sys.argv[sys.argv.index("--scale") + 1])
    figdir = outdir / "figures"
    figdir.mkdir(parents=True, exist_ok=True)

    from pypdf import PdfReader
    reader = PdfReader(str(pdf))

    items = []
    emb_by_page = {}

    # 1) 内嵌位图（按像素尺寸过滤 emoji / 小图标）
    #    pypdf 的 Image XObject 是 EncodedStreamObject，没有 .image 属性（旧写法在这里静默失败），
    #    统一改用 page.images，由 pypdf 负责 DCT/Flate 等滤镜解码。
    if PIL:
        from io import BytesIO
        for i, page in enumerate(reader.pages):
            try:
                imgs = list(page.images)
            except Exception:
                continue
            for j, im in enumerate(imgs):
                try:
                    pil = PIL.open(BytesIO(im.data))
                    if pil.width < 160 or pil.height < 120:
                        continue
                    if pil.mode in ("P", "LA", "RGBA"):
                        pil = pil.convert("RGB")
                    fname = f"fig-p{i+1}-{j+1}.png"
                    pil.save(figdir / fname)
                    item = {"file": fname, "page": i + 1, "caption": "", "kind": "embedded", "num": ""}
                    items.append(item)
                    emb_by_page.setdefault(i + 1, []).append(item)
                except Exception:
                    continue

    # 2) 图注定位 + 裁剪
    pages_needed = {}
    captions = []  # {page, top, bottom, num, split}
    for i, page in enumerate(reader.pages):
        lines = {}
        def visit(text, cm, tm, font_dict, font_size, _i=i):
            t = (text or "").strip()
            if not t:
                return
            lines.setdefault(round(tm[5] / 2) * 2, []).append((round(tm[4], 1), t))
        try:
            page.extract_text(visitor_text=visit)
        except Exception as e:
            print("page", i + 1, "text error", e, file=sys.stderr)
            continue
        ys = sorted(lines.keys())
        page_h = float(page.mediabox.height)
        page_w = float(page.mediabox.width)
        for idx, y in enumerate(ys):
            frags = sorted(lines[y])
            txt = "".join(t for _, t in frags)
            # 图注必须从行首开始（"Figure N:" / "Table N."）；
            # 旧写法用 finditer，会把正文里的 "…see Figure 3…" 也当成图注
            m = CAP.match(txt.lstrip())
            if not m:
                continue
            # 图注上方没有任何文本行时，图就是页面顶部到图注之间的整块
            if idx == 0:
                top, bottom = 24, y - 14
            else:
                above = ys[idx + 1] if idx + 1 < len(ys) else page_h - 24
                top = above - 6
                bottom = y + 4
            if top - bottom < 55:
                # 图注在图形上方（表格常见）：向下裁剪；下方文本太近时给足高度
                below = ys[idx - 1] if idx > 0 else None
                top = y - 6
                bottom = (below + 6) if below is not None else max(20, y - 300)
                if top - bottom < 120:
                    bottom = max(20, y - 300)
                if top - bottom < 60:
                    continue
            label = m.group(1).lower()
            kind = "table" if label.startswith("tab") else "figure"
            captions.append({"page": i + 1, "y": y, "top": top, "bottom": bottom, "num": m.group(2), "kind": kind, "split": "full", "w": page_w, "h": page_h, "text": txt[:160]})
            pages_needed[i + 1] = True

    if not captions:
        # 有内嵌图但没有图注：仍然要交差，否则上层会以为一张图都没有
        (outdir / "figures.json").write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"ok": True, "figures": len(items)}))
        return

    tmp = outdir / "_pages"
    tmp.mkdir(parents=True, exist_ok=True)
    missing = [str(p) for p in pages_needed if not (tmp / f"page{p}.png").exists()]
    if missing:
        render_pages(pdf, tmp, scale)

    if not PIL:
        msg = {"ok": False, "error": "需要 Pillow 才能裁剪"}
        (outdir / "figures.json").write_text(json.dumps(msg, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(msg, ensure_ascii=False))
        return

    for c in captions:
        img_path = next((tmp / n for n in (
            f"page{c['page']}.png", f"page-{c['page']}.png",
            f"page-{c['page']:02d}.png", f"page-{c['page']:03d}.png") if (tmp / n).exists()), None)
        if not img_path.exists():
            continue
        im = PIL.open(img_path)
        W, H = im.size
        sy = H / c["h"]
        gray = im.convert("L")
        px = gray.load()
        step = 2
        ink = []
        for y in range(0, H, step):
            dark = 0
            for x in range(0, W, 8):
                if px[x, y] < 235:
                    dark += 1
            ink.append(dark)
        runs = []
        run_start = None
        for i, v in enumerate(ink):
            on = v > 1
            if on and run_start is None:
                run_start = i
            elif not on and run_start is not None:
                runs.append((run_start * step, i * step))
                run_start = None
        if run_start is not None:
            runs.append((run_start * step, len(ink) * step))
        cap_top = int((c["y"] - 12) * sy)
        cap_bottom = int((c["y"] + 6) * sy)
        above = [r for r in runs if r[1] <= cap_top + 4 and (cap_top - r[1]) < 200 and (r[1] - r[0]) > 80]
        below = [r for r in runs if r[0] >= cap_bottom - 4 and (r[0] - cap_bottom) < 200 and (r[1] - r[0]) > 80]
        block = max(above, key=lambda r: r[1]) if above else (min(below, key=lambda r: r[0]) if below else None)
        if not block:
            continue
        top_px, bot_px = max(0, block[0] - 6), min(H, block[1] + 6)
        col_ink = []
        for x in range(0, W, 4):
            dark = 0
            for y in range(top_px, bot_px, 6):
                if px[x, y] < 235:
                    dark += 1
            col_ink.append(dark)
        xs = [i * 4 for i, v in enumerate(col_ink) if v > 0]
        left = max(0, (min(xs) if xs else 0) - 8)
        right = min(W, (max(xs) if xs else W) + 8)
        crop = im.crop((left, top_px, right, bot_px))
        if crop.width < 200 or crop.height < 60:
            continue
        name = f"fig-p{c['page']}-{c['num']}.png"
        crop.save(figdir / name)
        items.append({"file": name, "page": c["page"], "num": c.get("num", ""), "kind": c.get("kind", "figure"), "caption": c.get("text", "")})

    # 内嵌图与同页的 Figure 图注按顺序配对，得到「图 N」编号（供正文按图注定位）
    for page, its in emb_by_page.items():
        caps = [c for c in captions if c["page"] == page and c["kind"] == "figure"]
        if len(caps) != len(its):
            # 单图多注（同页既有图注又有正文引用）：取文字最长、最像图注的一条
            if len(its) == 1 and caps:
                caps = [max(caps, key=lambda c: len(c.get("text", "")))]
            else:
                continue
        for it, c in zip(its, caps):
            it["num"] = str(c.get("num", ""))
            it["caption"] = str(c.get("text", ""))[:160]

    (outdir / "figures.json").write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"ok": True, "figures": len(items)}))


if __name__ == "__main__":
    main()
