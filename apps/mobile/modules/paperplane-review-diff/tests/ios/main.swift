import UIKit

func check(_ passed: Bool, _ message: String = "Failed layout check") {
  if !passed {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
  }
}

// Runs the production layout against UIKit through Mac Catalyst, without launching an app.
let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
let characterWidth = ("M" as NSString).size(withAttributes: [.font: font]).width
let fixtures = ["漢字表示", "e\u{301}", "👨‍👩‍👧‍👦", "مرحبا بالعالم ", "\tvalue "]
var cases = 0
for fixture in fixtures {
  let text = String(repeating: fixture, count: 40)
  var previousHeight = CGFloat.greatestFiniteMagnitude
  for width: CGFloat in [180, 280, 420] {
    let layout = ReviewDiffCodeLayout(text: text, font: font, width: width, characterWidth: characterWidth)
    let height = layout.firstLineHeight + layout.extraHeight
    check(height <= previousHeight, "Wider text must not require more height")
    previousHeight = height
    let fullRange = NSRange(location: 0, length: text.utf16.count)
    let attributed = NSAttributedString(string: text, attributes: [.foregroundColor: UIColor.black])
    layout.decorate(text: attributed, highlights: [], color: .clear, version: 0)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = false
    format.preferredRange = .standard
    let size = CGSize(width: width + 40, height: ceil(height))
    let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      layout.draw(at: .zero, clip: CGRect(origin: .zero, size: size))
    }
    let bitmap = image.cgImage!
    let data = bitmap.dataProvider!.data!
    let bytes = CFDataGetBytePtr(data)!
    // Render without a viewport clip so an overflowing glyph cannot hide behind clipping.
    for y in 0..<bitmap.height {
      for x in Int(width) + 1..<bitmap.width {
        check(bytes[y * bitmap.bytesPerRow + x * 4 + 3] == 0, "Ink outside viewport: \(fixture) x=\(x) y=\(y) bpp=\(bitmap.bitsPerPixel) alpha=\(bitmap.alphaInfo.rawValue)")
      }
    }
    // Updating highlights and syntax colors must preserve measured geometry.
    layout.decorate(text: attributed, highlights: [fullRange], color: .green, version: 1)
    check(layout.firstLineHeight + layout.extraHeight == height)
    cases += 1
  }
}
let ascii = String(repeating: "const value = 123; ", count: 100)
let layout = ReviewDiffCodeLayout(text: ascii, font: font, width: 280, characterWidth: characterWidth)
let string = ascii as NSString
var reconstructed = ""
for (index, start) in layout.starts.enumerated() {
  let end = index + 1 < layout.starts.count ? layout.starts[index + 1] : string.length
  let segment = string.substring(with: NSRange(location: start, length: end - start))
  check((segment as NSString).size(withAttributes: [.font: font]).width <= 280)
  reconstructed += segment
}
check(reconstructed == ascii)
// Patches must keep warm strings for every row outside the patch.
let store = ReviewDiffTokenStore()
let rowCount = 1_000
let initialTokens = Dictionary(uniqueKeysWithValues: (0..<rowCount).map {
  ("row-\($0)", [ReviewDiffNativeToken(content: "before", color: "#ff0000", fontStyle: nil)])
})
store.replace(initialTokens)
var stringBuilds = 0
func cachedText(_ rowId: String) -> NSAttributedString {
  store.attributedString(for: rowId) {
    stringBuilds += 1
    return NSAttributedString(string: (store.tokensByRowId[rowId] ?? []).map(\.content).joined())
  }
}
let warmStrings = (0..<rowCount).map { cachedText("row-\($0)") }
stringBuilds = 0
var invalidated: [String] = []
let patch = Dictionary(uniqueKeysWithValues: (0..<4).map {
  ("row-\($0)", [ReviewDiffNativeToken(content: "after", color: "#008800", fontStyle: 2)])
})
let globalStore = ReviewDiffTokenStore()
globalStore.replace(initialTokens)
var globalBuilds = 0
func globalText(_ rowId: String) {
  _ = globalStore.attributedString(for: rowId) {
    globalBuilds += 1
    return NSAttributedString(string: "global invalidation baseline")
  }
}
for row in 0..<rowCount { globalText("row-\(row)") }
globalBuilds = 0
globalStore.replace(initialTokens.merging(patch) { _, incoming in incoming })
for row in 0..<rowCount { globalText("row-\(row)") }
check(globalBuilds == rowCount)
store.merge(patch) { invalidated.append($0) }
check(Set(invalidated) == Set(patch.keys), "Only patched rows may invalidate native decoration")
check(invalidated.count == patch.count, "Each patched row invalidates once")
for row in 0..<rowCount {
  let text = cachedText("row-\(row)")
  check(text.string == (row < 4 ? "after" : "before"))
  check((text === warmStrings[row]) == (row >= 4), "Unchanged row string was evicted")
}
check(stringBuilds == patch.count, "Patch must rebuild only affected strings")
check(store.tokensByRowId["row-0"]?.first?.fontStyle == 2, "Token metadata must survive merging")
store.merge(["new-row": patch["row-0"]!]) { _ in }
check(store.tokensByRowId.count == rowCount + 1, "Patches must accumulate rather than replace other chunks")
check(cachedText("row-10") === warmStrings[10], "Later chunks must retain unrelated cache entries")
store.merge([:]) { _ in check(false, "Empty patches must do no invalidation") }
store.merge(["row-0": []]) { _ in }
check(cachedText("row-0").length == 0, "Empty token arrays replace previous tokens")
store.replace([:])
check(store.tokensByRowId.isEmpty, "Full reset must remove every row")
check(cachedText("row-10").length == 0, "Full reset must evict even untouched cached strings")

// A native layout's targeted invalidation must repaint at the same global version.
let nativeText = "漢字"
let native = ReviewDiffCodeLayout(text: nativeText, font: font, width: 280, characterWidth: characterWidth)
func renderNative(_ color: UIColor) -> Data {
  native.decorate(
    text: NSAttributedString(string: nativeText, attributes: [.foregroundColor: color]),
    highlights: [], color: .clear, version: 7
  )
  let size = CGSize(width: 280, height: ceil(native.firstLineHeight + native.extraHeight))
  let image = UIGraphicsImageRenderer(size: size).image { _ in
    native.draw(at: .zero, clip: CGRect(origin: .zero, size: size))
  }
  return image.pngData()!
}
let red = renderNative(.red)
check(renderNative(.green) == red, "Unchanged decoration version should reuse native attributes")
native.invalidateDecoration()
check(renderNative(.green) != red, "Patched row must repaint without a global version bump")

print("Passed \(cases) Unicode/width cases, native decoration invalidation, token patch/reset, and ASCII coverage")
print("iOS warm-string builds for 4 patched rows / 1,000 total: global eviction \(globalBuilds) -> targeted \(patch.count)")
