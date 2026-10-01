import Foundation

enum ComposerLogSource: String {
    case user, commit, binding, dictation
}

struct ComposerLogEntry: Equatable {
    var source: ComposerLogSource
    var event = "edit"
    var location = 0
    var removed = 0
    var inserted = 0
    var length = 0
    var marked = false
    var audio = ""

    func line(at date: Date) -> String {
        let stamp = date.formatted(.iso8601.time(includingFractionalSeconds: true))
        return "\(stamp) \(source.rawValue) \(event) at=\(location) del=\(removed) ins=\(inserted) len=\(length) marked=\(marked ? 1 : 0) audio=\(audio)"
    }
}

@MainActor final class ComposerLog {
    static let shared = ComposerLog(defaults: .standard)
    static let cap = 400
    static var audio: () -> String = { "" }

    private let defaults: UserDefaults
    private let key = "telar.composer.log"
    private(set) var lines: [String]

    init(defaults: UserDefaults) {
        self.defaults = defaults
        lines = defaults.stringArray(forKey: key) ?? []
    }

    func record(_ entry: ComposerLogEntry, at date: Date = Date()) {
        var entry = entry
        if entry.audio.isEmpty { entry.audio = Self.audio() }
        lines.append(entry.line(at: date))
        if lines.count > Self.cap { lines.removeFirst(lines.count - Self.cap) }
        defaults.set(lines, forKey: key)
    }

    var exported: String { lines.joined(separator: "\n") }

    func clear() {
        lines = []
        defaults.removeObject(forKey: key)
    }
}
