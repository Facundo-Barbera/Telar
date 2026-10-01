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
}
