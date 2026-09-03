import Foundation

/// Mirrors for the composer's controls and the review screen —
/// `packages/engine-client/src/protocol/common.ts` + `entities.ts`.

struct ProviderModel: Decodable, Identifiable, Equatable {
    var id: String
    var label: String
    var description: String?
    var isDefault: Bool
    var hidden: Bool
    var efforts: [String]
    var defaultEffort: String?
    /// What an alias means TODAY (`sonnet` → `claude-sonnet-5`) — used to
    /// match a stored wire id back to its row.
    var resolves: String?
    var fastMode: Bool
    /// This row is the model's default WINDOW — a fact to show beside it,
    /// never a choice made for you. Optional: absent on every row written
    /// before the model manifest existed.
    var defaultWindow: Bool?
}

struct ModelCatalogue: Decodable {
    var driver: String
    var models: [ProviderModel]
    /// "provider" is the installed harness's own answer; "builtin" is the
    /// cockpit guessing and says so.
    var source: String
    var message: String?
}

struct ProviderInstance: Decodable, Identifiable, Equatable {
    var id: String
    var driver: String
    var displayName: String?
    var enabled: Bool
}

/// A stored attachment — written before the message that refers to it.
struct TurnAttachment: Decodable, Identifiable, Equatable {
    var id: EngineID
    var name: String
    var mediaType: String
    var bytes: Int
}

// MARK: - the session's review

struct GitFileChange: Decodable, Identifiable, Equatable, Hashable {
    var path: String
    /// added | modified | deleted | renamed | untracked (open set on the wire).
    var status: String
    var renamedFrom: String?
    var linesAdded: Int?
    var linesRemoved: Int?
    var binary: Bool?

    var id: String { path }
}

struct GitCommitEntry: Decodable, Identifiable, Equatable {
    var sha: String
    var shortSha: String
    var subject: String
    var at: Timestamp
    var author: String

    var id: String { sha }
}

struct SessionDiff: Decodable {
    var repository: Bool
    var workspacePath: String
    var branch: String?
    /// Absent = no recorded base; the diff is against HEAD and committed work
    /// is NOT included — the surface must say so.
    var base: String?
    var ahead: Int?
    var behind: Int?
    var files: [GitFileChange]
    var commits: [GitCommitEntry]
    var linesAdded: Int
    var linesRemoved: Int
    var truncated: Bool
}

struct FilePatch: Decodable {
    var patch: String
    var binary: Bool
}

// MARK: - the base-ref picker (`/api/projects/:id/git`)

struct GitRefEntry: Decodable, Identifiable, Equatable {
    var name: String
    /// local | remote
    var kind: String
    /// The checkout's current branch — the picker marks it. Local only.
    var head: Bool?

    var id: String { name }
}

struct GitOverview: Decodable {
    var repository: Bool
    var branch: String?
    /// Newest commit first, capped — the base-ref picker's menu. Absent
    /// (never empty) on a non-repository.
    var refs: [GitRefEntry]?
    /// What a fresh worktree is cut from unless the person picks otherwise.
    var defaultBase: String?
}

// MARK: - the Mac's folders (`/api/fs`)

struct DirectoryEntry: Decodable, Identifiable, Equatable, Hashable {
    var name: String
    var path: String
    /// Has a `.git` — a repository, which is what a project root usually is.
    var git: Bool

    var id: String { path }
}

struct DirectoryListing: Decodable {
    var path: String
    var name: String
    var parent: String?
    var home: String
    var dirs: [DirectoryEntry]
}
