import QuickLook
import SwiftUI

struct AttachmentSource {
    var host: HostID?
    var session: EngineID
    var fetch: @Sendable (EngineID, EngineID) async throws -> RawFile
}

extension EnvironmentValues {
    @Entry var attachmentSource: AttachmentSource?
}

struct SentAttachments: View {
    let attachments: [TurnAttachment]

    @Environment(\.attachmentSource) private var source
    @State private var opening: EngineID?
    @State private var previewing: URL?
    @State private var failed: String?

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(attachments) { attachment in
                        Button { open(attachment) } label: { tile(attachment) }
                            .buttonStyle(.plain)
                            .disabled(source == nil || opening != nil)
                            .accessibilityLabel("Open \(attachment.name)")
                    }
                }
            }
            .defaultScrollAnchor(.trailing)
            .fixedSize(horizontal: false, vertical: true)
            if let failed {
                Text(failed)
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.statusRed)
            }
        }
        .quickLookPreview($previewing)
    }

    @ViewBuilder private func tile(_ attachment: TurnAttachment) -> some View {
        ZStack {
            if attachment.mediaType.hasPrefix("image/") {
                SentImageThumbnail(attachment: attachment)
            } else {
                SentFileChip(attachment: attachment)
            }
            if opening == attachment.id {
                ProgressView().padding(8).background(.ultraThinMaterial, in: Circle())
            }
        }
    }

    private func open(_ attachment: TurnAttachment) {
        guard let source else { return }
        opening = attachment.id
        failed = nil
        Task {
            let url = await AttachmentCache.shared.fileURL(
                host: source.host, session: source.session, attachmentId: attachment.id, name: attachment.name, fetch: source.fetch
            )
            opening = nil
            if let url { previewing = url } else { failed = "Couldn't download \(attachment.name)." }
        }
    }
}

private struct SentImageThumbnail: View {
    let attachment: TurnAttachment

    @Environment(\.attachmentSource) private var source
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "photo")
                    .scaledGlyph(20)
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .scaledSquare(96)
        .background(Theme.subtle)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .task(id: attachment.id) {
            guard let source else { return }
            image = await AttachmentCache.shared.image(host: source.host, session: source.session, attachmentId: attachment.id, fetch: source.fetch)
        }
    }
}

private struct SentFileChip: View {
    let attachment: TurnAttachment

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: AttachmentGlyph.name(for: attachment.mediaType))
                .scaledGlyph(18)
                .foregroundStyle(Theme.textMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.name)
                    .font(.system(Theme.footnote, weight: .medium))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(humanBytes(attachment.bytes))
                    .font(.system(Theme.caption))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .frame(maxWidth: 220, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.messageSurface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

enum AttachmentGlyph {
    static func name(for mediaType: String) -> String {
        if mediaType.hasPrefix("image/") { return "photo" }
        if mediaType.hasPrefix("video/") { return "film" }
        if mediaType.hasPrefix("audio/") { return "waveform" }
        if mediaType == "application/pdf" { return "doc.richtext" }
        if mediaType.hasPrefix("text/") { return "doc.text" }
        return "doc"
    }
}
