import SwiftUI

struct DictationCaretPill: View {
    let language: String?

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "mic.fill")
                .font(.system(Theme.captionTiny, weight: .semibold))
            Text(DictationLanguages.badge(language))
                .font(.system(Theme.caption, weight: .semibold))
                .monospacedDigit()
        }
        .foregroundStyle(Theme.primaryGlyph)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(Theme.accent))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    static let size = CGSize(width: 52, height: 20)

    static let lift: CGFloat = 4
    static let nudge: CGFloat = 2

    static func origin(for rect: CGRect) -> CGPoint {
        CGPoint(x: max(rect.minX - nudge, 0), y: max(rect.minY - lift - size.height, 0))
    }
}
