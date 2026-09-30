import Foundation

struct NewConversationDraft: Equatable {
    var target: NewConversationTarget?
    var envMode = "worktree"
    var baseRef: String?
    var branchName = ""

    mutating func retarget(_ next: NewConversationTarget) {
        if next.id != target?.id { baseRef = nil; branchName = "" }
        target = next
    }

    mutating func setMode(_ mode: String) {
        envMode = mode
        if mode == "local" { baseRef = nil; branchName = "" }
    }

    var workspaceLabel: String {
        guard envMode == "worktree" else { return "Current checkout" }
        if !branchName.isEmpty { return "New worktree · \(branchName)" }
        if let baseRef { return "New worktree · \(Self.shortRef(baseRef))" }
        return "New worktree"
    }

    func input(driver: String, prompt: String, imageNames: [String]) -> NewSessionInput {
        let worktree = envMode == "worktree"
        return NewSessionInput(
            title: SessionDraft.title(prompt: prompt, imageNames: imageNames),
            driver: driver, envMode: envMode,
            baseRef: worktree ? baseRef : nil,
            branchName: worktree && !branchName.isEmpty ? branchName : nil
        )
    }

    static func shortRef(_ ref: String) -> String {
        ref.hasPrefix("origin/") ? String(ref.dropFirst("origin/".count)) : ref
    }
}

struct NewConversationMemory {
    var defaults: UserDefaults = .standard
    private let targetKey = "telar.newConversation.target"
    private let modeKey = "telar.newConversation.envMode"

    var lastTarget: String? { defaults.string(forKey: targetKey) }
    var lastMode: String { defaults.string(forKey: modeKey) ?? "worktree" }

    func remember(_ draft: NewConversationDraft) {
        defaults.set(draft.target?.id, forKey: targetKey)
        defaults.set(draft.envMode, forKey: modeKey)
    }
}
