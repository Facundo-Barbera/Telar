import AVFoundation
import Foundation

/// THIS APP'S CLAIM ON THE PHONE'S ONE SHARED AUDIO SESSION (#623).
///
/// It exists because `Dictation.stop()` is unconditional and stays that way —
/// its own comment says why: every path out comes through it, including the
/// ones that failed before anything opened, and a microphone left held keeps
/// the system's orange recording dot lit. `SessionView`'s `.onDisappear` leans
/// on exactly that, calling `stop()` every time somebody leaves a conversation.
///
/// The audio session is not this app's to hand back on those paths, though. A
/// `setActive(false, [.notifyOthersOnDeactivation])` reaches every other app on
/// the phone whether or not this one ever activated anything, which is why
/// leaving a conversation interrupted music in a session where dictation was
/// never used. So the claim is tracked, and only a session actually taken is
/// given back.
///
/// IT ALSO ANSWERS "DID WE TOUCH THE AUDIO HARDWARE AT ALL". `Dictation`'s
/// teardown reads `isHeld` to decide whether to instantiate `AVAudioEngine`'s
/// input node, because doing so configures an input route and is a second way
/// to disturb other audio. That works only because `take()` happens first in
/// `open()` — the ordering is commented at both ends, and is the one thing to
/// preserve if either moves.
///
/// ITS OWN TYPE SO THE RULE CAN BE PROVEN. Whether `setActive(false)` was
/// called is not something `AVAudioSession` will answer afterwards, and the
/// only other seam — driving `Dictation.stop()` from a test — starts an
/// `AVAudioEngine` and asks the test host for a microphone. This has neither.
@MainActor final class AudioSessionClaim {
    /// Whether this object believes it currently holds the session. `false`
    /// until a `take()` succeeds, and `false` again only once a handback has.
    private(set) var isHeld = false

    private let activate: () throws -> Void
    private let deactivate: () throws -> Void

    /// The real shared session — what every caller in the app gets. The
    /// closures below are a test seam and nothing else.
    init() {
        let session = AVAudioSession.sharedInstance()
        activate = { try session.setActive(true, options: []) }
        // `.notifyOthersOnDeactivation` is what actually un-ducks whatever was
        // playing, and is exactly what made this worth gating.
        deactivate = { try session.setActive(false, options: [.notifyOthersOnDeactivation]) }
    }

    init(activate: @escaping () throws -> Void, deactivate: @escaping () throws -> Void) {
        self.activate = activate
        self.deactivate = deactivate
    }

    /// Activate the session and remember that we did.
    ///
    /// A FAILURE CLAIMS NOTHING: a `setActive(true)` that throws left the
    /// session as it found it, and recording a claim there would hand back
    /// somebody else's.
    func take() throws {
        try activate()
        isHeld = true
    }

    /// Give back a session we took, and only one we took.
    ///
    /// NOT THROWING, because every caller is a teardown path with nothing to do
    /// about a failure. But a failed handback KEEPS the claim rather than
    /// clearing it: deactivation throws while the session is still busy, which
    /// means it is still ours, and of the two ways to be wrong here, leaving
    /// the session active is the worse one. `stop()` runs again on the way out
    /// of the screen, and that is the next chance to release it.
    func handBack() {
        guard isHeld else { return }
        do {
            try deactivate()
            isHeld = false
        } catch {
            // Still ours. The next teardown tries again.
        }
    }
}
