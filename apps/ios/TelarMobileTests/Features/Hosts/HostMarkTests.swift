import Foundation
import Testing
@testable import TelarMobile

@Suite struct HostMarkTests {
    @Test func eachHostKeepsItsOwnColour() {
        let mini = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
        let studio = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
        #expect(HostMark.hue(mini) == HostMark.hue(mini))
        #expect(HostMark.hue(mini) != HostMark.hue(studio))
        #expect((0..<360).contains(HostMark.hue(studio)))
    }
}
