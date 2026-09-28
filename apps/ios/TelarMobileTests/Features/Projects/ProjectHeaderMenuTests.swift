import Foundation
import Testing
@testable import TelarMobile

@Suite struct ProjectHeaderMenuTests {
    @Test func collapseOthersLeavesOnlyThatGroupExpanded() {
        let all = ["h1:alpha", "h1:beta", "h2:alpha"]
        #expect(ProjectHeaderMenu.collapseOthers(all: all, keeping: "h1:beta") == ["h1:alpha", "h2:alpha"])
        #expect(ProjectHeaderMenu.collapseOthers(all: all, keeping: "nobody") == Set(all))
        #expect(ProjectHeaderMenu.collapseOthers(all: [], keeping: "h1:beta").isEmpty)
    }
}
