import AppKit
import Foundation

let pointSize: CGFloat = 20
let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .medium)
guard let image = NSImage(systemSymbolName: "key.horizontal.fill", accessibilityDescription: nil)?
    .withSymbolConfiguration(config) else {
    fputs("no image\n", stderr)
    exit(1)
}

let outDir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

for (name, weight): (String, NSFont.Weight) in [("medium", .medium), ("semibold", .semibold)] {
    let cfg = NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
    guard let img = NSImage(systemSymbolName: "key.horizontal.fill", accessibilityDescription: nil)?
        .withSymbolConfiguration(cfg) else { continue }
    let size = img.size
    print("\(name) size: \(size.width)x\(size.height) ratio: \(size.width/size.height)")

    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 4), pixelsHigh: Int(size.height * 4),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(origin: .zero, size: size))
    NSGraphicsContext.restoreGraphicsState()
    if let png = rep.representation(using: .png, properties: [:]) {
        let url = outDir.appendingPathComponent("key-horizontal-fill-\(name).png")
        try png.write(to: url)
        print("wrote \(url.path)")
    }
}
