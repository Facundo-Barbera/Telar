import Foundation
import Testing
@testable import TelarMobile

private enum SessionRefusal: Error { case refused }

@Suite @MainActor struct AudioSessionClaimTests {
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
        let session = Session()
        let claim = session.claim()

        claim.handBack()

        #expect(session.deactivations == 0)
        #expect(claim.isHeld == false)
    }

    @Test func leavingRepeatedlyWithoutDictatingStaysSilent() {
        let session = Session()
        let claim = session.claim()

        for _ in 0..<4 { claim.handBack() }

        #expect(session.deactivations == 0)
    }

    @Test func aSessionTakenIsHandedBack() throws {
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
        let session = Session()
        let claim = session.claim()

        try? claim.take()
        claim.handBack()
        claim.handBack()

        #expect(session.deactivations == 1)
    }

    @Test func aTakeThatFailedClaimsNothing() {
        let session = Session()
        session.refuseTake = true
        let claim = session.claim()

        #expect(throws: SessionRefusal.self) { try claim.take() }
        #expect(claim.isHeld == false)

        claim.handBack()
        #expect(session.deactivations == 0)
    }

    @Test func aFailedHandBackKeepsTheClaimForTheNextTeardown() throws {
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
        let session = Session()
        let claim = session.claim()

        try claim.take()
        claim.handBack()

        #expect(session.deactivations == 1)
        #expect(claim.isHeld == false)
    }

    @Test func aSecondTakeOverTheSameSessionNeedsOneHandBack() throws {
        let session = Session()
        let claim = session.claim()

        try claim.take()
        try claim.take()
        claim.handBack()

        #expect(session.deactivations == 1)
        #expect(claim.isHeld == false)
    }
}
