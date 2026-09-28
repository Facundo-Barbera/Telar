import Foundation
import Highlightr
import SwiftUI

enum CodeLanguage {
    static func named(_ path: String) -> String? {
        let name = (path as NSString).lastPathComponent.lowercased()

        switch name {
        case "dockerfile", "containerfile": return "dockerfile"
        case "makefile", "gnumakefile": return "makefile"
        case "cmakelists.txt": return "cmake"
        case ".gitignore", ".dockerignore", ".gitattributes": return "gitignore"
        case ".env": return "ini"
        default: break
        }
        switch (path as NSString).pathExtension.lowercased() {
        case "swift": return "swift"
        case "py", "pyi", "pyw": return "python"
        case "ts", "mts", "cts": return "typescript"
        case "tsx": return "typescript"
        case "js", "mjs", "cjs": return "javascript"
        case "jsx": return "javascript"
        case "rs": return "rust"
        case "go": return "go"
        case "rb", "gemfile", "rake": return "ruby"
        case "java": return "java"
        case "kt", "kts": return "kotlin"
        case "c", "h": return "c"
        case "cc", "cpp", "cxx", "hpp", "hh": return "cpp"
        case "m": return "objectivec"
        case "mm": return "objectivec"
        case "cs": return "csharp"
        case "php": return "php"
        case "sh", "bash", "zsh", "fish": return "bash"
        case "json", "jsonc": return "json"
        case "yaml", "yml": return "yaml"
        case "toml": return "ini"
        case "ini", "cfg", "conf": return "ini"
        case "xml", "plist", "storyboard", "xib", "svg": return "xml"
        case "html", "htm": return "xml"
        case "css": return "css"
        case "scss", "sass": return "scss"
        case "sql": return "sql"
        case "md", "markdown": return "markdown"
        case "tex", "sty", "cls", "bib": return "latex"
        case "diff", "patch": return "diff"
        case "lua": return "lua"
        case "r": return "r"
        case "scala": return "scala"
        case "dart": return "dart"
        case "ex", "exs": return "elixir"
        case "hs": return "haskell"
        case "pl", "pm": return "perl"
        case "proto": return "protobuf"
        case "gradle", "groovy": return "groovy"
        case "vim": return "vim"
        case "ipynb": return "json"
        default: return nil
        }
    }

    static func fenced(_ info: String?) -> String? {
        guard let first = info?
            .trimmingCharacters(in: .whitespaces)
            .split(whereSeparator: { $0 == " " || $0 == "," || $0 == "{" || $0 == "}" || $0 == "." })
            .first
            .map(String.init)?
            .lowercased(), !first.isEmpty else { return nil }
        switch first {
        case "sh", "shell", "console", "zsh", "bash": return "bash"
        case "ts", "tsx", "typescript": return "typescript"
        case "js", "jsx", "javascript", "node": return "javascript"
        case "py", "python", "python3": return "python"
        case "yml", "yaml": return "yaml"
        case "rb", "ruby": return "ruby"
        case "rs", "rust": return "rust"
        case "objc", "objective-c": return "objectivec"
        case "c++", "cpp": return "cpp"
        case "c#", "csharp", "cs": return "csharp"
        case "html", "xml", "plist": return "xml"
        case "toml", "ini", "conf": return "ini"
        case "tex", "latex": return "latex"
        case "text", "txt", "plain", "plaintext", "none": return nil
        default: return first
        }
    }

    static let sizeCap = 200 * 1024

    static func worthHighlighting(_ text: String, language: String?) -> Bool {
        language != nil && text.utf8.count <= sizeCap
    }
}

actor CodeHighlighter {
    static let shared = CodeHighlighter()

    private var highlightr: Highlightr?
    private var theme: String?
    private var cache: [Key: AttributedString] = [:]
    private var order: [Key] = []
    private var lineCache: [Key: [AttributedString]] = [:]
    private var lineOrder: [Key] = []

    private let cacheLimit = 48

    private struct Key: Hashable {
        var hash: Int
        var language: String
        var dark: Bool
    }

    private func themeName(dark: Bool) -> String { dark ? "atom-one-dark" : "atom-one-light" }

    func highlight(_ text: String, language: String?, dark: Bool) -> AttributedString? {
        guard let language, CodeLanguage.worthHighlighting(text, language: language) else { return nil }
        let key = Key(hash: text.hashValue, language: language, dark: dark)
        if let cached = cache[key] { return cached }

        if highlightr == nil { highlightr = Highlightr() }
        guard let highlightr else { return nil }
        let wanted = themeName(dark: dark)
        if theme != wanted {
            highlightr.setTheme(to: wanted)
            theme = wanted
        }

        guard let highlighted = highlightr.highlight(text, as: language, fastRender: false) else { return nil }
        var attributed = AttributedString(highlighted)

        attributed.backgroundColor = nil
        cache[key] = attributed
        order.append(key)
        if order.count > cacheLimit, let oldest = order.first {
            order.removeFirst()
            cache[oldest] = nil
        }
        return attributed
    }

    func highlightedLines(_ text: String, language: String?, dark: Bool) -> [AttributedString]? {
        guard let language, CodeLanguage.worthHighlighting(text, language: language) else { return nil }
        let key = Key(hash: text.hashValue, language: language, dark: dark)
        if let cached = lineCache[key] { return cached }
        guard let whole = highlight(text, language: language, dark: dark) else { return nil }
        var lines: [AttributedString] = []
        var start = whole.startIndex
        var index = whole.startIndex
        while index < whole.endIndex {
            let next = whole.characters.index(after: index)
            if whole.characters[index] == "\n" {
                lines.append(AttributedString(whole[start..<index]))
                start = next
            }
            index = next
        }
        lines.append(AttributedString(whole[start...]))
        lineCache[key] = lines
        lineOrder.append(key)
        if lineOrder.count > cacheLimit, let oldest = lineOrder.first {
            lineOrder.removeFirst()
            lineCache[oldest] = nil
        }
        return lines
    }
}

struct HighlightedCode: View {
    let text: String
    let language: String?
    var font: Font = .system(Theme.footnote, design: .monospaced)

    @Environment(\.colorScheme) private var scheme
    @State private var highlighted: AttributedString?

    var body: some View {
        Group {
            if let highlighted {
                Text(highlighted).font(font)
            } else {
                Text(text).font(font).foregroundStyle(Theme.text)
            }
        }
        .textSelection(.enabled)
        .task(id: "\(text.hashValue):\(language ?? "-"):\(scheme == .dark)") {
            highlighted = await CodeHighlighter.shared.highlight(text, language: language, dark: scheme == .dark)
        }
    }
}
