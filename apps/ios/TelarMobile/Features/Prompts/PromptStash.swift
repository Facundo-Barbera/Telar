import Foundation
import Observation

/// THE STASH: prompts you set aside, shared by every composer on the phone —
/// the web's `prompt-stash.ts`, ported rule for rule.
///
/// NOT A DRAFT, and the distinction is the whole feature. A draft belongs to
/// ONE session, is written automatically as you type, and comes back when you
/// return there. A stash is global, explicit at both ends — a tap puts one in,
/// a pick takes one out — and POPPED on use. It solves what the clipboard
/// solves badly: you write a paragraph, realise it belongs in a different
/// conversation, and the clipboard holds exactly one of them.
///
/// SHARED WITH THE MAC BY SHAPE, NOT BY BYTES. The entries are the web's
/// `StashEntry` (id, at, prompt, images as data URLs), so a future sync would
/// be a transport question, not a format one. Today each device keeps its
/// own list in UserDefaults.
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

    /// The one line a row shows: the prompt's FIRST non-empty line, not its
    /// first eighty characters — a message opening with a blank line or a
    /// path on its own reads as an empty row otherwise.
    var summary: String {
        if let line = prompt.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) {
            return line.count > 90 ? String(line.prefix(89)) + "…" : line
        }
        if !images.isEmpty { return images.count == 1 ? "1 image" : "\(images.count) images" }
        return "Empty"
    }
}

/// A COUNT CAP THAT ONLY BINDS ON TEXT, and byte budgets that bind on
/// pictures: the same three numbers as the web, so a stash never grows past
/// what a browser would hold either.
enum StashLimits {
    static let entries = 20
    static let entryChars = 1_200_000
    static let totalChars = 3_500_000
}

/// Pure list rules, the web's `pushEntry` / `dropEntry` / `fitStash` /
/// `takeEntry` / `appendPrompt`, kept as free functions so a test reaches
/// them without a store.
enum StashRules {
    /// Newest first. The oldest falls off the end at the cap.
    static func push(_ current: [StashEntry], _ entry: StashEntry) -> [StashEntry] {
        Array(([entry] + current).prefix(StashLimits.entries))
    }

    static func drop(_ current: [StashEntry], _ id: String) -> [StashEntry] {
        current.filter { $0.id != id }
    }

    /// AN OVERSIZED ENTRY IS REFUSED BEFORE IT CAN EVICT ANYTHING: one
    /// four-megabyte screenshot must not walk twenty prompts off the end and
    /// then fail to fit anyway.
    static func fit(_ entries: [StashEntry]) -> [StashEntry] {
        var kept = Array(entries.filter { weigh($0) <= StashLimits.entryChars }.prefix(StashLimits.entries))
        var total = kept.reduce(0) { $0 + weigh($1) }
        while kept.count > 1, total > StashLimits.totalChars {
            let evicted = kept.removeLast()
            total -= weigh(evicted)
        }
        return kept
    }

    /// POP — with the amendment that stops it losing pictures: what the
    /// destination has no room for stays behind as an image-only remainder.
    static func take(_ current: [StashEntry], _ id: String, room: Int) -> (prompt: String, images: [StashedImage], left: Int, next: [StashEntry])? {
        guard let entry = current.first(where: { $0.id == id }) else { return nil }
        let images = Array(entry.images.prefix(max(0, room)))
        let rest = Array(entry.images.dropFirst(images.count))
        let next = rest.isEmpty
            ? drop(current, id)
            : current.map { $0.id == id ? StashEntry(id: $0.id, at: $0.at, prompt: "", images: rest) : $0 }
        return (entry.prompt, images, rest.count, next)
    }

    /// A RESTORE NEVER EATS WHAT IS ALREADY IN THE BOX: the stashed prompt
    /// lands after a blank line, and the half-sentence being typed survives.
    static func appendPrompt(_ draft: String, _ prompt: String) -> String {
        if prompt.isEmpty { return draft }
        let before = draft.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        return before.isEmpty ? prompt : before + "\n\n" + prompt
    }

    static func weigh(_ entry: StashEntry) -> Int {
        entry.prompt.count + entry.images.reduce(0) { $0 + $1.dataUrl.count }
    }
}

/// The store: READ, CHANGE, WRITE, never write from a view's copy. Two
/// composers can be up at once (a session and the new-conversation sheet)
/// and each sees this one list, so a stash from either lands for both.
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

    /// FALSE MEANS STORAGE REFUSED, and the caller must not clear the box: a
    /// stash treated as success and followed by clearing the draft destroys
    /// the paragraph.
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

    /// RETURNS WHETHER IT WROTE. Shedding for quota changes the list, so the
    /// view is repainted from what is on disk, not from the change that did
    /// not happen.
    private func commit(_ mutate: ([StashEntry]) -> [StashEntry]) -> Bool {
        let next = StashRules.fit(mutate(entries))
        guard let data = try? JSONEncoder().encode(next) else { return false }
        defaults.set(data, forKey: key)
        entries = next
        return true
    }
}
