import Foundation
import Observation

struct HostedSession: Identifiable, Equatable {
    let hostId: HostID
    let session: Session

    var id: ScopedSessionID { ScopedSessionID(hostId: hostId, sessionId: session.id) }
}

struct MergedSections: Equatable {
    var active: [HostedSession] = []
    var snoozed: [HostedSession] = []
    var settled: [HostedSession] = []

    var tail: [HostedSession] { snoozed + settled }
    var isEmpty: Bool { active.isEmpty && snoozed.isEmpty && settled.isEmpty }
}

func mergeInbox(_ parts: [(hostId: HostID, sections: InboxSections)], filter: HostID?) -> MergedSections {
    var merged = MergedSections()
    for part in parts where filter == nil || part.hostId == filter {
        merged.active.append(contentsOf: part.sections.active.map { HostedSession(hostId: part.hostId, session: $0) })
        merged.snoozed.append(contentsOf: part.sections.snoozed.map { HostedSession(hostId: part.hostId, session: $0) })
        merged.settled.append(contentsOf: part.sections.settled.map { HostedSession(hostId: part.hostId, session: $0) })
    }
    merged.active.sort { $0.session.createdAt > $1.session.createdAt }
    merged.snoozed.sort { $0.session.updatedAt > $1.session.updatedAt }
    merged.settled.sort { $0.session.updatedAt > $1.session.updatedAt }
    return merged
}

@MainActor @Observable final class MergedInbox {
    private(set) var stores: [HostID: InboxStore] = [:]

    var filter: HostID?

    private var fingerprints: [HostID: String] = [:]
    private var order: [HostID] = []

    struct Failure: Identifiable, Equatable {
        let hostId: HostID
        var message: String
        var needsPairing: Bool

        var recordedAt: Timestamp?
        var id: HostID { hostId }
    }

    var staleHosts: Set<HostID> {
        Set(stores.compactMap { id, store in store.recordedAt == nil ? nil : id })
    }

    var sections: MergedSections {
        mergeInbox(order.compactMap { id in stores[id].map { (id, $0.sections) } }, filter: filter)
    }

    var onCards: [HostedSession] {
        let stale = staleHosts
        let all = mergeInbox(order.compactMap { id in stores[id].map { (id, $0.sections) } }, filter: nil)
        return (all.active + all.tail.filter { $0.session.activity != .idle }).filter { !stale.contains($0.hostId) }
    }

    var shelvedOnMacs: Int {
        stores.reduce(0) { total, entry in
            guard filter == nil || filter == entry.key else { return total }
            return total + entry.value.shelvedOnMac
        }
    }

    func showSettled() async {
        await withTaskGroup(of: Void.self) { group in
            for store in stores.values {
                group.addTask { @MainActor in await store.showSettled() }
            }
        }
    }

    var failures: [Failure] {
        order.compactMap { id in
            guard let store = stores[id], let message = store.lastError else { return nil }
            return Failure(hostId: id, message: message, needsPairing: store.unauthorized, recordedAt: store.recordedAt)
        }
    }

    var loaded: Bool {
        stores.values.contains { $0.loaded }
    }

    var hasProjects: Bool {
        stores.contains { id, store in (filter == nil || filter == id) && !store.projects.isEmpty }
    }

    func projectName(_ session: HostedSession) -> String? {
        guard let projectId = session.session.projectId else { return nil }
        return stores[session.hostId]?.projectNames[projectId]
    }

    func project(_ session: HostedSession) -> ProjectRef? {
        guard let projectId = session.session.projectId else { return nil }
        return stores[session.hostId]?.projects[projectId]
    }

    func project(_ id: EngineID, on hostId: HostID) -> ProjectRef? {
        stores[hostId]?.projects[id]
    }

    func title(_ id: EngineID, on hostId: HostID) -> String? {
        guard let sections = stores[hostId]?.sections else { return nil }
        for band in [sections.active, sections.snoozed, sections.settled] {
            if let found = band.first(where: { $0.id == id }) { return found.title }
        }
        return nil
    }

    var layouts: [HostID: SidebarLayout] {
        stores.mapValues(\.layout)
    }

    var assignments: [ScopedSessionID: [SessionAssignment]] {
        var found: [ScopedSessionID: [SessionAssignment]] = [:]
        for (hostId, store) in stores {
            for (sessionId, held) in store.assignments {
                found[ScopedSessionID(hostId: hostId, sessionId: sessionId)] = held
            }
        }
        return found
    }

    func layout(_ hostId: HostID) -> SidebarLayout {
        stores[hostId]?.layout ?? SidebarLayout()
    }

    func applyLayout(_ hostId: HostID, _ next: SidebarLayout) {
        stores[hostId]?.applyLayout(next)
    }

    func sync(hosts: [Host], settings: AppSettings, active: Bool) {
        order = hosts.map(\.id)
        var next: [HostID: InboxStore] = [:]
        for host in hosts {
            let fingerprint = settings.apiFingerprint(host.id)
            if let existing = stores[host.id], fingerprints[host.id] == fingerprint {
                next[host.id] = existing
            } else if let api = settings.api(for: host.id) {
                stores[host.id]?.stop()
                let store = InboxStore(api: api, hostId: host.id, cache: settings.snapshotCache(for: host.id))
                if active { store.start() }
                next[host.id] = store
            }
            fingerprints[host.id] = fingerprint
        }
        for (id, store) in stores where next[id] == nil {
            store.stop()
            fingerprints[id] = nil

            settings.snapshotCache(for: id)?.cache.dropHost(id)
        }
        stores = next
        if let filter, !order.contains(filter) { self.filter = nil }
    }

    func start() {
        for store in stores.values { store.start() }
    }

    func stop() {
        for store in stores.values { store.stop() }
    }

    func refresh() async {
        await withTaskGroup(of: Void.self) { group in
            for store in stores.values {
                group.addTask { @MainActor in await store.refresh() }
            }
        }
    }

    func setSettled(_ ref: ScopedSessionID, _ settled: Bool) async {
        await stores[ref.hostId]?.setSettled(ref.sessionId, settled)
    }

    func applyRead(_ ref: ScopedSessionID, answer: Session) {
        stores[ref.hostId]?.applyRead(ref.sessionId, answer: answer)
    }
}
