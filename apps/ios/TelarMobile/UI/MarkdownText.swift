import SwiftUI
import MarkdownUI
import SwiftMath

struct MarkdownText: View {
    let text: String

    var source: MarkdownSource = .transcript

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(splitMath(rewriteInlineImages(text)).enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .markdown(let body):
                    if case .notebookCell(let notebookPath) = source, let block = soleHtmlBlock(body) {
                        HtmlOutputView(html: block)
                            .padding(.vertical, 2)
                            .id(notebookPath)
                    } else {
                    Markdown(body)
                        .markdownTheme(.telar)
                        .markdownImageProvider(imageProvider)
                        .markdownInlineImageProvider(imageProvider)
                        .textSelection(.enabled)
                    }
                case .display(let tex):
                    MathBlock(tex: tex, display: true)
                        .frame(maxWidth: .infinity, alignment: .center)
                case .inline(let tex):
                    MathBlock(tex: tex, display: false)
                }
            }
        }
    }

    private var imageProvider: AttachmentImageProvider {
        if case .notebookCell(let path) = source { return AttachmentImageProvider(notebookPath: path) }
        return AttachmentImageProvider()
    }
}

enum MarkdownSource: Equatable {
    case transcript

    case notebookCell(path: String)
}

func soleHtmlBlock(_ markdown: String) -> String? {
    let trimmed = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("<"), trimmed.hasSuffix(">") else { return nil }

    guard trimmed.range(of: "^<(div|table|details|figure|section|article|blockquote|ul|ol|dl|pre|iframe|video|audio|p|h[1-6])\\b",
                        options: [.regularExpression, .caseInsensitive]) != nil else { return nil }
    return trimmed
}

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

struct AttachmentImageProvider: ImageProvider, InlineImageProvider {
    var notebookPath: String?

    func makeImage(url: URL?) -> some View {
        Group {
            if let url, url.scheme == "https" || url.scheme == "http" {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFit() } else { EmptyView() }
                }
            } else if let notebookPath, let url {
                WorkspaceImage(path: resolveNotebookImagePath(url.absoluteString, notebookPath: notebookPath))
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

private struct WorkspaceImage: View {
    let path: String?
    @Environment(\.workspaceImages) private var loader
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Color.clear.frame(height: 1)
            }
        }
        .task(id: path ?? "-") {
            guard let path, let loader else { return }
            image = await loader(path)
        }
    }
}

private struct WorkspaceImagesKey: EnvironmentKey {
    static let defaultValue: (@Sendable (String) async -> UIImage?)? = nil
}

extension EnvironmentValues {
    var workspaceImages: (@Sendable (String) async -> UIImage?)? {
        get { self[WorkspaceImagesKey.self] }
        set { self[WorkspaceImagesKey.self] = newValue }
    }
}

extension MarkdownUI.Theme {
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
                if let language = CodeLanguage.fenced(configuration.language) {
                    HighlightedCode(text: configuration.content, language: language,
                                    font: .system(Theme.footnote, design: .monospaced))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(10)
                } else {
                    configuration.label
                        .fixedSize(horizontal: false, vertical: true)
                        .relativeLineSpacing(.em(0.2))
                        .markdownTextStyle { FontFamilyVariant(.monospaced); FontSize(.em(0.88)) }
                        .padding(10)
                }
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
