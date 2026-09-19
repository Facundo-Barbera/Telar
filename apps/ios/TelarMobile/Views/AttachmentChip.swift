import SwiftUI
import UniformTypeIdentifiers

/// ONE CHIP, BOTH COMPOSERS. The 72×72 tile in the attachment strip: the
/// picture itself when there is one, a glyph for its kind when there is not,
/// and a 22pt remove circle. Both strips drew their own before, and the one in
/// the new-session sheet claimed everything was a photo — which it no longer
/// is, now that anything can be dropped in.
struct AttachmentChip: View {
    let name: String
    let mediaType: String
    /// The bytes, when they are still at hand. A file already uploaded has
    /// only what the store kept for exactly this.
    var preview: Data?
    let onRemove: () -> Void

    private var glyph: String {
        if mediaType.hasPrefix("image/") { return "photo" }
        if mediaType.hasPrefix("video/") { return "film" }
        if mediaType.hasPrefix("audio/") { return "waveform" }
        if mediaType == "application/pdf" { return "doc.richtext" }
        if mediaType.hasPrefix("text/") { return "doc.text" }
        return "doc"
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let preview, let image = UIImage(data: preview) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    VStack(spacing: 6) {
                        Image(systemName: glyph)
                            // THE WHOLE CHIP KEEPS ABSOLUTE SIZES. The tile is
                            // a fixed 72pt square and the remove badge a fixed
                            // 22pt one, both clipping, so a glyph that grew
                            // with the reader's text would outgrow its own
                            // box. They want @ScaledMetric frames (#674).
                            .font(.system(size: 20))
                            .foregroundStyle(Theme.textMuted)
                        Text(name)
                            .font(.system(size: 10))
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                            .padding(.horizontal, 4)
                    }
                }
            }
            .frame(width: 72, height: 72)
            .background(Theme.subtle)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(Color.black.opacity(0.55))
                    .clipShape(Circle())
            }
            .padding(4)
            .accessibilityLabel("Remove \(name)")
        }
        // The chip's own ✕ as a row — it takes the file off the message, it
        // does not delete anything, and a bin would say it did.
        .contextMenu {
            Button("Remove attachment", systemImage: "xmark", role: .destructive) { onRemove() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(name)
    }
}
