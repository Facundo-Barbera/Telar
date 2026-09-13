import Foundation

/// ONE DESTINATION: a project, and the Mac it is registered on. The Mac's
/// `NewConversationTarget` (apps/web/components/new-conversation-dialog.tsx),
/// with the host NOT optional — the phone has no "this Mac", so every project
/// it can reach belongs to some paired one and naming it is never redundant.
struct NewConversationTarget: Identifiable, Hashable {
    var hostId: HostID
    var hostName: String
    var project: ProjectRef
    var id: String { "\(hostId.uuidString):\(project.id)" }
    var root: String? { project.root }
}

/**
 NARROW BY NAME, BY HOST, OR BY PATH — the three things the row shows, so
 anything a reader can SEE is something they can type. The Mac's `matchTargets`,
 with this app's own comparison: `localizedStandardContains` is the
 case- AND diacritic-insensitive one the sidebar's search already uses, so
 "telar" finds "Telár" here exactly as it does there.

 A BLANK QUERY IS EVERY PROJECT rather than none.
 */
func matchNewConversationTargets(_ targets: [NewConversationTarget], query: String) -> [NewConversationTarget] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return targets }
    return targets.filter { target in
        [target.project.name, target.hostName, target.root]
            .contains { $0?.localizedStandardContains(needle) == true }
    }
}

/**
 THE PALETTE'S ORDER: the host book's, so this phone's DEFAULT MAC LEADS, and
 each Mac's projects by name inside it.

 THE BOOK'S ORDER IS THE ANSWER, not the order the reads came back in. A phone
 has no "this Mac" the way a cockpit does — the closest thing is the first Mac
 it was paired with, which is the one most of its work belongs to. Sorting on
 arrival would put whichever Mac answered fastest on top, which is a fact about
 the network rather than about the person.

 A MAC THAT DID NOT ANSWER CONTRIBUTES NOTHING AND COSTS NOTHING: its absence
 from `projects` drops its rows, and every other Mac's keep their places.
 */
func newConversationTargets(hosts: [Host], projects: [HostID: [ProjectRef]]) -> [NewConversationTarget] {
    hosts.flatMap { host in
        (projects[host.id] ?? [])
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            .map { NewConversationTarget(hostId: host.id, hostName: host.name, project: $0) }
    }
}
