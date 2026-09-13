import SwiftUI
import PDFKit

/// The open file, by kind: a notebook as cells, a table as a grid, a PDF as
/// pages, an image as itself, prose in an editor, anything else as
/// monospaced text with line numbers.
struct FileBody: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let file: OpenFile
    let active: Bool
    /// The checkout's absolute path, when the listing has landed — what turns
    /// a repo-relative path into the one "Copy path" writes.
    var root: String?
    let onSaveState: (FilesSurface.SaveState?) -> Void

    var body: some View {
        switch FileKind.of(file.path, view: file.view) {
        case .notebook:
            NotebookSurface(api: api, sessionId: sessionId, hostId: hostId, path: file.path, active: active)
        case .notebookReadOnly:
            ReadOnlyNotebookView(api: api, sessionId: sessionId, hostId: hostId, path: file.path, active: active)
        case .table:
            TableSurface(api: api, sessionId: sessionId, path: file.path, active: active)
        case .pdf:
            PDFFileView(api: api, sessionId: sessionId, path: file.path, active: active)
        case .image:
            ImageFileView(api: api, sessionId: sessionId, path: file.path, active: active)
        case .prose:
            TextFileView(api: api, sessionId: sessionId, hostId: hostId, path: file.path, active: active, editable: true, root: root, onSaveState: onSaveState)
        case .code, .binary:
            TextFileView(api: api, sessionId: sessionId, hostId: hostId, path: file.path, active: active, editable: false, root: root, onSaveState: onSaveState)
        }
    }
}

/// The address row every file body wears: the path, and what it is.
struct FileAddressRow: View {
    let path: String
    var detail: String?
    var trailing: AnyView?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: fileGlyph(path)).font(.system(size: 11)).foregroundStyle(Theme.textMuted)
            Text(path)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.textMuted2)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 4)
            if let detail {
                Text(detail).font(.system(size: 10)).foregroundStyle(Theme.textTertiary)
            }
            if let trailing { trailing }
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(Theme.sheet)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.borderSubtle) }
    }
}

/// The absolute path of a file in the checkout — the web's
/// `workspaceFilePath`, join rule for join rule. Nil when the listing has not
/// landed yet, which is what HIDES "Copy path" rather than copying a relative
/// path under an absolute label.
func workspaceFilePath(_ root: String?, _ relative: String) -> String? {
    guard let root, !root.isEmpty, !relative.isEmpty else { return nil }
    var base = root
    while base.hasSuffix("/") { base.removeLast() }
    var tail = relative
    while tail.hasPrefix("/") { tail.removeFirst() }
    guard !base.isEmpty, !tail.isEmpty else { return nil }
    return base + "/" + tail
}

func humanBytes(_ bytes: Int) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
    if bytes < 1024 * 1024 * 1024 { return String(format: "%.1f MB", Double(bytes) / 1024 / 1024) }
    return String(format: "%.2f GB", Double(bytes) / 1024 / 1024 / 1024)
}

// MARK: - images

struct ImageFileView: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let path: String
    let active: Bool

    @State private var image: UIImage?
    @State private var bytes: Int?
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            FileAddressRow(path: path, detail: bytes.map(humanBytes))
            if let image {
                ScrollView([.vertical, .horizontal]) {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity)
                }
            } else if let error {
                ContentUnavailableView("Could not read this file", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(path):\(active)") {
            do {
                let raw = try await api.sessionFileRaw(sessionId, path: path)
                bytes = raw.data.count
                image = UIImage(data: raw.data)
                if image == nil { error = "The bytes are not an image this device can decode." }
            } catch {
                self.error = describe(error)
            }
        }
    }
}

// MARK: - PDF

/// PDFKit over the raw route. RELOADED WHEN THE HASH CHANGES, never
/// navigated in place: a recompiled PDF must not keep a stale scroll
/// position, and the metadata read comes first so a missing file is an
/// error row rather than a blank page.
struct PDFFileView: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let path: String
    let active: Bool

    @State private var meta: WorkspaceFile?
    @State private var document: PDFDocument?
    @State private var loadedSha: String?
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            FileAddressRow(path: path, detail: meta.map { humanBytes($0.bytes) }, trailing: AnyView(
                Button { Task { await load(force: true) } } label: {
                    Image(systemName: "arrow.clockwise").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Reload PDF")
            ))
            if let document {
                PDFKitView(document: document).id(loadedSha ?? "")
            } else if let error {
                ContentUnavailableView("Could not read this file", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(path):\(active)") { await load(force: false) }
    }

    private func load(force: Bool) async {
        do {
            let fresh = try await api.sessionFile(sessionId, path: path)
            meta = fresh
            guard force || fresh.sha256 != loadedSha else { return }
            let raw = try await api.sessionFileRaw(sessionId, path: path)
            guard let doc = PDFDocument(data: raw.data) else {
                error = "The bytes are not a PDF this device can open."
                return
            }
            document = doc
            loadedSha = fresh.sha256
            error = nil
        } catch {
            self.error = describe(error)
        }
    }
}

private struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = UIColor.systemGroupedBackground
        view.document = document
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
    }
}
