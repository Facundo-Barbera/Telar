import Foundation

struct PandasHtmlTable: Equatable {
    var columns: [String]

    var rows: [[String]]

    var columnCount: Int { columns.count }
}

func parsePandasHtmlTable(_ html: String) -> PandasHtmlTable? {
    guard let table = firstDataframeTable(in: html) else { return nil }
    let rows = htmlRows(in: table)
    guard !rows.isEmpty else { return nil }

    let headerRows = rows.prefix { $0.allSatisfy { $0.isHeader } }
    guard let header = headerRows.last else { return nil }
    let body = Array(rows.dropFirst(headerRows.count))
    guard !body.isEmpty else { return nil }

    let columns = header.map(\.text)

    let cells = body.map { row in row.map(\.text) }

    guard cells.allSatisfy({ $0.count == columns.count }) else { return nil }
    return PandasHtmlTable(columns: columns, rows: cells)
}

private struct HtmlCell {
    var text: String
    var isHeader: Bool
}

private func firstDataframeTable(in html: String) -> Substring? {
    guard let open = html.range(of: "<table[^>]*class=[\"'][^\"']*\\bdataframe\\b[^\"']*[\"'][^>]*>",
                                options: [.regularExpression, .caseInsensitive]) else { return nil }
    guard let close = html.range(of: "</table>", options: [.caseInsensitive], range: open.upperBound..<html.endIndex) else { return nil }
    return html[open.upperBound..<close.lowerBound]
}

private func htmlRows(in table: Substring) -> [[HtmlCell]] {
    var rows: [[HtmlCell]] = []
    var cursor = table.startIndex
    while let open = table.range(of: "<tr[^>]*>", options: [.regularExpression, .caseInsensitive], range: cursor..<table.endIndex) {
        let end = table.range(of: "</tr>", options: [.caseInsensitive], range: open.upperBound..<table.endIndex)
        let body = table[open.upperBound..<(end?.lowerBound ?? table.endIndex)]
        let cells = htmlCells(in: body)
        if !cells.isEmpty { rows.append(cells) }
        cursor = end?.upperBound ?? table.endIndex
    }
    return rows
}

private func htmlCells(in row: Substring) -> [HtmlCell] {
    var cells: [HtmlCell] = []
    var cursor = row.startIndex
    while let open = row.range(of: "<(th|td)[^>]*>", options: [.regularExpression, .caseInsensitive], range: cursor..<row.endIndex) {
        let isHeader = row[open].lowercased().hasPrefix("<th")
        let close = row.range(of: isHeader ? "</th>" : "</td>", options: [.caseInsensitive], range: open.upperBound..<row.endIndex)
        let inner = row[open.upperBound..<(close?.lowerBound ?? row.endIndex)]
        cells.append(HtmlCell(text: plainText(String(inner)), isHeader: isHeader))
        cursor = close?.upperBound ?? row.endIndex
    }
    return cells
}

private func plainText(_ fragment: String) -> String {
    var text = fragment.replacingOccurrences(of: "<br[^>]*>", with: " ", options: [.regularExpression, .caseInsensitive])
    text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    for (entity, character) in [
        ("&nbsp;", "\u{00A0}"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""),
        ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&"),
    ] {
        text = text.replacingOccurrences(of: entity, with: character)
    }

    text = text.replacingOccurrences(of: "\u{00A0}", with: " ")
    return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
}
