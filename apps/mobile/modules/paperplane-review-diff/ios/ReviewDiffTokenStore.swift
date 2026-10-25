import Foundation

struct ReviewDiffNativeToken: Decodable, Sendable {
  let content: String
  let color: String?
  let fontStyle: Int?
}

/// Tokens and their derived strings have the same row-scoped lifetime.
final class ReviewDiffTokenStore {
  private(set) var tokensByRowId: [String: [ReviewDiffNativeToken]] = [:]
  private var attributedStringsByRowId: [String: NSAttributedString] = [:]

  func replace(_ tokens: [String: [ReviewDiffNativeToken]]) {
    tokensByRowId = tokens
    clearAttributedStrings()
  }

  func merge(
    _ patch: [String: [ReviewDiffNativeToken]],
    invalidateRow: (String) -> Void
  ) {
    // One dictionary mutation, with no property observer doing global work per row.
    tokensByRowId.merge(patch) { _, incoming in incoming }
    for rowId in patch.keys {
      attributedStringsByRowId.removeValue(forKey: rowId)
      invalidateRow(rowId)
    }
  }

  func clearAttributedStrings() {
    attributedStringsByRowId.removeAll()
  }

  func attributedString(
    for rowId: String,
    make: () -> NSAttributedString
  ) -> NSAttributedString {
    if let cached = attributedStringsByRowId[rowId] { return cached }
    let text = make()
    attributedStringsByRowId[rowId] = text
    return text
  }
}
