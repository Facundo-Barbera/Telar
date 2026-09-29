import SwiftUI

struct TableSurface: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let path: String
    let active: Bool

    @ScaledMetric(relativeTo: .caption) private var headerHeight: CGFloat = 34
    @ScaledMetric(relativeTo: .caption) private var rowHeight: CGFloat = 26
    @ScaledMetric(relativeTo: .caption) private var columnPerCharacter: CGFloat = 9
    @ScaledMetric(relativeTo: .caption) private var columnPadding: CGFloat = 26
    @ScaledMetric(relativeTo: .caption) private var columnMinimum: CGFloat = 80
    @ScaledMetric(relativeTo: .caption) private var columnMaximum: CGFloat = 260

    @ScaledMetric(relativeTo: .caption) private var columnFallback: CGFloat = 100

    @State private var windows: TableWindows?
    @State private var sort: (column: String, desc: Bool)?
    @State private var viewport: CGSize = .zero

    var body: some View {
        VStack(spacing: 0) {
            FileAddressRow(path: path, detail: windows?.meta.map { "\($0.total) rows × \($0.columns.count)\($0.truncated == true ? " · partial read" : "")" })
            if let windows, let meta = windows.meta {
                grid(meta, windows)
            } else if let error = windows?.error {
                ContentUnavailableView("Could not read this table", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(path):\(active):\(sort?.column ?? ""):\(sort?.desc ?? false)") { await reset() }
    }

    private func grid(_ meta: TableWindow, _ windows: TableWindows) -> some View {
        let widths = meta.columns.map { column -> CGFloat in
            max(columnMinimum, min(columnMaximum, CGFloat(column.count) * columnPerCharacter + columnPadding))
        }
        return ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    ForEach(0..<meta.total, id: \.self) { index in
                        row(index, cells: windows.rows[index], widths: widths)
                            .onAppear { windows.ensure(index) }
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

            .frame(minWidth: viewport.width, minHeight: viewport.height, alignment: .topLeading)
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { viewport = $0 }
    }

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

    private func row(_ index: Int, cells: [JSONValue]?, widths: [CGFloat]) -> some View {
        HStack(spacing: 0) {
            if let cells {
                ForEach(Array(cells.enumerated()), id: \.offset) { i, cell in
                    cellText(cell)
                        .padding(.horizontal, 8)
                        .frame(width: widths[safe: i] ?? columnFallback, height: rowHeight, alignment: .leading)
                        .contentShape(Rectangle())

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

        let label: String = if case .string(let s) = cell, s.isEmpty { "\"\"" } else { tableCellValue(cell) }
        return Text(label)
            .font(.system(Theme.caption, design: .monospaced))
            .foregroundStyle(tone)
            .italic(cell == .null)
            .lineLimit(1)
    }

    private func reset() async {
        let sort = sort
        let fresh = TableWindows { [api, sessionId, path] offset in
            try await api.sessionTable(sessionId, path: path, offset: offset, limit: TableWindows.page, sort: sort?.column, desc: sort?.desc ?? false)
        }
        windows = fresh
        await fresh.ensure(0)?.value
    }

    private func cycleSort(_ column: String) {
        if sort?.column != column { sort = (column, false) }
        else if sort?.desc == false { sort = (column, true) }
        else { sort = nil }
    }
}

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
