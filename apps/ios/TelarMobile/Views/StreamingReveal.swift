import Foundation

/// Presentation-only pacing for streamed text. Port of
/// `apps/web/lib/streaming-reveal.ts` — same constants, same arithmetic, same
/// invariants, so both clients reveal a reply at the same rate.
///
/// WHY THE PHONE NEEDS ONE AT ALL. The transport is a poll: `SessionSyncEngine`
/// tails once a second while a turn is active, so a second of deltas arrives in
/// one page and the fold hands the view the whole second at once. The engine's
/// own pacing is fine — measured at a 19ms median gap between deltas — but none
/// of that survives the poll. The web has paced the resulting burst since
/// b0f61ba1; the phone painted it raw, so a reply short enough to finish inside
/// one poll arrived as a SINGLE BLOCK with no streaming visible at all. Every
/// wake acknowledgement is that short.
///
/// THE SUSTAINED PACE TRACKS THE ESTIMATED ARRIVAL RATE, holding a small
/// RESERVE of unshown text. Each frame:
///
///   sustained = arrival × clamp(backlog / reserve, drainSlack.min, drainSlack.max)
///
/// At steady state backlog ≈ reserve and text moves at the source's own rate;
/// when a burst lands the multiplier tops out at `drainSlack.max` — catch-up is
/// CAPPED at a small multiple of the felt rate instead of overpowering it — and
/// when a gap starves the backlog the multiplier floors at `drainSlack.min`, a
/// crawl that spends the reserve bridging the silence.
///
/// EVERY CHUNK STILL CARRIES ITS OWN DEADLINE, as the latency bound: a chunk
/// that arrived at `t` is fully shown by `t + maxLagMs` whatever the estimate
/// got wrong — one shared window reset by each arrival would let a busy stream
/// postpone old text forever.
///
/// INVARIANTS. Only prefixes of `target` are rendered; every exit ends at
/// `target`; no chunk outlives its deadline.
struct RevealConfig {
    struct DrainSlack {
        var min: Double
        var max: Double
    }

    /// THE BOUND, NOT THE PACE: a chunk is fully shown within this of ITS OWN
    /// arrival, however wrong the rate estimate is.
    var maxLagMs: Double
    /// The reserve the pacer holds to bridge chunk gaps, as time at the arrival
    /// rate — the intentional added latency, well under `maxLagMs`.
    var reserveMs: Double
    /// The reserve floor in characters. Two, not more: at 5 chars/s every floor
    /// character is 200ms of added latency.
    var reserveFloorChars: Double
    /// How far the sustained rate may deviate from the arrival estimate to
    /// manage the reserve: the floor keeps a crawl through gaps, the cap is the
    /// most catch-up may exceed the felt rate.
    var drainSlack: DrainSlack
    /// Weight of the newest interval sample in the arrival estimate.
    var arrivalWeight: Double

    static let standard = RevealConfig(
        maxLagMs: 1200,
        reserveMs: 450,
        reserveFloorChars: 2,
        drainSlack: DrainSlack(min: 0.25, max: 2),
        arrivalWeight: 0.3
    )
}

/// Text through `end` characters, which arrived at `at`.
struct Pending: Equatable {
    var end: Int
    var at: Double
}

struct RevealState: Equatable {
    /// FRACTIONAL: a whole-character floor per frame is 30 chars/s at the frame
    /// rate below, which outruns a slow stream and then stalls.
    var shown: Double
    var target: Int
    var pending: [Pending]
    /// Timestamp of the previous step, in milliseconds.
    var last: Double
    /// Timestamp of the previous arrival, for interval sampling.
    var arrivedAt: Double?
    /// Characters per second. Nil until two arrivals have been seen.
    var arrival: Double?

    init(shown: Double, target: Int, pending: [Pending], last: Double, arrivedAt: Double? = nil, arrival: Double? = nil) {
        self.shown = shown
        self.target = target
        self.pending = pending
        self.last = last
        self.arrivedAt = arrivedAt
        self.arrival = arrival
    }
}

func revealState(_ length: Int, _ now: Double = 0) -> RevealState {
    RevealState(shown: Double(length), target: length, pending: [], last: now)
}

/// Pace what is already outstanding up to `now`. Takes no target: idle time
/// belongs to the text that was waiting through it, never to a chunk that has
/// not arrived yet.
func advanceReveal(_ state: RevealState, _ now: Double, _ config: RevealConfig = .standard) -> RevealState {
    let elapsed = max(0, now - state.last)
    let pending = state.pending.filter { Double($0.end) > state.shown }
    if pending.isEmpty {
        return RevealState(
            shown: Double(state.target), target: state.target, pending: [], last: now,
            arrivedAt: state.arrivedAt, arrival: state.arrival
        )
    }

    // An overdue chunk is shown in full — but only THAT chunk. Flushing to the
    // whole target would drag every fresh character out with it.
    var base = state.shown
    for chunk in pending where chunk.at + config.maxLagMs - now <= 0 {
        base = max(base, Double(chunk.end))
    }

    // The worst case across the rest: whichever is closest to its own deadline
    // sets the BOUND rate, so a later arrival cannot postpone an earlier one.
    var required: Double = 0
    for chunk in pending {
        let left = chunk.at + config.maxLagMs - now
        if left > 0, Double(chunk.end) > base {
            required = max(required, (Double(chunk.end) - base) * 1000 / left)
        }
    }
    // The SUSTAINED rate: the arrival estimate, steered by how the backlog
    // compares to the reserve it should hold. Zero until two arrivals exist;
    // the deadlines pace the opening on their own.
    var sustained: Double = 0
    if let arrival = state.arrival {
        let backlog = Double(state.target) - max(base, state.shown)
        let reserve = max(config.reserveFloorChars, arrival * config.reserveMs / 1000)
        let pressure = min(config.drainSlack.max, max(config.drainSlack.min, backlog / reserve))
        sustained = arrival * pressure
    }
    let rate = max(required, sustained)
    let shown = min(Double(state.target), max(base, state.shown + rate * elapsed / 1000))
    return RevealState(
        shown: shown, target: state.target,
        pending: pending.filter { Double($0.end) > shown }, last: now,
        arrivedAt: state.arrivedAt, arrival: state.arrival
    )
}

/// Record text that has just arrived. Separate from pacing so the interval
/// before it is not charged against it.
func ingestReveal(_ state: RevealState, _ target: Int, _ now: Double, _ config: RevealConfig = .standard) -> RevealState {
    if Double(target) < state.shown { return revealState(target, now) }
    if target <= state.target { return state }
    // Sampled over the real interval between arrivals, so it reflects the
    // source rather than the frame that noticed it.
    var arrival = state.arrival
    if let arrivedAt = state.arrivedAt, now > arrivedAt {
        let sample = Double(target - state.target) * 1000 / (now - arrivedAt)
        arrival = arrival.map { $0 * (1 - config.arrivalWeight) + sample * config.arrivalWeight } ?? sample
    }
    return RevealState(
        shown: state.shown, target: target,
        pending: state.pending + [Pending(end: target, at: now)], last: state.last,
        arrivedAt: now, arrival: arrival
    )
}

/// Advance to `now`, then take whatever arrived at `now`. Pure: tests drive the
/// clock.
func stepReveal(_ state: RevealState, _ target: Int, _ now: Double, _ config: RevealConfig = .standard) -> RevealState {
    if Double(target) < state.shown { return revealState(target, now) }
    return ingestReveal(advanceReveal(state, now, config), target, now, config)
}

/// The prefix to render. `prefix` counts CHARACTERS — Swift grapheme clusters —
/// so unlike the web's UTF-16 walk this cannot split an emoji, a skin-tone
/// sequence or a combining mark, and needs no guard for it. `target` is
/// measured the same way, so `shown` and `count` speak one unit.
func revealText(_ target: String, _ shown: Double) -> String {
    let end = Int(max(0, shown).rounded(.down))
    if end >= target.count { return target }
    return String(target.prefix(end))
}

/// Whether `target` replaces what is on screen rather than continuing it.
///
/// LENGTH CANNOT DETECT ONE: a revised answer of the same or greater length
/// would otherwise render a prefix of the NEW text using the OLD progress —
/// words in an order the model never wrote.
func isReplacement(_ rendered: String, _ shown: Double, _ target: String) -> Bool {
    !target.hasPrefix(revealText(rendered, shown))
}
