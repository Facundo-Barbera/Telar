import CoreGraphics
import Testing
@testable import TelarMobile

@Suite struct ComposerSlotTests {
    @Test func anEmptyFieldOffersTheMic() {
        #expect(ComposerSlot.resolve(canSend: false, running: false, listening: false, canDictate: true) == .dictate)
    }

    @Test func textTurnsTheMicIntoSend() {
        #expect(ComposerSlot.resolve(canSend: true, running: false, listening: false, canDictate: true) == .send)
    }

    @Test func withoutDictationAnEmptyFieldShowsSend() {
        #expect(ComposerSlot.resolve(canSend: false, running: false, listening: false, canDictate: false) == .send)
    }

    @Test func aRunningTurnPutsStopInTheSlot() {
        #expect(ComposerSlot.resolve(canSend: false, running: true, listening: false, canDictate: true) == .stop)
    }

    @Test func textDuringARunningTurnSteersInsteadOfStopping() {
        #expect(ComposerSlot.resolve(canSend: true, running: true, listening: false, canDictate: true) == .send)
    }

    @Test func listeningKeepsTheMicSoDictationCanBeStopped() {
        #expect(ComposerSlot.resolve(canSend: true, running: true, listening: true, canDictate: true) == .stopDictating)
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
}
