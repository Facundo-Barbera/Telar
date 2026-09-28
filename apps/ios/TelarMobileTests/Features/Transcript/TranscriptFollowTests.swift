import Testing
@testable import TelarMobile

@Suite struct TranscriptFollowTests {
    @Test func nobodyHasTouchedItSoTheTailIsFollowed() {
        #expect(TranscriptFollow.shouldFollow(takenByReader: false, atBottom: true))
    }

    @Test func nobodyHasTouchedItEvenWhileGeometryStillSaysOtherwise() {
        #expect(TranscriptFollow.shouldFollow(takenByReader: false, atBottom: false))
    }

    @Test func aReaderWhoScrolledAwayIsLeftWhereTheyAre() {
        #expect(!TranscriptFollow.shouldFollow(takenByReader: true, atBottom: false))
    }

    @Test func aReaderWhoCameBackToTheTailFollowsAgain() {
        #expect(TranscriptFollow.shouldFollow(takenByReader: true, atBottom: true))
    }
}
