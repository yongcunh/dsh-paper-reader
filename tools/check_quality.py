#!/usr/bin/env python3
"""对照旧网页与当前生成内容，输出结构差异。

用法: python3 tools/check_quality.py [--json]
"""
import json, os, re, sys
from lxml import html as LH

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = os.path.dirname(BASE)
CONTENT = os.path.join(BASE, "content")

SOURCES = {
    "09_GPTQ_2022": "LLM_Papers/09_GPTQ_2022",
    "13_InstructGPT_SFT_RLHF_2022": "LLM_Papers/13_InstructGPT_SFT_RLHF_2022",
    "03_Attention_Is_All_You_Need_2017": "LLM_Papers/03_Attention_Is_All_You_Need_2017",
    "01_Beyond4Bits_DataCentric_PTQ": "Quant_Papers/01_Beyond4Bits_DataCentric_PTQ",
    "15_PaLM_2023": "LLM_Papers/15_PaLM_2023",
}
CN = re.compile(r"[\u4e00-\u9fff]")

def ref_metrics(path):
    doc = LH.parse(path).getroot()
    col = doc.xpath('//div[contains(@class,"col-md-8")]')
    root = col[0] if col else doc
    return {
        "h2": len(root.xpath(".//h2")), "h3": len(root.xpath(".//h3")),
        "img": len(root.xpath(".//img")), "table": len(root.xpath(".//table")),
        "cn_heads": sum(1 for h in root.xpath(".//h2|.//h3") if CN.search("".join(h.itertext()))),
        "heads": [" ".join("".join(h.itertext()).split()) for h in root.xpath(".//h2|.//h3")],
    }

def cur_metrics(pid):
    d = os.path.join(CONTENT, pid)
    meta = json.load(open(os.path.join(d, "meta.json")))
    zh = open(os.path.join(d, "zh.html"), encoding="utf-8").read()
    h2 = len(re.findall(r"<h2\b", zh)); h3 = len(re.findall(r"<h3\b", zh))
    heads = re.findall(r"<h[23][^>]*>(.*?)</h[23]>", zh, re.S)
    return {
        "h2": h2, "h3": h3,
        "img": len(re.findall(r"<img\b", zh)),
        "table": len(re.findall(r"<table\b", zh)),
        "cn_heads": sum(1 for h in heads if CN.search(re.sub(r"<[^>]+>", "", h))),
        "sections": len(meta.get("sections", [])),
        "titleZh": (meta.get("titleZh") or "")[:28],
        "authors": (meta.get("authors") or "")[:30],
        "year": meta.get("year") or "",
        "abstract_len": len(meta.get("abstract") or ""),
        "heads": [" ".join(re.sub(r"<[^>]+>", "", h).split()) for h in heads],
    }

def main():
    rows = []
    for pid, rel in SOURCES.items():
        src = os.path.join(WS, rel, "index.html")
        if not os.path.exists(src) or not os.path.isdir(os.path.join(CONTENT, pid)):
            continue
        r = ref_metrics(src); c = cur_metrics(pid)
        rows.append((pid, r, c))
    print(f"{'paper':34s} {'h2 ref/cur':>11s} {'h3 ref/cur':>11s} {'img ref/cur':>12s} {'tbl ref/cur':>12s} {'cn heads':>9s} {'abstract':>9s}")
    for pid, r, c in rows:
        print(f"{pid:34s} {r['h2']:>4d}/{c['h2']:<6d} {r['h3']:>4d}/{c['h3']:<6d} {r['img']:>5d}/{c['img']:<6d} {r['table']:>5d}/{c['table']:<6d} {c['cn_heads']:>4d}/{c['h2']+c['h3']:<4d} {c['abstract_len']:>9d}")
    print()
    for pid, r, c in rows:
        flags = []
        missing = [h for h in r["heads"] if h not in c["heads"]]
        if missing: flags.append("缺少标题 " + str(len(missing)))
        if c["img"] < r["img"]: flags.append(f"缺图 {r['img']-c['img']}")
        if c["table"] < r["table"]: flags.append(f"缺表 {r['table']-c['table']}")
        if c["abstract_len"] < 80: flags.append("摘要过短")
        if not c["authors"]: flags.append("缺作者")
        if not c["year"]: flags.append("缺年份")
        print(f"{pid:34s} " + ("OK" if not flags else "；".join(flags)))

if __name__ == "__main__":
    main()
