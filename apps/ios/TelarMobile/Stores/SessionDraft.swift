import Foundation

/// The draft's derivations, pure and testable.
enum SessionDraft {
    /// WORDS OR A PICTURE — either is a message. A screenshot on its own is
    /// something to send; any other file alone is not, and neither is an empty
    /// box. The engine's own rule (`turnHasContent`), so the arrow is never
    /// offered on a message the engine would refuse.
    static func canSend(text: String, mediaTypes: [String]) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || mediaTypes.contains { $0.hasPrefix("image/") }
    }

    /// The session's title: the explicit one when given, otherwise the
    /// message's first 80 characters with runs of whitespace collapsed —
    /// the exact rule the Mac's fresh canvas applies
    /// (`seedSessionTitle` in @telar/engine-client). An image-only message
    /// names its picture — "N images" for several — rather than going blank.
    static func title(explicit: String, prompt: String, imageNames: [String] = []) -> String {
        let chosen = explicit.trimmingCharacters(in: .whitespacesAndNewlines)
        if !chosen.isEmpty { return String(chosen.prefix(80)) }
        let collapsed = prompt
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if !collapsed.isEmpty { return String(collapsed.prefix(80)) }
        if imageNames.count == 1 { return String(imageNames[0].prefix(80)) }
        return imageNames.count > 1 ? "\(imageNames.count) images" : ""
    }
}
