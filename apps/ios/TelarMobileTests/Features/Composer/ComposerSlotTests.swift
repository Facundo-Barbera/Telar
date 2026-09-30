import CoreGraphics
import Testing
@testable import TelarMobile

@Suite struct ComposerSlotTests {
    @Test func anIdleEmptyFieldShowsSendDisabledBesideTheInlineMic() {
        #expect(ComposerSlot.resolve(canSend: false, running: false) == .send)
    }

    @Test func textShowsSend() {
        #expect(ComposerSlot.resolve(canSend: true, running: false) == .send)
    }

    @Test func aRunningTurnPutsStopInTheSlot() {
        #expect(ComposerSlot.resolve(canSend: false, running: true) == .stop)
    }

    @Test func textDuringARunningTurnSteersInsteadOfStopping() {
        #expect(ComposerSlot.resolve(canSend: true, running: true) == .send)
    }

    @Test func thePillIsAtLeastOneLine() {
        #expect(ComposerGrowth.height(content: 0, line: 20) == 20)
    }

    @Test func thePillFollowsTheText() {
        #expect(ComposerGrowth.height(content: 60, line: 20) == 60)
    }

    @Test func thePillStopsAtSixLines() {
        #expect(ComposerGrowth.height(content: 400, line: 20) == 120)
    }

    @Test func thePillNeverTakesMoreThanItIsOffered() {
        #expect(ComposerGrowth.height(content: 400, line: 20, offered: 50) == 50)
    }

    @Test func onlyTheFirstMeasurementPinsTheTranscriptToItsTail() {
        #expect(FloatingInset.pinsToTail(from: 0, to: 70))
        #expect(!FloatingInset.pinsToTail(from: 70, to: 130))
        #expect(!FloatingInset.pinsToTail(from: 130, to: 70))
    }
}
