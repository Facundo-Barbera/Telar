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
    var sounds: String? = nil
    var mutedSessions: [String]
    var activities: [Follow]
    var liveActivities: Bool = false
    var pushToStartToken: String? = nil
    var hostName: String? = nil
    var relay: RelayCredential? = nil
}
struct PushStatus: Decodable {
    var configured: Bool
    var activity: ActivityReport?
}

@MainActor @Observable final class MobileNotifications {
    static let shared = MobileNotifications()
    var destination: ScopedSessionID?
    var visibleSession: ScopedSessionID?
    var settings: AppSettings?
    var status = "Notifications are off"
    var readiness = PushReadiness()
    var activityError: String?
    var activityReports: [HostID: ActivityReport] = [:]
    private var resyncedForStartAt: Double = 0
    private var token: String? = UserDefaults.standard.string(forKey: "telar.apns.token")
    private var activityTokens: [String: String] = [:]
    private var watchers: [String: Task<Void, Never>] = [:]
    private var stateWatchers: [String: Task<Void, Never>] = [:]
    private let defaults = UserDefaults.standard
    private var synchronizing = false
    private var syncAgain = false
    private var attemptedRegistration = false
    private var startToken: String?
    private var startTokenRejected = false
    private var rejectedStartTokens = UserDefaults.standard.stringArray(forKey: "telar.activity.rejectedStartTokens") ?? []
    private var handledStartRejectionAt: Double = 0
    private var startTokenWatcher: Task<Void, Never>?
    private var incomingActivityWatcher: Task<Void, Never>?
    private var dismissedCards: Set<HostID> = []
    var liveActivities = UserDefaults.standard.object(forKey: "telar.activities.enabled") as? Bool ?? true {
        didSet { defaults.set(liveActivities, forKey: "telar.activities.enabled") }
    }

    func start(settings: AppSettings) {
        self.settings = settings
        guard startTokenWatcher == nil else { return }
        defaults.removeObject(forKey: "telar.activity.startToken")
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
        Task { await syncRegistrations() }
        Task { await ReadSync.reconcile(settings: settings) }
    }
    private func saveStartToken(_ data: Data) {
        let confirmed = data.map { String(format: "%02x", $0) }.joined()
        startToken = StartTokenPolicy.usable(confirmed, rejected: Set(rejectedStartTokens))
        startTokenRejected = startToken == nil
    }
    var liveActivityDiagnosis: [String] {
        LiveActivityDiagnosis.lines(systemAllowed: ActivityAuthorizationInfo().areActivitiesEnabled, toggle: liveActivities,
                                    hasStartToken: startToken != nil, startTokenRejected: startTokenRejected,
                                    currentToken: startToken.map(StartTokenPolicy.fingerprint),
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
    var completions = UserDefaults.standard.object(forKey: "telar.notifications.completions") as? Bool ?? true {
        didSet { defaults.set(completions, forKey: "telar.notifications.completions") }
    }
    var previews = UserDefaults.standard.bool(forKey: "telar.notifications.previews") {
        didSet { defaults.set(previews, forKey: "telar.notifications.previews") }
    }
    var sounds = UserDefaults.standard.string(forKey: "telar.notifications.sounds").flatMap(NotificationSound.init(rawValue:)) ?? .hilo {
        didSet { defaults.set(sounds.rawValue, forKey: "telar.notifications.sounds") }
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
        await endDuplicateCards()
        for activity in Activity<SessionActivityAttributes>.activities where activity.activityState == .active || activity.activityState == .stale {
            watch(activity)
        }
        guard let settings else { return }
        if (enabled || liveActivities) && !attemptedRegistration {
            attemptedRegistration = true
            UIApplication.shared.registerForRemoteNotifications()
        }
        guard let token else {
            if PushRelayClient.shared.unavailable { status = PushReadiness.unsupportedLine }
            return
        }
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
                    topic: Bundle.main.bundleIdentifier ?? "io.github.novarix.telar", sandbox: sandbox,
                    enabled: enabled && allowed, completions: completions, previews: previews, sounds: sounds.rawValue,
                    mutedSessions: mutedSessions, activities: subscriptions,
                    liveActivities: liveActivities && ActivityAuthorizationInfo().areActivitiesEnabled,
                    pushToStartToken: startToken, hostName: host.name, relay: relay))
                if !reply.configured { next.notSending.insert(host.id) }
                if let report = reply.activity { reports[host.id] = report }
            } catch { next.unreachable.insert(host.id) }
        }
        next.deviceUnsupported = PushRelayClient.shared.unavailable
        readiness = next
        activityReports = reports
        let refused = reports.values.filter(LiveActivityDiagnosis.startTokenMissingAtRelay).compactMap { $0.lastStart?.at }
        if let latest = refused.max(), latest > resyncedForStartAt {
            resyncedForStartAt = latest
            if let data = Activity<SessionActivityAttributes>.pushToStartToken { saveStartToken(data) }
            PushRelayClient.shared.forceRefresh()
            syncAgain = true
        }
        let rejected = reports.values.compactMap { report -> ActivityReport.Start? in
            LiveActivityDiagnosis.startTokenRejectedByApple(report) ? report.lastStart : nil
        }
        if let latest = rejected.max(by: { $0.at < $1.at }), latest.at > handledStartRejectionAt {
            handledStartRejectionAt = latest.at
            if let dead = latest.token ?? startToken.map(StartTokenPolicy.fingerprint) {
                rejectedStartTokens = StartTokenPolicy.remember(print: dead, in: rejectedStartTokens)
                defaults.set(rejectedStartTokens, forKey: "telar.activity.rejectedStartTokens")
                if startToken.map(StartTokenPolicy.fingerprint) == dead { startToken = nil; startTokenRejected = true }
            }
            if let data = Activity<SessionActivityAttributes>.pushToStartToken { saveStartToken(data) }
            PushRelayClient.shared.forceRefresh()
            syncAgain = true
        }
        status = next.statusLine(enabled: enabled, allowed: allowed)
    }

    private func currentRelayTokens(_ token: String) -> RelayTokens {
        let activities = Activity<SessionActivityAttributes>.activities.compactMap { activity -> RelayTokens.Activity? in
            guard let pushToken = activityTokens[activity.id],
                  activity.activityState == .active || activity.activityState == .stale,
                  activity.attributes.sessionId.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil
            else { return nil }
            return .init(id: activity.attributes.sessionId, token: pushToken)
        }
        return RelayTokens(token: token, pushToStartToken: startToken, activities: Array(activities.prefix(8)))
    }

    func promptAfterPairing() async {
        guard NotificationPrompt.shouldAsk(asked: defaults.bool(forKey: NotificationPrompt.askedKey), enabled: enabled) else {
            await syncRegistrations()
            return
        }
        defaults.set(true, forKey: NotificationPrompt.askedKey)
        await enable()
    }

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
            if !previews { state.title = "Telar work" }
            else if let host = UUID(uuidString: activity.attributes.hostId),
                    let snapshot = try? await settings?.api(for: host)?.session(state.sessionId ?? activity.attributes.sessionId, window: SnapshotWindow(turns: 1)) {
                state.title = snapshot.session.title
            }
            await activity.update(ActivityContent(state: state, staleDate: activity.content.staleDate))
        }
    }

    func startAutomaticCards(_ active: [HostedSession], projectName: (HostedSession) -> String?) {
        guard UIApplication.shared.applicationState == .active else { return }
        let projects = Dictionary(active.compactMap { s in projectName(s).map { (s.session.id, $0) } }, uniquingKeysWith: { first, _ in first })
        let working = Set(active.filter { $0.session.activity != .idle }.map(\.hostId))
        dismissedCards = AutomaticCard.dismissedStillIdle(dismissedCards, working: working)
        let carded = Set(Activity<SessionActivityAttributes>.activities
            .filter { $0.attributes.sessionId == AutomaticCard.sessionId && ($0.activityState == .active || $0.activityState == .stale) }
            .compactMap { UUID(uuidString: $0.attributes.hostId) })
        let engineStarts = Set(activityReports.filter { AutomaticCard.engineStarts($0.value) }.keys)
        let hosts = AutomaticCard.hostsToStart(enabled: liveActivities && ActivityAuthorizationInfo().areActivitiesEnabled,
                                               working: working, carded: carded, dismissed: dismissedCards, engineStarts: engineStarts)
        for host in hosts {
            for ended in Activity<SessionActivityAttributes>.activities where ended.attributes.hostId == host.uuidString {
                Task { await ended.end(nil, dismissalPolicy: .immediate) }
            }
            let now = Date()
            let state = AutomaticCard.initialState(active.filter { $0.hostId == host }.map(\.session), previews: previews, projects: projects, now: now)
            let attributes = SessionActivityAttributes(hostId: host.uuidString, sessionId: AutomaticCard.sessionId, hostName: HostLabel.short(settings?.host(host)?.name))
            do {
                let activity = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: now.addingTimeInterval(Self.activityStale)), pushType: .token)
                watch(activity)
            } catch { activityError = "Couldn't start a Live Activity: \(error.localizedDescription)" }
        }
        for activity in Activity<SessionActivityAttributes>.activities where activity.attributes.sessionId == AutomaticCard.sessionId {
            guard activity.activityState == .active || activity.activityState == .stale,
                  let host = UUID(uuidString: activity.attributes.hostId), working.contains(host) else { continue }
            let now = Date()
            guard let state = AutomaticCard.refreshed(activity.content.state, active.filter { $0.hostId == host }.map(\.session), previews: previews, projects: projects, now: now) else { continue }
            Task { await activity.update(ActivityContent(state: state, staleDate: now.addingTimeInterval(Self.activityStale))) }
        }
    }
    static let activityStale: TimeInterval = 600
    func removeHost(_ host: HostID, api: HTTPEngineAPI?) async {
        if let token, let api {
            #if DEBUG
            let sandbox = true
            #else
            let sandbox = false
            #endif
            _ = try? await api.registerPush(.init(hostId: host.uuidString, token: token,
                topic: Bundle.main.bundleIdentifier ?? "io.github.novarix.telar", sandbox: sandbox,
                enabled: false, completions: false, previews: false, mutedSessions: [], activities: []))
        }
        await PushRelayClient.shared.revoke(host: host.uuidString)
        for activity in Activity<SessionActivityAttributes>.activities where activity.attributes.hostId == host.uuidString {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
    private func endDuplicateCards() async {
        let shown = Activity<SessionActivityAttributes>.activities
        let extra = AutomaticCard.duplicates(shown.map {
            .init(id: $0.id, hostId: $0.attributes.hostId, sessionId: $0.attributes.sessionId, startedAt: $0.content.state.startedAt)
        })
        for activity in shown where extra.contains(activity.id) { await activity.end(nil, dismissalPolicy: .immediate) }
    }
    private func watch(_ activity: Activity<SessionActivityAttributes>) {
        if activity.attributes.sessionId == "__automatic__" && !liveActivities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
            return
        }
        guard let host = UUID(uuidString: activity.attributes.hostId) else { return }
        if let data = activity.pushToken { activityTokens[activity.id] = data.map { String(format: "%02x", $0) }.joined() }
        guard watchers[activity.id] == nil else { return }
        stateWatchers[activity.id] = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                if state == .dismissed && activity.attributes.sessionId == AutomaticCard.sessionId { self?.dismissedCards.insert(host) }
                if state == .ended || state == .dismissed {
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
        Task { @MainActor in
            MobileNotifications.shared.status = PushRelayClient.shared.unavailable
                ? PushReadiness.unsupportedLine : "Push registration failed. Check network and signing."
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == NotificationActions.approve,
           let approval = NotificationActions.approval(from: response.notification.request.content.userInfo) {
            Task { @MainActor in
                if !(await MobileNotifications.shared.approve(approval)) { await NotificationActions.reportFailure(approval, sound: MobileNotifications.shared.sounds) }
                completionHandler()
            }
            return
        }
        let url = (response.notification.request.content.userInfo["url"] as? String).flatMap(URL.init(string:))
        Task { @MainActor in
            let ref = url.flatMap(ScopedSessionID.init(url:))
            if let ref { MobileNotifications.shared.destination = ref }
            completionHandler()
            if let ref { await ReadSync.clearDelivered([ref]) }
        }
    }
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
