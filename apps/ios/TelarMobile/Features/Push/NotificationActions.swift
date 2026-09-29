import Foundation
import UserNotifications

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

    static func approval(from userInfo: [AnyHashable: Any]) -> Approval? {
        guard let url = (userInfo["url"] as? String).flatMap(URL.init(string:)),
              let ref = ScopedSessionID(url: url),
              let request = userInfo["request"] as? String, !request.isEmpty
        else { return nil }
        return Approval(ref: ref, requestId: request)
    }

    static func reportFailure(_ approval: Approval, sound: NotificationSound) async {
        let content = UNMutableNotificationContent()
        content.sound = sound.sound(.error)
        content.title = "Telar"
        content.body = "Couldn't approve. Open Telar to review the request."
        content.userInfo = ["url": approval.ref.url.absoluteString]
        content.categoryIdentifier = sessionCategory
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "approve-failed-\(approval.requestId)", content: content, trigger: nil))
    }
}
