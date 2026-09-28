import Foundation

struct RevealConfig {
    struct DrainSlack {
        var min: Double
        var max: Double
    }

    var maxLagMs: Double

    var reserveMs: Double

    var reserveFloorChars: Double

    var drainSlack: DrainSlack

    var arrivalWeight: Double

    static let standard = RevealConfig(
        maxLagMs: 1200,
        reserveMs: 450,
        reserveFloorChars: 2,
        drainSlack: DrainSlack(min: 0.25, max: 2),
        arrivalWeight: 0.3
    )
}

struct Pending: Equatable {
    var end: Int
    var at: Double
}

struct RevealState: Equatable {
    var shown: Double
    var target: Int
    var pending: [Pending]

    var last: Double

    var arrivedAt: Double?

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

func advanceReveal(_ state: RevealState, _ now: Double, _ config: RevealConfig = .standard) -> RevealState {
    let elapsed = max(0, now - state.last)
    let pending = state.pending.filter { Double($0.end) > state.shown }
    if pending.isEmpty {
        return RevealState(
            shown: Double(state.target), target: state.target, pending: [], last: now,
            arrivedAt: state.arrivedAt, arrival: state.arrival
        )
    }

    var base = state.shown
    for chunk in pending where chunk.at + config.maxLagMs - now <= 0 {
        base = max(base, Double(chunk.end))
    }

    var required: Double = 0
    for chunk in pending {
        let left = chunk.at + config.maxLagMs - now
        if left > 0, Double(chunk.end) > base {
            required = max(required, (Double(chunk.end) - base) * 1000 / left)
        }
    }

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

func ingestReveal(_ state: RevealState, _ target: Int, _ now: Double, _ config: RevealConfig = .standard) -> RevealState {
    if Double(target) < state.shown { return revealState(target, now) }
    if target <= state.target { return state }

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

func stepReveal(_ state: RevealState, _ target: Int, _ now: Double, _ config: RevealConfig = .standard) -> RevealState {
    if Double(target) < state.shown { return revealState(target, now) }
    return ingestReveal(advanceReveal(state, now, config), target, now, config)
}

func revealText(_ target: String, _ shown: Double) -> String {
    let end = Int(max(0, shown).rounded(.down))
    if end >= target.count { return target }
    return String(target.prefix(end))
}

func isReplacement(_ rendered: String, _ shown: Double, _ target: String) -> Bool {
    !target.hasPrefix(revealText(rendered, shown))
}
