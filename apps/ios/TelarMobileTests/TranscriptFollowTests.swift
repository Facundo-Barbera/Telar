import Testing
@testable import TelarMobile

@Suite struct TranscriptFollowTests {
    @Test func nobodyHasTouchedItSoTheTailIsFollowed() {
        #expect(TranscriptFollow.shouldFollow(takenByReader: false, atBottom: true))
    }

    /// The pin is the truth before anyone scrolls — geometry lags a fill that
    /// has only just landed, and refusing on it was how an opening transcript
    /// failed to reach its own end.
    @Test func nobodyHasTouchedItEvenWhileGeometryStillSaysOtherwise() {
        #expect(TranscriptFollow.shouldFollow(takenByReader: false, atBottom: false))
    }

    /// THE HALF THAT MUST NOT REGRESS: reading back through a long turn is the
    /// whole reason the flag exists.
    @Test func aReaderWhoScrolledAwayIsLeftWhereTheyAre() {
        #expect(!TranscriptFollow.shouldFollow(takenByReader: true, atBottom: false))
    }

    /// THE REPORTED BUG. `isPositionedByUser` never clears itself, and the jump
    /// button is hidden at the tail, so this used to be a transcript that had
    /// silently stopped moving with nothing offering the way back.
    @Test func aReaderWhoCameBackToTheTailFollowsAgain() {
        #expect(TranscriptFollow.shouldFollow(takenByReader: true, atBottom: true))
    }
}
