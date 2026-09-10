import Foundation
import Testing
@testable import TelarMobile

/// The phone and the Mac must agree on what colour "Telar" is: the hue is
/// the web's `projectHue` (FNV-1a over UTF-16), and the initial is the first
/// grapheme, not the first code unit.
@Suite struct ProjectAvatarTests {
    @Test func hueMatchesTheWebFunctionBitForBit() {
        // Values computed by apps/web/lib/project-avatar.ts for the same
        // strings. A drift here is two surfaces disagreeing about a colour.
        #expect(projectHue("Telar") == 273)
        #expect(projectHue("") == 61)
        #expect(projectHue("a") == 340)
        #expect(projectHue("b") == 157)
        #expect(projectHue("ozom-gv") == 14)
    }

    @Test func initialIsTheFirstGraphemeUppercased() {
        #expect(projectInitial("telar") == "T")
        #expect(projectInitial("  ozom-gv") == "O")
        #expect(projectInitial("Ålesund") == "Å")
        #expect(projectInitial("🚀 launch") == "🚀")
        #expect(projectInitial("   ") == "?")
    }

    @Test func projectRefDecodesTheIconKeyAndSurvivesItsAbsence() throws {
        let with = try JSONDecoder().decode(ProjectRef.self, from: Data(#"{"id":"p","name":"Telar","icon":"sha-abc"}"#.utf8))
        #expect(with.icon == "sha-abc")
        let without = try JSONDecoder().decode(ProjectRef.self, from: Data(#"{"id":"p","name":"Telar"}"#.utf8))
        #expect(without.icon == nil)
    }

    @Test func sidebarProjectsCarryTheIcon() throws {
        let host = UUID()
        let object: [String: Any] = ["id": "s", "projectId": "p", "title": "s", "createdAt": 1, "updatedAt": 1,
            "activity": "working", "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"]]
        let row = HostedSession(hostId: host, session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: object)))
        let model = SidebarModel(sessions: [row], names: { _ in "Telar" }, icons: { _ in "sha-abc" })
        #expect(model.projects.first?.icon == "sha-abc")
    }
}
