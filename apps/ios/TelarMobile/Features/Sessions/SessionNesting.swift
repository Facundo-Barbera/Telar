import Foundation

struct SessionFamily {
    var parent: HostedSession
    var children: [HostedSession]
    var needsYou: Int
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
        elsewhere: [HostedSession] = []
    ) -> [SessionFamily] {
        let byKey = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func root(_ row: HostedSession) -> HostedSession {
            var seen: Set<ScopedSessionID> = [row.id]
            var current = row
            while let key = parentKey(current, assignments: assignments), let parent = byKey[key] {
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

        let outside = elsewhere.filter { byKey[$0.id] == nil && $0.session.activity == .blocked }
        return order.compactMap { key in
            guard var family = families[key] else { return nil }
            let members = Set([key] + family.children.map(\.id))
            family.needsYou = family.children.filter { $0.session.activity == .blocked }.count
                + outside.filter { parentKey($0, assignments: assignments).map(members.contains) == true }.count
            return family
        }
    }

    static func visible(_ families: [SessionFamily], expanded: Set<String>, selected: ScopedSessionID?) -> [NestedRow] {
        families.flatMap { family -> [NestedRow] in
            let shown = expanded.contains(foldKey(family.parent.id))
                ? family.children
                : family.children.filter { $0.session.activity == .blocked || $0.id == selected }
            let head = NestedRow(row: family.parent, family: family.children.isEmpty && family.needsYou == 0 ? nil : family, nested: false)
            return [head] + shown.map { NestedRow(row: $0, family: nil, nested: true) }
        }
    }

    static func foldKey(_ id: ScopedSessionID) -> String { "\(id.hostId.uuidString):\(id.sessionId)" }
}
