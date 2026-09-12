import Foundation
import Testing
@testable import TelarMobile

/// The panel's pure rules: the tree from a flat list, the file-view decision,
/// the editor's open/close arithmetic, the notebook-read classifier, and the
/// wire shapes every surface decodes.
@Suite struct FileTreeTests {
    @Test func directoriesFirstThenNaturalOrder() {
        let tree = buildFileTree(["b.txt", "a/step-10.md", "a/step-2.md", "README.md", "a/z", "package.json"])
        #expect(tree.map(\.name) == ["a", "b.txt", "package.json", "README.md"])
        #expect(tree[0].children.map(\.name) == ["step-2.md", "step-10.md", "z"])
    }

    @Test func singleChildChainsCollapse() {
        let tree = buildFileTree(["src/main/java/App.java", "src/main/java/Util.java"])
        #expect(tree.count == 1)
        #expect(tree[0].name == "src/main/java")
        #expect(tree[0].path == "src/main/java")
        #expect(tree[0].children.map(\.name) == ["App.java", "Util.java"])
    }

    @Test func flattenHonoursExpansion() {
        let tree = buildFileTree(["a/x.md", "a/b/y.md", "c.md"])
        let closed = flattenTree(tree, expanded: [])
        #expect(closed.map(\.node.name) == ["a", "c.md"])
        let open = flattenTree(tree, expanded: ["a"])
        #expect(open.map(\.node.name) == ["a", "b", "x.md", "c.md"])
        #expect(open.map(\.depth) == [0, 1, 1, 0])
    }

    @Test func searchMatchesTheWholePathAndCaps() {
        let paths = (0..<500).map { "apps/engine/file\($0).ts" } + ["docs/panel.md"]
        let (matches, dropped) = matchFiles(paths, query: "ENGINE")
        #expect(matches.count == maxSearchMatches)
        #expect(dropped == 100)
        #expect(matchFiles(paths, query: "panel").matches == ["docs/panel.md"])
        #expect(matchFiles(paths, query: "  ").matches.count == paths.count)
    }

    @Test func ancestorsAndDirectories() {
        #expect(ancestorsOf(["a/b/c.md", "d.md"]) == ["a", "a/b"])
        let tree = buildFileTree(["a/b/c.md", "a/d.md"])
        #expect(Set(directoryPaths(tree)) == ["a", "a/b"])
    }
}

@Suite struct PanelModelTests {
    @Test func viewDecisionMirrorsTheDesktop() {
        #expect(panelView(for: "nb.ipynb", dataScience: true) == .notebook)
        // A notebook is still a notebook without the plugin — read-only, from
        // the file's own JSON, never the raw-JSON code view.
        #expect(panelView(for: "nb.ipynb", dataScience: false) == .notebookReadOnly)
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
        // A notebook is always pinned, read-only or not.
        editor.open("n.ipynb", view: .notebook, pin: false)
        #expect(editor.files.first { $0.path == "n.ipynb" }?.pinned == true)
        editor.open("r.ipynb", view: .notebookReadOnly, pin: false)
        #expect(editor.files.first { $0.path == "r.ipynb" }?.pinned == true)
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

@Suite struct NotebookReadTests {
    private func engine(_ code: String, _ message: String) -> Error {
        EngineAPIError.engine(code: code, message: message, status: 404)
    }

    @Test func missingOnlyWhenTheEngineSaysTheFileIsMissing() {
        #expect(classifyNotebookRead(engine("not_found", "no such file in this workspace: a.ipynb")) == .missing)
    }

    @Test func aMissingDoorIsNeverAMissingFile() {
        #expect(classifyNotebookRead(engine("not_found", "no data-science method notebook/read")) == .unreadable("no data-science method notebook/read"))
        #expect(classifyNotebookRead(engine("not_found", "data science is unavailable: plugin off")) == .unreadable("data science is unavailable: plugin off"))
        #expect(classifyNotebookRead(engine("invalid_request", "no such file in this workspace")) == .unreadable("no such file in this workspace"))
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

    @Test func displayOpenedIsDecoded() throws {
        let event = try decode(EngineEvent.self, #"{"id":9,"at":5,"sessionId":"s","type":"display.opened","path":"out/report.pdf","title":"Report"}"#)
        if case .displayOpened(let path, let title) = event.payload {
            #expect(path == "out/report.pdf" && title == "Report")
        } else {
            Issue.record("expected displayOpened")
        }
    }
}

/// THE PLUGIN FLAG, and the rule that keeps a disabled feature disabled.
///
/// `packages/engine-client/src/protocol/plugins.ts` `readProjectPlugins`: once
/// a project carries the map's `version` marker the map is the WHOLE truth,
/// and the legacy `dataScience` / `latex` blocks — which are still written as
/// mirrors for an older engine — are never read again. A per-key fallback is
/// what resurrects a feature somebody turned off.
@Suite struct ProjectPluginTests {
    private func project(_ json: String) throws -> Project {
        try JSONDecoder().decode(Project.self, from: Data(json.utf8))
    }

    @Test func aProjectThatWasNeverMigratedIsReadFromTheLegacyBlocks() throws {
        let p = try project(#"{"id":"p","name":"P","dataScience":{"enabled":true},"latex":{"enabled":false}}"#)
        #expect(p.pluginEnabled(.dataScience))
        #expect(!p.pluginEnabled(.latex))
    }

    @Test func aMigratedProjectIsReadFromTheMap() throws {
        let p = try project(#"{"id":"p","name":"P","plugins":{"version":1,"entries":{"data-science":{"enabled":true},"latex":{"enabled":true,"settings":{"mainFile":"main.tex"}}}}}"#)
        #expect(p.pluginEnabled(.dataScience))
        #expect(p.pluginEnabled(.latex))
    }

    @Test func theMapWinsOverAStaleLegacyMirror() throws {
        // Data Science was turned OFF: the entry is gone from the map and the
        // mirror still says true. Falling back to it would turn the plugin
        // back on by itself.
        let gone = try project(#"{"id":"p","name":"P","dataScience":{"enabled":true},"plugins":{"version":1,"entries":{"latex":{"enabled":true}}}}"#)
        #expect(!gone.pluginEnabled(.dataScience))
        #expect(gone.pluginEnabled(.latex))
        // And the explicit `false` entry beats the mirror just the same.
        let off = try project(#"{"id":"p","name":"P","latex":{"enabled":true},"plugins":{"version":1,"entries":{"latex":{"enabled":false}}}}"#)
        #expect(!off.pluginEnabled(.latex))
    }

    @Test func aMapThatWillNotParseIsNotAMigratedProject() throws {
        // No `version`, so no marker, so this project has never been migrated
        // — and it must not be dropped from the list over it.
        let p = try project(#"{"id":"p","name":"P","dataScience":{"enabled":true},"plugins":{"entries":{"data-science":{"enabled":false}}}}"#)
        #expect(p.plugins == nil)
        #expect(p.pluginEnabled(.dataScience))
    }

    @Test func anEntryThatWillNotParseIsSkippedRatherThanLosingTheMap() throws {
        let p = try project(#"{"id":"p","name":"P","plugins":{"version":1,"entries":{"data-science":{"enabled":true},"hello":{"enabled":"yes"}}}}"#)
        #expect(p.pluginEnabled(.dataScience))
        #expect(p.plugins?.entries["hello"] == nil)
    }
}

/// THE CLIENT-SIDE nbformat READ — what a notebook looks like with no plugin
/// and no kernel to ask.
@Suite struct NotebookFileTests {
    private func parse(_ json: String) -> NotebookRead? {
        parseNotebookFile(Data(json.utf8), path: "evidencia/report.ipynb", sha256: "")
    }

    @Test func sourceIsAStringOrTheArrayOfLinesNbformatActuallyWrites() throws {
        let nb = try #require(parse(#"""
        {"nbformat":4,"cells":[
          {"cell_type":"markdown","source":"# Title\nprose"},
          {"cell_type":"code","source":["import pandas as pd\n","df = pd.read_csv('a.csv')"],"execution_count":3,"outputs":[]}
        ]}
        """#))
        #expect(nb.cells.count == 2 && nb.cellCount == 2)
        #expect(nb.cells[0].type == .markdown && nb.cells[0].source == "# Title\nprose")
        // The lines already carry their newlines — joining with one more would
        // double every break in the file.
        #expect(nb.cells[1].type == .code && nb.cells[1].source == "import pandas as pd\ndf = pd.read_csv('a.csv')")
        #expect(nb.cells[1].executionCount == 3)
        #expect(nb.cells[1].index == 1)
    }

    @Test func aCodeCellCarriesItsStreamAndItsFigure() throws {
        let nb = try #require(parse(#"""
        {"cells":[{"id":"c9","cell_type":"code","source":"plot()","execution_count":7,"outputs":[
          {"output_type":"stream","name":"stderr","text":["one\n","two\n"]},
          {"output_type":"display_data","data":{"text/plain":"<Figure>","image/png":"aGVsbG8=\n"}},
          {"output_type":"execute_result","data":{"text/plain":["42"]},"execution_count":7}
        ]}]}
        """#))
        let outputs = try #require(nb.cells[0].outputs)
        #expect(nb.cells[0].id == "c9")
        #expect(outputs.count == 3)
        #expect(outputs[0] == .text(stream: "stderr", text: "one\ntwo\n", truncated: false))
        // Richest first: the picture, not the `<Figure>` repr beside it — and
        // the saved base64 comes back without the newlines it was wrapped at,
        // or `Data(base64Encoded:)` would refuse it.
        #expect(outputs[1] == .image(mediaType: "image/png", dataB64: "aGVsbG8=", attachmentId: nil, width: nil, height: nil))
        #expect(outputs[2] == .text(stream: "result", text: "42", truncated: false))
    }

    @Test func anErrorOutputAndAnUnknownOneBothSurvive() throws {
        let nb = try #require(parse(#"""
        {"cells":[{"cell_type":"code","source":"boom()","execution_count":null,"outputs":[
          {"output_type":"error","ename":"ValueError","evalue":"bad","traceback":["line one","line two"]},
          {"output_type":"hologram","payload":1}
        ]}]}
        """#))
        let outputs = try #require(nb.cells[0].outputs)
        #expect(nb.cells[0].executionCount == nil)
        #expect(nb.cells[0].id == "cell-0")
        if case .error(let e) = outputs[0] {
            #expect(e.ename == "ValueError" && e.traceback.count == 2)
        } else {
            Issue.record("expected an error output")
        }
        #expect(outputs[1] == .unknown(kind: "hologram"))
    }

    @Test func anHtmlBundleFallsBackPastAMissingImage() throws {
        let nb = try #require(parse(#"{"cells":[{"cell_type":"code","source":"df","outputs":[{"output_type":"execute_result","data":{"text/html":["<table>","</table>"],"text/plain":"   a\n0  1"}}]}]}"#))
        #expect(nb.cells[0].outputs?[0] == .html("<table></table>", truncated: false))
    }

    @Test func aCellTypeNothingKnowsStillRendersItsSource() throws {
        let nb = try #require(parse(#"{"cells":[{"cell_type":"tesseract","source":"?"},{"cell_type":"raw","source":"raw text"},"not-a-cell"]}"#))
        #expect(nb.cells.count == 2)
        #expect(nb.cells[0].type == .unknown && nb.cells[0].source == "?")
        #expect(nb.cells[1].type == .raw)
    }

    @Test func aDocumentWithNoCellsIsNotANotebook() {
        #expect(parse(#"{"nbformat":4,"metadata":{}}"#) == nil)
        #expect(parse("not json at all") == nil)
        #expect(parse("[1,2,3]") == nil)
        // An empty notebook IS one, and renders as one.
        #expect(parse(#"{"cells":[]}"#)?.cells.isEmpty == true)
    }
}
