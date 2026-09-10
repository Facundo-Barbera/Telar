import SwiftUI
import MarkdownUI
import SwiftMath

/// The agent's prose: GitHub-flavoured Markdown with tables, lists, headings,
/// block quotes and fenced code through MarkdownUI, and TeX through
/// SwiftMath — the web's Streamdown + KaTeX pairing, phone-sized.
///
/// MATH IS CUT OUT FIRST (`splitMath`), because MarkdownUI has no hook for a
/// new inline node; each run then goes to the renderer that owns it. The
/// web's policy carries over: `$$` only, single dollars are money, a failed
/// equation renders its own source in the muted colour rather than throwing.
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(splitMath(text).enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .markdown(let body):
                    Markdown(body)
                        .markdownTheme(.telar)
                        .markdownImageProvider(AttachmentImageProvider())
                        .markdownInlineImageProvider(AttachmentImageProvider())
                        .textSelection(.enabled)
                case .display(let tex):
                    MathBlock(tex: tex, display: true)
                        .frame(maxWidth: .infinity, alignment: .center)
                case .inline(let tex):
                    MathBlock(tex: tex, display: false)
                }
            }
        }
    }
}

/// One equation, typeset once and cached by source. SwiftMath's label is a
/// UIView; rendering to an image keeps the transcript a plain SwiftUI tree
/// and lets a long conversation hold a hundred equations as bitmaps rather
/// than a hundred live views.
private struct MathBlock: View {
    let tex: String
    let display: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let rendered = MathCache.shared.image(for: tex, display: display, dark: scheme == .dark)
        if let image = rendered {
            Image(uiImage: image)
                .accessibilityLabel(tex)
        } else {
            // THE SOURCE, in the muted colour — never a crashed row. A half-
            // streamed `\frac{1}{` lands here until the closing brace arrives.
            Text(display ? "$$\(tex)$$" : "$$\(tex)$$")
                .font(Theme.mono)
                .foregroundStyle(Theme.textMuted)
                .textSelection(.enabled)
        }
    }
}

@MainActor private final class MathCache {
    static let shared = MathCache()
    private var images: [String: UIImage] = [:]
    private var failed: Set<String> = []

    func image(for tex: String, display: Bool, dark: Bool) -> UIImage? {
        let key = "\(display ? "D" : "I")\(dark ? "k" : "l")\(tex)"
        if let hit = images[key] { return hit }
        if failed.contains(key) { return nil }
        let renderer = MTMathImage(
            latex: tex,
            fontSize: display ? 18 : 15,
            textColor: dark ? UIColor(white: 0.96, alpha: 1) : UIColor(red: 0.153, green: 0.153, blue: 0.165, alpha: 1),
            labelMode: display ? .display : .text,
            textAlignment: .left
        )
        let (error, image) = renderer.asImage()
        guard error == nil, let image else {
            failed.insert(key)
            return nil
        }
        images[key] = image
        return image
    }
}

/// Images in a message are attachment URLs relative to the cockpit, and the
/// cockpit is paired: a plain `AsyncImage` would be refused at the gate.
/// The provider fetches through the API the surface already holds.
///
/// NOT YET WIRED TO A SESSION: without an API in the environment a relative
/// URL renders as its alt text. Absolute `https://` images load directly.
private struct AttachmentImageProvider: ImageProvider, InlineImageProvider {
    func makeImage(url: URL?) -> some View {
        Group {
            if let url, url.scheme == "https" || url.scheme == "http" {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFit() } else { EmptyView() }
                }
            } else {
                EmptyView()
            }
        }
    }

    func image(with url: URL, label: String) async throws -> Image {
        guard url.scheme == "https" || url.scheme == "http" else { throw URLError(.unsupportedURL) }
        let (data, _) = try await URLSession.shared.data(from: url)
        guard let uiImage = UIImage(data: data) else { throw URLError(.cannotDecodeContentData) }
        return Image(uiImage: uiImage)
    }
}

extension MarkdownUI.Theme {
    /// MarkdownUI's GitHub theme in Telar's colours and type: the same
    /// 14pt body and 5pt leading the old renderer used, code blocks on the
    /// code surface, tables with the hairline border.
    static let telar = MarkdownUI.Theme()
        .text {
            ForegroundColor(TelarMobile.Theme.text)
            FontSize(15)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.88))
            BackgroundColor(TelarMobile.Theme.codeBackground)
        }
        .strong { FontWeight(.semibold) }
        .link { ForegroundColor(TelarMobile.Theme.accent) }
        .heading1 { $0.label.markdownMargin(top: 16, bottom: 8).markdownTextStyle { FontWeight(.semibold); FontSize(.em(1.4)) } }
        .heading2 { $0.label.markdownMargin(top: 14, bottom: 6).markdownTextStyle { FontWeight(.semibold); FontSize(.em(1.2)) } }
        .heading3 { $0.label.markdownMargin(top: 12, bottom: 4).markdownTextStyle { FontWeight(.semibold); FontSize(.em(1.05)) } }
        .heading4 { $0.label.markdownMargin(top: 10, bottom: 4).markdownTextStyle { FontWeight(.semibold) } }
        .heading5 { $0.label.markdownMargin(top: 8, bottom: 4).markdownTextStyle { FontWeight(.semibold); FontSize(.em(0.9)) } }
        .heading6 { $0.label.markdownMargin(top: 8, bottom: 4).markdownTextStyle { FontWeight(.semibold); FontSize(.em(0.85)); ForegroundColor(TelarMobile.Theme.textMuted) } }
        .paragraph { $0.label.fixedSize(horizontal: false, vertical: true).relativeLineSpacing(.em(0.3)).markdownMargin(top: 0, bottom: 10) }
        .blockquote { configuration in
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 2).fill(TelarMobile.Theme.border).frame(width: 3)
                configuration.label
                    .markdownTextStyle { ForegroundColor(TelarMobile.Theme.textMuted) }
                    .padding(.leading, 12)
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: 0, bottom: 10)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.2))
                    .markdownTextStyle { FontFamilyVariant(.monospaced); FontSize(.em(0.88)) }
                    .padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TelarMobile.Theme.codeBackground)
            .clipShape(RoundedRectangle(cornerRadius: TelarMobile.Theme.radiusRow))
            .overlay(RoundedRectangle(cornerRadius: TelarMobile.Theme.radiusRow).strokeBorder(TelarMobile.Theme.borderSubtle, lineWidth: 1))
            .markdownMargin(top: 0, bottom: 10)
            .contextMenu {
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = configuration.content }
            }
        }
        .listItem { $0.label.markdownMargin(top: .em(0.2)) }
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .markdownTableBorderStyle(.init(color: TelarMobile.Theme.border))
                    .markdownTableBackgroundStyle(.alternatingRows(Color.clear, TelarMobile.Theme.subtle.opacity(0.6)))
            }
            .markdownMargin(top: 0, bottom: 10)
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    if configuration.row == 0 { FontWeight(.semibold) }
                    FontSize(.em(0.92))
                    BackgroundColor(nil)
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 5)
                .padding(.horizontal, 10)
        }
        .thematicBreak {
            Divider().overlay(TelarMobile.Theme.border).markdownMargin(top: 14, bottom: 14)
        }
}

/// Fenced code outside a message — tool output, plan text. Unchanged.
struct CodeBlockView: View {
    let code: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(TelarMobile.Theme.mono)
                .foregroundStyle(TelarMobile.Theme.text)
                .textSelection(.enabled)
                .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TelarMobile.Theme.codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: TelarMobile.Theme.radiusRow))
        .hairline(TelarMobile.Theme.radiusRow)
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = code
            }
        }
    }
}
