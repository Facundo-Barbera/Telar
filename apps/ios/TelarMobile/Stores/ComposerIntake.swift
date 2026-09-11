import Foundation
import UniformTypeIdentifiers

/// One file on its way into a composer, named and typed.
struct ComposerFile: Equatable, Identifiable {
    var data: Data
    var name: String
    var mediaType: String
    var id: String { "\(name):\(data.count)" }

    var isImage: Bool { mediaType.hasPrefix("image/") }
}

/// WHAT A COMPOSER TAKES FROM A PASTE OR A DROP, and what it calls it.
///
/// The phone could only attach photos, through the picker. A screenshot on the
/// clipboard, a PDF dragged from Files, a log file dropped from another app —
/// all of it had to go through the Mac. The rules here are pure so they can be
/// tested without a pasteboard: the transport (an `NSItemProvider`) is loaded
/// separately and handed to `take`.
enum ComposerIntake {
    /// PER FILE. The engine takes an attachment in one request, and a phone on
    /// a hotel network uploading a 200MB video is a hang with no cancel. The
    /// cap is a refusal the person can read, not a stall.
    static let byteCap = 25 * 1024 * 1024

    /// Kept to draw the 72pt chip. A picture bigger than this is still
    /// attached; it just wears the document glyph rather than itself.
    static let previewCap = 8 * 1024 * 1024

    /// What a composer advertises to a drag and to the paste control. `.data`
    /// last: a provider registers its concrete type first, and that is the one
    /// worth loading.
    static let accepted: [UTType] = [.image, .pdf, .movie, .audio, .text, .fileURL, .data]

    /// The type worth loading out of everything a provider offers. A CONCRETE
    /// PAYLOAD BEATS A FILE URL: loading `public.png` gives the bytes, while
    /// loading `public.file-url` gives a path that may be in another app's
    /// sandbox and gone by the time the upload starts.
    static func best(of identifiers: [String]) -> UTType? {
        let types = identifiers.compactMap { UTType($0) }
        return types.first { $0.conforms(to: .image) && $0 != .fileURL }
            ?? types.first { $0.conforms(to: .pdf) }
            ?? types.first { $0.conforms(to: .data) && $0 != .fileURL && $0 != .url && $0 != .text }
            ?? types.first { $0.conforms(to: .text) }
            ?? types.first
    }

    /// The media type an attachment carries. The engine stores what it is told
    /// and the cockpit renders on it, so a wrong guess shows a picture as a
    /// download. `preferredMIMEType` is right whenever the system knows the
    /// type at all.
    static func mediaType(for type: UTType?) -> String {
        guard let type else { return "application/octet-stream" }
        if let mime = type.preferredMIMEType { return mime }
        if type.conforms(to: .image) { return "image/png" }
        if type.conforms(to: .text) { return "text/plain" }
        return "application/octet-stream"
    }

    /// A name with an extension, always: a clipboard image arrives with no
    /// name at all, and "pasted" alone tells the person nothing about what
    /// they are about to send.
    static func fileName(_ suggested: String?, type: UTType?, fallback: String = "pasted") -> String {
        let trimmed = suggested?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            guard (trimmed as NSString).pathExtension.isEmpty,
                  let ext = type?.preferredFilenameExtension else { return trimmed }
            return trimmed + "." + ext
        }
        return fallback + "." + (type?.preferredFilenameExtension ?? "dat")
    }

    /// The file, or the sentence saying why not. A refusal is SHOWN beside the
    /// composer; nothing is silently dropped, because a picture that simply
    /// never appears reads as the app being broken.
    static func take(_ data: Data, name: String?, type: UTType?, fallback: String = "pasted") -> ComposerIntakeResult {
        let named = fileName(name, type: type, fallback: fallback)
        guard !data.isEmpty else { return .refused("\(named) came through empty.") }
        guard data.count <= byteCap else {
            return .refused("\(named) is \(humanBytes(data.count)) — attachments stop at \(humanBytes(byteCap)).")
        }
        return .file(ComposerFile(data: data, name: named, mediaType: mediaType(for: type)))
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
    /// One dropped or pasted item, loaded and judged. `nil` when the item
    /// offers nothing the composer understands — a drag of plain text, say,
    /// which the text field itself will take.
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

/// Everything a paste or a drop handed over, in order, with the sentences for
/// whatever was turned away. The caller decides where each file goes: a live
/// session uploads it, a not-yet-created one holds it.
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
