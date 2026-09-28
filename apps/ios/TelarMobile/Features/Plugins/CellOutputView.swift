import SwiftUI

struct CellOutputView: View {
    let output: CellOutput
    let api: any PanelAPI
    let sessionId: EngineID
    var onOpenImage: ((EngineID) -> Void)?

    var body: some View {
        switch output {
        case .text(let stream, let text, let truncated):
            ClampedLines(text: text + (truncated ? " … truncated" : ""))
                .foregroundStyle(stream == "stderr" ? Theme.statusAmber : stream == "result" ? Theme.text : Theme.text.opacity(0.8))
                .frame(maxWidth: .infinity, alignment: .leading)
        case .error(let error):
            VStack(alignment: .leading, spacing: 4) {
                Text("\(error.ename): \(error.evalue)").font(.system(Theme.caption, design: .monospaced, weight: .semibold)).foregroundStyle(Theme.statusRed)
                if !error.traceback.isEmpty {
                    ClampedLines(text: error.traceback.map(stripAnsi).joined(separator: "\n"))
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
            Text("[\(kind)]").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
        }
    }
}

struct ClampedLines: View {
    let text: String

    static let limit = 12

    @State private var expanded = false

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let hidden = max(0, lines.count - Self.limit)
        VStack(alignment: .leading, spacing: 2) {
            Text(expanded || hidden == 0 ? text : lines.prefix(Self.limit).joined(separator: "\n"))
                .font(.system(Theme.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hidden > 0 {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                } label: {
                    Text(expanded ? "Show less" : "\(hidden) more line\(hidden == 1 ? "" : "s")")
                        .font(.system(Theme.caption, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .frame(minHeight: 28)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

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
                Text("[image]").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
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

    @ScaledMetric(relativeTo: .caption) private var columnWidth: CGFloat = 108
    @ScaledMetric(relativeTo: .caption) private var headerHeight: CGFloat = 34
    @ScaledMetric(relativeTo: .caption) private var rowHeight: CGFloat = 24

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    headerRow
                    ForEach(Array(rows.prefix(50).enumerated()), id: \.offset) { r, row in
                        dataRow(row, index: r)
                    }
                }
            }
            .background(Theme.codeBackground, in: RoundedRectangle(cornerRadius: 6))
            Text("\(shape.first ?? rows.count) × \(shape.last ?? columns.count)\(truncated ? " · preview" : "")")
                .font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
        }
    }

    private var headerRow: some View {
        HStack(spacing: 0) {
            ForEach(Array(columns.enumerated()), id: \.offset) { i, column in
                VStack(alignment: .leading, spacing: 0) {
                    Text(column).font(.system(Theme.caption, weight: .semibold)).lineLimit(1)
                    if let dtype = dtypes[safe: i] { Text(dtype).font(.system(Theme.captionTiny)).foregroundStyle(Theme.textMuted) }
                }
                .padding(.horizontal, 6).frame(width: columnWidth, height: headerHeight, alignment: .leading)
            }
        }
        .background(Theme.subtle)
    }

    private func dataRow(_ row: [JSONValue], index: Int) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                Text(cellString(cell))
                    .font(.system(Theme.caption, design: .monospaced))
                    .foregroundStyle(cell == .null ? Theme.textMuted : Theme.text)
                    .lineLimit(1)
                    .padding(.horizontal, 6).frame(width: columnWidth, height: rowHeight, alignment: .leading)
            }
        }
        .background(index % 2 == 0 ? Color.clear : Theme.subtle.opacity(0.4))
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
