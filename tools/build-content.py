#!/usr/bin/env python3
"""把现有 HTML 论文页转换为 paper-reader 的内容目录。

用法: python3 tools/build-content.py [--only quant|llm] [--paper <id>]
输出: content/index.json + content/<id>/{meta.json,zh.html,en.txt,figures/}
"""
import json, os, re, shutil, sys, copy
from pathlib import Path
from lxml import html as LH, etree

BASE = Path(__file__).resolve().parent.parent          # dsh-paper-reader/
WS = BASE.parent                                        # Quant/
CONTENT = BASE / "content"

COLLECTIONS = {
    "quant": ("quant", "Quant Papers", [
        ("01_Beyond4Bits_DataCentric_PTQ", WS / "Quant_Papers/01_Beyond4Bits_DataCentric_PTQ"),
        ("02_ResidualQuant_KVCache", WS / "Quant_Papers/02_ResidualQuant_KVCache"),
        ("03_UPQ_2bit_InstructionTuned", WS / "Quant_Papers/03_UPQ_2bit_InstructionTuned"),
    ]),
    "llm": ("llm", "LLM Papers", [
        (d.name, d) for d in sorted((WS / "LLM_Papers").iterdir())
        if d.is_dir() and re.match(r"^\d\d_", d.name)
    ]),
}

SLUG = {
    "摘要": "sec-abstract",
    "引言": "sec-intro",
    "结论": "sec-conclusion",
    "参考文献": "sec-refs",
    "附录要点": "sec-appendix",
}


def slug_for(text, used):
    t = text.strip()
    if t in SLUG:
        base = SLUG[t]
    else:
        m = re.match(r"^(\d+(?:\.\d+)*)", t)
        base = "sec-" + m.group(1).replace(".", "-") if m else "sec-" + re.sub(r"[^\w\u4e00-\u9fa5]+", "-", t)[:18].strip("-")
    sid, i = base, 2
    while sid in used:
        sid, i = f"{base}-{i}", i + 1
    used.add(sid)
    return sid


def clean_text(el):
    t = " ".join(el.text_content().split())
    return t


def build_paper(pid, src: Path, cid: str, collection: str, en_map, pdf_map):
    raw = (src / "index.html").read_bytes().decode("utf-8", "replace")
    raw = re.sub(r"^\s*<\?xml[^>]*\?>\s*", "", raw)
    doc = LH.fromstring(raw)
    col = doc.xpath('//div[contains(@class,"col-md-8")]')
    if not col:
        raise SystemExit(f"no content column: {src}")
    col = col[0]

    h1 = col.find(".//h1")
    title_zh = clean_text(h1) if h1 is not None else pid
    en_title = doc.find(".//title")
    en_title = clean_text(en_title) if en_title is not None else ""

    info = col.xpath('.//div[contains(@class,"info")]')
    info_txt = clean_text(info[0]) if info else ""
    # 作者行 / 单位 / venue
    lines = [l.strip() for l in (info[0].text_content() if info else "").split("\n") if l.strip()]
    authors = lines[0] if lines else ""
    venue = " · ".join(lines[1:]) if len(lines) > 1 else ""
    year = ""
    ym = re.search(r"(19|20)\d{2}", en_title + " " + venue)
    if ym:
        year = ym.group(0)

    # 标题英文：去掉 " -- 年份"
    en_title_clean = re.sub(r"\s*--\s*(19|20)\d{2}\s*$", "", en_title).strip()

    # 图片
    fig_dir = BASE / "content" / pid / "figures"
    if fig_dir.exists():
        shutil.rmtree(fig_dir)
    img_src = src / "img"
    nfig = 0
    if img_src.is_dir():
        fig_dir.mkdir(parents=True, exist_ok=True)
        for f in sorted(img_src.glob("*")):
            if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"):
                shutil.copy2(f, fig_dir / f.name)
                nfig += 1

    # 正文：给 h2/h3 加 id、改写图片路径
    used = set()
    sections = []
    heads = [h for h in col.iter() if h.tag in ("h2", "h3")]
    for h in heads:
        sid = h.get("id") or slug_for(clean_text(h), used)
        used.add(sid)
        h.set("id", sid)
        sections.append({
            "id": sid,
            "title": clean_text(h),
            "level": 2 if h.tag == "h2" else 3,
        })
    # 章节文本（用于搜索与问答上下文）
    nodes = list(col)
    for i, sec in enumerate(sections):
        # 找到该标题节点
        hidx = next((j for j, n in enumerate(nodes) if n.tag in ("h2", "h3") and n.get("id") == sec["id"]), None)
        if hidx is None:
            sec["text"] = ""
            continue
        texts = []
        for n in nodes[hidx + 1:]:
            if n.tag in ("h2", "h3"):
                break
            texts.append(clean_text(n))
        sec["text"] = " ".join(x for x in texts if x)[:8000]

    # 去掉属于问答的「通俗理解」块（内容已迁到 qa.json）
    for el in col.xpath('.//div[contains(@class,"qa-callout")]'):
        el.getparent().remove(el)

    # 去掉正文顶部的重复标题与作者块（阅读器头部已展示）
    for el in col.xpath('./h1 | .//div[contains(@class,"info")]'):
        el.getparent().remove(el)

    # 正文内的图片：改写为 API 路径
    for img in col.xpath(".//img"):
        s = img.get("src") or ""
        m = re.match(r"^\.?/?img/(.+)$", s)
        if m:
            img.set("src", f"/paper-reader/api/paper/{pid}/figures/{m.group(1)}")
        img.set("loading", "lazy")

    # 正文列之外的图片（有些页面把 <img> 放在页脚之后）：按「图N」图注插回
    inside = set(img.get("src") for img in col.xpath(".//img"))
    leftovers = []
    for img in doc.xpath("//img"):
        s = img.get("src") or ""
        if s in inside:
            continue
        m = re.match(r"^\.?/?img/(?P<name>[^/]+)$", s)
        if not m:
            continue
        name = m.group("name")
        n = re.search(r"(\d+)", name)
        target = None
        if n:
            pat = re.compile(r"(?:图|Figure)\s*" + n.group(1) + r"(?!\d)")
            for para in col.xpath(".//p"):
                txt = "".join(para.itertext())
                if len(txt) < 220 and pat.search(txt):
                    target = para
                    break
        new_img = copy.deepcopy(img)
        new_img.set("src", f"/paper-reader/api/paper/{pid}/figures/{name}")
        new_img.set("loading", "lazy")
        if target is not None:
            target.addprevious(new_img)
        else:
            leftovers.append(new_img)
    if leftovers:
        h = etree.SubElement(col, "h2")
        h.set("id", "sec-figures")
        h.text = "配图"
        for im in leftovers:
            col.append(im)

    # 内置问答（来自静态站的 qa-data.js）：写入 content/<id>/qa.json
    qa_src = src / "qa-data.js"
    if qa_src.exists():
        try:
            import subprocess, json as _json
            out = subprocess.run(
                [(os.environ.get("DSH_NODE") or shutil.which("node") or "node"), "-e", "global.window={};eval(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify(window.QA_DATA||[]))", str(qa_src)],
                capture_output=True, text=True, check=True
            ).stdout
            (BASE / "content" / pid / "qa.json").write_text(out, encoding="utf-8")
        except Exception as e:
            print("  qa import failed:", pid, e)

    # 摘要：优先「摘要」小节；否则取正文第一段较长文字（有些页面没有摘要标题）
    abstract = ""
    for sec in sections:
        if sec["id"] == "sec-abstract":
            abstract = sec["text"][:1200]
            break
    if not abstract:
        for para in col.xpath(".//p"):
            txt = "".join(para.itertext()).strip()
            if len(txt) >= 150:
                abstract = txt[:800]
                break

    zh_html = "".join(LH.tostring(ch, encoding="unicode") for ch in col)

    out = CONTENT / pid
    out.mkdir(parents=True, exist_ok=True)
    (out / "zh.html").write_text(zh_html, encoding="utf-8")

    # 英文原文 / PDF
    en_path = en_map.get(pid)
    has_en = False
    if en_path and en_path.exists():
        shutil.copy2(en_path, out / "en.txt")
        has_en = True
    elif (out / "en.txt").exists():
        (out / "en.txt").unlink()

    pdf = pdf_map.get(pid)
    has_pdf = bool(pdf and Path(pdf).exists())

    # 特殊处理：没有 PDF 的网页型论文（如 LSTM 博客），把原网页作为「网页」视图
    web_src = src / "index.html"
    has_web = False
    if pid == "01_LSTM_1997_Translation" and web_src.exists():
        raw2 = web_src.read_bytes().decode("utf-8", "replace")
        raw2 = re.sub(r"^\s*<\?xml[^>]*\?>\s*", "", raw2)
        page = LH.fromstring(raw2)
        for tag in page.xpath("//script | //link[contains(@rel,'stylesheet')]"):
            tag.getparent().remove(tag)
        head = page.xpath("//head")[0]
        style = etree.SubElement(head, "style")
        style.text = ("body{font-family:Georgia,'Songti SC',serif;max-width:860px;margin:0 auto;"
                      "padding:26px 20px 60px;line-height:1.85;color:#232323;background:#fff;font-size:16px}"
                      "img{max-width:100%;height:auto;display:block;margin:14px auto}"
                      "h1{font-size:26px;line-height:1.35}h2{font-size:21px;margin-top:28px}"
                      "h3{font-size:17px;margin-top:22px}a{color:#2b4a6f}"
                      "pre,code{background:#f3f1ea;padding:2px 5px;border-radius:3px}"
                      "p{margin:10px 0}")
        fig_dir.mkdir(parents=True, exist_ok=True)
        for img in page.xpath("//img"):
            sr = img.get("src") or ""
            name = os.path.basename(sr)
            if not name:
                continue
            src_file = src / sr
            if not src_file.exists():
                src_file = src / "img" / name
            if src_file.exists() and src_file.is_file():
                shutil.copy2(src_file, fig_dir / name)
                img.set("src", f"/paper-reader/api/paper/{pid}/figures/{name}")
            img.set("loading", "lazy")
        (BASE / "content" / pid / "original.html").write_text(
            LH.tostring(page, encoding="unicode"), encoding="utf-8")
        has_web = True

    meta = {
        "id": pid,
        "collection": collection,
        "collectionId": cid,
        "title": en_title_clean,
        "titleZh": title_zh,
        "authors": authors,
        "authorsShort": authors.split(",")[0] if authors else "",
        "venue": venue,
        "year": year,
        "abstract": abstract,
        "sections": sections,
        "figures": nfig,
        "hasOriginal": has_en,
        "hasPdf": has_pdf,
        "hasWeb": has_web,
        "webUrl": "https://colah.github.io/posts/2015-08-Understanding-LSTMs/" if pid == "01_LSTM_1997_Translation" else None,
        "pdfPath": str(pdf) if has_pdf else None,
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def main():
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    only_paper = None
    if "--paper" in sys.argv:
        only_paper = sys.argv[sys.argv.index("--paper") + 1]

    CONTENT.mkdir(parents=True, exist_ok=True)
    index = []

    # 英文原文映射（Quant：_work 提取；LLM：同名 .txt）
    # 原文（txt）功能已移除：不再生成 en.txt
    en_map = {}

    pdf_map = {
        "01_Beyond4Bits_DataCentric_PTQ": WS / "Beyond 4 bits Data-Centric Post-training Quantization and Recovery.pdf",
        "02_ResidualQuant_KVCache": WS / "ResidualQuant KV Cache Quantization for Looped Transformers with 2-Bit Residuals.pdf",
        "03_UPQ_2bit_InstructionTuned": WS / "Unifying Block-wise PTQ and Distillation-based QAT for Progressive Quantization toward 2-bit Instruction-Tuned LLMs.pdf",
    }
    for d in (WS / "LLM_Papers").iterdir():
        if d.is_dir():
            cand = [WS / "LLM_Papers" / (d.name + ".pdf")] + list(d.glob("*.pdf"))
            for f in cand:
                if f.exists():
                    pdf_map.setdefault(d.name, f)
                    break

    for key, (cid, collection, papers) in COLLECTIONS.items():
        if only and only != key:
            continue
        for pid, src in papers:
            if only_paper and pid != only_paper:
                continue
            if not (src / "index.html").exists():
                print("skip", pid)
                continue
            meta = build_paper(pid, src, cid, collection, en_map, pdf_map)
            index.append(meta)
            print(f"built {pid}: {len(meta['sections'])} sections, {meta['figures']} figs, en={meta['hasOriginal']}, pdf={meta['hasPdf']}")

    if only_paper:
        old_file = CONTENT / "index.json"
        if old_file.exists():
            try:
                prev = json.loads(old_file.read_text(encoding="utf-8"))
                merged = {p["id"]: p for p in prev}
                merged.update({p["id"]: p for p in index})
                index = sorted(merged.values(), key=lambda x: x["id"])
            except Exception:
                pass
    (CONTENT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    cols_file = CONTENT / "collections.json"
    if not cols_file.exists():
        cols_file.write_text(json.dumps([
            {"id": "drafts", "name": "Draft", "fixed": True, "order": 0},
            {"id": "quant", "name": "Quant Papers", "order": 1},
            {"id": "llm", "name": "LLM Papers", "order": 2},
        ], ensure_ascii=False, indent=2), encoding="utf-8")
    print("index:", len(index), "papers")


if __name__ == "__main__":
    main()
