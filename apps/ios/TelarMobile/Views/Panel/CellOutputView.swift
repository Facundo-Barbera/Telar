import SwiftUI

/// One cell output, one arm per kind — the desktop's `CellOutputView`. An
/// image comes as attachment bytes or inline base64; HTML shows its source
/// (no web view on the phone in this pass); an unknown kind names itself.
struct CellOutputView: View {
    let output: CellOutput
    let api: any PanelAPI
    let sessionId: EngineID
    var onOpenImage: ((EngineID) -> Void)?

    var body: some View {
        switch output {
        case .text(let stream, let text, let truncated):
            ClampedLines(text: text + (truncated ? " … truncated" : ""), size: 11)
                .foregroundStyle(stream == "stderr" ? Theme.statusAmber : stream == "result" ? Theme.text : Theme.text.opacity(0.8))
                .frame(maxWidth: .infinity, alignment: .leading)
        case .error(let error):
            VStack(alignment: .leading, spacing: 4) {
                Text("\(error.ename): \(error.evalue)").font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.statusRed)
                if !error.traceback.isEmpty {
                    ClampedLines(text: error.traceback.map(stripAnsi).joined(separator: "\n"), size: 10)
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.statusRed.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        case .image(_, let dataB64, let attachmentId, _, _):
            OutputImage(api: api, sessionId: sessionId, attachmentId: attachmentId, dataB64: dataB64, onOpen: onOpenImage)
        case .dataframe(let columns, let dtypes, let rows, let shape, let truncated):
            DataframeGrid(columns: columns, dtypes: dtypes, rows: rows, shape: shape, truncated: truncated)
        case .html(let html, let truncated):
            // THE FAST PATH FIRST. A pandas repr is the most common HTML a
            // notebook produces, and a native grid is selectable, cheap, and
            // identical to the `dataframe` kind the engine emits for runs it
            // made itself — without it the same table looks like two different
            // things depending on who ran the cell.
            if let table = parsePandasHtmlTable(html) {
                DataframeGrid(
                    columns: table.columns,
                    dtypes: [],
                    rows: table.rows.map { $0.map { JSONValue.string($0) } },
                    shape: [table.rows.count, max(0, table.columnCount - 1)],
                    truncated: truncated ?? false
                )
            } else {
                HtmlOutputView(html: html, truncated: truncated ?? false)
            }
        case .json(let value):
            CodeBlockView(code: value.prettyPrinted)
        case .clear:
            EmptyView()
        case .unknown(let kind):
            Text("[\(kind)]").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
        }
    }
}

/// LONG OUTPUT IS CLAMPED, NOT HIDDEN. A cell that printed a thousand lines
/// used to push every cell after it off the screen, and the only remedy was a
/// "Hide outputs" item buried in an ellipsis menu — all or nothing, per cell,
/// out of sight. Twelve lines is enough to see what happened; the rest is one
/// tap away and says how much it is holding.
struct ClampedLines: View {
    let text: String
    var size: CGFloat = 11
    /// JupyterLab clamps around this too. Enough for a traceback's head and a
    /// dataframe's first rows.
    static let limit = 12

    @State private var expanded = false

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let hidden = max(0, lines.count - Self.limit)
        VStack(alignment: .leading, spacing: 2) {
            Text(expanded || hidden == 0 ? text : lines.prefix(Self.limit).joined(separator: "\n"))
                .font(.system(size: size, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hidden > 0 {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                } label: {
                    Text(expanded ? "Show less" : "\(hidden) more line\(hidden == 1 ? "" : "s")")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .frame(minHeight: 28)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// ANSI colour codes IPython puts in tracebacks.
func stripAnsi(_ text: String) -> String {
    text.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
}

private struct OutputImage: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let attachmentId: EngineID?
    let dataB64: String?
    let onOpen: ((EngineID) -> Void)?

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 320)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onTapGesture { if let attachmentId { onOpen?(attachmentId) } }
            } else if attachmentId != nil || dataB64 != nil {
                ProgressView().frame(height: 60)
            } else {
                Text("[image]").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
            }
        }
        .task(id: attachmentId ?? dataB64?.prefix(32).description ?? "") {
            if let dataB64, let data = Data(base64Encoded: dataB64) {
                image = UIImage(data: data)
            } else if let attachmentId {
                image = await AttachmentImageCache.shared.image(host: nil, session: sessionId, attachmentId: attachmentId, api: api)
            }
        }
    }
}

private struct DataframeGrid: View {
    let columns: [String]
    let dtypes: [String]
    let rows: [[JSONValue]]
    let shape: [Int]
    let truncated: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 0) {
                        ForEach(Array(columns.enumerated()), id: \.offset) { i, column in
                            VStack(alignment: .leading, spacing: 0) {
                                Text(column).font(.system(size: 10, weight: .semibold)).lineLimit(1)
                                if let dtype = dtypes[safe: i] { Text(dtype).font(.system(size: 8)).foregroundStyle(Theme.textMuted) }
                            }
                            .padding(.horizontal, 6).frame(width: 96, height: 30, alignment: .leading)
                        }
                    }
                    .background(Theme.subtle)
                    ForEach(Array(rows.prefix(50).enumerated()), id: \.offset) { r, row in
                        HStack(spacing: 0) {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(cellString(cell))
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(cell == .null ? Theme.textMuted : Theme.text)
                                    .lineLimit(1)
                                    .padding(.horizontal, 6).frame(width: 96, height: 22, alignment: .leading)
                            }
                        }
                        .background(r % 2 == 0 ? Color.clear : Theme.subtle.opacity(0.4))
                    }
                }
            }
            .background(Theme.codeBackground, in: RoundedRectangle(cornerRadius: 6))
            Text("\(shape.first ?? rows.count) × \(shape.last ?? columns.count)\(truncated ? " · preview" : "")")
                .font(.system(size: 10)).foregroundStyle(Theme.textMuted)
        }
    }

    private func cellString(_ cell: JSONValue) -> String {
        switch cell {
        case .null: "null"
        case .string(let s): s
        case .number(let n): n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): b ? "true" : "false"
        default: cell.prettyPrinted
        }
    }
}

/// Attachment bytes are immutable per id, so they are kept on disk beside
/// the snapshot cache and decoded once — the project-icon pattern.
@MainActor final class AttachmentImageCache {
    static let shared = AttachmentImageCache()
    private var images: [String: UIImage] = [:]
    private var failed: Set<String> = []
    private let root = SnapshotCache.default.root.appending(path: "attachments")

    func image(host: HostID?, session: EngineID, attachmentId: EngineID, api: any PanelAPI) async -> UIImage? {
        let key = "\(host?.uuidString ?? "local")/\(session)/\(attachmentId)"
        if let hit = images[key] { return hit }
        if failed.contains(key) { return nil }
        let safe = { (part: String) in part.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? part }
        let file = root.appending(path: safe(host?.uuidString ?? "local")).appending(path: safe(session)).appending(path: safe(attachmentId))
        if let data = try? Data(contentsOf: file), let image = UIImage(data: data) {
            images[key] = image
            return image
        }
        guard let raw = try? await api.attachmentBytes(session, attachmentId: attachmentId), let image = UIImage(data: raw.data) else {
            failed.insert(key)
            return nil
        }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? raw.data.write(to: file, options: .atomic)
        images[key] = image
        return image
    }
}
