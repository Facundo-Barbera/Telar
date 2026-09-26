import ActivityKit
import Observation
import UIKit
import UserNotifications

struct PushRegistration: Encodable {
    struct Follow: Encodable {
        var sessionId: String
        var token: String
        var startedAt: Double
    }
    var hostId: String
    var token: String
    var topic: String
    var sandbox: Bool
    var enabled: Bool
    var completions: Bool
    var previews: Bool
    var mutedSessions: [String]
    var activities: [Follow]
    var liveActivities: Bool = false
    var pushToStartToken: String? = nil
    var hostName: String? = nil
    /// Relay v2: how this Mac sends to this phone without holding its tokens.
    /// An older Mac ignores it and keeps using the fields above.
    var relay: RelayCredential? = nil
}
struct PushStatus: Decodable {
    var configured: Bool
    /// Absent from a Mac older than the field.
    var activity: ActivityReport?
}

@MainActor @Observable final class MobileNotifications {
    static let shared = MobileNotifications()
    var destination: ScopedSessionID?
    var visibleSession: ScopedSessionID?
    var settings: AppSettings?
    var status = "Notifications are off"
    /// WHICH MACS CANNOT PUSH, AND WHY — issue #579.
    ///
    /// This used to be one integer called `unavailable`, counting a Mac with no
    /// relay and a Mac that did not answer as the same thing. They are not: one
    /// is a credential somebody has to go and write, in a named screen, on that
    /// machine; the other is a network. Kept apart so the banner and the status
    /// line can point at the right one — see `PushReadiness`.
    var readiness = PushReadiness()
    var activityError: String?
    var followed: Set<ScopedSessionID> = []
    /// Each Mac's word on this phone's automatic Live Activity, from the last sync.
    var activityReports: [HostID: ActivityReport] = [:]
    /// The latest refused start already answered with a forced re-send, so one
    /// refusal costs one extra sync rather than a loop.
    private var resyncedForStartAt: Double = 0
    private var token: String? = UserDefaults.standard.string(forKey: "telar.apns.token")
    private var activityTokens: [String: String] = [:]
    private var watchers: [String: Task<Void, Never>] = [:]
    private var stateWatchers: [String: Task<Void, Never>] = [:]
    private let defaults = UserDefaults.standard
    private var synchronizing = false
    private var syncAgain = false
    private var attemptedRegistration = false
    private var startToken: String? = UserDefaults.standard.string(forKey: "telar.activity.startToken")
    private var startTokenWatcher: Task<Void, Never>?
    private var incomingActivityWatcher: Task<Void, Never>?
    var liveActivities = UserDefaults.standard.object(forKey: "telar.activities.enabled") as? Bool ?? true {
        didSet { defaults.set(liveActivities, forKey: "telar.activities.enabled") }
    }

    // Installed during App initialization, including an APNs background launch.
    func start(settings: AppSettings) {
        self.settings = settings
        guard startTokenWatcher == nil else { return }
        if let data = Activity<SessionActivityAttributes>.pushToStartToken { saveStartToken(data) }
        startTokenWatcher = Task { [weak self] in
            for await data in Activity<SessionActivityAttributes>.pushToStartTokenUpdates {
                self?.saveStartToken(data)
                await self?.syncRegistrations()
            }
        }
        incomingActivityWatcher = Task { [weak self] in
            for await activity in Activity<SessionActivityAttributes>.activityUpdates {
                self?.watch(activity)
                await self?.syncRegistrations()
            }
        }
        restoreActivities()
        Task { await syncRegistrations() }
        // The read-sync safety net: alerts for sessions the Mac already has as
        // read, which a throttled or missed silent push left behind.
        Task { await ReadSync.reconcile(settings: settings) }
    }
    private func saveStartToken(_ data: Data) {
        startToken = data.map { String(format: "%02x", $0) }.joined()
        defaults.set(startToken, forKey: "telar.activity.startToken")
    }
    /// The Live Activities status lines for Settings — see `LiveActivityDiagnosis`.
    var liveActivityDiagnosis: [String] {
        LiveActivityDiagnosis.lines(systemAllowed: ActivityAuthorizationInfo().areActivitiesEnabled, toggle: liveActivities,
                                    hasStartToken: startToken != nil,
                                    macs: (settings?.hosts ?? []).map { ($0.name, activityReports[$0.id]) })
    }
    func setLiveActivities(_ enabled: Bool) async {
        liveActivities = enabled
        if !enabled {
            for activity in Activity<SessionActivityAttributes>.activities where activity.attributes.sessionId == "__automatic__" {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
        await syncRegistrations()
    }

    var enabled = UserDefaults.standard.bool(forKey: "telar.notifications.enabled") {
        didSet { defaults.set(enabled, forKey: "telar.notifications.enabled") }
    }
    /// ON BY DEFAULT (owner's decision, #584). `bool(forKey:)` answers `false`
    /// for a key nobody has written, so every phone that had never opened this
    /// setting was silently opted OUT of the completion alert it was told it
    /// would get. `object(forKey:)` distinguishes "off" from "never set".
    var completions = UserDefaults.standard.object(forKey: "telar.notifications.completions") as? Bool ?? true {
        didSet { defaults.set(completions, forKey: "telar.notifications.completions") }
    }
    var previews = UserDefaults.standard.bool(forKey: "telar.notifications.previews") {
        didSet { defaults.set(previews, forKey: "telar.notifications.previews") }
    }
    var muted = Set(UserDefaults.standard.stringArray(forKey: "telar.notifications.muted") ?? []) {
        didSet { defaults.set(Array(muted), forKey: "telar.notifications.muted") }
    }
    func isMuted(_ ref: ScopedSessionID) -> Bool { muted.contains(ref.url.absoluteString) }
    func toggleMute(_ ref: ScopedSessionID) async {
        var next = muted
        if next.contains(ref.url.absoluteString) { next.remove(ref.url.absoluteString) } else { next.insert(ref.url.absoluteString) }
        muted = next
        await syncRegistrations()
    }

    func enable() async {
        do {
            enabled = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            if enabled { UIApplication.shared.registerForRemoteNotifications(); status = "Connecting notifications…" }
            else { status = "Notifications are disabled in system Settings" }
        } catch { status = "Couldn't request notification permission" }
        await syncRegistrations()
    }
    func registered(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        defaults.set(token, forKey: "telar.apns.token")
        Task { await syncRegistrations() }
    }
    func syncRegistrations() async {
        syncAgain = true
        guard !synchronizing else { return }
        synchronizing = true
        repeat {
            syncAgain = false
            await performRegistrationSync()
        } while syncAgain
        synchronizing = false
    }
    private func performRegistrationSync() async {
        restoreActivities()
        guard let settings else { return }
        if (enabled || liveActivities || !followed.isEmpty) && !attemptedRegistration {
            attemptedRegistration = true
            UIApplication.shared.registerForRemoteNotifications()
        }
        guard let token else { return }
        let authorization = await UNUserNotificationCenter.current().notificationSettings()
        let allowed = authorization.authorizationStatus == .authorized || authorization.authorizationStatus == .provisional
        var next = PushReadiness()
        var reports: [HostID: ActivityReport] = [:]
        let relayTokens = currentRelayTokens(token)
        for host in settings.hosts {
            guard let api = settings.api(for: host.id) else { continue }
            let activities = Activity<SessionActivityAttributes>.activities.filter { $0.attributes.hostId == host.id.uuidString }
            let subscriptions = activities.compactMap { activity -> PushRegistration.Follow? in
                guard let pushToken = activityTokens[activity.id], activity.activityState == .active || activity.activityState == .stale else { return nil }
                return .init(sessionId: activity.attributes.sessionId, token: pushToken, startedAt: activity.content.state.startedAt.timeIntervalSince1970)
            }
            let mutedSessions = muted.compactMap { URL(string: $0).flatMap(ScopedSessionID.init(url:)) }.filter { $0.hostId == host.id }.map(\.sessionId)
            #if DEBUG
            let sandbox = true
            #else
            let sandbox = false
            #endif
            let relay = await PushRelayClient.shared.credential(for: host.id.uuidString, tokens: relayTokens)
            do {
                let reply = try await api.registerPush(.init(hostId: host.id.uuidString, token: token,
                    topic: Bundle.main.bundleIdentifier ?? "com.telar.mobile", sandbox: sandbox,
                    enabled: enabled && allowed, completions: completions, previews: previews,
                    mutedSessions: mutedSessions, activities: subscriptions,
                    liveActivities: liveActivities && ActivityAuthorizationInfo().areActivitiesEnabled,
                    pushToStartToken: startToken, hostName: host.name, relay: relay))
                // REGISTERED, AND TOLD IT WILL HEAR NOTHING. The Mac has this
                // phone's token and no relay to send with; that is a fact about
                // the Mac, and the banner says which one.
                if !reply.configured { next.missingRelay.insert(host.id) }
                if let report = reply.activity { reports[host.id] = report }
            } catch { next.unreachable.insert(host.id) }
        }
        readiness = next
        activityReports = reports
        // A Mac says the relay has no start token for this phone: re-read it from
        // ActivityKit and push the tokens again, once per refused start.
        let refused = reports.values.filter(LiveActivityDiagnosis.startTokenMissingAtRelay).compactMap { $0.lastStart?.at }
        if let latest = refused.max(), latest > resyncedForStartAt {
            resyncedForStartAt = latest
            if let data = Activity<SessionActivityAttributes>.pushToStartToken { saveStartToken(data) }
            PushRelayClient.shared.forceRefresh()
            syncAgain = true
        }
        status = next.statusLine(enabled: enabled, allowed: allowed)
    }

    /// What the relay should hold for this phone: one list across every Mac,
    /// each Live Activity named by its session id (the name a Mac sends by).
    private func currentRelayTokens(_ token: String) -> RelayTokens {
        let activities = Activity<SessionActivityAttributes>.activities.compactMap { activity -> RelayTokens.Activity? in
            guard let pushToken = activityTokens[activity.id],
                  activity.activityState == .active || activity.activityState == .stale,
                  activity.attributes.sessionId.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil
            else { return nil }
            return .init(id: activity.attributes.sessionId, token: pushToken)
        }
        // THE START TOKEN IS ALWAYS SENT WHEN THERE IS ONE. Omitting it makes the
        // relay drop its copy, and a moment where Live Activities read as off (the
        // toggle, or iOS reporting them disabled while it settles) then left every
        // later start refused `not_registered`. Whether to start a card is the
        // Mac's decision, from `liveActivities` in the registration it gets.
        return RelayTokens(token: token, pushToStartToken: startToken, activities: Array(activities.prefix(8)))
    }

    /**
     ASK ONCE, AFTER PAIRING — issue #579.

     Nothing on this phone ever raised the system prompt. The only path to it
     was the toggle in Settings ▸ Notifications, so an owner who never opened
     that screen had an app which had never appeared in iOS's own Notifications
     list, and no reason to suspect it. Pairing a Mac is the moment the app
     first has something to notify anybody ABOUT, so it is the moment to ask.

     ONCE PER INSTALL, AND NEVER AFTER AN ANSWER — see `NotificationPrompt`.
     When it does not ask it still REGISTERS, because that round trip is how
     the phone learns whether that Mac can push at all.
     */
    func promptAfterPairing() async {
        guard NotificationPrompt.shouldAsk(asked: defaults.bool(forKey: NotificationPrompt.askedKey), enabled: enabled) else {
            await syncRegistrations()
            return
        }
        defaults.set(true, forKey: NotificationPrompt.askedKey)
        await enable()
    }

    /// The Approve action on an alert: accept exactly the request it named.
    /// False when that Mac is unknown here or refused, so the caller can say so.
    func approve(_ approval: NotificationActions.Approval) async -> Bool {
        guard let api = settings?.api(for: approval.ref.hostId) else { return false }
        do {
            try await api.resolveRequest(approval.ref.sessionId, requestId: approval.requestId, decision: .accept, reason: nil, answers: nil)
            return true
        } catch {
            return false
        }
    }

    func refreshActivityPrivacy() async {
        for activity in Activity<SessionActivityAttributes>.activities {
            var state = activity.content.state
            if !previews { state.title = activity.attributes.sessionId == "__automatic__" ? "Telar work" : "Telar session" }
            else if let host = UUID(uuidString: activity.attributes.hostId),
                    let snapshot = try? await settings?.api(for: host)?.session(state.sessionId ?? activity.attributes.sessionId, window: SnapshotWindow(turns: 1)) {
                state.title = snapshot.session.title
            }
            await activity.update(ActivityContent(state: state, staleDate: activity.content.staleDate))
        }
    }

    func follow(_ ref: ScopedSessionID, session: Session) async {
        activityError = nil
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { activityError = "Enable Live Activities for Telar in system Settings."; return }
        guard session.activity != .idle else { activityError = "Follow a session while it is working, queued, monitoring, or waiting for you."; return }
        guard !followed.contains(ref) else { return }
        let now = Date()
        let state = SessionActivityAttributes.ContentState(title: previews ? session.title : "Telar session", status: label(session), updatedAt: now, startedAt: now, ended: false)
        var pushType: PushType? = .token
        #if DEBUG
        // Unsigned simulator UI tests exercise rendering/lifecycle separately
        // from signed-device APNs acceptance. Never enabled in a Release build.
        if UserDefaults.standard.bool(forKey: "localActivityPreview"),
           let url = UserDefaults.standard.string(forKey: "mobilePreviewURL").flatMap(URL.init(string:)),
           url.scheme == "http", ["localhost", "127.0.0.1"].contains(url.host ?? "") { pushType = nil }
        #endif
        do {
            let activity = try Activity.request(attributes: SessionActivityAttributes(hostId: ref.hostId.uuidString, sessionId: ref.sessionId, hostName: settings?.host(ref.hostId)?.name ?? "Mac"), content: ActivityContent(state: state, staleDate: now.addingTimeInterval(90)), pushType: pushType)
            watch(activity)
            UIApplication.shared.registerForRemoteNotifications()
        } catch { activityError = "Couldn't start a Live Activity: \(error.localizedDescription)" }
    }
    func removeHost(_ host: HostID, api: HTTPEngineAPI?) async {
        if let token, let api {
            #if DEBUG
            let sandbox = true
            #else
            let sandbox = false
            #endif
            _ = try? await api.registerPush(.init(hostId: host.uuidString, token: token,
                topic: Bundle.main.bundleIdentifier ?? "com.telar.mobile", sandbox: sandbox,
                enabled: false, completions: false, previews: false, mutedSessions: [], activities: []))
        }
        await PushRelayClient.shared.revoke(host: host.uuidString)

        for ref in followed where ref.hostId == host { await unfollow(ref) }
    }
    func unfollow(_ ref: ScopedSessionID) async {
        for activity in Activity<SessionActivityAttributes>.activities where activity.attributes.hostId == ref.hostId.uuidString && activity.attributes.sessionId == ref.sessionId {
            await activity.end(nil, dismissalPolicy: .immediate)
            watchers.removeValue(forKey: activity.id)?.cancel()
            activityTokens[activity.id] = nil
        }
        followed.remove(ref)
        await syncRegistrations()
    }
    func update(_ session: Session, hostId: HostID) async {
        for activity in Activity<SessionActivityAttributes>.activities where activity.attributes.hostId == hostId.uuidString && activity.attributes.sessionId == session.id {
            let ended = session.activity == .idle
            let state = SessionActivityAttributes.ContentState(title: previews ? session.title : "Telar session", status: label(session), updatedAt: Date(), startedAt: activity.content.state.startedAt, ended: ended)
            let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(90))
            if ended { await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(300))) }
            else { await activity.update(content) }
        }
    }
    private func label(_ session: Session) -> String {
        switch session.activity {
        case .blocked: "Needs you"
        case .working: "Working"
        case .queued: "Queued"
        case .monitoring: "Monitoring"
        case .idle: session.lastTurnFailed == true ? "Failed" : "Finished"
        }
    }
    private func restoreActivities() {
        followed = []
        for activity in Activity<SessionActivityAttributes>.activities where activity.activityState == .active || activity.activityState == .stale {
            watch(activity)
        }
    }
    private func watch(_ activity: Activity<SessionActivityAttributes>) {
        if activity.attributes.sessionId == "__automatic__" && !liveActivities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
            return
        }
        guard let host = UUID(uuidString: activity.attributes.hostId) else { return }
        followed.insert(.init(hostId: host, sessionId: activity.attributes.sessionId))
        if let data = activity.pushToken { activityTokens[activity.id] = data.map { String(format: "%02x", $0) }.joined() }
        guard watchers[activity.id] == nil else { return }
        stateWatchers[activity.id] = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                if state == .ended || state == .dismissed {
                    self?.followed.remove(.init(hostId: host, sessionId: activity.attributes.sessionId))
                    self?.activityTokens[activity.id] = nil
                    self?.watchers.removeValue(forKey: activity.id)?.cancel()
                    self?.stateWatchers[activity.id] = nil
                    await self?.syncRegistrations()
                    break
                }
            }
        }
        watchers[activity.id] = Task { [weak self] in
            for await data in activity.pushTokenUpdates {
                guard !Task.isCancelled else { break }
                self?.activityTokens[activity.id] = data.map { String(format: "%02x", $0) }.joined()
                await self?.syncRegistrations()
            }
        }
    }
}

final class MobileAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(NotificationActions.categories)
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in MobileNotifications.shared.registered(deviceToken) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in MobileNotifications.shared.status = "Push registration failed. Check network and signing." }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == NotificationActions.approve,
           let approval = NotificationActions.approval(from: response.notification.request.content.userInfo) {
            Task { @MainActor in
                if !(await MobileNotifications.shared.approve(approval)) { await NotificationActions.reportFailure(approval) }
                completionHandler()
            }
            return
        }
        let url = (response.notification.request.content.userInfo["url"] as? String).flatMap(URL.init(string:))
        Task { @MainActor in
            let ref = url.flatMap(ScopedSessionID.init(url:))
            if let ref { MobileNotifications.shared.destination = ref }
            completionHandler()
            // OPENING ONE IS LOOKING AT ALL OF THEM: the session's older alerts
            // come down with the one tapped. The Mac hears of it through the
            // ordinary receipt once the answer is actually on screen
            // (`ReadReceiptCourier`) — never from the tap alone, which is the
            // "marking on appear" `ReadReceipt.swift` refuses.
            if let ref { await ReadSync.clearDelivered([ref]) }
        }
    }
    /// THE SILENT READ-SYNC PUSH: the Mac saw these sessions read. Take their
    /// alerts down and answer at once — iOS allows about thirty seconds and
    /// budgets future wakes on how promptly this returns.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        let reads = Set(ReadSync.reads(from: userInfo))
        guard !reads.isEmpty else { completionHandler(.noData); return }
        Task {
            completionHandler(await ReadSync.clearDelivered(reads) ? .newData : .noData)
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let url = (notification.request.content.userInfo["url"] as? String).flatMap(URL.init(string:))
        Task { @MainActor in
            let ref = url.flatMap(ScopedSessionID.init(url:))
            completionHandler(ref != nil && ref == MobileNotifications.shared.visibleSession ? [] : [.banner, .sound])
        }
    }
}
