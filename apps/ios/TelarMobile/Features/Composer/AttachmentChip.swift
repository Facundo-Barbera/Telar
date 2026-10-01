import SwiftUI

struct AttachmentChip: View {
    let name: String
    let mediaType: String

    var preview: Data?
    let onRemove: () -> Void

    @State private var thumbnail: UIImage?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image = thumbnail {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    VStack(spacing: 6) {
                        Image(systemName: AttachmentGlyph.name(for: mediaType))
                            .scaledGlyph(20)
                            .foregroundStyle(Theme.textMuted)
                        Text(name)
                            .scaledGlyph(10)
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                            .padding(.horizontal, 4)
                    }
                }
            }
            .scaledSquare(72)
            .background(Theme.subtle)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .foregroundStyle(.white)
                    .scaledGlyphBox(22, glyph: 9, weight: .bold)
                    .background(Color.black.opacity(0.55))
                    .clipShape(Circle())
            }
            .padding(4)
            .accessibilityLabel("Remove \(name)")
        }
        .task(id: preview) {
            guard let preview else { return thumbnail = nil }
            thumbnail = await Task.detached(priority: .userInitiated) { Thumbnail.make(preview, side: Thumbnail.tile) }.value
        }

        .contextMenu {
            Button("Remove attachment", systemImage: "xmark", role: .destructive) { onRemove() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(name)
    }
}
