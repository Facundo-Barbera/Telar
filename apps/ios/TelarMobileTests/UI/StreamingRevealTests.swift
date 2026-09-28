import Foundation
import Testing
@testable import TelarMobile

private struct Frame {
    var at: Double
    var target: Int
    var seen: Int
}

private struct Arrival {
    var at: Double
    var grew: Int
}

private func runFrames(_ arrivals: [Arrival], until: Double, step: Double = 16.7) -> (frames: [Frame], state: RevealState) {
    var state = revealState(0, 0)
    var target = 0
    var frames: [Frame] = []
    var now = step
    while now <= until {
        for arrival in arrivals where arrival.at > now - step && arrival.at <= now { target += arrival.grew }
        state = stepReveal(state, target, now)
        frames.append(Frame(at: now, target: target, seen: revealText(String(repeating: "x", count: target), state.shown).count))
        now += step
    }
    return (frames, state)
}

private func worstAge(_ arrivals: [Arrival], _ frames: [Frame]) -> Double {
    var worst: Double = 0
    for frame in frames {
        var end = 0
        for arrival in arrivals {
            if arrival.at > frame.at { break }
            end += arrival.grew
            if end > frame.seen {
                worst = max(worst, frame.at - arrival.at)
                break
            }
        }
    }
    return worst
}

@Suite struct StreamingRevealTests {
    let reveal = RevealConfig.standard

    @Test func aBurstIsSpreadAcrossAWindowNotDrainedInAFrame() {
        let arrivals = (0..<8).map { Arrival(at: Double($0) * 250 + 1, grew: 5) }
        let (frames, _) = runFrames(arrivals, until: 2600)
        #expect(frames[2].seen < 5)
        #expect(frames[9].seen < 5)
        #expect(frames.first { $0.at >= 1 + reveal.maxLagMs }!.seen >= 5)
    }

    @Test func theSustainedPaceTracksASlowStreamInsteadOfBurstingPastIt() {
        let arrivals = (0..<20).map { Arrival(at: Double($0) * 600 + 1, grew: 6) }
        let (frames, _) = runFrames(arrivals, until: 12_600)
        let warm = frames.filter { $0.at > 3000 }
        let cap = Int((10 * reveal.drainSlack.max * 100 / 1000).rounded(.up)) + 1
        for (index, frame) in warm.enumerated() {
            let within = warm[index...].prefix { $0.at <= frame.at + 100 }
            #expect(within.last!.seen - frame.seen <= cap)
        }
    }

    @Test func theReserveKeepsTextMovingThroughAChunkGap() {
        let arrivals = (0..<20).map { Arrival(at: Double($0) * 600 + 1, grew: 6) }
        let (frames, _) = runFrames(arrivals, until: 12_000)
        let inGap = frames.filter { $0.at >= 6051 && $0.at <= 6551 }
        #expect(inGap.last!.seen > inGap[0].seen)
    }

    @Test func continuousArrivalNoCharacterWaitsLongerThanMaxLag() {
        let arrivals = (0..<60).map { Arrival(at: Double($0) * 100 + 1, grew: 12) }
        let (frames, _) = runFrames(arrivals, until: 6000 + reveal.maxLagMs + 100)
        #expect(worstAge(arrivals, frames) <= reveal.maxLagMs + 17)
        #expect(frames.last!.seen == 720)
    }

    @Test func aLargeBurstFollowedByATrickleNeitherStarvesTheOther() {
        let arrivals = [Arrival(at: 1, grew: 800)]
            + (0..<20).map { Arrival(at: 300 + Double($0) * 120, grew: 3) }
        let (frames, _) = runFrames(arrivals, until: 2580 + reveal.maxLagMs + 100)
        #expect(frames[0].seen < 800)
        #expect(worstAge(arrivals, frames) <= reveal.maxLagMs + 17)
        #expect(frames.last!.seen == 860)
    }

    @Test func aChunkKeepsItsOwnDeadlineWhileNewerTextKeepsArriving() {
        let arrivals = [Arrival(at: 1, grew: 5)]
            + (0..<30).map { Arrival(at: 20 + Double($0) * 20, grew: 4) }
        let (frames, _) = runFrames(arrivals, until: 1 + reveal.maxLagMs + 400)
        #expect(frames.first { $0.at >= 1 + reveal.maxLagMs }!.seen >= 5)
    }

    @Test func idleTimeIsNotChargedToAChunkThatHadNotArrivedYet() {
        let state = stepReveal(revealState(5, 0), 10, 1000)
        #expect(state.shown < 10)
    }

    @Test func anOverdueChunkFlushesItselfNotTheFreshTextBehindIt() {
        let late = reveal.maxLagMs + 10
        let state = stepReveal(
            RevealState(shown: 0, target: 5, pending: [Pending(end: 5, at: 0)], last: late - 60),
            805, late
        )
        #expect(state.shown >= 5)
        #expect(state.shown < 805)
    }

    @Test func theFirstChunkIsNotPacedFromOneFramesDelta() {
        let (frames, _) = runFrames([Arrival(at: 1, grew: 5)], until: 60)
        #expect(frames[0].seen < 5)
    }

    @Test func pacingFollowsTheClockNotTheFrameCount() {
        func at(_ step: Double, _ until: Double) -> Int {
            runFrames([Arrival(at: 1, grew: 100)], until: until, step: step).frames.last!.seen
        }
        let coarse = abs(at(16.7, 200) - at(8.3, 200))
        let fine = abs(at(8.3, 200) - at(4.15, 200))
        #expect(fine <= coarse)
        let done = 1 + reveal.maxLagMs + 20
        #expect(at(16.7, done) == 100)
        #expect(at(8.3, done) == 100)
        #expect(at(4.15, done) == 100)
    }

    @Test func aBackgroundedAppReturnsShowingEverythingNotAnimatingIt() {
        var state = stepReveal(revealState(0, 0), 5000, 16)
        state = stepReveal(state, 5000, 30_000)
        #expect(state.shown == 5000)
    }

    @Test func aShorterReplacementRestartsRatherThanRewinds() {
        let state = stepReveal(
            RevealState(shown: 400, target: 400, pending: [Pending(end: 400, at: 0)], last: 0),
            12, 16
        )
        #expect(state.shown == 12)
        #expect(state.target == 12)
        #expect(state.pending.isEmpty)
    }

    @Test func onlyPrefixesAreEverRenderedAndTheLastOneIsEverything() {
        let source = "The quick brown fox jumps over the lazy dog."
        var state = revealState(0, 0)
        var now = 16.7
        while now < 16.7 + reveal.maxLagMs + 40 {
            state = stepReveal(state, source.count, now)
            #expect(source.hasPrefix(revealText(source, state.shown)))
            now += 16.7
        }
        #expect(revealText(source, state.shown) == source)
    }

    @Test func anEmojiIsNeverCutInHalfAtAnyPosition() {
        let source = "hi 👋🏽 there"
        for shown in 0...source.count {
            #expect(source.hasPrefix(revealText(source, Double(shown))))
        }
    }

    @Test func aReplacementIsDetectedByContentNotLength() {
        #expect(isReplacement("hello world", 5, "goodbye"))
        #expect(!isReplacement("hello world", 5, "hello world and more"))
        #expect(isReplacement("hello world", 11, "hello WORLD"))
    }

    @Test func oneSecondsWorthOfDeltasArrivingAtOnceIsSpreadNotPainted() {
        let (frames, state) = runFrames([Arrival(at: 1, grew: 437)], until: 1 + reveal.maxLagMs + 40)
        let visible = frames.filter { $0.seen > 0 && $0.seen < 437 }
        #expect(visible.count > 10)
        #expect(revealText(String(repeating: "x", count: 437), state.shown).count == 437)
    }
}
