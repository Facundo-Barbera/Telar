import Foundation

/// A REPLY AS SPEECH — the pass between the Markdown on screen and
/// `AVSpeechUtterance`. Pure, so it tests the way `splitMath` and the reveal
/// pacer do (`docs/investigations/ios-talkback-2026-09-11.md`, §1).
///
/// WHY NOT `MarkdownContent.renderPlainText()`. MarkdownUI exposes one, and it
/// is not a speakable pass: it hands back fenced code VERBATIM, tables as pipe
/// rows and `$$…$$` untouched. A synthesizer reading that says "pipe alpha pipe
/// one pipe" and spells out braces. The block tree cannot be walked instead —
/// `MarkdownContent.blocks` is internal — so the pass is our own.
///
/// THE POLICY, one line per element (the investigation's table):
///
///   prose, headings, list items, block quotes  read, markers dropped
///   fenced code                                "code block omitted"
///   inline `code`                              read as-is — it is one word
///   table                                      "a table, N rows"
///   `$$…$$`                                    "an equation"
///   link                                       its label; the URL is not speech
///   image                                      its alt text
///
/// IT IS A LINE WALK, not a parser, and it copies the one already in
/// `MathSegments.swift`: fence toggling, and a backtick span tracked across the
/// characters of a line. The cost is a parser's exactness on constructs nobody
/// dictates — a reference definition, a nested fence — and the gain is that the
/// whole thing is a pure function over a String.
///
/// INJECTED PHRASES ARE LOWERCASE, always ("code block omitted.", "an
/// equation."). They are read, never seen, and one case everywhere beats a rule
/// about where a substitution happens to land in a sentence.

/// The reply, as the synthesizer should hear it. Blocks are one per line;
/// every one ends in punctuation, which is what a synthesizer pauses on.
func speakableText(_ markdown: String) -> String {
    var blocks: [String] = []
    /// Soft-wrapped lines of one paragraph, joined with a space.
    var paragraph: [String] = []
    /// LIST ITEMS BECOME SENTENCES, in one block: a bullet is a visual mark
    /// with nothing to say, and an item read without a full stop runs into the
    /// next one.
    var list: [String] = []
    /// Non-delimiter rows of the table being crossed.
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

        // A fence toggles. The BODY IS NEVER SPOKEN — that is the whole point
        // of the pass — so the opener stands for the block and everything up to
        // the closer is dropped.
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

        // `$$` on its own line opens a display equation, closed by another.
        // Unclosed, it was text after all.
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

        // A table is a SHAPE, not prose: its cells read as a stream of
        // fragments with no sentence in them. Say that one is there and how
        // big, and leave reading it to the eyes.
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

        // A quote is read as what it says. Nested `>` markers strip with it —
        // the depth is a fact about the page, not about the words.
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

// MARK: - blocks

/// The index of the `$$` that closes one opened at `index`, if it is closed.
private func closingDisplayMath(_ lines: [String], after index: Int) -> Int? {
    var close = index + 1
    while close < lines.count {
        if lines[close].trimmingCharacters(in: .whitespaces) == "$$" { return close }
        close += 1
    }
    return nil
}

/// `## Title ##` → `Title`. Nil when the line is not an ATX heading.
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

/// The text of a list item, with the marker gone — and with a checkbox read
/// rather than dropped, because "done" and "to do" are the sentence's meaning
/// and not its decoration.
private func listItemBody(_ line: String) -> String? {
    var rest: Substring
    if let first = line.first, first == "-" || first == "*" || first == "+" {
        rest = line.dropFirst()
        guard rest.isEmpty || rest.hasPrefix(" ") || rest.hasPrefix("\t") else { return nil }
    } else if let dot = line.firstIndex(where: { $0 == "." || $0 == ")" }),
              line[line.startIndex..<dot].count <= 9,
              !line[line.startIndex..<dot].isEmpty,
              line[line.startIndex..<dot].allSatisfy(\.isNumber) {
        // An ordinal is worth keeping: "step 2" is what the order MEANS, and a
        // listener has no numbered column to look at.
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

/// `---`, `***`, `___` — and the `===` under a setext heading, which is a rule
/// as far as speech is concerned either way.
private func isThematicBreak(_ line: String) -> Bool {
    let marks = line.filter { !$0.isWhitespace }
    guard marks.count >= 3 else { return false }
    return marks.allSatisfy { $0 == "-" } || marks.allSatisfy { $0 == "*" }
        || marks.allSatisfy { $0 == "_" } || marks.allSatisfy { $0 == "=" }
}

/// The `|---|:--:|` row under a table's header: alignment, never content.
private func isTableDelimiter(_ line: String) -> Bool {
    let marks = line.filter { !$0.isWhitespace }
    guard marks.contains("-") else { return false }
    return marks.allSatisfy { $0 == "|" || $0 == "-" || $0 == ":" }
}

/// One block, ended so the synthesizer stops for breath. Punctuation it
/// already has is left alone — a paragraph ending in a colon is introducing
/// the next block and should still sound like it.
private func sentence(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    guard let last = trimmed.last else { return "" }
    return ".!?:;,".contains(last) ? trimmed : trimmed + "."
}

// MARK: - one line

/// Inline Markdown, spoken. A CHARACTER WALK rather than substitutions,
/// because the two things that must be read VERBATIM — a code span and an
/// equation — are exactly the two that a substitution pass would corrupt:
/// `a_b` inside backticks is an identifier, not emphasis.
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

        // A code span: read what is inside it, drop the ticks. The fence may
        // be any run of backticks, and an unclosed one is text.
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

        // `$$…$$`. Single dollars are money — the web's rule, and the phone's
        // renderer already agrees (`MathSegments.swift`).
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

/// The start of the next run of `length` `mark`s at or after `from` — the
/// closer of a span opened before it.
private func closingRun(_ chars: [Character], from: Int, mark: Character, length: Int) -> Int? {
    guard length > 0 else { return nil }
    var index = from
    while index + length <= chars.count {
        if (0..<length).allSatisfy({ chars[index + $0] == mark }) { return index }
        index += 1
    }
    return nil
}

/// Everything that is NOT a code span or an equation: links, images, raw HTML
/// and emphasis, all of which are marks on a page with nothing to say.
private func spokenProse(_ run: String) -> String {
    var out = ""
    let chars = Array(run)
    var index = 0
    while index < chars.count {
        let ch = chars[index]

        // An escape means the author wanted the character, not the mark.
        if ch == "\\", index + 1 < chars.count {
            out.append(chars[index + 1])
            index += 2
            continue
        }

        // `![alt](url)` — the alt text is the only part written for a person.
        if ch == "!", index + 1 < chars.count, chars[index + 1] == "[",
           let link = bracketed(chars, from: index + 1) {
            out += link.label.isEmpty ? "an image" : link.label
            index = link.next
            continue
        }

        // `[label](url)`, `[label][ref]`, `[label]` — the label, never the URL.
        if ch == "[", let link = bracketed(chars, from: index) {
            out += link.label
            index = link.next
            continue
        }

        // An autolink says nothing but "there is a link here"; a raw tag says
        // nothing at all.
        if ch == "<", let close = chars[index...].firstIndex(of: ">") {
            let inner = String(chars[(index + 1)..<close])
            if inner.hasPrefix("http") || inner.hasPrefix("mailto:") { out += "a link" }
            index = close + 1
            continue
        }

        // Emphasis and strikethrough are tone, and the voice cannot wear them.
        if ch == "*" || ch == "~" {
            index += 1
            continue
        }
        // AN UNDERSCORE INSIDE A WORD IS PART OF THE WORD. `snake_case` written
        // as prose keeps its underscores; `_emphasis_` loses them.
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

/// `[label]`, plus the `(url)` or `[ref]` that may follow it. Nil when the
/// bracket never closes, in which case it is an ordinary character.
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
