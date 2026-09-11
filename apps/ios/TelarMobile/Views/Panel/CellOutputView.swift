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
            Text(text + (truncated ? " … truncated" : ""))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(stream == "stderr" ? Theme.statusAmber : stream == "result" ? Theme.text : Theme.text.opacity(0.8))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .error(let error):
            VStack(alignment: .leading, spacing: 4) {
                Text("\(error.ename): \(error.evalue)").font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.statusRed)
                if !error.traceback.isEmpty {
                    Text(error.traceback.map(stripAnsi).joined(separator: "\n"))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.textMuted)
                        .textSelection(.enabled)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.statusRed.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        case .image(_, let dataB64, let attachmentId, _, _):
            OutputImage(api: api, sessionId: sessionId, attachmentId: attachmentId, dataB64: dataB64, onOpen: onOpenImage)
        case .dataframe(let columns, let dtypes, let rows, let shape, let truncated):
            DataframeGrid(columns: columns, dtypes: dtypes, rows: rows, shape: shape, truncated: truncated)
        case .html(let html, _):
            CodeBlockView(code: html)
        case .json(let value):
            CodeBlockView(code: value.prettyPrinted)
        case .clear:
            EmptyView()
        case .unknown(let kind):
            Text("[\(kind)]").font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
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
                Text("[image]").font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
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
                                if let dtype = dtypes[safe: i] { Text(dtype).font(.system(size: 8)).foregroundStyle(Theme.textTertiary) }
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
                                    .foregroundStyle(cell == .null ? Theme.textTertiary : Theme.text)
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
                .font(.system(size: 10)).foregroundStyle(Theme.textTertiary)
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
