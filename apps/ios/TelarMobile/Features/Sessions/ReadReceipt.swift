import Foundation

struct ReceiptTurn: Equatable, Sendable {
    var runId: EngineID
    var state: TurnState
    var sequence: Int
}

func isResultTurn(_ state: TurnState) -> Bool {
    state == .completed || state == .failed || state == .stopped
}

func newestResultTurn(_ turns: [ReceiptTurn]) -> ReceiptTurn? {
    var newest: ReceiptTurn?
    for turn in turns where isResultTurn(turn.state) {
        if newest == nil || turn.sequence > newest!.sequence { newest = turn }
    }
    return newest
}

struct ReceiptGate: Equatable, Sendable {
    var foreground: Bool

    var atLatestResult: Bool

    var loading: Bool
}

func receiptToSend(
    candidate: ReceiptTurn?,
    readSequence: Int?,
    confirmedSequence: Int?,
    gate: ReceiptGate
) -> ReceiptTurn? {
    guard let candidate, !gate.loading, gate.foreground, gate.atLatestResult else { return nil }
    let known = max(readSequence ?? 0, confirmedSequence ?? 0)
    return candidate.sequence > known ? candidate : nil
}

let receiptSettleMs = 700

let receiptMaxAttempts = 3

func receiptRetryDelayMs(attempt: Int) -> Int {
    min(8_000, 1_000 * (1 << min(max(0, attempt - 1), 13)))
}

struct ReadMark: Equatable, Sendable {
    var sequence: Int?
    var readAt: Timestamp?
}

func advancedReadMark(_ current: ReadMark, _ answer: ReadMark) -> ReadMark? {
    guard let next = answer.sequence, next > (current.sequence ?? 0) else { return nil }
    return ReadMark(sequence: next, readAt: answer.readAt ?? current.readAt)
}

extension Session {
    var readMark: ReadMark { ReadMark(sequence: lastReadTurnSequence, readAt: readAt) }

    @discardableResult mutating func applyReadMark(_ answer: ReadMark) -> Bool {
        guard let advanced = advancedReadMark(readMark, answer) else { return false }
        lastReadTurnSequence = advanced.sequence
        readAt = advanced.readAt
        return true
    }
}

struct ReceiptIdentity: Equatable, Sendable {
    var sessionId: EngineID
    var hostId: HostID?
}

@MainActor final class ReadReceiptCourier {
    private let send: @Sendable (ReceiptIdentity, EngineID) async throws -> Session
    private let onRead: (ReceiptIdentity, Session) -> Void

    private var generation = 0
    private var identity: ReceiptIdentity?

    private var confirmed = 0

    private var inFlight: [EngineID: Int] = [:]
    private var attempts: [EngineID: Int] = [:]
    private var dwell: Task<Void, Never>?
    private var lastGateOpen = false

    init(
        send: @escaping @Sendable (ReceiptIdentity, EngineID) async throws -> Session,
        onRead: @escaping (ReceiptIdentity, Session) -> Void
    ) {
        self.send = send
        self.onRead = onRead
    }

    func update(identity: ReceiptIdentity?, candidate: ReceiptTurn?, readSequence: Int?, gate: ReceiptGate) {
        if identity != self.identity { reset(to: identity) }

        let open = gate.foreground && gate.atLatestResult
        if open && !lastGateOpen { attempts.removeAll() }
        lastGateOpen = open
        evaluate(candidate: candidate, readSequence: readSequence, gate: gate)
    }

    func dispose() {
        generation += 1
        dwell?.cancel()
        dwell = nil
    }

    private func reset(to identity: ReceiptIdentity?) {
        generation += 1
        self.identity = identity
        confirmed = 0
        inFlight.removeAll()
        attempts.removeAll()
        lastGateOpen = false
        dwell?.cancel()
        dwell = nil
    }

    private func claimed() -> Int {
        max(confirmed, inFlight.values.max() ?? 0)
    }

    private func evaluate(candidate: ReceiptTurn?, readSequence: Int?, gate: ReceiptGate) {
        dwell?.cancel()
        dwell = nil
        guard let identity else { return }
        guard let pending = receiptToSend(
            candidate: candidate, readSequence: readSequence,
            confirmedSequence: claimed(), gate: gate
        ) else { return }
        let spent = attempts[pending.runId] ?? 0
        guard spent < receiptMaxAttempts else { return }
        let generation = self.generation
        let delay = spent == 0 ? receiptSettleMs : receiptRetryDelayMs(attempt: spent)
        dwell = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delay))
            guard !Task.isCancelled, let self, generation == self.generation else { return }
            self.dwell = nil
            self.attempts[pending.runId] = spent + 1
            self.inFlight[pending.runId] = pending.sequence
            do {
                let session = try await self.send(identity, pending.runId)

                guard generation == self.generation else { return }
                self.inFlight[pending.runId] = nil
                self.confirmed = max(self.confirmed, pending.sequence)
                self.attempts[pending.runId] = nil
                self.onRead(identity, session)
            } catch {
                guard generation == self.generation else { return }

                self.inFlight[pending.runId] = nil
            }
        }
    }
}
