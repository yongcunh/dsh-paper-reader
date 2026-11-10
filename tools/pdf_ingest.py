#!/usr/bin/env python3
"""把上传的 PDF 解析成结构化素材：逐页文本 + 内嵌图片。

用法: python3 tools/pdf_ingest.py <pdf> <outdir>
输出: <outdir>/ingest.json  { pages:[{n,text}], images:[{file,page,w,h}], title }
      <outdir>/figures/*.png
"""
import json, re, sys
from pathlib import Path
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "vendor"))

def main():
    pdf_path, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    figdir = outdir / "figures"
    figdir.mkdir(exist_ok=True)

    from pypdf import PdfReader
    reader = PdfReader(str(pdf_path))
    pages = []
    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        pages.append({"n": i + 1, "text": text})

    images = []
    pil_ok = False
    try:
        from PIL import Image
        from io import BytesIO
        pil_ok = True
    except Exception:
        # macOS 硬化运行时：import PIL 可以，from PIL import Image 会因原生扩展 Team ID 校验失败
        pil_ok = False
    if pil_ok:
        for i, page in enumerate(reader.pages):
            try:
                imgs = list(page.images)
            except Exception:
                continue
            for j, im in enumerate(imgs):
                try:
                    data = im.data
                    pil = Image.open(BytesIO(data))
                    w, h = pil.size
                    if w < 160 or h < 120:
                        continue
                    if pil.mode in ("P", "LA", "RGBA"):
                        pil = pil.convert("RGB")
                    name = f"p{i+1}-{j+1}.png"
                    pil.save(figdir / name)
                    images.append({"file": name, "page": i + 1, "w": w, "h": h})
                except Exception:
                    continue

    info = {}
    try:
        md = reader.metadata or {}
        info = {
            "title": str(md.get("/Title") or ""),
            "author": str(md.get("/Author") or ""),
            "creation": str(md.get("/CreationDate") or ""),
        }
    except Exception:
        pass

    title = pdf_path.stem
    first = (pages[0]["text"] if pages else "").strip().splitlines()
    if first:
        guess = " ".join(first[:2]).strip()
        if 8 < len(guess) < 160:
            title = guess

    (outdir / "ingest.json").write_text(json.dumps({
        "title": title,
        "pages": pages,
        "images": images,
        "pil": pil_ok,
        "info": info,
    }, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"ok": True, "pages": len(pages), "images": len(images)}))

if __name__ == "__main__":
    main()
