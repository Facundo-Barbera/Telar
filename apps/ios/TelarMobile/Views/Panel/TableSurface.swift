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

    /// THE GRID IS THE UNIT (#674). Every figure a column's geometry is built
    /// from scales off `.caption`, the style the cells are drawn in, so the
    /// whole grid grows by one ratio and the columns stay square across a
    /// two-axis scroll. Scaling any of these alone would break the alignment
    /// the fixed sizes existed to hold.
    ///
    /// The seeds are nudged up on what was here — 32 → 34, 24 → 26, and a
    /// column's estimate from 8-per-character on 24 of padding to 9 on 26 —
    /// because the cells moved from an 11 and a 9 onto `.caption` (12) and
    /// `.caption2` (11). The clamp band keeps its 80 and 260 and scales with
    /// the rest. Same default-size widening `DataframeGrid` takes, same reason.
    @ScaledMetric(relativeTo: .caption) private var headerHeight: CGFloat = 34
    @ScaledMetric(relativeTo: .caption) private var rowHeight: CGFloat = 26
    @ScaledMetric(relativeTo: .caption) private var columnPerCharacter: CGFloat = 9
    @ScaledMetric(relativeTo: .caption) private var columnPadding: CGFloat = 26
    @ScaledMetric(relativeTo: .caption) private var columnMinimum: CGFloat = 80
    @ScaledMetric(relativeTo: .caption) private var columnMaximum: CGFloat = 260
    /// The fallback width for a cell with no column above it — scaled with the
    /// rest so a malformed row cannot pin one column to an absolute 100.
    @ScaledMetric(relativeTo: .caption) private var columnFallback: CGFloat = 100

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
            max(columnMinimum, min(columnMaximum, CGFloat(column.count) * columnPerCharacter + columnPadding))
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
                                        Text(column).font(.system(Theme.caption, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                                        if let dtype = meta.dtypes?[safe: i] {
                                            Text(dtype).font(.system(Theme.captionTiny)).foregroundStyle(Theme.textMuted)
                                        }
                                    }
                                    if sort?.column == column {
                                        Image(systemName: sort?.desc == true ? "chevron.down" : "chevron.up").font(.system(Theme.captionTiny, weight: .bold)).foregroundStyle(Theme.accent)
                                    }
                                }
                                .padding(.horizontal, 8)
                                .frame(width: widths[i], height: headerHeight, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .contextMenu { headerMenu(column) }
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

    /// The desktop's header menu: the same three sort states the tap cycles
    /// through, named rather than guessed at, plus the column's own name.
    /// Radio groups have no context-menu shape on iOS, so the state that is on
    /// wears the checkmark — the pattern the composer's menus already use.
    @ViewBuilder private func headerMenu(_ column: String) -> some View {
        Button { sort = (column, false) } label: {
            sortRow("Sort ascending", on: sort?.column == column && sort?.desc == false)
        }
        Button { sort = (column, true) } label: {
            sortRow("Sort descending", on: sort?.column == column && sort?.desc == true)
        }
        Button { sort = nil } label: {
            sortRow("Clear sort", on: sort?.column != column)
        }
        Divider()
        Button("Copy column name", systemImage: "doc.on.doc") { UIPasteboard.general.string = column }
    }

    @ViewBuilder private func sortRow(_ label: String, on: Bool) -> some View {
        if on { Label(label, systemImage: "checkmark") } else { Text(label) }
    }

    /// THIS GRID SCALES AS A UNIT (#674) — all five sites, not four. The `…`
    /// placeholder below is the fifth: its frame is height-only, so the sweep
    /// COULD have converted it on its own, and deliberately did not. A row
    /// that has not loaded yet scaling while the loaded rows beside it did not
    /// is a worse answer than either state on its own, and it stays the fifth
    /// member of this unit now for the same reason — it takes the same
    /// `rowHeight` and the same token as the cells it stands in for.
    private func row(_ index: Int, widths: [CGFloat]) -> some View {
        HStack(spacing: 0) {
            if let cells = rows[index] {
                ForEach(Array(cells.enumerated()), id: \.offset) { i, cell in
                    cellText(cell)
                        .padding(.horizontal, 8)
                        .frame(width: widths[safe: i] ?? columnFallback, height: rowHeight, alignment: .leading)
                        .contentShape(Rectangle())
                        // ONE CELL, AND THE ONE THING ANYBODY WANTS FROM IT. A
                        // cell is clipped to its column's width, so the value
                        // you can SEE is often not the value that is there —
                        // which is why this copies the whole string rather than
                        // the rendered text.
                        .contextMenu {
                            Button("Copy value", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = tableCellValue(cell)
                            }
                        }
                }
            } else {
                Text("…").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted).padding(.horizontal, 8).frame(height: rowHeight)
            }
        }
        .background(index % 2 == 0 ? Color.clear : Theme.subtle.opacity(0.5))
    }

    private func cellText(_ cell: JSONValue) -> some View {
        let tone: Color = switch cell {
        case .null: Theme.textMuted
        case .string(let s): s.isEmpty ? Theme.textMuted : Theme.text
        case .number, .bool: Theme.text
        default: Theme.textMuted
        }
        // AN EMPTY STRING IS DRAWN, NOT COPIED, as `""`: a blank cell is
        // indistinguishable from a missing one on screen, and two quote marks
        // on the clipboard are not what was in the column.
        let label: String = if case .string(let s) = cell, s.isEmpty { "\"\"" } else { tableCellValue(cell) }
        return Text(label)
            .font(.system(Theme.caption, design: .monospaced))
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

/// One cell as text — what the grid draws and what "Copy value" writes. A
/// whole number keeps its integer shape (`3`, not `3.0`), which is the one
/// place a grid of floats reads as data rather than as arithmetic.
func tableCellValue(_ cell: JSONValue) -> String {
    switch cell {
    case .null: "null"
    case .string(let s): s
    case .number(let n): n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
    case .bool(let b): b ? "true" : "false"
    default: cell.prettyPrinted
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
