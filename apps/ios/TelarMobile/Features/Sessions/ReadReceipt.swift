import Foundation

/// WHEN A RESULT COUNTS AS READ — the decision, with no SwiftUI in it.
/// Ported from `apps/web/lib/session-read-receipt.ts`.
///
/// THE PHONE NEVER SENT ONE. The engine models unread as two numbers
/// (`Session.lastTurnSequence` vs `lastReadTurnSequence`) and the cockpit moves
/// the second one when a human has actually been shown an answer. The phone
/// read sessions and confirmed nothing, so on the phone nothing ever became
/// read: the dot stayed lit on both devices, and the settling rule — which
/// refuses to shelve a session with an unread answer — would have kept those
/// rows in the list for good.
///
/// The ways to be dishonest about "shown" are all easy, and the gate is all of
/// them at once, held for a beat:
///
///   - MARKING ON APPEAR. A session view built behind a navigation push, or
///     restored into a scene that is not on screen, has rendered nothing to
///     anybody.
///   - MARKING ON POLL. The sync engine tails the journal every second or
///     three. A receipt on that loop would mark every open session read
///     forever, including one on a phone in a pocket.
///   - MARKING WHILE THE SCENE IS NOT ACTIVE. Backgrounded, in the app
///     switcher, or under a locked screen are all "somebody is elsewhere".
///   - MARKING WHAT IS NOT ON SCREEN. A reader scrolled up to re-read an older
///     answer has not seen the new one at the bottom.
///
/// `receiptToSend` is that rule as one pure function, which is what lets it be
/// tested without a scene.

/// The three fields the rule reads off a turn. Not `JournalTurn`, so a test can
/// build one in a line.
struct ReceiptTurn: Equatable, Sendable {
    var runId: EngineID
    var state: TurnState
    var sequence: Int
}

/// The states that leave AN ANSWER — the same set the engine will accept a
/// receipt for (`isResultTurn` in apps/engine/src/state.ts), spelled here so
/// the phone never sends a turn the engine must refuse.
///
/// `steering`/`steered` are the human's own words on their way into a running
/// turn and are not drawn as turns at all; `discarded` is a dismissed recovery;
/// `ambiguous` is a question for a human, not a result.
func isResultTurn(_ state: TurnState) -> Bool {
    state == .completed || state == .failed || state == .stopped
}

/// The turn a receipt would name: the newest answer in the transcript.
///
/// BY SEQUENCE, not by array position or by a timestamp — the engine's unread
/// comparison is on sequence, so choosing any other way is how a client ends up
/// confirming a turn that leaves the session still unread.
func newestResultTurn(_ turns: [ReceiptTurn]) -> ReceiptTurn? {
    var newest: ReceiptTurn?
    for turn in turns where isResultTurn(turn.state) {
        if newest == nil || turn.sequence > newest!.sequence { newest = turn }
    }
    return newest
}

/// Every condition that must hold at once for a render to count as "seen".
struct ReceiptGate: Equatable, Sendable {
    /// The scene is active. One fact rather than the web's two, because a phone
    /// has no notion of a visible-but-unfocused window: `scenePhase == .active`
    /// is the whole question.
    var foreground: Bool
    /// The end of the newest answer is inside the viewport right now.
    var atLatestResult: Bool
    /// A hydrate is still in flight, so what is on screen may not be this
    /// session's, or may not be current. Nothing is confirmed mid-load.
    var loading: Bool
}

/// Which turn to confirm, if any.
///
/// `confirmedSequence` is what this client has already sent or is sending, and
/// it is deliberately separate from `readSequence` (what the engine last told
/// us): the answer takes a round trip to come back, and without the local
/// high-water mark a visible answer would be reported once per render until it
/// did.
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

/// How long the gate must hold before a receipt is sent.
///
/// A SCROLL PAST IS NOT A READ, and neither is a session that flashes past on
/// the way to another one. Short enough that nobody notices, long enough that
/// the answer was actually on screen.
let receiptSettleMs = 700

/// Retry, but not forever: a receipt is worth almost nothing on its own, and a
/// phone that keeps trying to send one at a Mac that is away is a phone burning
/// its battery on a nicety. Three attempts, then wait for the next time the
/// reader looks at the answer.
let receiptMaxAttempts = 3

/// Backoff for attempt `n` (1-based), in ms. The shift is clamped as well as
/// the result: the budget makes an attempt past 3 unreachable, but a doubling
/// left to run on a wild argument traps rather than saturating.
func receiptRetryDelayMs(attempt: Int) -> Int {
    min(8_000, 1_000 * (1 << min(max(0, attempt - 1), 13)))
}

/// THE TWO FIELDS A RECEIPT MOVES, on their own.
///
/// Not the whole `Session`, because folding the record back would be the bug:
/// the response was built when the receipt was SENT, and a poll that landed in
/// between (a new turn, a title, a settle from the Mac) must not be undone by a
/// bookkeeping call.
struct ReadMark: Equatable, Sendable {
    var sequence: Int?
    var readAt: Timestamp?
}

/// The engine's answer to a receipt, folded into what a surface already holds —
/// or `nil` when it moves nothing and the surface should be left alone.
///
/// MONOTONIC, and this is the whole reason it is a function rather than two
/// assignments. A slow receipt for turn 5 can land after a fast one for turn 6,
/// or after a poll already reported a higher mark set on another device. Taking
/// only a mark that moved FORWARD is the one fold that cannot go backwards.
///
/// A LOWER ANSWER IS DROPPED WHOLE, `readAt` INCLUDED — the stamp belongs to
/// the sequence it arrived with, so keeping it while refusing the sequence
/// would claim a read at a time that never happened. For the same reason an
/// answer with no stamp keeps the one already there rather than clearing it:
/// the mark moved, so the old stamp is the best true thing known about when.
func advancedReadMark(_ current: ReadMark, _ answer: ReadMark) -> ReadMark? {
    guard let next = answer.sequence, next > (current.sequence ?? 0) else { return nil }
    return ReadMark(sequence: next, readAt: answer.readAt ?? current.readAt)
}

extension Session {
    var readMark: ReadMark { ReadMark(sequence: lastReadTurnSequence, readAt: readAt) }

    /// Fold a receipt's answer in, monotonically. Returns whether anything
    /// moved, so a caller can skip publishing an identical value.
    @discardableResult mutating func applyReadMark(_ answer: ReadMark) -> Bool {
        guard let advanced = advancedReadMark(readMark, answer) else { return false }
        lastReadTurnSequence = advanced.sequence
        readAt = advanced.readAt
        return true
    }
}

/// WHOSE SESSION THIS IS. Both halves, always.
///
/// A session id is unique per ENGINE, not per phone: two paired Macs can mint
/// the same one. Everything below is keyed on the pair, so a receipt raised on
/// one Mac's session can never be applied to another Mac's session that happens
/// to share its id.
struct ReceiptIdentity: Equatable, Sendable {
    var sessionId: EngineID
    var hostId: HostID?
}

/// THE PART A PURE FUNCTION CANNOT HOLD: what is in flight, for whom.
///
/// `receiptToSend` answers "should this render confirm anything". Everything
/// that goes wrong afterwards is about TIME — a request outliving the thing it
/// was about — and these are the web courier's hazards that also apply here:
///
///   - A RECEIPT OUTLIVING ITS SESSION. SwiftUI reuses a detail view across
///     selections, so a request raised on A can resolve while B is on screen.
///     Every send carries the generation it was raised in, and a generation
///     that is no longer current is dropped on the floor.
///   - A RECEIPT OUTLIVING ITS MAC. Same session id on a different Mac is a
///     DIFFERENT session, so the generation is keyed on the pair.
///   - AN OLD FAILURE UNDOING A NEW SUCCESS. The high-water mark only ever
///     moves FORWARD: a success raises it, and a failure merely stops counting
///     its own attempt as in flight.
///
/// The web's `ReceiptCourier` also carries a timer port so its tests can drive
/// it; here the dwell is a cancellable `Task` and the pure rule is what the
/// tests drive, which is the same split arrived at from the other end.
@MainActor final class ReadReceiptCourier {
    private let send: @Sendable (ReceiptIdentity, EngineID) async throws -> Session
    private let onRead: (ReceiptIdentity, Session) -> Void

    /// Bumped whenever the identity changes. Anything raised under an older one
    /// is stale by definition.
    private var generation = 0
    private var identity: ReceiptIdentity?
    /// The highest sequence the ENGINE has confirmed to this courier. Monotonic
    /// within a generation, and reset with it.
    private var confirmed = 0
    /// Sequences currently being sent, by run id — counted as "already claimed"
    /// so a re-render does not send a second copy, and removed on either
    /// outcome so a failure does not claim one forever.
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

    /// Re-evaluate against the current world. Called from the view's `onChange`.
    func update(identity: ReceiptIdentity?, candidate: ReceiptTurn?, readSequence: Int?, gate: ReceiptGate) {
        if identity != self.identity { reset(to: identity) }
        // THE READER LOOKING AGAIN IS A FRESH START. The attempt budget exists
        // to stop a retry loop against a Mac that is away, not to give up on
        // the session for good — so a gate that closes and re-opens (they
        // scrolled back to the answer, or came back to the app) hands it back.
        let open = gate.foreground && gate.atLatestResult
        if open && !lastGateOpen { attempts.removeAll() }
        lastGateOpen = open
        evaluate(candidate: candidate, readSequence: readSequence, gate: gate)
    }

    /// Stop everything. A courier is never reused after this.
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

    /// The high-water mark `receiptToSend` is given — what is confirmed, plus
    /// what is on its way.
    private func claimed() -> Int {
        max(confirmed, inFlight.values.max() ?? 0)
    }

    private func evaluate(candidate: ReceiptTurn?, readSequence: Int?, gate: ReceiptGate) {
        // A pending send is cancelled on EVERY re-evaluation and re-armed below
        // if it still applies. That is what makes the settle window a DWELL:
        // scrolling away, or backgrounding the app, before it elapses sends
        // nothing.
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
                // STALE MEANS GONE. Not "apply carefully" — the session this
                // was about is not the session on screen.
                guard generation == self.generation else { return }
                self.inFlight[pending.runId] = nil
                self.confirmed = max(self.confirmed, pending.sequence)
                self.attempts[pending.runId] = nil
                self.onRead(identity, session)
            } catch {
                guard generation == self.generation else { return }
                // Only the claim is released. `confirmed` is never lowered, so
                // a slow failure cannot undo a fast success for a later turn.
                self.inFlight[pending.runId] = nil
            }
        }
    }
}
