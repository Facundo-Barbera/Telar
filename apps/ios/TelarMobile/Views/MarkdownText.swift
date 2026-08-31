import SwiftUI

/// Markdown without a dependency: split on ``` fences, render prose through
/// AttributedString (inline-only, whitespace-preserving so paragraphs
/// survive) and fenced code through a mono scroll block. Tables and nested
/// lists degrade to plain text — revisit only if that ever matters.
struct MarkdownText: View {
    let text: String

    private enum Segment: Identifiable {
        case prose(id: Int, String)
        case code(id: Int, String)
        var id: Int {
            switch self {
            case .prose(let id, _), .code(let id, _): id
            }
        }
    }

    private var segments: [Segment] {
        var result: [Segment] = []
        var inCode = false
        var buffer: [Substring] = []
        var nextId = 0
        func flush() {
            let body = buffer.joined(separator: "\n")
            if !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result.append(inCode ? .code(id: nextId, body) : .prose(id: nextId, body))
                nextId += 1
            }
            buffer = []
        }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                flush()
                inCode.toggle()
            } else {
                buffer.append(line)
            }
        }
        flush()
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(segments) { segment in
                switch segment {
                case .prose(_, let body):
                    Text(attributed(body))
                        .textSelection(.enabled)
                case .code(_, let body):
                    CodeBlockView(code: body)
                }
            }
        }
    }

    private func attributed(_ prose: String) -> AttributedString {
        (try? AttributedString(
            markdown: prose,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(prose)
    }
}

struct CodeBlockView: View {
    let code: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = code
            }
        }
    }
}
