#!/usr/bin/env python3
"""把工作区里已有的 PDF 复制进 content/<id>/paper.pdf，并改写 meta.pdfPath。

用法: python3 tools/backfill-pdfs.py
"""
import json, re, shutil
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
WS = BASE.parent
CONTENT = BASE / "content"

QUANT = {
    "01_Beyond4Bits_DataCentric_PTQ": WS / "Beyond 4 bits Data-Centric Post-training Quantization and Recovery.pdf",
    "02_ResidualQuant_KVCache": WS / "ResidualQuant KV Cache Quantization for Looped Transformers with 2-Bit Residuals.pdf",
    "03_UPQ_2bit_InstructionTuned": WS / "Unifying Block-wise PTQ and Distillation-based QAT for Progressive Quantization toward 2-bit Instruction-Tuned LLMs.pdf",
}

def find_pdf(pid: str):
    if pid in QUANT and QUANT[pid].exists():
        return QUANT[pid]
    cand = WS / "LLM_Papers" / (pid + ".pdf")
    if cand.exists():
        return cand
    return None

def main():
    done = miss = 0
    for d in sorted(CONTENT.iterdir()):
        if not d.is_dir():
            continue
        meta_file = d / "meta.json"
        if not meta_file.exists():
            continue
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        pdf = find_pdf(d.name)
        if not pdf:
            miss += 1
            print("no pdf:", d.name)
            continue
        target = d / "paper.pdf"
        if not target.exists() or target.stat().st_size != pdf.stat().st_size:
            shutil.copy2(pdf, target)
        meta["pdfPath"] = "paper.pdf"
        meta["hasPdf"] = True
        meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        done += 1
    print(f"backfilled {done}, missing {miss}")

if __name__ == "__main__":
    main()
