import Foundation
import Observation

@MainActor @Observable final class NewConversationModel {
    let settings: AppSettings
    var draft = NewConversationDraft()
    var prompt = "" { didSet { saveText() } }
    var choice = ModelChoice(driver: "claude")
    var runtimeMode: String?
    var catalogues: [String: ModelCatalogue] = [:]
    var git: GitOverview?
    private(set) var targets: [NewConversationTarget] = []
    private(set) var activity: [String: Timestamp] = [:]
    private(set) var unreachable: [String] = []
    private(set) var loading = true
    private(set) var attachments: [TurnAttachment] = []
    private(set) var attachmentData: [EngineID: Data] = [:]
    private(set) var submitting = false
    var error: String?
    private(set) var createdSessionId: EngineID?
    private var submissionRunId = RunID.newRunId()
    @ObservationIgnored var memory = NewConversationMemory()
    @ObservationIgnored var onCreated: (ScopedSessionID) -> Void = { _ in }

    init(settings: AppSettings, seed: MobileDraft?) {
        self.settings = settings
        draft.envMode = memory.lastMode
        guard let seed, let host = settings.host(seed.hostId) else { return }
        draft.target = NewConversationTarget(hostId: host.id, hostName: host.name, project: seed.project)
        draft.baseRef = seed.baseRef
        if seed.baseRef != nil { draft.envMode = "worktree" }
        restoreText(for: draft.target)
    }

    var api: HTTPEngineAPI? { draft.target.flatMap { settings.api(for: $0.hostId) } }
    var locked: Bool { createdSessionId != nil || submitting }
    var hostCount: Int { settings.hosts.count }

    func load() async {
        loading = true
        defer { loading = false }
        let hosts = settings.hosts
        var projects: [HostID: [ProjectRef]] = [:]
        var sessions: [HostID: [Session]] = [:]
        var failed: Set<HostID> = []
        await withTaskGroup(of: (HostID, LiveSessions?).self) { group in
            for host in hosts {
                guard let api = settings.api(for: host.id) else { continue }
                group.addTask { (host.id, try? await api.liveSessions()) }
            }
            for await (id, live) in group {
                if let live { projects[id] = live.projects; sessions[id] = live.sessions } else { failed.insert(id) }
            }
        }
        targets = NewConversationTargets.all(hosts: hosts, projects: projects)
        activity = NewConversationTargets.activity(sessions.flatMap { host, rows in rows.map { (host, $0.projectId, $0.updatedAt) } })
        unreachable = hosts.filter { failed.contains($0.id) }.map(\.name)
        if draft.target == nil, let chosen = NewConversationTargets.preferred(
            targets, activity: activity, lastUsed: memory.lastTarget,
            projectHint: UserDefaults.standard.string(forKey: "newSessionProject")
        ) { pick(chosen) }
    }

    func pick(_ target: NewConversationTarget) {
        guard !locked, target.id != draft.target?.id else { return }
        let text = prompt
        forgetText()
        draft.retarget(target)
        git = nil
        if let saved = MobileDrafts.shared.draft(host: target.hostId, project: target.project.id), text.isEmpty {
            restoreText(for: draft.target, from: saved)
        } else {
            prompt = text
        }
        if !targets.contains(where: { $0.id == target.id }) { targets.append(target) }
    }

    func loadDetails() async {
        guard let api, let projectId = draft.target?.project.id else { return }
        for driver in ["claude", "codex", "opencode"] where catalogues[driver] == nil {
            catalogues[driver] = try? await api.models(driver: driver)
        }
        git = try? await api.projectGit(projectId)
    }

    func attach(data: Data, name: String, mediaType: String) {
        let row = TurnAttachment(id: UUID().uuidString, name: name, mediaType: mediaType, bytes: data.count)
        attachments.append(row)
        attachmentData[row.id] = data
    }

    func removeAttachment(_ id: EngineID) {
        attachments.removeAll { $0.id == id }
        attachmentData[id] = nil
    }

    var previews: [EngineID: Data] {
        attachmentData.filter { id, data in
            data.count <= ComposerIntake.previewCap && attachments.contains { $0.id == id && $0.mediaType.hasPrefix("image/") }
        }
    }

    func send(_ text: String) async {
        guard let target = draft.target, let api else {
            prompt = text
            error = loading ? "Projects are still loading." : "Choose a project first."
            return
        }
        submitting = true
        defer { submitting = false }
        do {
            let sessionId: EngineID
            if let createdSessionId { sessionId = createdSessionId } else { sessionId = try await create(api, target: target, text: text) }
            var uploaded: [EngineID] = []
            for attachment in attachments {
                guard let data = attachmentData[attachment.id] else { continue }
                do {
                    uploaded.append(try await api.uploadAttachment(sessionId, name: attachment.name, mediaType: attachment.mediaType, data: data).id)
                } catch {
                    prompt = text
                    self.error = "Couldn't upload \(attachment.name) — nothing was sent. Try again."
                    return
                }
            }
            _ = try await api.submitTurn(sessionId, runId: submissionRunId, input: text, attachments: uploaded.isEmpty ? nil : uploaded)
            MobileDrafts.shared.remove(host: target.hostId, project: target.project.id)
            onCreated(ScopedSessionID(hostId: target.hostId, sessionId: sessionId))
        } catch {
            prompt = text
            self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func create(_ api: HTTPEngineAPI, target: NewConversationTarget, text: String) async throws -> EngineID {
        let images = attachments.filter { $0.mediaType.hasPrefix("image/") }.map(\.name)
        let session = try await api.createSession(projectId: target.project.id, input: draft.input(driver: choice.driver, prompt: text, imageNames: images))
        createdSessionId = session.id
        memory.remember(draft)
        saveText(force: text)
        if choice.isTouched || runtimeMode != nil {
            var patch = SessionPatch()
            if let runtimeMode { patch.runtimeMode = runtimeMode }
            if choice.isTouched, let instanceId = session.providerInstanceId ?? session.model?.instanceId {
                patch.model = ModelSelection(
                    instanceId: instanceId, model: choice.model, effort: choice.effort,
                    fastMode: choice.fastMode, serviceTier: choice.serviceTier, ultracode: choice.ultracode
                )
            }
            try? await api.patchSession(session.id, patch: patch)
        }
        return session.id
    }

    private func restoreText(for target: NewConversationTarget?, from saved: MobileDraft? = nil) {
        guard let target, let saved = saved ?? MobileDrafts.shared.draft(host: target.hostId, project: target.project.id) else { return }
        prompt = saved.prompt
        createdSessionId = saved.createdSessionId
        if let runId = saved.submissionRunId { submissionRunId = runId }
        if let baseRef = saved.baseRef { draft.baseRef = baseRef }
    }

    private func forgetText() {
        guard let target = draft.target, createdSessionId == nil else { return }
        MobileDrafts.shared.remove(host: target.hostId, project: target.project.id)
    }

    private func saveText(force text: String? = nil) {
        guard let target = draft.target else { return }
        MobileDrafts.shared.save(MobileDraft(
            hostId: target.hostId, project: target.project, prompt: text ?? prompt,
            createdSessionId: createdSessionId, submissionRunId: submissionRunId, baseRef: draft.baseRef
        ))
    }
}
