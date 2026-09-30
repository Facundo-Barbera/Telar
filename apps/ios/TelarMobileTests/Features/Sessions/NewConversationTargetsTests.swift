import Foundation
import Testing
@testable import TelarMobile

@Suite struct NewConversationTargetsTests {
    private let mini = Host(id: UUID(), name: "mini", baseURLString: "http://mini.local:3000")
    private let studio = Host(id: UUID(), name: "Studio Mac", baseURLString: "http://studio.local:3000")

    private func project(_ id: String, _ name: String, root: String? = nil) -> ProjectRef {
        ProjectRef(id: id, name: name, icon: nil, root: root)
    }

    private func key(_ host: Host, _ projectId: String) -> String { NewConversationTarget.key(host.id, projectId) }

    private var oneMac: [NewConversationTarget] {
        NewConversationTargets.all(hosts: [mini], projects: [mini.id: [project("z", "zebra"), project("a", "apple"), project("m", "mango")]])
    }

    @Test func eachMacsProjectsAreByNameAndAMissingMacCostsOnlyItsRows() {
        let targets = NewConversationTargets.all(
            hosts: [mini, studio],
            projects: [mini.id: [project("z", "zebra"), project("a", "apple")], studio.id: [project("m", "mango")]]
        )
        #expect(targets.map(\.project.name) == ["apple", "zebra", "mango"])
        #expect(NewConversationTargets.all(hosts: [mini, studio], projects: [studio.id: [project("m", "mango")]]).map(\.hostName) == ["Studio Mac"])
    }

    @Test func activityKeepsTheLatestSessionPerProjectOnEachMac() {
        let activity = NewConversationTargets.activity([
            (mini.id, "a", 10), (mini.id, "a", 30), (studio.id, "a", 20), (mini.id, nil, 99),
        ])
        #expect(activity == [key(mini, "a"): 30, key(studio, "a"): 20])
    }

    @Test func recentProjectsAreByLatestActivityWithTheLastUsedFirst() {
        let activity = [key(mini, "z"): 50, key(mini, "a"): 90]
        #expect(NewConversationTargets.recent(oneMac, activity: activity, lastUsed: nil).map(\.project.name) == ["apple", "zebra"])
        #expect(NewConversationTargets.recent(oneMac, activity: activity, lastUsed: key(mini, "m")).map(\.project.name) == ["mango", "apple", "zebra"])
    }

    @Test func theDefaultIsTheLastUsedThenTheBusiestThenTheFirst() {
        let activity = [key(mini, "z"): 50]
        #expect(NewConversationTargets.preferred(oneMac, activity: activity, lastUsed: key(mini, "m"))?.project.name == "mango")
        #expect(NewConversationTargets.preferred(oneMac, activity: activity, lastUsed: "gone")?.project.name == "zebra")
        #expect(NewConversationTargets.preferred(oneMac, activity: [:], lastUsed: nil)?.project.name == "apple")
        #expect(NewConversationTargets.preferred(oneMac, activity: activity, lastUsed: nil, projectHint: "m")?.project.name == "mango")
        #expect(NewConversationTargets.preferred([], activity: [:], lastUsed: nil) == nil)
    }

    @Test func oneMacShowsRecentThenTheRestWithoutAMacName() {
        let sections = NewConversationTargets.sections(oneMac, activity: [key(mini, "z"): 1], lastUsed: nil)
        #expect(sections.map(\.title) == ["Recent", "All projects"])
        #expect(sections.map { $0.targets.map(\.project.name) } == [["zebra"], ["apple", "mango"]])
        #expect(NewConversationTargets.sections(oneMac, activity: [:], lastUsed: nil).map(\.title) == [nil])
    }

    @Test func severalMacsGroupTheRestByMac() {
        let targets = NewConversationTargets.all(
            hosts: [mini, studio],
            projects: [mini.id: [project("a", "apple"), project("z", "zebra")], studio.id: [project("m", "mango")]]
        )
        let sections = NewConversationTargets.sections(targets, activity: [key(studio, "m"): 1], lastUsed: nil)
        #expect(sections.map(\.title) == ["Recent", "mini"])
        #expect(sections.last?.targets.map(\.project.name) == ["apple", "zebra"])
    }

    @Test func recentsNeverCrowdOutTheListBeyondTheirCap() {
        let many = NewConversationTargets.all(hosts: [mini], projects: [mini.id: (0..<9).map { project("p\($0)", "p\($0)") }])
        let activity = Dictionary(uniqueKeysWithValues: (0..<9).map { (key(mini, "p\($0)"), Timestamp($0)) })
        let sections = NewConversationTargets.sections(many, activity: activity, lastUsed: nil)
        #expect(sections[0].targets.count == NewConversationTargets.recentLimit)
        #expect(sections.flatMap(\.targets).count == 9)
    }

    @Test func thePathShowsOnlyToTellSameNamedProjectsApart() {
        let targets = NewConversationTargets.all(
            hosts: [mini, studio],
            projects: [mini.id: [project("t", "telar", root: "/a/telar"), project("s", "sprout", root: "/a/sprout")],
                       studio.id: [project("t2", "Telar", root: "/b/telar")]]
        )
        #expect(targets.filter { NewConversationTargets.showsPath($0, among: targets) }.map(\.project.id).sorted() == ["t", "t2"])
    }

    @Test func searchNarrowsOnNameHostOrRootPathIgnoringCaseAndAccents() {
        let targets = NewConversationTargets.all(
            hosts: [mini, studio],
            projects: [mini.id: [project("t", "Telár", root: "/Users/me/code/telar")],
                       studio.id: [project("s", "sprout", root: "/Volumes/work/sprout")]]
        )
        #expect(NewConversationTargets.match(targets, query: "  ").count == 2)
        #expect(NewConversationTargets.match(targets, query: "studio").map(\.project.name) == ["sprout"])
        #expect(NewConversationTargets.match(targets, query: "/Volumes").map(\.project.name) == ["sprout"])
        #expect(NewConversationTargets.match(targets, query: " TELAR ").map(\.project.name) == ["Telár"])
        #expect(NewConversationTargets.sections(targets, activity: [:], lastUsed: nil, query: "nothing").isEmpty)
    }

    @Test func theRootPathArrivesOnTheAggregateRead() throws {
        let json = """
        {"sessions":[],"projects":[{"id":"p1","name":"telar","root":"/Users/me/code/telar"},{"id":"p2","name":"old"}]}
        """
        let live = try JSONDecoder().decode(LiveSessions.self, from: Data(json.utf8))
        #expect(live.projects.map(\.root) == ["/Users/me/code/telar", nil])
    }
}
