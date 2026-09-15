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

/// PURE — the Main-session fold, pinned by the tests exactly as `mergeInbox` is
/// (#522). Each part is one Mac's designation and the rows it has already
/// banded; this only picks.
///
/// ONE PER MAC, NOT ONE FULL STOP, and that is this phone's honest reading of
/// the desktop's "one entry". A designation is a fact about the MAC that holds
/// it, and unlike the cockpit — which sits on the machine it coordinates from —
/// this app is remote to all of them. One Mac paired, which is most phones, is
/// exactly one row; three paired and coordinating means three, because hiding
/// two would be the sidebar deciding which Mac the reader meant.
///
/// A DESIGNATION WITH NO ROW DRAWS NOTHING. The id is the Mac's; the
/// conversation it names is in that Mac's own sections because its engine keeps
/// it there while Main is on. A Mac still answering its first poll has the id
/// and not yet the row, and a row that opened nothing would be worse than none.
///
/// IN THE MACS' OWN ORDER, which is the order their groups appear in below: a
/// band that re-sorted itself as conversations were touched would move under
/// the thumb.
func mainSessionRows(
    _ parts: [(hostId: HostID, main: MainSession?, sections: InboxSections)],
    filter: HostID?
) -> [HostedSession] {
    parts.compactMap { part in
        guard filter == nil || part.hostId == filter else { return nil }
        guard let main = part.main, main.enabled, let sessionId = main.sessionId else { return nil }
        let rows = part.sections.active + part.sections.snoozed + part.sections.settled
        guard let session = rows.first(where: { $0.id == sessionId }) else { return nil }
        return HostedSession(hostId: part.hostId, session: session)
    }
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

    /// THE CONVERSATIONS THE MACS CALL MAIN (#522) — experimental, off by
    /// default, and empty on every phone whose Macs have never switched it on.
    /// The fold is `mainSessionRows` above, where the tests can reach it.
    var mainSessions: [HostedSession] {
        mainSessionRows(order.compactMap { id in stores[id].map { (id, $0.mainSession, $0.sections) } }, filter: filter)
    }

    /// HOW MANY SETTLED ROWS THE MACS ARE HOLDING BACK (#457), summed over the
    /// ones being shown. Their live reads answer the unsettled rows alone until
    /// somebody opens the shelf, so this is what draws the shelf that asks.
    ///
    /// Zero from a Mac that predates the filter — it sent every row, and
    /// `sections.settled` already holds them.
    var shelvedOnMacs: Int {
        stores.reduce(0) { total, entry in
            guard filter == nil || filter == entry.key else { return total }
            return total + entry.value.shelvedOnMac
        }
    }

    /// A reader opened the settled shelf: ask every Mac for its rows, now
    /// rather than on the next tick — otherwise they open it and watch an empty
    /// shelf for three seconds. Concurrently and per store, exactly like
    /// `refresh` below, so one slow Mac does not hold the others' rows.
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

    /// Loaded once ANY Mac has answered — one dead host must not hold the
    /// whole list on a spinner.
    var loaded: Bool {
        stores.values.contains { $0.loaded }
    }

    /// IS ANYTHING REGISTERED AT ALL — the question that tells an empty rail
    /// apart from an empty registry, so the phone can offer the desktop's two
    /// different sentences rather than one that covers both (#404, `SidebarEmpty`
    /// in app-sidebar.tsx). Honours the Mac filter: a machine with no projects
    /// has none while it is the one being shown.
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

    /// WHAT ANOTHER CONVERSATION ON THE SAME MAC IS CALLED — for a row that
    /// names one by id, which today is a settled delegate naming its
    /// coordinator (`SessionSettledBy`).
    ///
    /// SCOPED BY HOST, for `assignments`' reason: two Macs can mint the same
    /// session id, so a global search could name a stranger. Nil when that Mac
    /// is not answering, or when the coordinator has since been archived — the
    /// hint says what happened without a name rather than inventing one.
    func title(_ id: EngineID, on hostId: HostID) -> String? {
        guard let sections = stores[hostId]?.sections else { return nil }
        for band in [sections.active, sections.snoozed, sections.settled] {
            if let found = band.first(where: { $0.id == id }) { return found.title }
        }
        return nil
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
    ///
    /// `active` IS THE SCENE PHASE, AND A NEW STORE ONLY POLLS WHEN IT IS TRUE
    /// (#499). This used to start every store it built, whatever the app was
    /// doing — and it is called on the host book changing, which a backgrounded
    /// phone does all by itself: a token refresh, a Mac renamed from the
    /// cockpit. The poll that began then had nothing to stop it, because
    /// `onChange(of: scenePhase)` fires on a CHANGE and the phase was already
    /// where it was going to stay. It is passed in rather than remembered here
    /// for the mirror-image reason: the phase the app LAUNCHED in never arrives
    /// as a change either, so a flag this class kept for itself would be wrong
    /// exactly once, at the only moment that matters.
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
