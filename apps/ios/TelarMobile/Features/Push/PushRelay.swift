import Foundation

/// WHY NO NOTIFICATION EVER ARRIVED, SAID OUT LOUD — issue #579.
///
/// ── THE TWO SILENCES THIS FILE ENDS ─────────────────────────────────────────
/// Nothing on this phone ever ASKED for notification permission. The only path
/// to the system prompt was the toggle in Settings ▸ Notifications, so an owner
/// who never opened that screen had an app which had never appeared in iOS's
/// own Notifications list — and no reason to suspect it.
///
/// And when a Mac answered `configured: false` — it has no way to send to this
/// phone — the app folded that into a count of "unavailable" Macs alongside
/// ones that simply did not reply. Two different problems, reported as one
/// sentence.
///
/// Both halves are decisions rather than rendering, so they live here where a
/// test can hold them: `NotificationPrompt` for when to ask, `PushReadiness`
/// for what to say.

enum NotificationPrompt {
    /// Where "we have asked" is remembered. Not `telar.notifications.enabled` —
    /// that is the ANSWER, and a person who said no must not be asked again on
    /// the next pairing.
    static let askedKey = "telar.notifications.askedAfterPairing"

    /// Whether pairing a Mac should raise the system permission prompt.
    ///
    /// ONCE PER INSTALL, NOT ONCE PER MAC. The permission belongs to the phone,
    /// not to any Mac, and iOS shows its alert exactly once whatever the app
    /// does — so asking again for a second Mac would be a silent no-op the app
    /// could easily misread as a refusal.
    ///
    /// AND NOT AT ALL IF IT IS ALREADY ON: somebody who found the toggle before
    /// they paired has already answered the question.
    static func shouldAsk(asked: Bool, enabled: Bool) -> Bool {
        !asked && !enabled
    }
}

/// What the phone knows about whether its Macs can actually push.
///
/// A Mac sends through the push relay with the credential this phone gave it,
/// so a Mac that answers `configured: false` is one this phone could not give
/// a credential to. Either this phone cannot register at all — then push is
/// simply unavailable here, and saying so is the whole answer — or the relay
/// could not be reached just now, which the next sync retries. A Mac that did
/// not answer is a network, and a different sentence.
struct PushReadiness: Equatable {
    /// This phone cannot register with the push relay (no App Attest: the
    /// simulator, an unknown build, or an attestation the relay refused).
    var deviceUnsupported = false
    /// Macs that answered `configured: false`: reachable, registered, and
    /// certain to send nothing.
    var notSending: Set<HostID> = []
    /// Macs that did not answer at all.
    var unreachable: Set<HostID> = []

    var isEmpty: Bool { notSending.isEmpty && unreachable.isEmpty }

    /// The sentence under the toggle in Settings ▸ Notifications. A Mac that
    /// will not send comes first: a Mac that is away answers later by itself.
    /// An unsupported phone that a Mac can still reach (a developer's own
    /// APNs key) says nothing about it, because push works there.
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
