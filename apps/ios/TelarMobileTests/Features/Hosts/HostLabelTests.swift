import Foundation
import Testing
@testable import TelarMobile

/// WHICH MAC A CONVERSATION COMES FROM — issue #244. The rule the header strip
/// and the rail's rows both ask, pinned here because it is the only form in
/// which it can be read: in the views it is one `if let` each.
@Suite struct HostLabelTests {
    // MARK: the name itself

    @Test func nameFallsBackWhenThereIsNothingToDraw() {
        #expect(HostLabel.name("mini.local") == "mini.local")
        // A Mac just forgotten, with its rows still on screen.
        #expect(HostLabel.name(nil) == HostLabel.unknown)
        // Mid-rename: `HostBook.rename` trims to "" before restoring the URL
        // host, and an empty badge is a rectangle with nothing in it.
        #expect(HostLabel.name("") == HostLabel.unknown)
        #expect(HostLabel.name("   ") == HostLabel.unknown)
    }

    @Test func nameKeepsWhatTheHumanTyped() {
        // Not trimmed, not title-cased, not truncated — only emptiness is
        // treated as absence.
        #expect(HostLabel.name("Facundo's MacBook Pro") == "Facundo's MacBook Pro")
        #expect(HostLabel.name("127.0.0.1:3100") == "127.0.0.1:3100")
    }

    // MARK: the conversation's header strip

    @Test func headerSaysNothingWithOneMacPaired() {
        #expect(HostLabel.header(name: "mini.local", hostCount: 1) == nil)
        // And not even for a phone that has forgotten its last Mac.
        #expect(HostLabel.header(name: "mini.local", hostCount: 0) == nil)
    }

    @Test func headerNamesTheMacOnceThereAreTwo() {
        #expect(HostLabel.header(name: "mini.local", hostCount: 2) == "mini.local")
        #expect(HostLabel.header(name: "laptop.local", hostCount: 3) == "laptop.local")
    }

    @Test func headerNeverDefersToContext() {
        // The strip has no neighbouring row and no group header to infer from —
        // a conversation opened from a notification never passed the rail at
        // all — so unlike a row it has no reason to keep quiet. The only input
        // it takes is how many Macs exist.
        #expect(HostLabel.header(name: nil, hostCount: 2) == HostLabel.unknown)
    }

    // MARK: a row in the rail

    @Test func rowSaysNothingWithOneMacPaired() {
        #expect(HostLabel.row(name: "mini.local", hostCount: 1, placesAbove: 0) == nil)
        #expect(HostLabel.row(name: "mini.local", hostCount: 1, placesAbove: 2) == nil)
    }

    @Test func rowDefersToAHeaderThatAlreadyNamedOneMac() {
        // A project group living on exactly one Mac badges it in the header;
        // repeating that on every slim row under it is what turns the group
        // into a column of badges.
        #expect(HostLabel.row(name: "mini.local", hostCount: 2, placesAbove: 1) == nil)
        #expect(HostLabel.row(name: "mini.local", hostCount: 5, placesAbove: 1) == nil)
    }

    @Test func rowNamesItselfWhenTheGroupSpansTwoMacs() {
        // ONE repository checked out on two paired Macs is one group
        // (`SidebarModel.groupKey`); its header lists both, which shows that two
        // are involved and not which one owns this row. That is #244 exactly.
        #expect(HostLabel.row(name: "mini.local", hostCount: 2, placesAbove: 2) == "mini.local")
        #expect(HostLabel.row(name: "laptop.local", hostCount: 3, placesAbove: 3) == "laptop.local")
    }

    @Test func rowNamesItselfWhenNothingIsHeadingIt() {
        // Search results, both shelves, the attention band and the pinned band
        // all mix projects and Macs with no header over them.
        #expect(HostLabel.row(name: "mini.local", hostCount: 2, placesAbove: 0) == "mini.local")
        #expect(HostLabel.row(name: nil, hostCount: 2, placesAbove: 0) == HostLabel.unknown)
    }

    @Test func rowDoesNotWaitForTwoSessionsToShareATitle() {
        // The trigger is the CONTEXT failing to answer, not a coincidence of
        // titles: two conversations named differently on two Macs inside one
        // merged group are just as unattributable as two named the same.
        let mini = HostLabel.row(name: "mini.local", hostCount: 2, placesAbove: 2)
        let laptop = HostLabel.row(name: "laptop.local", hostCount: 2, placesAbove: 2)
        #expect(mini == "mini.local")
        #expect(laptop == "laptop.local")
        #expect(mini != laptop)
    }

    @Test func theTwoSurfacesAgreeWhereTheyShould() {
        // A row with nothing above it asks the same question the strip does, and
        // must get the same answer — otherwise opening a search result would
        // change which Mac it claims to be on.
        for count in [0, 1, 2, 7] {
            #expect(
                HostLabel.row(name: "mini.local", hostCount: count, placesAbove: 0)
                    == HostLabel.header(name: "mini.local", hostCount: count)
            )
        }
    }
}
