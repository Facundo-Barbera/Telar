import Foundation

/// The new-session draft's derivations, pure and testable.
enum SessionDraft {
    /// The session's title: the explicit one when given, otherwise the
    /// message's first 80 characters with runs of whitespace collapsed —
    /// the exact rule the Mac's fresh canvas applies
    /// (session-cockpit.tsx: `text.replace(/\s+/g, " ").slice(0, 80)`).
    static func title(explicit: String, prompt: String) -> String {
        let chosen = explicit.trimmingCharacters(in: .whitespacesAndNewlines)
        if !chosen.isEmpty { return String(chosen.prefix(80)) }
        let collapsed = prompt
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return String(collapsed.prefix(80))
    }
}
