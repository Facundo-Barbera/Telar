import Foundation
import Testing
@testable import TelarMobile

/// The panel's pure rules: the tree from a flat list, the file-view decision,
/// the editor's open/close arithmetic, the notebook-read classifier, and the
/// wire shapes every surface decodes.
@Suite struct PanelModelTests {
    @Test func viewDecisionMirrorsTheDesktop() {
        #expect(panelView(for: "nb.ipynb", dataScience: true) == .notebook)
        #expect(panelView(for: "nb.ipynb", dataScience: false) == .code)
        #expect(panelView(for: "data/rows.CSV", dataScience: true) == .table)
        #expect(panelView(for: "data/rows.parquet", dataScience: false) == .code)
        #expect(panelView(for: "out/report.pdf", dataScience: false) == .pdf)
        #expect(panelView(for: "src/main.swift", dataScience: true) == .code)
    }

    @Test func previewSlotIsReplacedInPlaceAndPinsStay() {
        var editor = EditorState()
        editor.open("a.md", view: .code, pin: false)
        editor.open("b.md", view: .code, pin: false)
        #expect(editor.files.map(\.path) == ["b.md"])
        editor.pin("b.md")
        editor.open("c.md", view: .code, pin: false)
        #expect(editor.files.map(\.path) == ["b.md", "c.md"])
        #expect(editor.activePath == "c.md")
        // A notebook is always pinned.
        editor.open("n.ipynb", view: .notebook, pin: false)
        #expect(editor.files.first { $0.path == "n.ipynb" }?.pinned == true)
    }

    @Test func closingHandsFocusToTheRightNeighbourThenTheLast() {
        var editor = EditorState()
        for path in ["a", "b", "c"] { editor.open(path, view: .code, pin: true) }
        editor.activePath = "b"
        editor.close("b")
        #expect(editor.activePath == "c")
        editor.close("c")
        #expect(editor.activePath == "a")
        editor.close("a")
        #expect(editor.activePath == nil && editor.files.isEmpty)
    }

    @Test @MainActor func persistenceIsHostScoped() {
        let suite = "telar.panel.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let a = UUID(), b = UUID()
        let panelA = PanelModel(hostId: a, sessionId: "s", defaults: defaults)
        panelA.openFile("notes.md")
        #expect(panelA.isOpen && panelA.active == .files)
        // Same session id on another Mac sees nothing of it.
        let panelB = PanelModel(hostId: b, sessionId: "s", defaults: defaults)
        #expect(!panelB.isOpen && panelB.editor.files.isEmpty)
        // The same Mac re-opens where it left.
        let again = PanelModel(hostId: a, sessionId: "s", defaults: defaults)
        #expect(again.editor.files.map(\.path) == ["notes.md"])
    }

    @Test @MainActor func aTabTheProjectDoesNotOfferFallsBackToDiff() {
        let suite = "telar.panel.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let panel = PanelModel(hostId: UUID(), sessionId: "s", defaults: defaults)
        panel.select(.data)
        panel.setPlugins(dataScience: false, latex: true)
        #expect(panel.tabs == [.diff, .files, .latex])
        #expect(panel.active == .diff)
    }
}

@Suite struct PanelDecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func writeResultIsADiscriminatedBoolean() throws {
        let ok = try decode(WorkspaceWriteResult.self, #"{"written":true,"file":{"path":"a.md","text":"x","bytes":1,"sha256":"h2","binary":false,"truncated":false}}"#)
        if case .written(let file) = ok { #expect(file.sha256 == "h2") } else { Issue.record("expected written") }
        let refused = try decode(WorkspaceWriteResult.self, #"{"written":false,"refusal":"conflict","sha256":"h3"}"#)
        #expect(refused == .refused(.conflict, sha256: "h3"))
        let novel = try decode(WorkspaceWriteResult.self, #"{"written":false,"refusal":"quota"}"#)
        #expect(novel == .refused(.unknown, sha256: nil))
    }

    @Test func cellOutputsFallBackToTheirKind() throws {
        let outputs = try decode([CellOutput].self, #"""
        [{"kind":"text","stream":"stderr","text":"warn"},
         {"kind":"image","mediaType":"image/png","attachmentId":"att_1"},
         {"kind":"dataframe","columns":["a"],"dtypes":["int64"],"rows":[[1],[null]],"shape":[2,1],"truncated":false},
         {"kind":"error","ename":"ValueError","evalue":"bad","traceback":["\u001b[31mred\u001b[0m"]},
         {"kind":"hologram","payload":1},
         {"kind":"clear"}]
        """#)
        #expect(outputs.count == 6)
        #expect(outputs[0] == .text(stream: "stderr", text: "warn", truncated: false))
        if case .image(_, _, let attachmentId, _, _) = outputs[1] { #expect(attachmentId == "att_1") } else { Issue.record("image") }
        if case .dataframe(let columns, _, let rows, let shape, _) = outputs[2] {
            #expect(columns == ["a"] && rows[1] == [.null] && shape == [2, 1])
        } else { Issue.record("dataframe") }
        if case .error(let e) = outputs[3] { #expect(stripAnsi(e.traceback[0]) == "red") } else { Issue.record("error") }
        #expect(outputs[4] == .unknown(kind: "hologram"))
        #expect(outputs[5] == .clear)
    }

    @Test func notebookReadTakesNullExecutionCountsAndSkipsAlienCells() throws {
        let nb = try decode(NotebookRead.self, #"{"path":"n.ipynb","sha256":"h","cellCount":2,"cells":[{"id":"c1","index":0,"type":"code","source":"1+1","executionCount":null,"outputs":[]},{"id":"c2","index":1,"type":"tesseract","source":"?"},{"bogus":true}]}"#)
        #expect(nb.cells.count == 2)
        #expect(nb.cells[0].executionCount == nil)
        #expect(nb.cells[1].type == .unknown)
    }

    @Test func latexStatusHasANeverArm() throws {
        let never = try decode(LatexCompileStatus.self, #"{"status":"never"}"#)
        #expect(never.status == .never && never.diagnostics.isEmpty)
        let full = try decode(LatexCompileStatus.self, #"{"status":"failed","path":"main.tex","diagnostics":[{"severity":"error","file":"main.tex","line":12,"message":"Undefined control sequence","code":"undefined-control-sequence"}],"logTail":["! Undefined"],"jobId":"j","startedAt":1}"#)
        #expect(full.status == .failed && full.diagnostics.first?.line == 12 && full.diagnostics.first?.severity == .error)
    }

    @Test func tableWindowRowsAreOpaqueJSON() throws {
        let window = try decode(TableWindow.self, #"{"path":"d.csv","columns":["a","b"],"dtypes":["int64","object"],"total":3,"offset":0,"rows":[[1,"x"],[2,null]]}"#)
        #expect(window.total == 3 && window.rows[1] == [.number(2), .null])
    }

    @Test func projectListSkipsARowItCannotRead() throws {
        let list = try decode(ProjectList.self, #"{"projects":[{"id":"p","name":"P","dataScience":{"enabled":true}},{"id":"q"}]}"#)
        #expect(list.projects.count == 1 && list.projects[0].dataScience?.enabled == true && list.projects[0].latex == nil)
    }
}
