import Foundation
import UserNotifications

/**
 APPROVE AND OPEN, ON THE NOTIFICATION ITSELF.

 The Mac tags every alert with one of two categories (`CATEGORY_*` in
 `apps/web/lib/mobile/push.ts`, which must match these ids):

 - `TELAR_REQUEST`: a session is blocked on exactly one approval (a command,
   an edit, a read, a tool call). It offers Approve and Open, and names that
   request in `request`.
 - `TELAR_SESSION`: everything else. It offers Open.

 APPROVE ASKS FOR AN UNLOCK. It runs something on the Mac, so a phone lying on a
 desk must not be able to do it from the lock screen. It resolves only the
 request the alert named, so tapping an old alert cannot approve something newer.
 Questions and secrets never get Approve; they have to be answered in the app.
 */
enum NotificationActions {
    static let requestCategory = "TELAR_REQUEST"
    static let sessionCategory = "TELAR_SESSION"
    static let approve = "TELAR_APPROVE"
    static let open = "TELAR_OPEN"

    static var categories: Set<UNNotificationCategory> {
        let open = UNNotificationAction(identifier: open, title: "Open", options: [.foreground])
        let approve = UNNotificationAction(identifier: approve, title: "Approve", options: [.authenticationRequired])
        return [
            UNNotificationCategory(identifier: requestCategory, actions: [approve, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: sessionCategory, actions: [open], intentIdentifiers: []),
        ]
    }

    struct Approval: Equatable {
        var ref: ScopedSessionID
        var requestId: EngineID
    }

    /// What an Approve tap resolves: the session the alert opens, and the one
    /// request it named. Nil for an alert that never offered Approve.
    static func approval(from userInfo: [AnyHashable: Any]) -> Approval? {
        guard let url = (userInfo["url"] as? String).flatMap(URL.init(string:)),
              let ref = ScopedSessionID(url: url),
              let request = userInfo["request"] as? String, !request.isEmpty
        else { return nil }
        return Approval(ref: ref, requestId: request)
    }

    /// A failed approval must not look like a successful one. Say so, and make
    /// the tap on that notice open the session.
    static func reportFailure(_ approval: Approval) async {
        let content = UNMutableNotificationContent()
        content.title = "Telar"
        content.body = "Couldn't approve. Open Telar to review the request."
        content.userInfo = ["url": approval.ref.url.absoluteString]
        content.categoryIdentifier = sessionCategory
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "approve-failed-\(approval.requestId)", content: content, trigger: nil))
    }
}
