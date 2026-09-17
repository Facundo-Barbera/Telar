import Foundation

/// WHY NO NOTIFICATION EVER ARRIVED, SAID OUT LOUD — issue #579.
///
/// ── THE TWO SILENCES THIS FILE ENDS ─────────────────────────────────────────
/// Nothing on this phone ever ASKED for notification permission. The only path
/// to the system prompt was the toggle in Settings ▸ Notifications, so an owner
/// who never opened that screen had an app which had never appeared in iOS's
/// own Notifications list — and no reason to suspect it.
///
/// And when the Mac answered `configured: false` — it has no push relay, so it
/// will send nothing — the app folded that into a count of "unavailable" Macs
/// alongside ones that simply did not reply. Two different problems with two
/// different fixes, reported as one sentence, on one screen nobody was on.
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
/// THE TWO STATES ARE KEPT APART, which is the whole point: a Mac with no relay
/// is a thing to go and FIX, on that Mac, in a named screen; a Mac that did not
/// answer is a network that will probably come back. Counting them together —
/// which is what the old `unavailable` tally did — produces a sentence that
/// points nowhere.
struct PushReadiness: Equatable {
    /// Macs that answered `configured: false`: reachable, registered, and
    /// certain to send nothing.
    var missingRelay: Set<HostID> = []
    /// Macs that did not answer at all.
    var unreachable: Set<HostID> = []

    var isEmpty: Bool { missingRelay.isEmpty && unreachable.isEmpty }

    /// The sentence under the toggle in Settings ▸ Notifications.
    ///
    /// THE RELAY COMES FIRST when both are true, because it is the one the
    /// person can act on: a Mac that is away will answer later by itself, and a
    /// Mac with no relay will not, however long anybody waits.
    ///
    /// IT NAMES THE SCREEN ON THE MAC. "Push unavailable — check your setup"
    /// was the old line, and it is the kind of sentence that leaves somebody
    /// checking the phone, which is not where the missing thing is.
    func statusLine(enabled: Bool, allowed: Bool) -> String {
        if !missingRelay.isEmpty {
            let count = missingRelay.count
            return count == 1
                ? "No push relay on that Mac, so it will send nothing. Open Settings ▸ Remote access on the Mac to provision one."
                : "No push relay on \(count) Macs, so they will send nothing. Open Settings ▸ Remote access on each Mac to provision one."
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

    /// The banner's own sentence — shorter, because it sits above a
    /// conversation rather than under the toggle it explains.
    static let bannerLine = "This Mac has no push relay configured, so it cannot notify you. Open Settings ▸ Remote access on the Mac."
}
