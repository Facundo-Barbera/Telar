import Foundation

func parseNotebookFile(_ data: Data, path: String, sha256: String) -> NotebookRead? {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let rawCells = root["cells"] as? [Any]
    else { return nil }
    let cells = rawCells.enumerated().compactMap { index, raw -> NotebookCell? in
        guard let cell = raw as? [String: Any] else { return nil }
        return NotebookCell(

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

func nbformatSource(_ raw: Any?) -> String {
    if let text = raw as? String { return text }
    if let lines = raw as? [Any] { return lines.compactMap { $0 as? String }.joined() }
    return ""
}

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

func nbformatBundle(_ data: [String: Any]?) -> CellOutput? {
    guard let data else { return nil }
    for mediaType in ["image/png", "image/jpeg", "image/gif"] {
        guard let payload = data[mediaType] else { continue }

        let b64 = nbformatSource(payload).filter { !$0.isNewline && !$0.isWhitespace }
        guard !b64.isEmpty else { continue }
        return .image(mediaType: mediaType, dataB64: b64, attachmentId: nil, width: nil, height: nil)
    }
    if let svg = data["image/svg+xml"] { return .html(nbformatSource(svg), truncated: false) }
    if let html = data["text/html"] { return .html(nbformatSource(html), truncated: false) }
    if let plain = data["text/plain"] { return .text(stream: "result", text: nbformatSource(plain), truncated: false) }

    if let first = data.keys.sorted().first { return .unknown(kind: first) }
    return nil
}
