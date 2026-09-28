import Foundation
import Observation

struct StashedImage: Codable, Equatable {
    var name: String
    var type: String
    var dataUrl: String
}

struct StashEntry: Codable, Equatable, Identifiable {
    var id: String
    var at: Timestamp
    var prompt: String
    var images: [StashedImage]

    var summary: String {
        if let line = prompt.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) {
            return line.count > 90 ? String(line.prefix(89)) + "…" : line
        }
        if !images.isEmpty { return images.count == 1 ? "1 image" : "\(images.count) images" }
        return "Empty"
    }
}

enum StashLimits {
    static let entries = 20
    static let entryChars = 1_200_000
    static let totalChars = 3_500_000
}

enum StashRules {
    static func push(_ current: [StashEntry], _ entry: StashEntry) -> [StashEntry] {
        Array(([entry] + current).prefix(StashLimits.entries))
    }

    static func drop(_ current: [StashEntry], _ id: String) -> [StashEntry] {
        current.filter { $0.id != id }
    }

    static func fit(_ entries: [StashEntry]) -> [StashEntry] {
        var kept = Array(entries.filter { weigh($0) <= StashLimits.entryChars }.prefix(StashLimits.entries))
        var total = kept.reduce(0) { $0 + weigh($1) }
        while kept.count > 1, total > StashLimits.totalChars {
            let evicted = kept.removeLast()
            total -= weigh(evicted)
        }
        return kept
    }

    static func take(_ current: [StashEntry], _ id: String, room: Int) -> (prompt: String, images: [StashedImage], left: Int, next: [StashEntry])? {
        guard let entry = current.first(where: { $0.id == id }) else { return nil }
        let images = Array(entry.images.prefix(max(0, room)))
        let rest = Array(entry.images.dropFirst(images.count))
        let next = rest.isEmpty
            ? drop(current, id)
            : current.map { $0.id == id ? StashEntry(id: $0.id, at: $0.at, prompt: "", images: rest) : $0 }
        return (entry.prompt, images, rest.count, next)
    }

    static func appendPrompt(_ draft: String, _ prompt: String) -> String {
        if prompt.isEmpty { return draft }
        let before = draft.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        return before.isEmpty ? prompt : before + "\n\n" + prompt
    }

    static func weigh(_ entry: StashEntry) -> Int {
        entry.prompt.count + entry.images.reduce(0) { $0 + $1.dataUrl.count }
    }
}

@MainActor @Observable final class PromptStash {
    static let shared = PromptStash()

    private(set) var entries: [StashEntry] = []
    private let defaults: UserDefaults
    private let key = "telar.promptStash.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: key), let rows = try? JSONDecoder().decode([StashEntry].self, from: data) {
            entries = rows
        }
    }

    @discardableResult
    func stash(_ entry: StashEntry) -> Bool {
        commit { StashRules.push($0, entry) }
    }

    func take(_ id: String, room: Int) -> (prompt: String, images: [StashedImage], left: Int)? {
        guard let taken = StashRules.take(entries, id, room: room) else { return nil }
        guard commit({ _ in taken.next }) else { return nil }
        return (taken.prompt, taken.images, taken.left)
    }

    func drop(_ id: String) {
        _ = commit { StashRules.drop($0, id) }
    }

    private func commit(_ mutate: ([StashEntry]) -> [StashEntry]) -> Bool {
        let next = StashRules.fit(mutate(entries))
        guard let data = try? JSONEncoder().encode(next) else { return false }
        defaults.set(data, forKey: key)
        entries = next
        return true
    }
}
