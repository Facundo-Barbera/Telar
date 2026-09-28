import Foundation
import Testing
@testable import TelarMobile

@Suite struct ProjectHeaderMenuTests {
    /// COLLAPSE OTHERS LEAVES ONLY THAT GROUP EXPANDED — including when the
    /// group it was pressed on was itself collapsed, which is the only reading
    /// of "only that one" that is true afterwards.
    @Test func collapseOthersLeavesOnlyThatGroupExpanded() {
        let all = ["h1:alpha", "h1:beta", "h2:alpha"]
        #expect(ProjectHeaderMenu.collapseOthers(all: all, keeping: "h1:beta") == ["h1:alpha", "h2:alpha"])
        #expect(ProjectHeaderMenu.collapseOthers(all: all, keeping: "nobody") == Set(all))
        #expect(ProjectHeaderMenu.collapseOthers(all: [], keeping: "h1:beta").isEmpty)
    }
}
