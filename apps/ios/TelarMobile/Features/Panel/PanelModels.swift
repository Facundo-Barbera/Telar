import Foundation

struct DataScienceConfig: Decodable, Equatable {
    var enabled: Bool
}

struct LatexConfig: Decodable, Equatable {
    var enabled: Bool
    var mainFile: String?
}

struct PluginID: RawRepresentable, Hashable, Codable, Sendable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    init(_ rawValue: String) { self.rawValue = rawValue }

    static let dataScience = PluginID("data-science")
    static let latex = PluginID("latex")
}

struct PluginConfig: Decodable, Equatable {
    var enabled: Bool
}

struct ProjectPlugins: Decodable, Equatable {
    var version: Int
    var entries: [String: PluginConfig]

    private enum CodingKeys: String, CodingKey { case version, entries }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        entries = (try? c.decode([String: Skippable<PluginConfig>].self, forKey: .entries))?.compactMapValues(\.value) ?? [:]
    }
}

enum ProjectAvailability: String, Codable, Equatable {
    case available
    case unmounted
    case missing

    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectAvailability(rawValue: raw) ?? .unknown
    }
}

struct Project: Decodable, Identifiable, Equatable {
    var id: EngineID
    var name: String
    var root: String?
    var dataScience: DataScienceConfig?
    var latex: LatexConfig?

    var plugins: ProjectPlugins?

    var availability: ProjectAvailability?

    private enum CodingKeys: String, CodingKey { case id, name, root, dataScience, latex, plugins, availability }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(EngineID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        root = try? c.decodeIfPresent(String.self, forKey: .root)
        dataScience = try? c.decodeIfPresent(DataScienceConfig.self, forKey: .dataScience)
        latex = try? c.decodeIfPresent(LatexConfig.self, forKey: .latex)

        plugins = try? c.decodeIfPresent(ProjectPlugins.self, forKey: .plugins)

        availability = try? c.decodeIfPresent(ProjectAvailability.self, forKey: .availability)
    }

    init(
        id: EngineID,
        name: String,
        root: String? = nil,
        dataScience: DataScienceConfig? = nil,
        latex: LatexConfig? = nil,
        plugins: ProjectPlugins? = nil,
        availability: ProjectAvailability? = nil
    ) {
        self.id = id; self.name = name; self.root = root
        self.dataScience = dataScience; self.latex = latex; self.plugins = plugins
        self.availability = availability
    }

    var awayLabel: String? {
        switch availability {
        case .unmounted: return "Drive away"
        case .missing: return "Folder gone"
        case .available, .unknown, nil: return nil
        }
    }

    var enabledPlugins: Set<PluginID> {
        if let plugins { return Set(plugins.entries.filter { $0.value.enabled }.keys.map { PluginID($0) }) }
        var legacy = Set<PluginID>()
        if dataScience?.enabled == true { legacy.insert(.dataScience) }
        if latex?.enabled == true { legacy.insert(.latex) }
        return legacy
    }
}

struct ProjectList: Decodable {
    var projects: [Project]

    private enum CodingKeys: String, CodingKey { case projects }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projects = try c.decode([Skippable<Project>].self, forKey: .projects).compactMap(\.value)
    }
}

enum WorkspaceListingSource: String, Decodable {
    case git, walk
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WorkspaceListingSource(rawValue: raw) ?? .unknown
    }
}

struct WorkspaceListing: Decodable, Equatable {
    var workspacePath: String
    var repository: Bool

    var files: [String]
    var source: WorkspaceListingSource
    var truncated: Bool
    var readAt: Timestamp
}

struct WorkspaceFile: Decodable, Equatable {
    var path: String

    var text: String

    var bytes: Int

    var sha256: String
    var binary: Bool
    var truncated: Bool
}

enum WorkspaceWriteRefusal: String, Decodable {
    case notFound = "not_found"
    case binary
    case tooLarge = "too_large"
    case conflict
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WorkspaceWriteRefusal(rawValue: raw) ?? .unknown
    }
}

enum WorkspaceWriteResult: Decodable, Equatable {
    case written(WorkspaceFile)
    case refused(WorkspaceWriteRefusal, sha256: String?)

    private enum CodingKeys: String, CodingKey { case written, file, refusal, sha256 }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if try c.decode(Bool.self, forKey: .written) {
            self = .written(try c.decode(WorkspaceFile.self, forKey: .file))
        } else {
            self = .refused(
                (try? c.decode(WorkspaceWriteRefusal.self, forKey: .refusal)) ?? .unknown,
                sha256: try c.decodeIfPresent(String.self, forKey: .sha256)
            )
        }
    }
}

struct TableWindow: Decodable, Equatable {
    var path: String
    var columns: [String]
    var dtypes: [String]?
    var total: Int
    var offset: Int
    var rows: [[JSONValue]]
    var truncated: Bool?
}

enum KernelState: String, Decodable {
    case starting, idle, busy, restarting, dead, none
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = KernelState(rawValue: raw) ?? .unknown
    }

    var isLive: Bool { self != .none && self != .dead && self != .unknown }
}

struct KernelStatus: Decodable, Equatable {
    var state: KernelState
    var executionCount: Int?
    var python: String?
}

struct VarRow: Decodable, Identifiable, Equatable {
    var name: String
    var type: String
    var shape: [Int]?
    var len: Int?
    var sizeBytes: Int?
    var repr: String?

    var id: String { name }
}

struct KernelError: Decodable, Equatable {
    var ename: String
    var evalue: String
    var traceback: [String]
}

enum CellOutput: Decodable, Equatable {
    case text(stream: String, text: String, truncated: Bool)
    case html(String, truncated: Bool)
    case image(mediaType: String, dataB64: String?, attachmentId: EngineID?, width: Int?, height: Int?)
    case json(JSONValue)
    case dataframe(columns: [String], dtypes: [String], rows: [[JSONValue]], shape: [Int], truncated: Bool)
    case error(KernelError)
    case clear
    case unknown(kind: String)

    private enum CodingKeys: String, CodingKey {
        case kind, stream, text, truncated, html, mediaType, dataB64, attachmentId, width, height
        case value, columns, dtypes, rows, shape, ename, evalue, traceback
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        func fallback() -> CellOutput { .unknown(kind: kind) }
        switch kind {
        case "text":
            guard let text = try? c.decode(String.self, forKey: .text) else { self = fallback(); return }
            self = .text(
                stream: (try? c.decode(String.self, forKey: .stream)) ?? "stdout",
                text: text,
                truncated: (try? c.decode(Bool.self, forKey: .truncated)) ?? false
            )
        case "html":
            guard let html = try? c.decode(String.self, forKey: .html) else { self = fallback(); return }
            self = .html(html, truncated: (try? c.decode(Bool.self, forKey: .truncated)) ?? false)
        case "image":
            self = .image(
                mediaType: (try? c.decode(String.self, forKey: .mediaType)) ?? "image/png",
                dataB64: try? c.decodeIfPresent(String.self, forKey: .dataB64),
                attachmentId: try? c.decodeIfPresent(EngineID.self, forKey: .attachmentId),
                width: try? c.decodeIfPresent(Int.self, forKey: .width),
                height: try? c.decodeIfPresent(Int.self, forKey: .height)
            )
        case "json":
            self = .json((try? c.decode(JSONValue.self, forKey: .value)) ?? .null)
        case "dataframe":
            guard let columns = try? c.decode([String].self, forKey: .columns),
                  let rows = try? c.decode([[JSONValue]].self, forKey: .rows)
            else { self = fallback(); return }
            self = .dataframe(
                columns: columns,
                dtypes: (try? c.decode([String].self, forKey: .dtypes)) ?? [],
                rows: rows,
                shape: (try? c.decode([Int].self, forKey: .shape)) ?? [rows.count, columns.count],
                truncated: (try? c.decode(Bool.self, forKey: .truncated)) ?? false
            )
        case "error":
            guard let ename = try? c.decode(String.self, forKey: .ename) else { self = fallback(); return }
            self = .error(KernelError(
                ename: ename,
                evalue: (try? c.decode(String.self, forKey: .evalue)) ?? "",
                traceback: (try? c.decode([String].self, forKey: .traceback)) ?? []
            ))
        case "clear":
            self = .clear
        default:
            self = fallback()
        }
    }
}

enum NotebookCellType: String, Decodable {
    case code, markdown, raw
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = NotebookCellType(rawValue: raw) ?? .unknown
    }
}

struct NotebookCell: Decodable, Identifiable, Equatable {
    var id: String
    var index: Int
    var type: NotebookCellType
    var source: String

    var executionCount: Int?
    var outputs: [CellOutput]?

    private enum CodingKeys: String, CodingKey { case id, index, type, source, executionCount, outputs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        index = try c.decode(Int.self, forKey: .index)
        type = (try? c.decode(NotebookCellType.self, forKey: .type)) ?? .unknown
        source = try c.decode(String.self, forKey: .source)
        executionCount = try? c.decodeIfPresent(Int.self, forKey: .executionCount)
        outputs = try c.decodeIfPresent([Skippable<CellOutput>].self, forKey: .outputs)?.compactMap(\.value)
    }

    init(id: String, index: Int, type: NotebookCellType, source: String, executionCount: Int? = nil, outputs: [CellOutput]? = nil) {
        self.id = id; self.index = index; self.type = type; self.source = source
        self.executionCount = executionCount; self.outputs = outputs
    }
}

struct NotebookRead: Decodable, Equatable {
    var path: String
    var sha256: String
    var cellCount: Int
    var cells: [NotebookCell]

    private enum CodingKeys: String, CodingKey { case path, sha256, cellCount, cells }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        sha256 = try c.decode(String.self, forKey: .sha256)
        cellCount = try c.decode(Int.self, forKey: .cellCount)
        cells = try c.decode([Skippable<NotebookCell>].self, forKey: .cells).compactMap(\.value)
    }

    init(path: String, sha256: String, cellCount: Int, cells: [NotebookCell]) {
        self.path = path; self.sha256 = sha256; self.cellCount = cellCount; self.cells = cells
    }
}

struct ExecResult: Decodable, Equatable {
    var execId: String
    var ok: Bool
    var executionCount: Int?
    var error: KernelError?
    var outputs: [CellOutput]

    private enum CodingKeys: String, CodingKey { case execId, ok, executionCount, error, outputs }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        execId = try c.decode(String.self, forKey: .execId)
        ok = try c.decode(Bool.self, forKey: .ok)
        executionCount = try? c.decodeIfPresent(Int.self, forKey: .executionCount)
        error = try? c.decodeIfPresent(KernelError.self, forKey: .error)
        outputs = (try? c.decode([Skippable<CellOutput>].self, forKey: .outputs))?.compactMap(\.value) ?? []
    }
}

struct NotebookRunResult: Decodable {
    struct CellRun: Decodable { var cellId: String; var result: ExecResult }
    var results: [CellRun]
    var notebook: NotebookRead
}

struct DataSciencePackage: Decodable, Identifiable, Equatable {
    var name: String
    var version: String
    var channel: String?
    var direct: Bool?
    var id: String { name }
}

struct PackageList: Decodable {
    struct Environment: Decodable { var manager: String; var root: String; var python: String }
    var packages: [DataSciencePackage]
    var environment: Environment?

    private enum CodingKeys: String, CodingKey { case packages, environment }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        packages = (try? c.decode([Skippable<DataSciencePackage>].self, forKey: .packages))?.compactMap(\.value) ?? []
        environment = try? c.decodeIfPresent(Environment.self, forKey: .environment)
    }
}

enum LatexSeverity: String, Decodable {
    case error, warning
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LatexSeverity(rawValue: raw) ?? .unknown
    }
}

struct LatexDiagnostic: Decodable, Identifiable, Equatable {
    var severity: LatexSeverity
    var file: String?
    var line: Int?
    var message: String
    var code: String?
    var detail: String?
    var suggestion: String?

    var id: String { "\(severity.rawValue):\(file ?? ""):\(line ?? 0):\(message)" }
}

enum LatexJobStatus: String, Decodable {
    case running, ok, failed, cancelled

    case never
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LatexJobStatus(rawValue: raw) ?? .unknown
    }
}

struct LatexCompileStatus: Decodable, Equatable {
    var status: LatexJobStatus
    var path: String?
    var pdfPath: String?
    var diagnostics: [LatexDiagnostic]
    var logTail: [String]
    var jobId: String?
    var startedAt: Timestamp?
    var finishedAt: Timestamp?

    private enum CodingKeys: String, CodingKey { case status, path, pdfPath, diagnostics, logTail, jobId, startedAt, finishedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decode(LatexJobStatus.self, forKey: .status)) ?? .unknown
        path = try? c.decodeIfPresent(String.self, forKey: .path)
        pdfPath = try? c.decodeIfPresent(String.self, forKey: .pdfPath)
        diagnostics = (try? c.decode([Skippable<LatexDiagnostic>].self, forKey: .diagnostics))?.compactMap(\.value) ?? []
        logTail = (try? c.decode([String].self, forKey: .logTail)) ?? []
        jobId = try? c.decodeIfPresent(String.self, forKey: .jobId)
        startedAt = try? c.decodeIfPresent(Timestamp.self, forKey: .startedAt)
        finishedAt = try? c.decodeIfPresent(Timestamp.self, forKey: .finishedAt)
    }

    static let never = LatexCompileStatus(status: .never)

    init(status: LatexJobStatus, path: String? = nil, pdfPath: String? = nil, diagnostics: [LatexDiagnostic] = [], logTail: [String] = []) {
        self.status = status; self.path = path; self.pdfPath = pdfPath
        self.diagnostics = diagnostics; self.logTail = logTail
    }
}

struct LatexCompileAnswer: Decodable {
    var ok: Bool
    var path: String?
    var pdfPath: String?
    var error: String?
}

struct LatexToolchain: Decodable {
    var kind: String
    var mainFile: String?
    var version: String?
}
