import Foundation

enum FolderPath {
    struct Invalid: Error, Equatable {
        let message: String
    }

    static func parse(_ raw: String) -> Result<String, Invalid> {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for quote in ["\"", "'"] where text.count >= 2 && text.hasPrefix(quote) && text.hasSuffix(quote) {
            text = String(text.dropFirst().dropLast())
        }
        if text.isEmpty { return .failure(Invalid(message: "Type or paste a folder path.")) }
        guard text.hasPrefix("/") || text == "~" || text.hasPrefix("~/") else {
            return .failure(Invalid(message: "A folder path has to start with / or ~."))
        }
        while text.count > 1 && text.hasSuffix("/") { text.removeLast() }
        return .success(text)
    }

    static func otherRoots(of listing: DirectoryListing) -> [DirectoryEntry] {
        (listing.roots ?? [])
            .filter { $0.path != listing.path }
            .map { DirectoryEntry(name: $0.name, path: $0.path, git: false) }
    }
}
