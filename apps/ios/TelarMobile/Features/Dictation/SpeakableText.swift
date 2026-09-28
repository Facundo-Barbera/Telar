import Foundation

func speakableText(_ markdown: String) -> String {
    var blocks: [String] = []

    var paragraph: [String] = []

    var list: [String] = []

    var tableRows = 0

    func flushParagraph() {
        guard !paragraph.isEmpty else { return }
        blocks.append(sentence(paragraph.joined(separator: " ")))
        paragraph = []
    }
    func flushList() {
        guard !list.isEmpty else { return }
        blocks.append(list.joined(separator: " "))
        list = []
    }
    func flushTable() {
        guard tableRows > 0 else { return }
        blocks.append("a table, \(tableRows) \(tableRows == 1 ? "row" : "rows").")
        tableRows = 0
    }
    func flushAll() {
        flushParagraph()
        flushList()
        flushTable()
    }

    let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var index = 0
    var inFence = false
    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            if !inFence {
                flushAll()
                blocks.append("code block omitted.")
            }
            inFence.toggle()
            index += 1
            continue
        }
        if inFence {
            index += 1
            continue
        }

        if trimmed == "$$", let close = closingDisplayMath(lines, after: index) {
            flushAll()
            blocks.append("an equation.")
            index = close + 1
            continue
        }

        if trimmed.isEmpty || isThematicBreak(trimmed) {
            flushAll()
            index += 1
            continue
        }

        if trimmed.hasPrefix("|") {
            flushParagraph()
            flushList()
            if !isTableDelimiter(trimmed) { tableRows += 1 }
            index += 1
            continue
        }
        flushTable()

        if let heading = headingBody(trimmed) {
            flushParagraph()
            flushList()
            let spoken = inlineSpeakable(heading)
            if !spoken.isEmpty { blocks.append(sentence(spoken)) }
            index += 1
            continue
        }

        var body = trimmed
        while body.hasPrefix(">") {
            body = String(body.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        if body.isEmpty {
            flushAll()
            index += 1
            continue
        }

        if let item = listItemBody(body) {
            flushParagraph()
            let spoken = inlineSpeakable(item)
            if !spoken.isEmpty { list.append(sentence(spoken)) }
            index += 1
            continue
        }

        flushList()
        let spoken = inlineSpeakable(body)
        if !spoken.isEmpty { paragraph.append(spoken) }
        index += 1
    }
    flushAll()
    return blocks.joined(separator: "\n")
}

private func closingDisplayMath(_ lines: [String], after index: Int) -> Int? {
    var close = index + 1
    while close < lines.count {
        if lines[close].trimmingCharacters(in: .whitespaces) == "$$" { return close }
        close += 1
    }
    return nil
}

private func headingBody(_ line: String) -> String? {
    guard line.hasPrefix("#") else { return nil }
    let hashes = line.prefix { $0 == "#" }
    guard hashes.count <= 6 else { return nil }
    let rest = line.dropFirst(hashes.count)
    guard rest.isEmpty || rest.hasPrefix(" ") || rest.hasPrefix("\t") else { return nil }
    var body = rest.trimmingCharacters(in: .whitespaces)
    while body.hasSuffix("#") { body = String(body.dropLast()) }
    return body.trimmingCharacters(in: .whitespaces)
}

private func listItemBody(_ line: String) -> String? {
    var rest: Substring
    if let first = line.first, first == "-" || first == "*" || first == "+" {
        rest = line.dropFirst()
        guard rest.isEmpty || rest.hasPrefix(" ") || rest.hasPrefix("\t") else { return nil }
    } else if let dot = line.firstIndex(where: { $0 == "." || $0 == ")" }),
              line[line.startIndex..<dot].count <= 9,
              !line[line.startIndex..<dot].isEmpty,
              line[line.startIndex..<dot].allSatisfy(\.isNumber) {
        rest = line[line.index(after: dot)...]
        guard rest.isEmpty || rest.hasPrefix(" ") || rest.hasPrefix("\t") else { return nil }
        let body = checkbox(rest.trimmingCharacters(in: .whitespaces))
        return "\(line[line.startIndex..<dot]). \(body)"
    } else {
        return nil
    }
    return checkbox(rest.trimmingCharacters(in: .whitespaces))
}

private func checkbox(_ body: String) -> String {
    if body.hasPrefix("[x] ") || body.hasPrefix("[X] ") { return "done, " + String(body.dropFirst(4)) }
    if body.hasPrefix("[ ] ") { return "to do, " + String(body.dropFirst(4)) }
    return body
}

private func isThematicBreak(_ line: String) -> Bool {
    let marks = line.filter { !$0.isWhitespace }
    guard marks.count >= 3 else { return false }
    return marks.allSatisfy { $0 == "-" } || marks.allSatisfy { $0 == "*" }
        || marks.allSatisfy { $0 == "_" } || marks.allSatisfy { $0 == "=" }
}

private func isTableDelimiter(_ line: String) -> Bool {
    let marks = line.filter { !$0.isWhitespace }
    guard marks.contains("-") else { return false }
    return marks.allSatisfy { $0 == "|" || $0 == "-" || $0 == ":" }
}

private func sentence(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    guard let last = trimmed.last else { return "" }
    return ".!?:;,".contains(last) ? trimmed : trimmed + "."
}

private func inlineSpeakable(_ line: String) -> String {
    var out = ""
    var prose = ""
    let chars = Array(line)
    var index = 0

    func flushProse() {
        out += spokenProse(prose)
        prose = ""
    }

    while index < chars.count {
        let ch = chars[index]

        if ch == "`" {
            var run = 0
            while index + run < chars.count, chars[index + run] == "`" { run += 1 }
            if let close = closingRun(chars, from: index + run, mark: "`", length: run) {
                flushProse()
                out += String(chars[(index + run)..<close]).trimmingCharacters(in: .whitespaces)
                index = close + run
            } else {
                prose += String(repeating: "`", count: run)
                index += run
            }
            continue
        }

        if ch == "$", index + 1 < chars.count, chars[index + 1] == "$" {
            if let close = closingRun(chars, from: index + 2, mark: "$", length: 2) {
                flushProse()
                out += "an equation"
                index = close + 2
                continue
            }
            prose += "$$"
            index += 2
            continue
        }

        prose.append(ch)
        index += 1
    }
    flushProse()
    return out.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        .trimmingCharacters(in: .whitespaces)
}

private func closingRun(_ chars: [Character], from: Int, mark: Character, length: Int) -> Int? {
    guard length > 0 else { return nil }
    var index = from
    while index + length <= chars.count {
        if (0..<length).allSatisfy({ chars[index + $0] == mark }) { return index }
        index += 1
    }
    return nil
}

private func spokenProse(_ run: String) -> String {
    var out = ""
    let chars = Array(run)
    var index = 0
    while index < chars.count {
        let ch = chars[index]

        if ch == "\\", index + 1 < chars.count {
            out.append(chars[index + 1])
            index += 2
            continue
        }

        if ch == "!", index + 1 < chars.count, chars[index + 1] == "[",
           let link = bracketed(chars, from: index + 1) {
            out += link.label.isEmpty ? "an image" : link.label
            index = link.next
            continue
        }

        if ch == "[", let link = bracketed(chars, from: index) {
            out += link.label
            index = link.next
            continue
        }

        if ch == "<", let close = chars[index...].firstIndex(of: ">") {
            let inner = String(chars[(index + 1)..<close])
            if inner.hasPrefix("http") || inner.hasPrefix("mailto:") { out += "a link" }
            index = close + 1
            continue
        }

        if ch == "*" || ch == "~" {
            index += 1
            continue
        }

        if ch == "_" {
            let before = index > 0 ? chars[index - 1] : " "
            let after = index + 1 < chars.count ? chars[index + 1] : " "
            if before.isLetter || before.isNumber, after.isLetter || after.isNumber { out.append(ch) }
            index += 1
            continue
        }

        out.append(ch)
        index += 1
    }
    return out
}

private func bracketed(_ chars: [Character], from: Int) -> (label: String, next: Int)? {
    var depth = 0
    var index = from
    var close: Int?
    while index < chars.count {
        if chars[index] == "[" { depth += 1 }
        if chars[index] == "]" {
            depth -= 1
            if depth == 0 { close = index; break }
        }
        index += 1
    }
    guard let close else { return nil }
    let label = String(chars[(from + 1)..<close])
    var next = close + 1
    if next < chars.count, chars[next] == "(" {
        var depth = 0
        while next < chars.count {
            if chars[next] == "(" { depth += 1 }
            if chars[next] == ")" {
                depth -= 1
                if depth == 0 { next += 1; break }
            }
            next += 1
        }
    } else if next < chars.count, chars[next] == "[" {
        while next < chars.count, chars[next] != "]" { next += 1 }
        if next < chars.count { next += 1 }
    }
    return (label, next)
}
