import Foundation
import Testing
@testable import TelarMobile

/// THE MAIN SESSION, AS THIS PHONE SEES IT (#522).
///
/// Two claims, and the first is the feature being optional: a Mac that has
/// never switched it on, or whose engine predates the field, puts no row on
/// this sidebar. An absent designation read as anything but "off" is exactly
/// how an experimental feature ends up on by accident.
///
/// The second is the fold — one entry per MAC, and only when that Mac actually
/// has the conversation it names. A designation is the Mac's own fact, and this
/// app is remote to all of them.
private func session(_ id: String) -> Session {
    let json = """
    {"id":"\(id)","title":"\(id)","createdAt":1,"updatedAt":1,
     "driver":"claude","workspace":{"mode":"worktree","path":"/tmp/x"}}
    """
    return try! JSONDecoder().decode(Session.self, from: Data(json.utf8))
}

@Suite struct MainSessionTests {
    let hostA = HostID()
    let hostB = HostID()

    @Test func aMacThatSaysNothingIsOff() throws {
        // The live answer every Mac sent before this feature existed. It must
        // decode, and it must mean off rather than "cannot say".
        let json = #"{"sessions":[],"projects":[],"revision":4}"#
        let live = try JSONDecoder().decode(LiveSessions.self, from: Data(json.utf8))
        #expect(live.mainSession == nil)
    }

    @Test func theDesignationDecodesWithAndWithoutASession() throws {
        let on = #"{"sessions":[],"projects":[],"mainSession":{"enabled":true,"sessionId":"session_main"}}"#
        let decoded = try JSONDecoder().decode(LiveSessions.self, from: Data(on.utf8))
        #expect(decoded.mainSession == MainSession(enabled: true, sessionId: "session_main"))

        // ALREADY RESOLVED BY THE MAC: a designation whose conversation was
        // deleted arrives with no id at all, so this phone never has to decide
        // what to do with one that points nowhere.
        let dangling = #"{"sessions":[],"projects":[],"mainSession":{"enabled":true}}"#
        #expect(try JSONDecoder().decode(LiveSessions.self, from: Data(dangling.utf8)).mainSession?.sessionId == nil)
    }

    @Test func noRowUntilAMacSaysOtherwise() {
        let sections = InboxSections(active: [session("session_main")])
        // Never switched on, or an engine older than the field.
        #expect(mainSessionRows([(hostA, nil, sections)], filter: nil).isEmpty)
        // Switched off — every install's case out of the box.
        #expect(mainSessionRows([(hostA, MainSession(enabled: false, sessionId: nil), sections)], filter: nil).isEmpty)
        // Off but still designated: the Mac keeps the id so re-enabling reuses
        // it, and a sidebar that read the id alone would draw an entry for a
        // feature that is off.
        #expect(mainSessionRows([(hostA, MainSession(enabled: true, sessionId: "session_main"), sections)], filter: nil).count == 1)
        #expect(mainSessionRows([(hostA, MainSession(enabled: false, sessionId: "session_main"), sections)], filter: nil).isEmpty)
    }

    @Test func aDesignationWithNoRowDrawsNothing() {
        // A Mac still answering its first poll has the id and not yet the row.
        let elsewhere = InboxSections(active: [session("session_other")])
        #expect(mainSessionRows([(hostA, MainSession(enabled: true, sessionId: "session_main"), elsewhere)], filter: nil).isEmpty)
    }

    @Test func theRowIsFoundWhereverItsMacHasBandedIt() {
        // Its own engine keeps it off the shelf while Main is on, but a phone
        // that asked for the settled rows too must still find it — the entry is
        // about where to go, not about which band the conversation is in.
        let main = MainSession(enabled: true, sessionId: "session_main")
        let settled = InboxSections(settled: [session("session_main")])
        #expect(mainSessionRows([(hostA, main, settled)], filter: nil).map(\.session.id) == ["session_main"])
    }

    @Test func oneEntryPerMacAndTheFilterNarrowsIt() {
        let main = MainSession(enabled: true, sessionId: "session_main")
        let parts: [(hostId: HostID, main: MainSession?, sections: InboxSections)] = [
            (hostA, main, InboxSections(active: [session("session_main")])),
            (hostB, main, InboxSections(active: [session("session_main")])),
        ]
        // TWO MACS COORDINATING IS TWO ENTRIES. Hiding one would be the sidebar
        // deciding which Mac the reader meant — and two Macs can mint the same
        // session id, which is why the rows are scoped rather than deduplicated.
        let both = mainSessionRows(parts, filter: nil)
        #expect(both.count == 2)
        #expect(both.map(\.hostId) == [hostA, hostB])
        // Scoped to one Mac, it is that Mac's.
        #expect(mainSessionRows(parts, filter: hostB).map(\.hostId) == [hostB])
    }
}
