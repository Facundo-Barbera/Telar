import Foundation

enum SessionDraft {
    static func canSend(text: String, mediaTypes: [String]) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || mediaTypes.contains { $0.hasPrefix("image/") }
    }

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
