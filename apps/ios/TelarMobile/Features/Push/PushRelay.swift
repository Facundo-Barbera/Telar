import Foundation

enum NotificationPrompt {
    static let askedKey = "telar.notifications.askedAfterPairing"

    static func shouldAsk(asked: Bool, enabled: Bool) -> Bool {
        !asked && !enabled
    }
}

struct PushReadiness: Equatable {
    var deviceUnsupported = false

    var notSending: Set<HostID> = []

    var unreachable: Set<HostID> = []

    var isEmpty: Bool { notSending.isEmpty && unreachable.isEmpty }

    func statusLine(enabled: Bool, allowed: Bool) -> String {
        if !notSending.isEmpty {
            return deviceUnsupported
                ? Self.unsupportedLine
                :"Notifications couldn't be set up just now; tap Check connection to try again."
        }
        if !unreachable.isEmpty {
            let count = unreachable.count
            return count == 1
                ? "One Mac did not answer. Check that it is awake and this phone can reach it."
                : "\(count) Macs did not answer. Check that they are awake and this phone can reach them."
        }
        if !enabled { return "Notifications are off" }
        if !allowed { return "Notifications are disabled in system Settings" }
        return "Push registration saved"
    }

    static let unsupportedLine = "Notifications can't be set up on this device."
}
