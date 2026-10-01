import Foundation
import UniformTypeIdentifiers

struct ComposerFile: Equatable, Identifiable {
    var data: Data
    var name: String
    var mediaType: String
    var id: String { "\(name):\(data.count)" }
}

enum ComposerIntake {
    static let byteCap = 20 * 1024 * 1024

    static let previewCap = 8 * 1024 * 1024

    static let accepted: [UTType] = [.image, .pdf, .movie, .audio, .text, .fileURL, .data]

    static func best(of identifiers: [String]) -> UTType? {
        let types = identifiers.compactMap { UTType($0) }
        return types.first { $0.conforms(to: .image) && $0 != .fileURL }
            ?? types.first { $0.conforms(to: .pdf) }
            ?? types.first { $0.conforms(to: .data) && $0 != .fileURL && $0 != .url && $0 != .text }
            ?? types.first { $0.conforms(to: .text) }
            ?? types.first
    }

    static func isAttachment(_ identifiers: [String]) -> Bool {
        guard let type = best(of: identifiers) else { return false }
        if type.conforms(to: .fileURL) { return true }
        return !type.conforms(to: .text) && !type.conforms(to: .url)
    }

    static func hasAttachment(in itemTypes: [[String]]) -> Bool {
        itemTypes.contains { isAttachment($0) }
    }

    static func mediaType(for type: UTType?) -> String {
        guard let type else { return "application/octet-stream" }
        if let mime = type.preferredMIMEType { return mime }
        if type.conforms(to: .image) { return "image/png" }
        if type.conforms(to: .text) { return "text/plain" }
        return "application/octet-stream"
    }

    static func fileName(_ suggested: String?, type: UTType?, fallback: String = "pasted") -> String {
        let trimmed = suggested?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            guard (trimmed as NSString).pathExtension.isEmpty,
                  let ext = type?.preferredFilenameExtension else { return trimmed }
            return trimmed + "." + ext
        }
        return fallback + "." + (type?.preferredFilenameExtension ?? "dat")
    }

    static func take(_ data: Data, name: String?, type: UTType?, fallback: String = "pasted") -> ComposerIntakeResult {
        let named = fileName(name, type: type, fallback: fallback)
        guard !data.isEmpty else { return .refused("\(named) came through empty.") }
        guard data.count <= byteCap else {
            return .refused("\(named) is \(humanBytes(data.count)) — attachments stop at \(humanBytes(byteCap)).")
        }
        return .file(ComposerFile(data: data, name: named, mediaType: mediaType(for: type)))
    }

    static func take(fileAt url: URL) -> ComposerIntakeResult {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        let type = UTType(filenameExtension: url.pathExtension) ?? .data
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > byteCap {
            return .refused("\(name) is \(humanBytes(size)) — attachments stop at \(humanBytes(byteCap)).")
        }
        guard let data = try? Data(contentsOf: url) else { return .refused("\(name) could not be read.") }
        return take(data, name: name, type: type)
    }
}

enum ComposerIntakeResult: Equatable {
    case file(ComposerFile)
    case refused(String)

    var file: ComposerFile? { if case .file(let file) = self { return file } else { return nil } }
    var refusal: String? { if case .refused(let why) = self { return why } else { return nil } }
}

@MainActor
extension NSItemProvider {
    func composerFile() async -> ComposerIntakeResult? {
        guard let type = ComposerIntake.best(of: registeredTypeIdentifiers) else { return nil }
        let named = suggestedName
        let data: Data? = await withCheckedContinuation { continuation in
            _ = loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                continuation.resume(returning: data)
            }
        }
        guard let data else {
            return .refused("\(ComposerIntake.fileName(named, type: type)) could not be read.")
        }
        return ComposerIntake.take(data, name: named, type: type)
    }
}

@MainActor
func composerFiles(from providers: [NSItemProvider]) async -> (files: [ComposerFile], refusals: [String]) {
    var files: [ComposerFile] = []
    var refusals: [String] = []
    for provider in providers {
        switch await provider.composerFile() {
        case .file(let file)?: files.append(file)
        case .refused(let why)?: refusals.append(why)
        case nil: continue
        }
    }
    return (files, refusals)
}
