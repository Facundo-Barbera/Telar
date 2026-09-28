import Foundation
import Observation

@MainActor @Observable final class SessionStore {
    struct PendingSend: Codable, Equatable {
        var runId: String
        var text: String
        var attachments: [EngineID]?
    }

    let sync: SessionSyncEngine
    private(set) var pendingSend: PendingSend?
    private(set) var sendError: String?
    private(set) var actionError: String?
    private(set) var pendingAttachments: [TurnAttachment] = []
    private(set) var attachmentPreviews: [EngineID: Data] = [:]
    private(set) var uploading = false
    private(set) var catalogue: ModelCatalogue?

    let api: any EngineAPI
    private let sessionId: EngineID
    private let hostId: HostID?
    private var pendingKey: String {
        if let hostId { return "telar.pendingSend.\(hostId.uuidString).\(sessionId)" }
        return "telar.pendingSend.\(sessionId)"
    }

    init(api: any EngineAPI, sessionId: EngineID, hostId: HostID? = nil, cache: HostSnapshotCache? = nil) {
        self.api = api
        self.sessionId = sessionId
        self.hostId = hostId
        sync = SessionSyncEngine(api: api, sessionId: sessionId, cache: cache)
        if let data = UserDefaults.standard.data(forKey: pendingKey) {
            pendingSend = try? JSONDecoder().decode(PendingSend.self, from: data)
        }
    }

    var hasActiveTurn: Bool {
        sync.turns.contains { $0.state.isActive }
    }

    var hasRunningTurn: Bool {
        sync.turns.contains { $0.state == .running || $0.state == .claimed || $0.state == .steering }
    }

    var queuedTurns: [JournalTurn] {
        sync.turns.filter { $0.state == .queued || $0.state == .steering }
    }

    func withdraw(_ runId: String) async {
        await perform { try await self.api.stopTurn(self.sessionId, runId: runId) }
    }

    func promote(_ runId: String) async {
        await perform { try await self.api.promoteTurn(self.sessionId, runId: runId) }
    }

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard SessionDraft.canSend(text: trimmed, mediaTypes: pendingAttachments.map(\.mediaType)) else { return }
        let attachments = pendingAttachments.isEmpty ? nil : pendingAttachments.map(\.id)
        let pending = pendingSend.flatMap { $0.text == trimmed && $0.attachments == attachments ? $0 : nil }
            ?? PendingSend(runId: RunID.newRunId(), text: trimmed, attachments: attachments)
        persist(pending)
        await deliver(pending)
    }

    func attach(data: Data, name: String, mediaType: String) async {
        uploading = true
        defer { uploading = false }
        do {
            let attachment = try await api.uploadAttachment(sessionId, name: name, mediaType: mediaType, data: data)
            pendingAttachments.append(attachment)
            if mediaType.hasPrefix("image/"), data.count <= ComposerIntake.previewCap {
                attachmentPreviews[attachment.id] = data
            }
            actionError = nil
        } catch {
            actionError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func removeAttachment(_ id: EngineID) {
        pendingAttachments.removeAll { $0.id == id }
        attachmentPreviews[id] = nil
    }

    func loadModels() async {
        guard catalogue == nil, let driver = sync.session?.driver else { return }
        catalogue = try? await api.models(driver: driver)
    }

    func setModelChoice(_ choice: ModelChoice) async {
        await perform {
            var instanceId = self.sync.session?.model?.instanceId ?? self.sync.session?.providerInstanceId
            if instanceId == nil {
                let instances = try await self.api.providerInstances()
                instanceId = instances.first {
                    $0.enabled && $0.driver == self.sync.session?.driver
                }?.id
            }
            guard let instanceId else {
                throw EngineAPIError.engine(code: "invalid_request", message: "No provider instance for this driver.", status: 400)
            }
            try await self.api.patchSession(
                self.sessionId,
                patch: SessionPatch(model: ModelSelection(
                    instanceId: instanceId, model: choice.model,
                    effort: choice.effort, fastMode: choice.fastMode,
                    serviceTier: choice.serviceTier, ultracode: choice.ultracode
                ))
            )
        }
    }

    func retryPending() async {
        guard let pending = pendingSend else { return }
        await deliver(pending)
    }

    func discardPending() {
        pendingSend = nil
        sendError = nil
        UserDefaults.standard.removeObject(forKey: pendingKey)
    }

    private func deliver(_ pending: PendingSend) async {
        do {
            _ = try await api.submitTurn(sessionId, runId: pending.runId, input: pending.text, attachments: pending.attachments)
            discardPending()
            pendingAttachments = []
            attachmentPreviews = [:]
            await sync.refresh()
        } catch {
            sendError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func persist(_ pending: PendingSend) {
        pendingSend = pending
        sendError = nil
        if let data = try? JSONEncoder().encode(pending) {
            UserDefaults.standard.set(data, forKey: pendingKey)
        }
    }

    func stopActiveTurn() async {
        await perform { try await self.api.stopSession(self.sessionId) }
    }

    func resolve(_ request: EngineRequest, decision: RequestDecision,
                 reason: String? = nil, answers: [String: AnswerValue]? = nil) async {
        await perform {
            try await self.api.resolveRequest(
                self.sessionId, requestId: request.id,
                decision: decision, reason: reason, answers: answers
            )
        }
    }

    func rename(_ title: String) async {
        await perform { try await self.api.patchSession(self.sessionId, patch: SessionPatch(title: title)) }
    }

    func setRuntimeMode(_ mode: String) async {
        await perform { try await self.api.patchSession(self.sessionId, patch: SessionPatch(runtimeMode: mode)) }
    }

    func setSettled(_ settled: Bool) async {
        await perform {
            try await self.api.patchSession(self.sessionId, patch: SessionPatch(settledOverride: settled ? "settled" : "active"))
        }
    }

    private func perform(_ action: @escaping () async throws -> Void) async {
        do {
            try await action()
            actionError = nil
            await sync.refresh()
        } catch {
            actionError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
