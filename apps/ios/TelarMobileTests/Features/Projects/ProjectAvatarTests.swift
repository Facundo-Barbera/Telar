import Foundation
import Testing
@testable import TelarMobile

@Suite struct ProjectAvatarTests {
    @Test func hueMatchesTheWebFunctionBitForBit() {
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

    @Test func projectRefDecodesTheChosenGlyphAndTheTypedMark() throws {
        let ref = try JSONDecoder().decode(ProjectRef.self, from: Data(
            #"{"id":"p","name":"Telar","icon":"sha-abc","iconName":"flask-conical","iconEmoji":"🧪"}"#.utf8))
        #expect(ref.iconName == "flask-conical")
        #expect(ref.iconEmoji == "🧪")
        #expect(ref.mark == ProjectMark(icon: "sha-abc", iconName: "flask-conical", iconEmoji: "🧪"))
        let bare = try JSONDecoder().decode(ProjectRef.self, from: Data(#"{"id":"p","name":"Telar"}"#.utf8))
        #expect(bare.mark == .none)
    }

    @Test func sidebarProjectsCarryTheWholeMark() throws {
        let host = UUID()
        let object: [String: Any] = ["id": "s", "projectId": "p", "title": "s", "createdAt": 1, "updatedAt": 1,
            "activity": "working", "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"]]
        let row = HostedSession(hostId: host, session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: object)))
        let mark = ProjectMark(icon: "sha-abc", iconName: "rocket")
        let model = SidebarModel(sessions: [row], names: { _ in "Telar" }, marks: { _ in mark })
        #expect(model.projects.first?.mark == mark)
        #expect(model.projects.first?.places.first?.mark == mark)
    }

    @Test func everyPairedIconResolvesToASymbolThisBuildCanDraw() {
        #expect(telarIconIds.count == 40)
        for id in telarIconIds {
            #expect(telarIconSymbol(id) != nil, "no drawable SF Symbol for \(id)")
        }
    }

    @Test func anUnknownIconIdIsNotAMark() {
        #expect(telarIconSymbol("not-a-glyph-in-this-build") == nil)
        #expect(telarIconSymbol(nil) == nil)
    }
}
