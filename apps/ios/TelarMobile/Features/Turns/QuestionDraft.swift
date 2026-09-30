import Foundation

struct QuestionPage: Equatable {
    let key: String
    let question: String
    let header: String?
    let choices: [String]
    let descriptions: [String: String]
    let multiple: Bool
}

/// One question per page; `nil` when a field needs the plain form (a secret or a toggle).
struct QuestionDraft: Equatable {
    let pages: [QuestionPage]
    private(set) var index = 0
    private var selected: [String: [String]] = [:]
    private var custom: [String: String] = [:]

    init?(fields: [UserInputField]) {
        guard !fields.isEmpty, fields.allSatisfy({ $0.kind == "choice" || $0.kind == "text" }) else { return nil }
        pages = fields.map { field in
            QuestionPage(
                key: field.key,
                question: field.label,
                header: field.header,
                choices: field.choices ?? [],
                descriptions: field.descriptions ?? [:],
                multiple: field.isMultiSelect
            )
        }
    }

    var page: QuestionPage { pages[index] }
    var isLast: Bool { index >= pages.count - 1 }
    var canAdvance: Bool { answer(for: page) != nil }

    func isSelected(_ choice: String) -> Bool {
        (selected[page.key] ?? []).contains(choice)
    }

    var customText: String { custom[page.key] ?? "" }

    mutating func toggle(_ choice: String) {
        let chosen = selected[page.key] ?? []
        let already = chosen.contains(choice)
        if page.multiple {
            selected[page.key] = already ? chosen.filter { $0 != choice } : chosen + [choice]
        } else {
            selected[page.key] = already ? [] : [choice]
        }
        custom[page.key] = ""
    }

    mutating func setCustom(_ text: String) {
        custom[page.key] = text
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { selected[page.key] = [] }
    }

    mutating func advance() {
        if canAdvance && !isLast { index += 1 }
    }

    mutating func back() {
        index = max(0, index - 1)
    }

    func answer(for page: QuestionPage) -> AnswerValue? {
        let typed = (custom[page.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { return page.multiple ? .list([typed]) : .text(typed) }
        let chosen = selected[page.key] ?? []
        guard let first = chosen.first else { return nil }
        return page.multiple ? .list(page.choices.filter(chosen.contains)) : .text(first)
    }

    /// Every page's answer keyed by field, or `nil` while one is unanswered.
    var answers: [String: AnswerValue]? {
        var all: [String: AnswerValue] = [:]
        for page in pages {
            guard let answer = answer(for: page) else { return nil }
            all[page.key] = answer
        }
        return all
    }
}
