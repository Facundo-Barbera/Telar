import Testing
@testable import TelarMobile

@Suite struct SmokeTests {
    @Test func harnessRuns() {
        #expect(1 + 1 == 2)
    }
}
