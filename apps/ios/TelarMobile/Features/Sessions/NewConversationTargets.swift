import Foundation

struct NewConversationTarget: Identifiable, Hashable {
    var hostId: HostID
    var hostName: String
    var project: ProjectRef
    var id: String { "\(hostId.uuidString):\(project.id)" }
    var root: String? { project.root }
}

func matchNewConversationTargets(_ targets: [NewConversationTarget], query: String) -> [NewConversationTarget] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return targets }
    return targets.filter { target in
        [target.project.name, target.hostName, target.root]
            .contains { $0?.localizedStandardContains(needle) == true }
    }
}

func newConversationTargets(hosts: [Host], projects: [HostID: [ProjectRef]]) -> [NewConversationTarget] {
    hosts.flatMap { host in
        (projects[host.id] ?? [])
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            .map { NewConversationTarget(hostId: host.id, hostName: host.name, project: $0) }
    }
}
