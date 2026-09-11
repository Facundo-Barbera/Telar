import Foundation
import Testing
@testable import TelarMobile

/// The web's `apps/web/lib/streaming-reveal.test.ts`, vector for vector. The
/// pacer is a PORT, so the tests are the parity check: if one client's pacing
/// drifts from the other's, one of these fails.

/// A fake clock over RENDERED characters. `state.shown` is fractional and
/// always "moves"; what a reader experiences is `revealText`, so that is what
/// counts.
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

/// The oldest character still unshown at each frame, in ms of age.
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
        // THE REPORTED STUTTER, MEASURED. Unpaced rendering shows [5,5,5,…]:
        // the whole burst on frame one, then a flat quarter second.
        let arrivals = (0..<8).map { Arrival(at: Double($0) * 250 + 1, grew: 5) }
        let (frames, _) = runFrames(arrivals, until: 2600)
        #expect(frames[2].seen < 5)
        #expect(frames[9].seen < 5)
        // The opening chunk is fully out by its own bound.
        #expect(frames.first { $0.at >= 1 + reveal.maxLagMs }!.seen >= 5)
    }

    @Test func theSustainedPaceTracksASlowStreamInsteadOfBurstingPastIt() {
        // At a steady 10 chars/s, once the estimate has warmed up, no 100ms
        // window may reveal more than drainSlack.max × the source rate —
        // catch-up is capped, never a flash of a whole chunk.
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
        // Unpaced, the screen sits dead between arrivals. A warmed-up pacer
        // holds a reserve and spends it: inside a 600ms gap there is movement.
        let arrivals = (0..<20).map { Arrival(at: Double($0) * 600 + 1, grew: 6) }
        let (frames, _) = runFrames(arrivals, until: 12_000)
        let inGap = frames.filter { $0.at >= 6051 && $0.at <= 6551 }
        #expect(inGap.last!.seen > inGap[0].seen)
    }

    @Test func continuousArrivalNoCharacterWaitsLongerThanMaxLag() {
        // THE CONTRACT. A later chunk must never postpone an earlier one.
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
        // 5 characters, then a steady stream. The first five must still be
        // shown within their own window rather than pushed along by newcomers.
        let arrivals = [Arrival(at: 1, grew: 5)]
            + (0..<30).map { Arrival(at: 20 + Double($0) * 20, grew: 4) }
        let (frames, _) = runFrames(arrivals, until: 1 + reveal.maxLagMs + 400)
        #expect(frames.first { $0.at >= 1 + reveal.maxLagMs }!.seen >= 5)
    }

    @Test func idleTimeIsNotChargedToAChunkThatHadNotArrivedYet() {
        // Caught up, a second of silence, then five characters. That second
        // belonged to nothing outstanding; spending it on the new chunk shows
        // the whole thing instantly.
        let state = stepReveal(revealState(5, 0), 10, 1000)
        #expect(state.shown < 10)
    }

    @Test func anOverdueChunkFlushesItselfNotTheFreshTextBehindIt() {
        // Five characters past their deadline, and 800 that arrived this
        // instant. Flushing to the whole target drags the new 800 out too.
        let late = reveal.maxLagMs + 10
        let state = stepReveal(
            RevealState(shown: 0, target: 5, pending: [Pending(end: 5, at: 0)], last: late - 60),
            805, late
        )
        #expect(state.shown >= 5)
        #expect(state.shown < 805)
    }

    @Test func theFirstChunkIsNotPacedFromOneFramesDelta() {
        // Measuring 5 characters against 16ms reports 300/s and drains instantly.
        let (frames, _) = runFrames([Arrival(at: 1, grew: 5)], until: 60)
        #expect(frames[0].seen < 5)
    }

    @Test func pacingFollowsTheClockNotTheFrameCount() {
        // A mid-window sample differs slightly between refresh rates because
        // the same continuous curve is stepped at different resolutions. Drift
        // would GROW as the step shrinks; discretization shrinks. Both must
        // also finish together, which is the part a reader sees.
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
        // Swift's `prefix` cuts on grapheme clusters, so this holds by
        // construction where the web needs an explicit surrogate guard.
        let source = "hi 👋🏽 there"
        for shown in 0...source.count {
            #expect(source.hasPrefix(revealText(source, Double(shown))))
        }
    }

    @Test func aReplacementIsDetectedByContentNotLength() {
        // LENGTH CANNOT DETECT ONE: a revised answer of the same or greater
        // length would render a prefix of the NEW text at the OLD progress.
        #expect(isReplacement("hello world", 5, "goodbye"))
        #expect(!isReplacement("hello world", 5, "hello world and more"))
        #expect(isReplacement("hello world", 11, "hello WORLD"))
    }

    /// THE BUG THIS FIXES, as the journal recorded it. A wake reply of 437
    /// characters streamed out of the engine over 992ms; the phone tails once a
    /// second, so the fold handed the view the whole thing in one arrival.
    /// Unpaced that is one paint. Paced, it is spread over frames.
    @Test func oneSecondsWorthOfDeltasArrivingAtOnceIsSpreadNotPainted() {
        let (frames, state) = runFrames([Arrival(at: 1, grew: 437)], until: 1 + reveal.maxLagMs + 40)
        let visible = frames.filter { $0.seen > 0 && $0.seen < 437 }
        #expect(visible.count > 10)
        #expect(revealText(String(repeating: "x", count: 437), state.shown).count == 437)
    }
}
