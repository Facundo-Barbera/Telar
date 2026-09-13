import Foundation
import Observation

/// t3's model: every Mac stays live at once. One InboxStore per host — each
/// keeps its own settling policy, its own 3s/10s cadence, its own error —
/// and this layer only MERGES. Banding (active/snoozed/settled) is per host;
/// only the ORDER is global. One Mac going dark cannot blank the others.
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

/// PURE — the fold the tests pin. Each part arrives already banded by its
/// own store; the merge interleaves by the same keys the single-host list
/// sorted on (active: createdAt desc, tail: updatedAt desc).
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
    /// nil = all Macs.
    var filter: HostID?
    /// Fingerprints the stores were built against, so a token/address change
    /// swaps ONE store while the rest keep polling, unblinking.
    private var fingerprints: [HostID: String] = [:]
    private var order: [HostID] = []

    struct Failure: Identifiable, Equatable {
        let hostId: HostID
        var message: String
        var needsPairing: Bool
        /// When that Mac's rows on screen were recorded, if they are the
        /// phone's own copy rather than a live answer. Nil: nothing cached,
        /// the failure is the only thing to show for it.
        var recordedAt: Timestamp?
        var id: HostID { hostId }
    }

    /// The Macs whose rows are the phone's copy right now — a row can dim
    /// itself by asking.
    var staleHosts: Set<HostID> {
        Set(stores.compactMap { id, store in store.recordedAt == nil ? nil : id })
    }

    var sections: MergedSections {
        mergeInbox(order.compactMap { id in stores[id].map { (id, $0.sections) } }, filter: filter)
    }

    var failures: [Failure] {
        order.compactMap { id in
            guard let store = stores[id], let message = store.lastError else { return nil }
            return Failure(hostId: id, message: message, needsPairing: store.unauthorized, recordedAt: store.recordedAt)
        }
    }

    /// Loaded once ANY Mac has answered — one dead host must not hold the
    /// whole list on a spinner.
    var loaded: Bool {
        stores.values.contains { $0.loaded }
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

    /// Each Mac's own arrangement, keyed by host — one document per Mac, and
    /// never merged: the keys inside are that Mac's, so folding two of them
    /// together would place one Mac's rows by another's decisions.
    var layouts: [HostID: SidebarLayout] {
        stores.mapValues(\.layout)
    }

    /// WHO EACH SESSION IS WORKING FOR, scoped by Mac. An assignment's
    /// `fromSessionId` is a BARE id, meaningful only inside the engine that
    /// stamped it — so the coordinator it names must be looked for on that Mac
    /// and nowhere else, exactly as `applyRead` is routed rather than broadcast.
    var assignments: [ScopedSessionID: [SessionAssignment]] {
        var found: [ScopedSessionID: [SessionAssignment]] = [:]
        for (hostId, store) in stores {
            for (sessionId, held) in store.assignments {
                found[ScopedSessionID(hostId: hostId, sessionId: sessionId)] = held
            }
        }
        return found
    }

    /// Who the pinned conversations have asked to be woken by, scoped the same
    /// way and for the same reason.
    var following: [ScopedSessionID: [Subscription]] {
        var found: [ScopedSessionID: [Subscription]] = [:]
        for (hostId, store) in stores {
            for (sessionId, held) in store.following {
                found[ScopedSessionID(hostId: hostId, sessionId: sessionId)] = held
            }
        }
        return found
    }

    func layout(_ hostId: HostID) -> SidebarLayout {
        stores[hostId]?.layout ?? SidebarLayout()
    }

    /// A drop on this phone, drawn before the write comes back. ROUTED BY THE
    /// HOST, for the same reason `applyRead` is: an arrangement is one Mac's.
    func applyLayout(_ hostId: HostID, _ next: SidebarLayout) {
        stores[hostId]?.applyLayout(next)
    }

    /// Reconcile the store set with the host book. Unchanged hosts keep
    /// their store (no poll churn, no flash of empty).
    func sync(hosts: [Host], settings: AppSettings) {
        order = hosts.map(\.id)
        var next: [HostID: InboxStore] = [:]
        for host in hosts {
            let fingerprint = settings.apiFingerprint(host.id)
            if let existing = stores[host.id], fingerprints[host.id] == fingerprint {
                next[host.id] = existing
            } else if let api = settings.api(for: host.id) {
                stores[host.id]?.stop()
                let store = InboxStore(api: api, hostId: host.id, cache: settings.snapshotCache(for: host.id))
                store.start()
                next[host.id] = store
            }
            fingerprints[host.id] = fingerprint
        }
        for (id, store) in stores where next[id] == nil {
            store.stop()
            fingerprints[id] = nil
            // Forgetting a Mac forgets what it said.
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

    /// A read receipt landed. ROUTED BY THE HOST, never broadcast: two Macs can
    /// mint the same session id, so applying it everywhere would clear the dot
    /// on a different Mac's session that happens to share one.
    func applyRead(_ ref: ScopedSessionID, answer: Session) {
        stores[ref.hostId]?.applyRead(ref.sessionId, answer: answer)
    }
}
