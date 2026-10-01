import Foundation

enum ComposerCommandAction: Equatable {
    case insert(String)
    case runtimeMode(String)
    case envMode(String)
    case driver(String)
    case stop
}

struct ComposerCompletion: Identifiable, Equatable {
    var id: String
    var label: String
    var detail: String
    var symbol: String
    var group: String
    var action: ComposerCommandAction
}

struct ComposerCommandContext: Equatable {
    var busy = false
    var fresh = false
    var runtimeMode: String?
    var driver: String?
    var envMode: String?
}

enum ComposerCompletions {
    static let commandsGroup = "Commands"
    static let providerGroup = "Provider commands"
    static let skillsGroup = "Skills"
    static let orchestrateSkill = "orchestrate"
    static let orchestratePrompt = "Use \(skillReference(orchestrateSkill)) to coordinate this list:"

    static func skillReference(_ name: String) -> String {
        "the \"\(name.replacingOccurrences(of: "\"", with: "'"))\" skill"
    }

    private static let access: [(slug: String, mode: String, detail: String)] = [
        ("supervised", "approval-required", "Ask before commands and file changes."),
        ("auto-edits", "auto-accept-edits", "Auto-approve edits, ask before other actions."),
        ("auto", "auto", "A reviewer approves routine actions; risky ones still ask."),
        ("full-access", "full-access", "Allow commands and edits without prompts."),
    ]

    static func available(_ context: ComposerCommandContext, orchestrate: Bool) -> [ComposerCompletion] {
        var rows = access.map { entry in
            command("access:\(entry.mode)", "/\(entry.slug)", current(entry.detail, context.runtimeMode == entry.mode), "slider.horizontal.3", .runtimeMode(entry.mode))
        }
        if context.fresh {
            for driver in ["claude", "codex"] {
                rows.append(command("driver:\(driver)", "/\(driver)", current("Start this session on this agent.", context.driver == driver), "cpu", .driver(driver)))
            }
            rows.append(command("env:local", "/local", current("Work directly in the project folder.", context.envMode == "local"), "folder", .envMode("local")))
            rows.append(command("env:worktree", "/worktree", current("Work in a cut-off checkout of its own.", context.envMode == "worktree"), "arrow.triangle.branch", .envMode("worktree")))
        }
        if orchestrate {
            rows.append(command("orchestrate", "/orchestrate", "Split a list of tasks across worker sessions and coordinate them.", "sparkles", .insert(orchestratePrompt)))
        }
        if context.busy {
            rows.append(command("stop", "/stop", "Stop the turn that is running.", "stop.fill", .stop))
        }
        return rows
    }

    static func list(for trigger: ComposerTrigger, context: ComposerCommandContext, skills: ProviderSkills) -> [ComposerCompletion] {
        let ranked = rankSkills(skills.skills, query: trigger.query)
        guard trigger.kind == .command else { return ranked }
        let own = available(context, orchestrate: skills.skills.contains { $0.name == orchestrateSkill })
        return rankCommands(own, query: trigger.query) + rankCommands(providerCommands(skills.commands), query: trigger.query) + ranked
    }

    static func providerCommands(_ commands: [ProviderSkill]) -> [ComposerCompletion] {
        commands.map { entry in
            ComposerCompletion(id: "provider:\(entry.name)", label: "/\(entry.name)", detail: detail(entry), symbol: "terminal", group: providerGroup, action: .insert("/\(entry.name)"))
        }
    }

    static func rankCommands(_ commands: [ComposerCompletion], query: String) -> [ComposerCompletion] {
        let normalized = normalize(query, dropping: "/")
        guard !normalized.isEmpty else { return commands }
        return rank(commands, limit: .max, tieBreaker: \.label) { row in
            best(
                score(String(row.label.drop { $0 == "/" }).lowercased(), normalized, exact: 0, prefix: 2, boundary: 6, includes: 12, fuzzy: 100, markers: ["-", " ", "_"]),
                score(row.detail.lowercased(), normalized, exact: 40, includes: 44)
            )
        }
    }

    static func rankSkills(_ skills: [ProviderSkill], query: String, limit: Int = 12) -> [ComposerCompletion] {
        let normalized = normalize(query, dropping: "$")
        let picked = normalized.isEmpty
            ? Array(skills.prefix(limit))
            : rank(skills, limit: limit, tieBreaker: \.name) { skill in
                best(
                    score(skill.name.lowercased(), normalized, exact: 0, prefix: 2, boundary: 6, includes: 12, fuzzy: 100, markers: [":", "-", "_", "."]),
                    score(skill.description.lowercased(), normalized, exact: 40, includes: 44)
                )
            }
        return picked.map { skill in
            ComposerCompletion(id: "skill:\(skill.name)", label: skill.name, detail: detail(skill), symbol: "sparkles", group: skillsGroup, action: .insert(skillReference(skill.name)))
        }
    }

    static func score(_ value: String, _ query: String, exact: Int, prefix: Int? = nil, boundary: Int? = nil, includes: Int? = nil, fuzzy: Int? = nil, markers: [String] = [" ", "-", "_", "/"]) -> Int? {
        guard !value.isEmpty, !query.isEmpty else { return nil }
        if value == query { return exact }
        let penalty = min(64, max(0, value.count - query.count))
        if let prefix, value.hasPrefix(query) { return prefix + penalty }
        if let boundary {
            let hits = markers.compactMap { marker in offset(of: marker + query, in: value).map { $0 + marker.count } }
            if let first = hits.min() { return boundary + first * 2 + penalty }
        }
        if let includes, let at = offset(of: query, in: value) { return includes + at * 2 + penalty }
        if let fuzzy, let subsequence = subsequence(value, query) { return fuzzy + subsequence }
        return nil
    }

    private static func subsequence(_ value: String, _ query: String) -> Int? {
        let chars = Array(value), wanted = Array(query)
        var next = 0, first = -1, previous = -1, gaps = 0
        for (index, char) in chars.enumerated() where char == wanted[next] {
            if first == -1 { first = index }
            if previous != -1 { gaps += index - previous - 1 }
            previous = index
            next += 1
            if next == wanted.count {
                return first * 2 + gaps * 3 + (index - first + 1 - wanted.count) + min(64, chars.count - wanted.count)
            }
        }
        return nil
    }

    private static func offset(of needle: String, in haystack: String) -> Int? {
        haystack.range(of: needle).map { haystack.distance(from: haystack.startIndex, to: $0.lowerBound) }
    }

    private static func rank<T>(_ items: [T], limit: Int, tieBreaker: KeyPath<T, String>, scored: (T) -> Int?) -> [T] {
        let kept = items.compactMap { item in scored(item).map { (item, $0) } }
        let sorted = kept.sorted { left, right in
            left.1 != right.1 ? left.1 < right.1 : left.0[keyPath: tieBreaker].localizedCompare(right.0[keyPath: tieBreaker]) == .orderedAscending
        }
        return sorted.prefix(limit).map(\.0)
    }

    private static func best(_ scores: Int?...) -> Int? { scores.compactMap { $0 }.min() }

    private static func normalize(_ query: String, dropping sigil: Character) -> String {
        String(query.trimmingCharacters(in: .whitespaces).drop { $0 == sigil }).lowercased()
    }

    private static func detail(_ entry: ProviderSkill) -> String {
        if !entry.description.isEmpty { return entry.description }
        switch entry.source {
        case "project": return "This project"
        case "user": return "This computer"
        case "plugin": return "Plugin"
        default: return "Provider"
        }
    }

    private static func current(_ detail: String, _ selected: Bool) -> String { selected ? "\(detail) (current)" : detail }

    private static func command(_ id: String, _ label: String, _ detail: String, _ symbol: String, _ action: ComposerCommandAction) -> ComposerCompletion {
        ComposerCompletion(id: id, label: label, detail: detail, symbol: symbol, group: commandsGroup, action: action)
    }
}
