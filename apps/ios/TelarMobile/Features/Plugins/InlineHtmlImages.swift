import Foundation

/// INLINE `<img>` BECOMES A MARKDOWN IMAGE, before anything parses the text.
///
/// MarkdownUI has no hook for inline HTML: `TextInlineRenderer.renderHTML`
/// special-cases `<br>` and renders every other tag as its own literal source.
/// A Jupyter markdown cell that says `<img src="fig.png">` therefore showed
/// the tag, and so did a transcript where an agent pasted one — which is the
/// same failure the panel had with HTML outputs, one layer up.
///
/// A PRE-PASS RATHER THAN A RENDERER. The rewrite happens on the source, so
/// everything downstream — the image provider, the sizing, the cache — is the
/// path a Markdown image already took. Nothing new has to be trusted.
///
/// ONLY `<img>`. Every other inline tag is left exactly as it was, including
/// `<br>`, which MarkdownUI already turns into a line break and which would
/// lose that if this touched it.
func rewriteInlineImages(_ markdown: String) -> String {
    guard markdown.range(of: "<img", options: .caseInsensitive) != nil else { return markdown }
    var out = ""
    var cursor = markdown.startIndex
    while let open = markdown.range(of: "<img\\b[^>]*>", options: [.regularExpression, .caseInsensitive],
                                    range: cursor..<markdown.endIndex) {
        out += markdown[cursor..<open.lowerBound]
        let tag = String(markdown[open])
        // A tag with no `src` is not an image anybody can draw; leaving it
        // literal says more than an empty `![]()` would.
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

/// One attribute out of a tag, single or double quoted. Unquoted values are
/// not read: they are vanishingly rare in a repr and guessing where one ends
/// is how a rewrite swallows the rest of the tag.
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

/// A label that would otherwise close the bracket early.
private func escapeMarkdownLabel(_ text: String) -> String {
    text.replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
}

/// A target with a space or a paren in it needs angle brackets, or the link
/// ends where the space is.
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

/// WHERE A NOTEBOOK'S `<img src="fig.png">` POINTS. A relative path is
/// relative to the notebook, not to the workspace root, so it is resolved
/// against the notebook's own directory before the raw-file route is asked
/// for it. An absolute URL is left alone and loads over the network.
func resolveNotebookImagePath(_ source: String, notebookPath: String) -> String? {
    if source.hasPrefix("http://") || source.hasPrefix("https://") || source.hasPrefix("data:") { return nil }
    var path = source
    if path.hasPrefix("./") { path.removeFirst(2) }
    // A workspace-absolute path is already what the route wants.
    if path.hasPrefix("/") { return String(path.dropFirst()) }
    let directory = (notebookPath as NSString).deletingLastPathComponent
    return normalisePath(directory.isEmpty ? path : (directory as NSString).appendingPathComponent(path))
}

/// `a/b/../c` → `a/c`, by hand.
///
/// `NSString.standardizingPath` DOES NOT DO THIS for a relative path — it
/// leaves `..` in place, because resolving one without knowing the real
/// filesystem could cross a symlink. Here the path is a workspace key rather
/// than a filesystem path, so resolving it is the right thing and doing it
/// ourselves is the only way.
///
/// A path that climbs past the root is CLAMPED rather than escaping: the raw
/// route serves the workspace and nothing above it, so `../../etc` is simply
/// not a thing this can ask for.
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
