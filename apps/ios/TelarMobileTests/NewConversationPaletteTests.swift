import Foundation
import Testing
@testable import TelarMobile

/// THE PALETTE'S TWO RULES — what order the rows come in, and what a query
/// narrows on. Both are the Mac's (`new-conversation-dialog.tsx`), and #332 is
/// the drift they close.
@Suite struct NewConversationPaletteTests {
    private let mini = Host(id: UUID(), name: "mini", baseURLString: "http://mini.local:3000")
    private let studio = Host(id: UUID(), name: "Studio Mac", baseURLString: "http://studio.local:3000")

    private func project(_ id: String, _ name: String, root: String? = nil) -> ProjectRef {
        ProjectRef(id: id, name: name, icon: nil, root: root)
    }

    @Test func theDefaultMacLeadsAndEachMacsProjectsAreByName() {
        let targets = newConversationTargets(
            hosts: [mini, studio],
            projects: [
                mini.id: [project("z", "zebra"), project("a", "apple")],
                studio.id: [project("m", "mango")],
            ]
        )
        // The host book's order, not the order the reads came back in.
        #expect(targets.map(\.hostName) == ["mini", "mini", "Studio Mac"])
        #expect(targets.map(\.project.name) == ["apple", "zebra", "mango"])
        // Two Macs can register the same project id, so identity is the pair.
        #expect(Set(targets.map(\.id)).count == 3)
    }

    @Test func aMacThatDidNotAnswerCostsOnlyItsOwnRows() {
        let targets = newConversationTargets(hosts: [mini, studio], projects: [studio.id: [project("m", "mango")]])
        #expect(targets.map(\.project.name) == ["mango"])
        #expect(targets.map(\.hostName) == ["Studio Mac"])
    }

    @Test func searchNarrowsOnNameHostOrRootPath() {
        let targets = newConversationTargets(
            hosts: [mini, studio],
            projects: [
                mini.id: [project("t", "telar", root: "/Users/me/code/telar")],
                studio.id: [project("s", "sprout", root: "/Volumes/work/sprout")],
            ]
        )
        #expect(matchNewConversationTargets(targets, query: "").count == 2)
        #expect(matchNewConversationTargets(targets, query: "spr").map(\.project.name) == ["sprout"])
        // The host — the fact the row now carries instead of a mode above it.
        #expect(matchNewConversationTargets(targets, query: "studio").map(\.project.name) == ["sprout"])
        // The path, which is the whole point of showing it.
        #expect(matchNewConversationTargets(targets, query: "/Volumes").map(\.project.name) == ["sprout"])
        #expect(matchNewConversationTargets(targets, query: "nothing here").isEmpty)
    }

    @Test func searchIgnoresCaseAccentsAndSurroundingSpace() {
        let targets = newConversationTargets(hosts: [mini], projects: [mini.id: [project("t", "Telár")]])
        #expect(matchNewConversationTargets(targets, query: "telar").count == 1)
        #expect(matchNewConversationTargets(targets, query: "  TELÁR  ").count == 1)
        // A query of nothing but space is not a query.
        #expect(matchNewConversationTargets(targets, query: "   ").count == 1)
    }

    /// The root path is a field the phone was throwing away: `/api/sessions/
    /// live` has always forwarded the engine's own project records, and
    /// `ProjectRef` simply did not decode it.
    @Test func theRootPathArrivesOnTheAggregateRead() throws {
        let json = """
        {"sessions":[],"projects":[{"id":"p1","name":"telar","root":"/Users/me/code/telar"},{"id":"p2","name":"old"}]}
        """
        let live = try JSONDecoder().decode(LiveSessions.self, from: Data(json.utf8))
        #expect(live.projects.map(\.root) == ["/Users/me/code/telar", nil])
    }
}
