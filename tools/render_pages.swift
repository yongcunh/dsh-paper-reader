// render_pages.swift — render every page of a PDF to PNG.
// Usage: swift render_pages.swift <pdf> <outdir> <scale>
import Foundation
import PDFKit
import AppKit

let args = CommandLine.arguments
guard args.count >= 4,
      let doc = PDFDocument(url: URL(fileURLWithPath: args[1])),
      let scale = Double(args[3]) else {
    FileHandle.standardError.write("usage: render_pages.swift <pdf> <outdir> <scale>\n".data(using: .utf8)!)
    exit(1)
}
let outDir = args[2]
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let w = Int(bounds.width * scale), h = Int(bounds.height * scale)
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { continue }
    rep.size = NSSize(width: w, height: h)
    guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { continue }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    ctx.cgContext.setFillColor(NSColor.white.cgColor)
    ctx.cgContext.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.cgContext.saveGState()
    ctx.cgContext.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    page.draw(with: .mediaBox, to: ctx.cgContext)
    ctx.cgContext.restoreGState()
    NSGraphicsContext.restoreGraphicsState()
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: URL(fileURLWithPath: "\(outDir)/page\(i + 1).png"))
    }
}
print("rendered \(doc.pageCount) pages")
