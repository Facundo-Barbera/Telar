import Foundation
import Testing
@testable import TelarMobile

/// A PROJECT ON AN EXTERNAL DRIVE, as far as the phone is concerned — #534.
///
/// The phone decides nothing about disks: a Mac probes its own, and this is
/// about reading the answer it published without ever losing a project row over
/// it. Two claims are pinned here, and the second is the one that would hurt.
@Suite struct ProjectAvailabilityTests {
    private func decodeProject(_ json: String) throws -> Project {
        try JSONDecoder().decode(Project.self, from: Data(json.utf8))
    }

    @Test func availabilityIsDecodedFromTheProjectRecord() throws {
        let away = try decodeProject(#"{"id":"project_one","name":"One","availability":"unmounted"}"#)
        #expect(away.availability == .unmounted)
        #expect(away.awayLabel == "Drive away")
        #expect(away.availability?.isReadable == false)

        let here = try decodeProject(#"{"id":"project_one","name":"One","availability":"available"}"#)
        #expect(here.availability == .available)
        #expect(here.awayLabel == nil)
    }

    /// A MAC THAT PREDATES THE FIELD SAYS NOTHING, and nothing is not a state.
    @Test func anOlderMacDrawsWhatItAlwaysDid() throws {
        let old = try decodeProject(#"{"id":"project_one","name":"One"}"#)
        #expect(old.availability == nil)
        #expect(old.awayLabel == nil)
    }

    /// A WORD THIS BUILD HAS NEVER HEARD OF COSTS A BADGE, NEVER THE PROJECT.
    ///
    /// The default decode of a raw-value enum throws on an unknown string, and a
    /// throw inside a project record does not lose a badge — it loses the whole
    /// row, and with it every conversation drawn under it.
    @Test func aStateFromTheFutureDoesNotDropTheProject() throws {
        let future = try decodeProject(#"{"id":"project_one","name":"One","availability":"ejecting"}"#)
        #expect(future.availability == .unknown)
        #expect(future.awayLabel == nil)
        #expect(future.availability?.isReadable == true)
        #expect(future.name == "One")
    }

    /// THE HEADER BADGE ONLY WHEN EVERY MAC AGREES — the desktop's rule
    /// (`groupAvailability`, apps/web/lib/session-groups.ts). A repository
    /// checked out on two Macs is reachable if the drive is plugged into one of
    /// them, and a header saying otherwise is false for half its rows.
    private func row(host: UUID, id: String) throws -> HostedSession {
        let object: [String: Any] = [
            "id": id, "projectId": "project_one", "title": id, "createdAt": 1000, "updatedAt": 1000,
            "activity": "working", "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"],
        ]
        return HostedSession(hostId: host, session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    @Test func aGroupIsAwayOnlyWhenEveryPlaceAgrees() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "session_one"), row(host: host, id: "session_two")]

        #expect(SidebarModel.agreedAvailability(rows) { _ in .unmounted } == .unmounted)
        #expect(SidebarModel.agreedAvailability(rows) { $0.session.id == "session_one" ? .unmounted : .available } == nil)
        // One row with no answer is enough to say nothing: "not yet known" is
        // not evidence, and a badge that flickered on during every first load
        // would be worse than no badge at all.
        #expect(SidebarModel.agreedAvailability(rows) { $0.session.id == "session_one" ? .unmounted : nil } == nil)
        #expect(SidebarModel.agreedAvailability(rows) { _ in nil } == nil)
        #expect(SidebarModel.agreedAvailability([]) { _ in .unmounted } == nil)
    }

    /// AND THE GROUP CARRIES IT, which is what the header badge reads.
    @Test func theGroupHeaderReadsTheBadgeOffTheSameField() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "session_one")]
        let away = SidebarModel(sessions: rows, names: { _ in "One" }, availabilities: { _ in .unmounted })
        #expect(away.projects.first?.awayLabel == "Drive away")

        let here = SidebarModel(sessions: rows, names: { _ in "One" }, availabilities: { _ in .available })
        #expect(here.projects.first?.awayLabel == nil)
    }
}
