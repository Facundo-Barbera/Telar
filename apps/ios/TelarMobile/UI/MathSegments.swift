import Foundation

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

            markdown += line + "\n"
            index += 1
            continue
        }

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

        inlineCodeOpen = trackInlineCode(line, open: inlineCodeOpen)
        markdown += line + "\n"
        index += 1
    }
    flushMarkdown()
    return segments
}

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
