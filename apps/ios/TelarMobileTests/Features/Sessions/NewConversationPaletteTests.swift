import Foundation
import Testing
@testable import TelarMobile

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
        #expect(targets.map(\.hostName) == ["mini", "mini", "Studio Mac"])
        #expect(targets.map(\.project.name) == ["apple", "zebra", "mango"])
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
        #expect(matchNewConversationTargets(targets, query: "studio").map(\.project.name) == ["sprout"])
        #expect(matchNewConversationTargets(targets, query: "/Volumes").map(\.project.name) == ["sprout"])
        #expect(matchNewConversationTargets(targets, query: "nothing here").isEmpty)
    }

    @Test func searchIgnoresCaseAccentsAndSurroundingSpace() {
        let targets = newConversationTargets(hosts: [mini], projects: [mini.id: [project("t", "Telár")]])
        #expect(matchNewConversationTargets(targets, query: "telar").count == 1)
        #expect(matchNewConversationTargets(targets, query: "  TELÁR  ").count == 1)
        #expect(matchNewConversationTargets(targets, query: "   ").count == 1)
    }

    @Test func theRootPathArrivesOnTheAggregateRead() throws {
        let json = """
        {"sessions":[],"projects":[{"id":"p1","name":"telar","root":"/Users/me/code/telar"},{"id":"p2","name":"old"}]}
        """
        let live = try JSONDecoder().decode(LiveSessions.self, from: Data(json.utf8))
        #expect(live.projects.map(\.root) == ["/Users/me/code/telar", nil])
    }
}
