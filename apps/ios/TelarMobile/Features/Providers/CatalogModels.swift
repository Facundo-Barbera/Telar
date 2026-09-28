import Foundation

struct ProviderModel: Decodable, Identifiable, Equatable {
    var id: String
    var label: String
    var description: String?
    var isDefault: Bool
    var hidden: Bool
    var efforts: [String]
    var defaultEffort: String?

    var resolves: String?
    var fastMode: Bool

    var defaultWindow: Bool?

    var contextWindow: Int?

    var legacy: Bool?

    var serviceTiers: [ServiceTier]?

    var defaultServiceTier: String?
}

struct ServiceTier: Decodable, Identifiable, Equatable, Hashable {
    var id: String
    var name: String
    var description: String?
}

struct ModelCatalogue: Decodable {
    var driver: String
    var models: [ProviderModel]

    var source: String
    var message: String?
}

struct ProviderInstance: Decodable, Identifiable, Equatable {
    var id: String
    var driver: String
    var enabled: Bool
}

struct TurnAttachment: Decodable, Identifiable, Equatable {
    var id: EngineID
    var name: String
    var mediaType: String
    var bytes: Int
    var tags: [String]?

    var producer: String?
    var createdAt: Timestamp?

    var isPinned: Bool { tags?.contains("pinned") == true }
}

struct GitFileChange: Decodable, Identifiable, Equatable, Hashable {
    var path: String

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

    var id: String { sha }
}

struct SessionDiff: Decodable {
    var repository: Bool
    var workspacePath: String
    var branch: String?

    var base: String?

    var baseUnverified: String?
    var behind: Int?
    var files: [GitFileChange]

    var filesIncomplete: String?
    var commits: [GitCommitEntry]

    var commitsIncomplete: String?
    var linesAdded: Int
    var linesRemoved: Int
    var truncated: Bool
}

struct FilePatch: Decodable {
    var patch: String
    var binary: Bool

    var incomplete: String?
}

struct GitRefEntry: Decodable, Identifiable, Equatable {
    var name: String

    var kind: String

    var head: Bool?

    var id: String { name }
}

struct GitOverview: Decodable {
    var repository: Bool
    var branch: String?

    var refs: [GitRefEntry]?

    var defaultBase: String?
}

struct DirectoryEntry: Decodable, Identifiable, Equatable, Hashable {
    var name: String
    var path: String

    var git: Bool

    var id: String { path }
}

struct DirectoryListing: Decodable {
    var path: String
    var name: String
    var home: String
    var dirs: [DirectoryEntry]
}
