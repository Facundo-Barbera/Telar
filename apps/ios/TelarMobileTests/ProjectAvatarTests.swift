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

    /// THE CHOSEN GLYPH AND THE TYPED MARK ARE THEIR OWN FIELDS (#365, #364),
    /// and the phone has to read both or a project a person gave a mark shows
    /// the initial it was trying to replace. The JSON is the `/api/sessions/live`
    /// shape, which forwards the engine's `Project` verbatim.
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

    /// EVERY ID IN THE VOCABULARY DRAWS SOMETHING. The stored value is one of
    /// `TELAR_ICONS` (packages/engine-client/src/icons.ts); a pairing that names
    /// a symbol this OS does not ship renders as nothing at all, which is why
    /// `telarIconSymbol` probes rather than trusting the map.
    @Test func everyPairedIconResolvesToASymbolThisBuildCanDraw() {
        #expect(telarIconIds.count == 40)
        for id in telarIconIds {
            #expect(telarIconSymbol(id) != nil, "no drawable SF Symbol for \(id)")
        }
    }

    /// AN ID THIS BUILD DOES NOT KNOW IS NOT A MARK — a registry written by a
    /// newer Mac must fall through to the icon, the initial and the folder
    /// rather than drawing a blank box. The web's `isTelarIcon` guard.
    @Test func anUnknownIconIdIsNotAMark() {
        #expect(telarIconSymbol("not-a-glyph-in-this-build") == nil)
        #expect(telarIconSymbol(nil) == nil)
    }
}
