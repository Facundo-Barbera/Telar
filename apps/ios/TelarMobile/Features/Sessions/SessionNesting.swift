import Foundation

struct SessionFamily {
    var parent: HostedSession
    var children: [HostedSession]
    var needsYou: Int
}

struct FlatRail {
    var pinned: [NestedRow]
    var rows: [NestedRow]
}

struct NestedRow: Identifiable {
    var row: HostedSession
    var family: SessionFamily?
    var nested: Bool
    var id: ScopedSessionID { row.id }
}

enum SessionNesting {
    static func parentId(_ session: Session, assignments: [SessionAssignment]) -> EngineID? {
        let first = assignments.min { ($0.receivedAt ?? .max) < ($1.receivedAt ?? .max) }
        guard let parent = session.startedFrom?.sessionId ?? first?.fromSessionId, parent != session.id else { return nil }
        return parent
    }

    static func parentKey(_ row: HostedSession, assignments: [ScopedSessionID: [SessionAssignment]]) -> ScopedSessionID? {
        parentId(row.session, assignments: assignments[row.id] ?? []).map { ScopedSessionID(hostId: row.hostId, sessionId: $0) }
    }

    static func families(
        _ rows: [HostedSession],
        assignments: [ScopedSessionID: [SessionAssignment]],
        pinned: Set<ScopedSessionID> = []
    ) -> [SessionFamily] {
        let byKey = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func root(_ row: HostedSession) -> HostedSession {
            var seen: Set<ScopedSessionID> = [row.id]
            var current = row
            while !pinned.contains(current.id), let key = parentKey(current, assignments: assignments), let parent = byKey[key] {
                guard seen.insert(parent.id).inserted else { return row }
                current = parent
            }
            return current
        }

        var order: [ScopedSessionID] = []
        var families: [ScopedSessionID: SessionFamily] = [:]
        var nested: [(root: ScopedSessionID, child: HostedSession)] = []
        for row in rows where families[row.id] == nil {
            let top = root(row)
            if top.id == row.id {
                order.append(row.id)
                families[row.id] = SessionFamily(parent: row, children: [], needsYou: 0)
            } else {
                nested.append((top.id, row))
            }
        }
        for (key, child) in nested { families[key]?.children.append(child) }
        return order.compactMap { key in
            guard var family = families[key] else { return nil }
            family.needsYou = family.children.filter { $0.session.activity == .blocked }.count
            return family
        }
    }

    static func isFlat(_ layouts: [SidebarLayout]) -> Bool {
        !layouts.isEmpty && layouts.allSatisfy { $0.mode == .flat }
    }

    static func flat(
        _ model: SidebarModel,
        assignments: [ScopedSessionID: [SessionAssignment]],
        expanded: Set<String>,
        selected: ScopedSessionID?
    ) -> FlatRail {
        let pinned = Set(model.pinned.map(\.id))
        let others = (model.attention + model.projects.flatMap(\.sessions)).sorted(by: newestActivityFirst)
        let placed = families(model.pinned + others, assignments: assignments, pinned: pinned).flatMap { family -> [SessionFamily] in
            guard family.parent.session.activity == .blocked else { return [family] }
            return family.children.filter { $0.session.activity != .blocked }.map { SessionFamily(parent: $0, children: [], needsYou: 0) }
        }
        return FlatRail(
            pinned: visible(placed.filter { pinned.contains($0.parent.id) }, expanded: expanded, selected: selected),
            rows: visible(placed.filter { !pinned.contains($0.parent.id) }, expanded: expanded, selected: selected)
        )
    }

    private static func newestActivityFirst(_ a: HostedSession, _ b: HostedSession) -> Bool {
        let at = { (s: Session) in max(s.updatedAt, s.activityAt ?? 0, s.lastTurnEndedAt ?? 0) }
        if at(a.session) != at(b.session) { return at(a.session) > at(b.session) }
        if a.session.createdAt != b.session.createdAt { return a.session.createdAt > b.session.createdAt }
        return a.session.id < b.session.id
    }

    static func visible(_ families: [SessionFamily], expanded: Set<String>, selected: ScopedSessionID?) -> [NestedRow] {
        families.flatMap { family -> [NestedRow] in
            let shown = expanded.contains(foldKey(family.parent.id))
                ? family.children
                : family.children.filter { $0.session.activity == .blocked || $0.id == selected }
            let head = NestedRow(row: family.parent, family: family.children.isEmpty ? nil : family, nested: false)
            return [head] + shown.map { NestedRow(row: $0, family: nil, nested: true) }
        }
    }

    static func foldKey(_ id: ScopedSessionID) -> String { "\(id.hostId.uuidString):\(id.sessionId)" }
}
