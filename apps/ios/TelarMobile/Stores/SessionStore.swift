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
    }

    let sync: SessionSyncEngine
    private(set) var pendingSend: PendingSend?
    private(set) var sendError: String?
    private(set) var actionError: String?

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

    /// Messages waiting behind the running turn, oldest first — the strip
    /// above the composer.
    var queuedTurns: [JournalTurn] {
        sync.turns.filter { $0.state == .queued }
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
        guard !trimmed.isEmpty else { return }
        // A still-unsent earlier message keeps its runId; a new message after a
        // success mints a fresh one.
        let pending = pendingSend?.text == trimmed
            ? pendingSend!
            : PendingSend(runId: RunID.newRunId(), text: trimmed)
        persist(pending)
        await deliver(pending)
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
            _ = try await api.submitTurn(sessionId, runId: pending.runId, input: pending.text)
            discardPending()
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
