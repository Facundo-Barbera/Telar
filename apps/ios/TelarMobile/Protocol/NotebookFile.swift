import Foundation

/// AN .ipynb READ FROM ITS OWN BYTES, with no kernel and no plugin behind it.
///
/// The engine's `notebook/read` lives behind Data Science, so a project that
/// has not turned the plugin on has no door to ask — and a notebook is still a
/// notebook. This parses nbformat v4 straight into the `NotebookRead` the live
/// surface already renders, so one set of views draws both and a read-only
/// notebook cannot drift into looking like a different app.
///
/// TOLERANT LIKE EVERY OTHER DECODE HERE. A cell type nothing recognises falls
/// to `.unknown` and still renders its source; an output kind nothing knows
/// names itself; a cell that is not an object at all is dropped. Only a
/// document with no `cells` array returns nil — that is not a notebook, and the
/// honest answer is to say so rather than draw an empty one.
///
/// `JSONSerialization` rather than `Codable`: nbformat is a shape with two
/// spellings for half its fields (`source` is a string or an array of lines,
/// `execution_count` is a number or null or absent), and a hand-written walk
/// over `Any` says that once instead of six times.
func parseNotebookFile(_ data: Data, path: String, sha256: String) -> NotebookRead? {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let rawCells = root["cells"] as? [Any]
    else { return nil }
    let cells = rawCells.enumerated().compactMap { index, raw -> NotebookCell? in
        guard let cell = raw as? [String: Any] else { return nil }
        return NotebookCell(
            // nbformat 4.5 gives every cell an id; before that there was none,
            // and the index is the only stable name a cell has.
            id: (cell["id"] as? String) ?? "cell-\(index)",
            index: index,
            type: NotebookCellType(rawValue: (cell["cell_type"] as? String) ?? "") ?? .unknown,
            source: nbformatSource(cell["source"]),
            executionCount: cell["execution_count"] as? Int,
            outputs: (cell["outputs"] as? [Any])?.compactMap(nbformatOutput)
        )
    }
    return NotebookRead(path: path, sha256: sha256, cellCount: cells.count, cells: cells)
}

/// Text as nbformat writes it: one string, or an array of lines that ALREADY
/// CARRY their own newlines — joining with "\n" would double every one of them.
func nbformatSource(_ raw: Any?) -> String {
    if let text = raw as? String { return text }
    if let lines = raw as? [Any] { return lines.compactMap { $0 as? String }.joined() }
    return ""
}

/// One saved output → the `CellOutput` the panel already draws.
func nbformatOutput(_ raw: Any) -> CellOutput? {
    guard let output = raw as? [String: Any] else { return nil }
    switch output["output_type"] as? String {
    case "stream":
        return .text(
            stream: (output["name"] as? String) ?? "stdout",
            text: nbformatSource(output["text"]),
            truncated: false
        )
    case "error":
        return .error(KernelError(
            ename: (output["ename"] as? String) ?? "Error",
            evalue: (output["evalue"] as? String) ?? "",
            traceback: (output["traceback"] as? [Any])?.compactMap { $0 as? String } ?? []
        ))
    case "execute_result", "display_data":
        return nbformatBundle(output["data"] as? [String: Any])
    case let kind?:
        return .unknown(kind: kind)
    case nil:
        return nil
    }
}

/// A MIME BUNDLE, RICHEST FIRST — a picture over a table over the plain-text
/// repr that accompanies both. The engine's own outputs arrive already reduced
/// to one kind, so this is the only place the choice is made on the phone.
func nbformatBundle(_ data: [String: Any]?) -> CellOutput? {
    guard let data else { return nil }
    for mediaType in ["image/png", "image/jpeg", "image/gif"] {
        guard let payload = data[mediaType] else { continue }
        // SAVED BASE64 IS LINE-WRAPPED. `Data(base64Encoded:)` refuses those
        // newlines by default, so a figure that is on disk would draw as a
        // spinner that never resolves.
        let b64 = nbformatSource(payload).filter { !$0.isNewline && !$0.isWhitespace }
        guard !b64.isEmpty else { continue }
        return .image(mediaType: mediaType, dataB64: b64, attachmentId: nil, width: nil, height: nil)
    }
    if let svg = data["image/svg+xml"] { return .html(nbformatSource(svg), truncated: false) }
    if let html = data["text/html"] { return .html(nbformatSource(html), truncated: false) }
    if let plain = data["text/plain"] { return .text(stream: "result", text: nbformatSource(plain), truncated: false) }
    // Sorted so a bundle of two unknown types names the same one every read.
    if let first = data.keys.sorted().first { return .unknown(kind: first) }
    return nil
}
