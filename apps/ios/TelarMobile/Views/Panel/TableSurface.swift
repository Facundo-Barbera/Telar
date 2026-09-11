import SwiftUI

/// A CSV, TSV or Parquet as a grid, WINDOWED the desktop's way: 200-row
/// pages aligned to page boundaries, fetched as the scroll reaches them, an
/// in-flight set so a page is never asked for twice, a sticky header, and a
/// tap on a column that cycles ascending → descending → none.
struct TableSurface: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let path: String
    let active: Bool

    static let page = 200
    static let rowHeight: CGFloat = 24

    @State private var meta: TableWindow?
    @State private var rows: [Int: [JSONValue]] = [:]
    @State private var inflight: Set<Int> = []
    @State private var sort: (column: String, desc: Bool)?
    @State private var error: String?
    @State private var viewport: CGSize = .zero

    var body: some View {
        VStack(spacing: 0) {
            FileAddressRow(path: path, detail: meta.map { "\($0.total) rows × \($0.columns.count)\($0.truncated == true ? " · partial read" : "")" })
            if let meta {
                grid(meta)
            } else if let error {
                ContentUnavailableView("Could not read this table", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(path):\(active):\(sort?.column ?? ""):\(sort?.desc ?? false)") { await reset() }
    }

    private func grid(_ meta: TableWindow) -> some View {
        let widths = meta.columns.map { column -> CGFloat in
            max(80, min(260, CGFloat(column.count) * 8 + 24))
        }
        return ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    ForEach(0..<meta.total, id: \.self) { index in
                        row(index, widths: widths)
                            .onAppear { ensure(index) }
                    }
                } header: {
                    HStack(spacing: 0) {
                        ForEach(Array(meta.columns.enumerated()), id: \.offset) { i, column in
                            Button {
                                cycleSort(column)
                            } label: {
                                HStack(spacing: 3) {
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(column).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                                        if let dtype = meta.dtypes?[safe: i] {
                                            Text(dtype).font(.system(size: 9)).foregroundStyle(Theme.textTertiary)
                                        }
                                    }
                                    if sort?.column == column {
                                        Image(systemName: sort?.desc == true ? "chevron.down" : "chevron.up").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.accent)
                                    }
                                }
                                .padding(.horizontal, 8)
                                .frame(width: widths[i], height: 32, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .background(Theme.sheet)
                    .overlay(alignment: .bottom) { Divider().overlay(Theme.border) }
                }
            }
            // A TWO-AXIS ScrollView CENTRES content smaller than its viewport,
            // so a short table floated in the middle of the panel with its
            // header adrift. A MINIMUM of the viewport pins the grid to the
            // top left; a longer table still grows past it and scrolls.
            .frame(minWidth: viewport.width, minHeight: viewport.height, alignment: .topLeading)
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { viewport = $0 }
    }

    private func row(_ index: Int, widths: [CGFloat]) -> some View {
        HStack(spacing: 0) {
            if let cells = rows[index] {
                ForEach(Array(cells.enumerated()), id: \.offset) { i, cell in
                    cellText(cell)
                        .padding(.horizontal, 8)
                        .frame(width: widths[safe: i] ?? 100, height: Self.rowHeight, alignment: .leading)
                }
            } else {
                Text("…").font(.system(size: 11)).foregroundStyle(Theme.textTertiary).padding(.horizontal, 8).frame(height: Self.rowHeight)
            }
        }
        .background(index % 2 == 0 ? Color.clear : Theme.subtle.opacity(0.5))
    }

    private func cellText(_ cell: JSONValue) -> some View {
        let (label, tone): (String, Color) = switch cell {
        case .null: ("null", Theme.textTertiary)
        case .string(let s): (s.isEmpty ? "\"\"" : s, s.isEmpty ? Theme.textTertiary : Theme.text)
        case .number(let n): (n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n), Theme.text)
        case .bool(let b): (b ? "true" : "false", Theme.text)
        default: (cell.prettyPrinted, Theme.textMuted)
        }
        return Text(label)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(tone)
            .italic(cell == .null)
            .lineLimit(1)
    }

    // MARK: windowing

    private func reset() async {
        rows = [:]
        inflight = []
        meta = nil
        error = nil
        await fetch(offset: 0)
    }

    /// A row coming on screen asks for its page, aligned to the page size.
    private func ensure(_ index: Int) {
        let offset = (index / Self.page) * Self.page
        guard rows[offset] == nil, !inflight.contains(offset) else { return }
        Task { await fetch(offset: offset) }
    }

    private func fetch(offset: Int) async {
        guard !inflight.contains(offset) else { return }
        inflight.insert(offset)
        defer { inflight.remove(offset) }
        do {
            let window = try await api.sessionTable(sessionId, path: path, offset: offset, limit: Self.page, sort: sort?.column, desc: sort?.desc ?? false)
            if meta == nil { meta = window }
            for (i, cells) in window.rows.enumerated() { rows[window.offset + i] = cells }
        } catch {
            if meta == nil { self.error = describe(error) }
        }
    }

    private func cycleSort(_ column: String) {
        if sort?.column != column { sort = (column, false) }
        else if sort?.desc == false { sort = (column, true) }
        else { sort = nil }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
