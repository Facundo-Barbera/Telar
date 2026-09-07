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
}
struct PushStatus: Decodable { var configured: Bool }

@MainActor @Observable final class MobileNotifications {
    static let shared = MobileNotifications()
    var destination: ScopedSessionID?
    var visibleSession: ScopedSessionID?
    var settings: AppSettings?
    var status = "Notifications are off"
    var activityError: String?
    var followed: Set<ScopedSessionID> = []
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
    }
    private func saveStartToken(_ data: Data) {
        startToken = data.map { String(format: "%02x", $0) }.joined()
        defaults.set(startToken, forKey: "telar.activity.startToken")
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
    var completions = UserDefaults.standard.bool(forKey: "telar.notifications.completions") {
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
        var unavailable = 0
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
            do {
                let reply = try await api.registerPush(.init(hostId: host.id.uuidString, token: token,
                    topic: Bundle.main.bundleIdentifier ?? "com.telar.mobile", sandbox: sandbox,
                    enabled: enabled && allowed, completions: completions, previews: previews,
                    mutedSessions: mutedSessions, activities: subscriptions,
                    liveActivities: liveActivities && ActivityAuthorizationInfo().areActivitiesEnabled,
                    pushToStartToken: startToken, hostName: host.name))
                if !reply.configured { unavailable += 1 }
            } catch { unavailable += 1 }
        }
        status = unavailable > 0 ? "Push unavailable on \(unavailable) Mac(s). Check connection and push setup." : (enabled && allowed ? "Push registration saved" : "Notifications are off")
    }

    func refreshActivityPrivacy() async {
        for activity in Activity<SessionActivityAttributes>.activities {
            var state = activity.content.state
            if !previews { state.title = activity.attributes.sessionId == "__automatic__" ? "Telar work" : "Telar session" }
            else if let host = UUID(uuidString: activity.attributes.hostId),
                    let snapshot = try? await settings?.api(for: host)?.session(state.sessionId ?? activity.attributes.sessionId) {
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
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in MobileNotifications.shared.registered(deviceToken) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in MobileNotifications.shared.status = "Push registration failed. Check network and signing." }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let url = (response.notification.request.content.userInfo["url"] as? String).flatMap(URL.init(string:))
        Task { @MainActor in
            if let url { MobileNotifications.shared.destination = ScopedSessionID(url: url) }
            completionHandler()
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
