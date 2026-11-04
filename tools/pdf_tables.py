#!/usr/bin/env python3
"""用 pdfplumber 抽取某页表格为二维数组。

用法: python3 tools/pdf_tables.py <pdf> <page>
输出: {"page": n, "tables": [{"index": i, "rows": [[...]]}]}
"""
import json, sys
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "vendor"))

def main():
    try:
        import pdfplumber
    except Exception as e:
        print(json.dumps({"error": "pdfplumber 未安装：" + str(e)}))
        return
    pdf, page_no = sys.argv[1], int(sys.argv[2])
    out = []
    with pdfplumber.open(pdf) as doc:
        page = doc.pages[page_no - 1]
        for i, t in enumerate(page.extract_tables() or []):
            rows = [[(c or "").strip() for c in row] for row in t]
            out.append({"index": i, "rows": rows})
    print(json.dumps({"page": page_no, "tables": out}, ensure_ascii=False))

if __name__ == "__main__":
    main()
