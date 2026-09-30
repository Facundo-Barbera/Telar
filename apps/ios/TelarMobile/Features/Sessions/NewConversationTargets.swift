import Foundation

struct NewConversationTarget: Identifiable, Hashable {
    var hostId: HostID
    var hostName: String
    var project: ProjectRef
    var id: String { Self.key(hostId, project.id) }
    var root: String? { project.root }

    static func key(_ hostId: HostID, _ projectId: EngineID) -> String { "\(hostId.uuidString):\(projectId)" }
}

struct NewConversationSection: Identifiable, Equatable {
    var title: String?
    var targets: [NewConversationTarget]
    var id: String { title ?? "" }
}

enum NewConversationTargets {
    static let recentLimit = 5

    static func all(hosts: [Host], projects: [HostID: [ProjectRef]]) -> [NewConversationTarget] {
        hosts.flatMap { host in
            (projects[host.id] ?? [])
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                .map { NewConversationTarget(hostId: host.id, hostName: host.name, project: $0) }
        }
    }

    static func activity(_ rows: [(host: HostID, projectId: EngineID?, at: Timestamp)]) -> [String: Timestamp] {
        var latest: [String: Timestamp] = [:]
        for row in rows {
            guard let projectId = row.projectId else { continue }
            let key = NewConversationTarget.key(row.host, projectId)
            latest[key] = max(latest[key] ?? 0, row.at)
        }
        return latest
    }

    static func recent(_ targets: [NewConversationTarget], activity: [String: Timestamp], lastUsed: String?) -> [NewConversationTarget] {
        let ranked = targets
            .filter { activity[$0.id] != nil }
            .sorted { activity[$0.id]! > activity[$1.id]! }
        let last = targets.first { $0.id == lastUsed }
        return Array(([last].compactMap { $0 } + ranked.filter { $0.id != lastUsed }).prefix(recentLimit))
    }

    static func preferred(_ targets: [NewConversationTarget], activity: [String: Timestamp], lastUsed: String?, projectHint: String? = nil) -> NewConversationTarget? {
        if let projectHint, let hinted = targets.first(where: { $0.project.id == projectHint }) { return hinted }
        return recent(targets, activity: activity, lastUsed: lastUsed).first ?? targets.first
    }

    static func sections(_ targets: [NewConversationTarget], activity: [String: Timestamp], lastUsed: String?, query: String = "") -> [NewConversationSection] {
        let shown = match(targets, query: query)
        let recents = recent(shown, activity: activity, lastUsed: lastUsed)
        let rest = shown.filter { target in !recents.contains { $0.id == target.id } }
        var sections: [NewConversationSection] = []
        if !recents.isEmpty { sections.append(NewConversationSection(title: "Recent", targets: recents)) }
        let hostNames = Set(targets.map(\.hostId)).count > 1
        if hostNames {
            var order: [HostID] = []
            for target in rest where !order.contains(target.hostId) { order.append(target.hostId) }
            for host in order {
                let rows = rest.filter { $0.hostId == host }
                sections.append(NewConversationSection(title: rows[0].hostName, targets: rows))
            }
        } else if !rest.isEmpty {
            sections.append(NewConversationSection(title: recents.isEmpty ? nil : "All projects", targets: rest))
        }
        return sections
    }

    static func showsPath(_ target: NewConversationTarget, among targets: [NewConversationTarget]) -> Bool {
        target.root != nil && targets.contains { $0.id != target.id && $0.project.name.localizedCaseInsensitiveCompare(target.project.name) == .orderedSame }
    }

    static func match(_ targets: [NewConversationTarget], query: String) -> [NewConversationTarget] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return targets }
        return targets.filter { target in
            [target.project.name, target.hostName, target.root]
                .contains { $0?.localizedStandardContains(needle) == true }
        }
    }
}
