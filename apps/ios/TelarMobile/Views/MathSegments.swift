import Foundation

/// TeX in a conversation, cut out of the Markdown BEFORE the Markdown parser
/// sees it — the phone's half of what `apps/web/lib/markdown-math.ts` and
/// remark-math do together on the web.
///
/// THE WEB'S RULES, PORTED:
///   `$$…$$` across its own lines is a DISPLAY equation.
///   `$$…$$` opening and closing on one line is INLINE math — unless that
///   line is the whole paragraph, in which case it is promoted to display
///   (models write standalone equations on one line far more often than
///   they spread them over three).
///   Single `$…$` is NOT math: "$5 to $10" is money.
///   Nothing inside a ``` fence or a `code` span is math.
///
/// WHY A PRE-PASS AND NOT A PARSER PLUGIN: MarkdownUI has no extension point
/// for a new inline node. So the text is split into Markdown runs and math
/// runs first; each Markdown run is rendered by the library and each math
/// run by the TeX engine. The cost is that an inline `$$…$$` mid-sentence
/// breaks the paragraph into two Markdown views around the equation, which
/// is visible only as a line break — the honest limit of the approach, and
/// far better than pipes and backslashes on the screen.
enum MathSegment: Equatable {
    case markdown(String)
    case display(String)
    case inline(String)
}

func splitMath(_ text: String) -> [MathSegment] {
    var segments: [MathSegment] = []
    var markdown = ""
    var inFence = false
    var inlineCodeOpen = false

    func flushMarkdown() {
        let trimmed = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { segments.append(.markdown(markdown)) }
        markdown = ""
    }

    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var index = 0
    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        // A fence toggles; nothing inside is math.
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            inFence.toggle()
            markdown += line + "\n"
            index += 1
            continue
        }
        if inFence {
            markdown += line + "\n"
            index += 1
            continue
        }

        // A line that is exactly `$$` opens a multi-line display block.
        if trimmed == "$$" {
            var body: [String] = []
            var close = index + 1
            while close < lines.count, lines[close].trimmingCharacters(in: .whitespaces) != "$$" {
                body.append(lines[close])
                close += 1
            }
            if close < lines.count {
                flushMarkdown()
                segments.append(.display(body.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)))
                index = close + 1
                continue
            }
            // Unclosed: it is text.
            markdown += line + "\n"
            index += 1
            continue
        }

        // `$$…$$` on ONE line. The whole-paragraph case promotes to display;
        // otherwise the line is split around each equation.
        if line.contains("$$") {
            let pieces = splitInlineMath(line, codeOpen: &inlineCodeOpen)
            let onlyMath = pieces.count == 1 && { if case .inline = pieces[0] { return true } else { return false } }()
            let standalone = onlyMath
                && (index == 0 || lines[index - 1].trimmingCharacters(in: .whitespaces).isEmpty)
                && (index + 1 >= lines.count || lines[index + 1].trimmingCharacters(in: .whitespaces).isEmpty)
            if standalone, case .inline(let tex) = pieces[0] {
                flushMarkdown()
                segments.append(.display(tex))
            } else if pieces.contains(where: { if case .inline = $0 { return true } else { return false } }) {
                for piece in pieces {
                    switch piece {
                    case .markdown(let run): markdown += run
                    case .inline, .display:
                        flushMarkdown()
                        segments.append(piece)
                    }
                }
                markdown += "\n"
            } else {
                markdown += line + "\n"
            }
            index += 1
            continue
        }

        // Track backtick spans across lines so a `$$` inside one stays text.
        inlineCodeOpen = trackInlineCode(line, open: inlineCodeOpen)
        markdown += line + "\n"
        index += 1
    }
    flushMarkdown()
    return segments
}

/// One line, cut around every `$$…$$` pair that is not inside a backtick
/// span. An odd `$$` (no closer on the line) is left as text.
private func splitInlineMath(_ line: String, codeOpen: inout Bool) -> [MathSegment] {
    var pieces: [MathSegment] = []
    var run = ""
    var tex = ""
    var inMath = false
    var inCode = codeOpen
    var iterator = Array(line)
    var i = 0
    while i < iterator.count {
        let ch = iterator[i]
        if ch == "`" && !inMath {
            inCode.toggle()
            run.append(ch)
            i += 1
            continue
        }
        if !inCode, ch == "$", i + 1 < iterator.count, iterator[i + 1] == "$" {
            if inMath {
                pieces.append(.inline(tex.trimmingCharacters(in: .whitespaces)))
                tex = ""
                inMath = false
            } else {
                if !run.isEmpty { pieces.append(.markdown(run)) }
                run = ""
                inMath = true
            }
            i += 2
            continue
        }
        if inMath { tex.append(ch) } else { run.append(ch) }
        i += 1
    }
    if inMath {
        // Unclosed on this line: the `$$` was text after all.
        run += "$$" + tex
    }
    if !run.isEmpty { pieces.append(.markdown(run)) }
    codeOpen = inCode
    iterator.removeAll()
    return pieces
}

private func trackInlineCode(_ line: String, open: Bool) -> Bool {
    var state = open
    for ch in line where ch == "`" { state.toggle() }
    return state
}
