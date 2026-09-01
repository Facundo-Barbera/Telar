import Foundation
import Testing
@testable import TelarMobile

private func session(_ id: String, createdAt: Timestamp, updatedAt: Timestamp? = nil) -> Session {
    let json = """
    {"id":"\(id)","title":"\(id)","createdAt":\(createdAt),"updatedAt":\(updatedAt ?? createdAt),
     "driver":"claude","workspace":{"mode":"worktree","path":"/tmp/x"}}
    """
    return try! JSONDecoder().decode(Session.self, from: Data(json.utf8))
}

@Suite struct MergedInboxTests {
    let hostA = HostID()
    let hostB = HostID()

    @Test func mergeInterleavesActiveByCreatedAtAcrossMacs() {
        let merged = mergeInbox([
            (hostA, InboxSections(active: [session("a2", createdAt: 200), session("a1", createdAt: 50)])),
            (hostB, InboxSections(active: [session("b1", createdAt: 100)])),
        ], filter: nil)
        #expect(merged.active.map(\.session.id) == ["a2", "b1", "a1"])
        #expect(merged.active.map(\.hostId) == [hostA, hostB, hostA])
    }

    @Test func filterNarrowsToOneMacWithoutTouchingBanding() {
        let parts: [(hostId: HostID, sections: InboxSections)] = [
            (hostA, InboxSections(active: [session("a1", createdAt: 100)], settled: [session("a_done", createdAt: 10)])),
            (hostB, InboxSections(active: [session("b1", createdAt: 200)])),
        ]
        let all = mergeInbox(parts, filter: nil)
        #expect(all.active.count == 2)
        #expect(all.settled.count == 1)
        let onlyB = mergeInbox(parts, filter: hostB)
        #expect(onlyB.active.map(\.session.id) == ["b1"])
        #expect(onlyB.settled.isEmpty)
    }

    @Test func tailKeepsSnoozedBeforeSettledAndSortsByUpdatedAt() {
        let merged = mergeInbox([
            (hostA, InboxSections(snoozed: [session("a_snoozed", createdAt: 1, updatedAt: 50)])),
            (hostB, InboxSections(settled: [session("b_settled", createdAt: 1, updatedAt: 900)])),
        ], filter: nil)
        #expect(merged.tail.map(\.session.id) == ["a_snoozed", "b_settled"])
    }

    @Test func sameSessionIdOnTwoMacsStaysTwoRows() {
        // Two Macs can mint the same engine id — the scoped id keeps them apart.
        let merged = mergeInbox([
            (hostA, InboxSections(active: [session("twin", createdAt: 100)])),
            (hostB, InboxSections(active: [session("twin", createdAt: 200)])),
        ], filter: nil)
        #expect(merged.active.count == 2)
        #expect(Set(merged.active.map(\.id)).count == 2)
    }
}
