import Foundation
import Observation

/// One open session: the sync engine plus the actions the composer takes.
///
/// SENDING IS IDEMPOTENT BY PERSISTENCE: the (runId, text) pair is written to
/// UserDefaults BEFORE the POST and cleared only on a 2xx. A retry — user-
/// tapped or on next open — resends the SAME runId, and the engine's
/// idempotency contract returns the original turn rather than a duplicate.
@MainActor @Observable final class SessionStore {
    struct PendingSend: Codable, Equatable {
        var runId: String
        var text: String
        /// Stored attachment ids — already on the engine, so a retry re-sends
        /// the same handles. Optional for decoding pre-attachment drafts.
        var attachments: [EngineID]?
    }

    let sync: SessionSyncEngine
    private(set) var pendingSend: PendingSend?
    private(set) var sendError: String?
    private(set) var actionError: String?
    /// Uploaded-but-not-yet-sent files — thumbnails in the expanded composer.
    private(set) var pendingAttachments: [TurnAttachment] = []
    private(set) var uploading = false
    /// Loaded lazily when the Model pill first opens.
    private(set) var catalogue: ModelCatalogue?

    private let api: any EngineAPI
    private let sessionId: EngineID
    private var pendingKey: String { "telar.pendingSend.\(sessionId)" }

    init(api: any EngineAPI, sessionId: EngineID) {
        self.api = api
        self.sessionId = sessionId
        sync = SessionSyncEngine(api: api, sessionId: sessionId)
        if let data = UserDefaults.standard.data(forKey: pendingKey) {
            pendingSend = try? JSONDecoder().decode(PendingSend.self, from: data)
        }
    }

    var hasActiveTurn: Bool {
        sync.turns.contains { $0.state.isActive }
    }

    /// A turn the model is executing right now (queued doesn't count) — what
    /// makes "Send now" meaningful and the stop button honest.
    var hasRunningTurn: Bool {
        sync.turns.contains { $0.state == .running || $0.state == .claimed || $0.state == .steering }
    }

    /// The strip above the composer: messages waiting behind the running
    /// turn, plus a `steering` one mid-flight to the worker — it is not in
    /// the transcript yet and must not silently vanish for the seconds the
    /// injection waits for a safe boundary. (The web strip's exact rule.)
    var queuedTurns: [JournalTurn] {
        sync.turns.filter { $0.state == .queued || $0.state == .steering }
    }

    /// Withdraw a queued message — `stop` with its runId, the same call the
    /// web composer makes.
    func withdraw(_ runId: String) async {
        await perform { try await self.api.stop(self.sessionId, runId: runId) }
    }

    /// SEND NOW — the running turn hears it without stopping.
    func promote(_ runId: String) async {
        await perform { try await self.api.promoteTurn(self.sessionId, runId: runId) }
    }

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !pendingAttachments.isEmpty else { return }
        // A still-unsent earlier message keeps its runId; a new message after a
        // success mints a fresh one.
        let pending = pendingSend?.text == trimmed
            ? pendingSend!
            : PendingSend(
                runId: RunID.newRunId(), text: trimmed,
                attachments: pendingAttachments.isEmpty ? nil : pendingAttachments.map(\.id)
            )
        persist(pending)
        await deliver(pending)
    }

    /// Upload one picked file; it joins the next send. Upload failures land in
    /// actionError — the draft is untouched.
    func attach(data: Data, name: String, mediaType: String) async {
        uploading = true
        defer { uploading = false }
        do {
            let attachment = try await api.uploadAttachment(sessionId, name: name, mediaType: mediaType, data: data)
            pendingAttachments.append(attachment)
            actionError = nil
        } catch {
            actionError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func removeAttachment(_ id: EngineID) {
        pendingAttachments.removeAll { $0.id == id }
    }

    /// The Model pill's list — fetched once per open session.
    func loadModels() async {
        guard catalogue == nil, let driver = sync.session?.driver else { return }
        catalogue = try? await api.models(driver: driver)
    }

    /// Change what runs the next turn — model, effort, fast mode, whole. The
    /// instance is the session's own when it has one, else the first enabled
    /// instance for its driver — the engine validates the pair either way.
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
                    effort: choice.effort, fastMode: choice.fastMode
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
        let runId = sync.turns.last { $0.state.isActive }?.runId
        await perform { try await self.api.stop(self.sessionId, runId: runId) }
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
