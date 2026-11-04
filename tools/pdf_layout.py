#!/usr/bin/env python3
"""给 agent 用的 PDF 版面工具（文本行坐标 + 候选空白带）。

用法:
  python3 tools/pdf_layout.py <pdf> info
  python3 tools/pdf_layout.py <pdf> lines <page>
  python3 tools/pdf_layout.py <pdf> captions <page>
  python3 tools/pdf_layout.py <pdf> candidates <page>
  python3 tools/pdf_layout.py <pdf> inspect <page> <top> <bottom>
"""
import json, re, sys
from pypdf import PdfReader

CAP = re.compile(r"^(Figure|Fig\.?|FIGURE|Table|TABLE)\s*([0-9]+[a-z]?)\s*[:.]")


def lines_of(page):
    rows = {}
    def visit(text, cm, tm, font_dict, font_size):
        t = (text or "").strip()
        if not t:
            return
        rows.setdefault(round(tm[5] / 2) * 2, []).append((round(tm[4], 1), t, font_size))
    try:
        page.extract_text(visitor_text=visit)
    except Exception:
        pass
    out = []
    for y in sorted(rows.keys()):
        frags = sorted(rows[y])
        out.append({"y": y, "x": frags[0][0], "text": "".join(f[1] for f in frags)})
    return out


def main():
    pdf = sys.argv[1]
    cmd = sys.argv[2]
    reader = PdfReader(pdf)

    if cmd == "info":
        p = reader.pages[0]
        print(json.dumps({"pages": len(reader.pages),
                          "width": float(p.mediabox.width),
                          "height": float(p.mediabox.height)}))
        return

    page_no = int(sys.argv[3])
    page = reader.pages[page_no - 1]
    ls = lines_of(page)
    h = float(page.mediabox.height)
    for l in ls:
        l["y"] = round(h - l["y"], 1)  # 统一为距页顶的坐标
    ls.sort(key=lambda l: l["y"])

    if cmd == "lines":
        print(json.dumps({"page": page_no, "height": h,
                          "lines": [{"y": l["y"], "x": l["x"], "text": l["text"][:120]} for l in ls]}))
        return

    if cmd == "captions":
        out = []
        ys = [l["y"] for l in ls]
        for idx, l in enumerate(ls):
            m = CAP.match(l["text"])
            if not m:
                continue
            prev = ls[idx - 1] if idx > 0 else None
            nxt = ls[idx + 1] if idx + 1 < len(ls) else None
            out.append({"y": l["y"], "x": l["x"], "num": m.group(2),
                        "kind": "table" if m.group(1).lower().startswith("tab") else "figure",
                        "text": l["text"][:160],
                        "prev": {"y": prev["y"], "text": prev["text"][:60]} if prev else None,
                        "next": {"y": nxt["y"], "text": nxt["text"][:60]} if nxt else None,
                        "gap_above": round(l["y"] - prev["y"], 1) if prev else None,
                        "gap_below": round(nxt["y"] - l["y"], 1) if nxt else None})
        print(json.dumps({"page": page_no, "height": h, "captions": out}))
        return

    if cmd == "candidates":
        # 相邻文本行之间的空白带（高度 > 60）
        out = []
        ys = [l["y"] for l in ls]
        for i in range(len(ys) - 1):
            gap_top, gap_bottom = ys[i] + 6, ys[i + 1] - 4
            if gap_bottom - gap_top >= 60:
                inside = [l for l in ls if gap_top < l["y"] < gap_bottom]
                chars = sum(len(x["text"]) for x in inside)
                out.append({"top": round(gap_top, 1), "bottom": round(gap_bottom, 1),
                            "height": round(gap_bottom - gap_top, 1), "chars_inside": chars,
                            "lines_inside": len(inside)})
        # 页首空白（图在最上方）
        if ys and ys[-1] + 6 < h - 40:
            top = ys[-1] + 6
            bottom = h - 20
            inside = [l for l in ls if top < l["y"] < bottom]
            out.append({"top": round(top, 1), "bottom": round(bottom, 1),
                        "height": round(bottom - top, 1),
                        "chars_inside": sum(len(x["text"]) for x in inside), "lines_inside": len(inside)})
        print(json.dumps({"page": page_no, "height": h, "candidates": out}))
        return

    if cmd == "inspect":
        top, bottom = float(sys.argv[4]), float(sys.argv[5])
        inside = [l for l in ls if top < l["y"] < bottom]
        print(json.dumps({
            "page": page_no, "top": top, "bottom": bottom,
            "lines_inside": len(inside),
            "chars_inside": sum(len(x["text"]) for x in inside),
            "sample": [x["text"][:80] for x in inside[:4]]
        }))
        return

    print(json.dumps({"error": "unknown command"}))


if __name__ == "__main__":
    main()
