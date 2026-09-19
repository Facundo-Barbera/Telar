import Foundation
import Testing
@testable import TelarMobile

/// HANDING BACK ONLY WHAT WAS TAKEN (#623).
///
/// The bug this pins: leaving a Telar conversation deactivated the phone's
/// shared audio session with `.notifyOthersOnDeactivation` whether or not
/// dictation had ever run, so a podcast reacted every time somebody walked out
/// of a conversation they had only been reading.
///
/// WHAT THIS CANNOT COVER is the thing that was reported. "The music was
/// unaffected" is audible, on a device, with something playing; no test here
/// reaches `AVAudioSession` at all. What it does cover is the rule underneath —
/// that a session never taken is never given back, and that every path which
/// did take one still gives it back.
private enum SessionRefusal: Error { case refused }

@Suite @MainActor struct AudioSessionClaimTests {
    /// Counts the two calls the real claim makes on `AVAudioSession`, and can
    /// be told to fail either — both failures are load-bearing below.
    @MainActor private final class Session {
        var activations = 0
        var deactivations = 0
        var refuseTake = false
        var refuseHandBack = false

        func claim() -> AudioSessionClaim {
            AudioSessionClaim(
                activate: {
                    if self.refuseTake { throw SessionRefusal.refused }
                    self.activations += 1
                },
                deactivate: {
                    if self.refuseHandBack { throw SessionRefusal.refused }
                    self.deactivations += 1
                }
            )
        }
    }

    @Test func aSessionNeverTakenIsNeverHandedBack() {
        // THE REPORTED BUG, in one assertion. `Dictation.stop()` reaches this
        // on every `.onDisappear`, and on the overwhelmingly common path no
        // category was ever set and nothing was ever activated.
        let session = Session()
        let claim = session.claim()

        claim.handBack()

        #expect(session.deactivations == 0)
        #expect(claim.isHeld == false)
    }

    @Test func leavingRepeatedlyWithoutDictatingStaysSilent() {
        // Opening and leaving four conversations is four `stop()`s. None of
        // them is this app's to announce to the rest of the phone.
        let session = Session()
        let claim = session.claim()

        for _ in 0..<4 { claim.handBack() }

        #expect(session.deactivations == 0)
    }

    @Test func aSessionTakenIsHandedBack() throws {
        // The other half of the rule, and the reason the line exists at all:
        // ducked audio has to come back up after a real dictation.
        let session = Session()
        let claim = session.claim()

        try claim.take()
        #expect(claim.isHeld)
        claim.handBack()

        #expect(session.activations == 1)
        #expect(session.deactivations == 1)
        #expect(claim.isHeld == false)
    }

    @Test func handingBackTwiceDeactivatesOnce() {
        // `stop()` is called from the socket's failure path AND from
        // `.onDisappear`, so a dictation that dropped and was then left is two
        // teardowns over one session.
        let session = Session()
        let claim = session.claim()

        try? claim.take()
        claim.handBack()
        claim.handBack()

        #expect(session.deactivations == 1)
    }

    @Test func aTakeThatFailedClaimsNothing() {
        // `setActive(true)` that throws left the session as it found it. A
        // claim recorded here would hand back somebody else's.
        let session = Session()
        session.refuseTake = true
        let claim = session.claim()

        #expect(throws: SessionRefusal.self) { try claim.take() }
        #expect(claim.isHeld == false)

        claim.handBack()
        #expect(session.deactivations == 0)
    }

    @Test func aFailedHandBackKeepsTheClaimForTheNextTeardown() throws {
        // Deactivation throws while the session is still busy — which means it
        // is still ours. Of the two ways to be wrong, leaving it active is the
        // worse one, so the claim survives and the next `stop()` retries.
        let session = Session()
        let claim = session.claim()

        try claim.take()
        session.refuseHandBack = true
        claim.handBack()
        #expect(claim.isHeld)
        #expect(session.deactivations == 0)

        session.refuseHandBack = false
        claim.handBack()

        #expect(session.deactivations == 1)
        #expect(claim.isHeld == false)
    }

    @Test func aStartAbandonedAfterActivatingStillHandsItBack() throws {
        // THE `generation` FENCE CASE. A start cancelled after `open()` had
        // already activated runs `stop()` on this same object — the claim is
        // instance state, not generation state, so the abandoned start's
        // session is exactly what that teardown finds and releases.
        let session = Session()
        let claim = session.claim()

        try claim.take()   // the start that was about to be abandoned
        claim.handBack()   // the `stop()` the stale guard calls

        #expect(session.deactivations == 1)
        #expect(claim.isHeld == false)
    }

    @Test func aSecondTakeOverTheSameSessionNeedsOneHandBack() throws {
        // There is only ever one shared session. Two takes are not two claims,
        // and a handback count that grew with them would be this app talking to
        // the rest of the phone about a session it had already returned.
        let session = Session()
        let claim = session.claim()

        try claim.take()
        try claim.take()
        claim.handBack()

        #expect(session.deactivations == 1)
        #expect(claim.isHeld == false)
    }
}
