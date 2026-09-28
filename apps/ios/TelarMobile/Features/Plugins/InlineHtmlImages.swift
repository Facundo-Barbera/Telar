import Foundation

func rewriteInlineImages(_ markdown: String) -> String {
    guard markdown.range(of: "<img", options: .caseInsensitive) != nil else { return markdown }
    var out = ""
    var cursor = markdown.startIndex
    while let open = markdown.range(of: "<img\\b[^>]*>", options: [.regularExpression, .caseInsensitive],
                                    range: cursor..<markdown.endIndex) {
        out += markdown[cursor..<open.lowerBound]
        let tag = String(markdown[open])

        if let source = htmlAttribute("src", in: tag), !source.isEmpty {
            let alt = htmlAttribute("alt", in: tag) ?? ""
            out += "![\(escapeMarkdownLabel(alt))](\(escapeMarkdownTarget(source)))"
        } else {
            out += tag
        }
        cursor = open.upperBound
    }
    out += markdown[cursor...]
    return out
}

func htmlAttribute(_ name: String, in tag: String) -> String? {
    let pattern = "\\b\(name)\\s*=\\s*(\"([^\"]*)\"|'([^']*)')"
    guard let range = tag.range(of: pattern, options: [.regularExpression, .caseInsensitive]) else { return nil }
    let match = String(tag[range])
    guard let quote = match.firstIndex(where: { $0 == "\"" || $0 == "'" }) else { return nil }
    let mark = match[quote]
    let rest = match[match.index(after: quote)...]
    guard let end = rest.firstIndex(of: mark) else { return nil }
    return decodeHtmlEntities(String(rest[rest.startIndex..<end]))
}

private func escapeMarkdownLabel(_ text: String) -> String {
    text.replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
}

private func escapeMarkdownTarget(_ text: String) -> String {
    let needsBrackets = text.contains(" ") || text.contains("(") || text.contains(")")
    return needsBrackets ? "<\(text)>" : text
}

func decodeHtmlEntities(_ text: String) -> String {
    var out = text
    for (entity, character) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
        out = out.replacingOccurrences(of: entity, with: character)
    }
    return out
}

func resolveNotebookImagePath(_ source: String, notebookPath: String) -> String? {
    if source.hasPrefix("http://") || source.hasPrefix("https://") || source.hasPrefix("data:") { return nil }
    var path = source
    if path.hasPrefix("./") { path.removeFirst(2) }

    if path.hasPrefix("/") { return String(path.dropFirst()) }
    let directory = (notebookPath as NSString).deletingLastPathComponent
    return normalisePath(directory.isEmpty ? path : (directory as NSString).appendingPathComponent(path))
}

func normalisePath(_ path: String) -> String {
    var parts: [String] = []
    for segment in path.split(separator: "/") {
        switch segment {
        case ".": continue
        case "..": if !parts.isEmpty { parts.removeLast() }
        default: parts.append(String(segment))
        }
    }
    return parts.joined(separator: "/")
}
