import Foundation
import Testing
@testable import TelarMobile

@Suite struct HostLabelTests {
    @Test func nameFallsBackWhenThereIsNothingToDraw() {
        #expect(HostLabel.name("mini.local") == "mini.local")
        #expect(HostLabel.name(nil) == HostLabel.unknown)
        #expect(HostLabel.name("") == HostLabel.unknown)
        #expect(HostLabel.name("   ") == HostLabel.unknown)
    }

    @Test func nameKeepsWhatTheHumanTyped() {
        #expect(HostLabel.name("Facundo's MacBook Pro") == "Facundo's MacBook Pro")
        #expect(HostLabel.name("127.0.0.1:3100") == "127.0.0.1:3100")
    }

    @Test func headerSaysNothingWithOneMacPaired() {
        #expect(HostLabel.header(name: "mini.local", hostCount: 1) == nil)
        #expect(HostLabel.header(name: "mini.local", hostCount: 0) == nil)
    }

    @Test func headerNamesTheMacOnceThereAreTwo() {
        #expect(HostLabel.header(name: "mini.local", hostCount: 2) == "mini.local")
        #expect(HostLabel.header(name: "laptop.local", hostCount: 3) == "laptop.local")
    }

    @Test func headerNeverDefersToContext() {
        #expect(HostLabel.header(name: nil, hostCount: 2) == HostLabel.unknown)
    }

    @Test func rowSaysNothingWithOneMacPaired() {
        #expect(HostLabel.row(name: "mini.local", hostCount: 1, placesAbove: 0) == nil)
        #expect(HostLabel.row(name: "mini.local", hostCount: 1, placesAbove: 2) == nil)
    }

    @Test func rowDefersToAHeaderThatAlreadyNamedOneMac() {
        #expect(HostLabel.row(name: "mini.local", hostCount: 2, placesAbove: 1) == nil)
        #expect(HostLabel.row(name: "mini.local", hostCount: 5, placesAbove: 1) == nil)
    }

    @Test func rowNamesItselfWhenTheGroupSpansTwoMacs() {
        #expect(HostLabel.row(name: "mini.local", hostCount: 2, placesAbove: 2) == "mini.local")
        #expect(HostLabel.row(name: "laptop.local", hostCount: 3, placesAbove: 3) == "laptop.local")
    }

    @Test func rowNamesItselfWhenNothingIsHeadingIt() {
        #expect(HostLabel.row(name: "mini.local", hostCount: 2, placesAbove: 0) == "mini.local")
        #expect(HostLabel.row(name: nil, hostCount: 2, placesAbove: 0) == HostLabel.unknown)
    }

    @Test func rowDoesNotWaitForTwoSessionsToShareATitle() {
        let mini = HostLabel.row(name: "mini.local", hostCount: 2, placesAbove: 2)
        let laptop = HostLabel.row(name: "laptop.local", hostCount: 2, placesAbove: 2)
        #expect(mini == "mini.local")
        #expect(laptop == "laptop.local")
        #expect(mini != laptop)
    }

    @Test func theTwoSurfacesAgreeWhereTheyShould() {
        for count in [0, 1, 2, 7] {
            #expect(
                HostLabel.row(name: "mini.local", hostCount: count, placesAbove: 0)
                    == HostLabel.header(name: "mini.local", hostCount: count)
            )
        }
    }
}
