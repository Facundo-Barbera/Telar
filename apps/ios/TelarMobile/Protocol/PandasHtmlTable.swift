import Foundation

/// A `DataFrame` repr, read back out of the HTML pandas wrote.
///
/// WHY PARSE IT AT ALL, when a web view would draw it: because this is the
/// single most common HTML output in any notebook, and a native grid is
/// selectable, cheap, and IDENTICAL to the `dataframe` output kind the engine
/// emits for runs it made itself. Without this the same table looks like two
/// different things depending on who ran the cell.
///
/// Anything that is not plainly a pandas table returns nil and falls through
/// to the web view. This is a fast path, not an HTML parser.
struct PandasHtmlTable: Equatable {
    /// Column headers. A pandas table has a leading empty header for the index
    /// column, which is kept as "" rather than invented a name for.
    var columns: [String]
    /// Cells as text, one array per row, aligned to `columns`. The index value
    /// is the first entry when the table has one.
    var rows: [[String]]

    var columnCount: Int { columns.count }
}

/// The table pandas writes, or nil.
///
/// THE MARKER IS `class="dataframe"`, which `DataFrame.to_html` always sets and
/// which hand-written HTML in a notebook will not. A `<style>` prelude and a
/// `<div>` wrapper are both normal around it and are ignored.
func parsePandasHtmlTable(_ html: String) -> PandasHtmlTable? {
    guard let table = firstDataframeTable(in: html) else { return nil }
    let rows = htmlRows(in: table)
    guard !rows.isEmpty else { return nil }

    // The header is every row made ONLY of <th>. A MultiIndex writes several;
    // the last is the most specific, and the one worth showing in a grid this
    // size.
    let headerRows = rows.prefix { $0.allSatisfy { $0.isHeader } }
    guard let header = headerRows.last else { return nil }
    let body = Array(rows.dropFirst(headerRows.count))
    guard !body.isEmpty else { return nil }

    let columns = header.map(\.text)
    // A body row carries its index as a leading <th> and its values as <td>;
    // both are cells in the same order the header names them.
    let cells = body.map { row in row.map(\.text) }
    // Ragged rows mean this is not the shape we think it is. Falling through
    // to the web view is better than drawing a grid with the columns shifted.
    guard cells.allSatisfy({ $0.count == columns.count }) else { return nil }
    return PandasHtmlTable(columns: columns, rows: cells)
}

// MARK: - the scanner

private struct HtmlCell {
    var text: String
    var isHeader: Bool
}

private func firstDataframeTable(in html: String) -> Substring? {
    // Find a <table …> whose attributes name the dataframe class, then take
    // everything up to its </table>.
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

/// A cell's own text: nested markup dropped, entities decoded, whitespace
/// collapsed. pandas puts `<b>` in bold-formatted frames and `&nbsp;` in empty
/// ones, and neither is worth carrying into a grid cell.
private func plainText(_ fragment: String) -> String {
    var text = fragment.replacingOccurrences(of: "<br[^>]*>", with: " ", options: [.regularExpression, .caseInsensitive])
    text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    for (entity, character) in [
        ("&nbsp;", "\u{00A0}"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""),
        ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&"),
    ] {
        text = text.replacingOccurrences(of: entity, with: character)
    }
    // A non-breaking space is what pandas writes for an empty cell; it should
    // read as empty rather than as a space you cannot see.
    text = text.replacingOccurrences(of: "\u{00A0}", with: " ")
    return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
}
