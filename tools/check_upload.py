#!/usr/bin/env python3
"""检查上传论文的成品质量，输出缺口（供闭环修正）。

用法: python3 tools/check_upload.py <paper-id> [more ids...]
"""
import json, os, re, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(BASE, "content")
CN = re.compile(r"[\u4e00-\u9fff]")

def check(pid):
    d = os.path.join(CONTENT, pid)
    meta = json.load(open(os.path.join(d, "meta.json")))
    zh = open(os.path.join(d, "zh.html"), encoding="utf-8").read()
    heads = [re.sub(r"<[^>]+>", "", h).strip() for h in re.findall(r"<h[23][^>]*>(.*?)</h[23]>", zh, re.S)]
    cn = sum(1 for h in heads if CN.search(h))
    imgs = len(re.findall(r"<img\b", zh))
    tables = len(re.findall(r"<table\b", zh))
    gaps = []
    if len(heads) < 8: gaps.append(f"章节过少({len(heads)})")
    if heads and cn / len(heads) < 0.8: gaps.append(f"标题中文占比低({cn}/{len(heads)})")
    if imgs == 0: gaps.append("没有配图")
    if len(meta.get("abstract") or "") < 150: gaps.append("摘要过短")
    if not meta.get("authors"): gaps.append("缺作者")
    if not meta.get("year"): gaps.append("缺年份")
    print(f"{pid}: 章节 {len(heads)} · 中文标题 {cn}/{len(heads)} · 图 {imgs} · 表 {tables} · 摘要 {len(meta.get('abstract') or '')} 字")
    print("  " + ("OK" if not gaps else "；".join(gaps)))
    return gaps

if __name__ == "__main__":
    ids = sys.argv[1:] or [d for d in os.listdir(CONTENT) if os.path.isdir(os.path.join(CONTENT, d)) and d not in ("collections.json",)]
    for pid in ids:
        if os.path.exists(os.path.join(CONTENT, pid, "meta.json")):
            check(pid)
