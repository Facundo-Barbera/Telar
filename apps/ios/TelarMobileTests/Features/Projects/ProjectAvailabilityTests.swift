import Foundation
import Testing
@testable import TelarMobile

@Suite struct ProjectAvailabilityTests {
    private func decodeProject(_ json: String) throws -> Project {
        try JSONDecoder().decode(Project.self, from: Data(json.utf8))
    }

    @Test func availabilityIsDecodedFromTheProjectRecord() throws {
        let away = try decodeProject(#"{"id":"project_one","name":"One","availability":"unmounted"}"#)
        #expect(away.availability == .unmounted)
        #expect(away.awayLabel == "Drive away")

        let here = try decodeProject(#"{"id":"project_one","name":"One","availability":"available"}"#)
        #expect(here.availability == .available)
        #expect(here.awayLabel == nil)
    }

    @Test func anOlderMacDrawsWhatItAlwaysDid() throws {
        let old = try decodeProject(#"{"id":"project_one","name":"One"}"#)
        #expect(old.availability == nil)
        #expect(old.awayLabel == nil)
    }

    @Test func aStateFromTheFutureDoesNotDropTheProject() throws {
        let future = try decodeProject(#"{"id":"project_one","name":"One","availability":"ejecting"}"#)
        #expect(future.availability == .unknown)
        #expect(future.awayLabel == nil)
        #expect(future.name == "One")
    }

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
        #expect(SidebarModel.agreedAvailability(rows) { $0.session.id == "session_one" ? .unmounted : nil } == nil)
        #expect(SidebarModel.agreedAvailability(rows) { _ in nil } == nil)
        #expect(SidebarModel.agreedAvailability([]) { _ in .unmounted } == nil)
    }

    @Test func theGroupHeaderReadsTheBadgeOffTheSameField() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "session_one")]
        let away = SidebarModel(sessions: rows, names: { _ in "One" }, availabilities: { _ in .unmounted })
        #expect(away.projects.first?.awayLabel == "Drive away")

        let here = SidebarModel(sessions: rows, names: { _ in "One" }, availabilities: { _ in .available })
        #expect(here.projects.first?.awayLabel == nil)
    }
}
