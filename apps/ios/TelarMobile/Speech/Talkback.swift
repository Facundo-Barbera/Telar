import AVFoundation
import Foundation

/// THE SYNTHESIZER, on device, and as little else as possible.
///
/// `usesApplicationAudioSession = false` is the whole audio design
/// (`docs/investigations/ios-talkback-2026-09-11.md`, §4): the synthesizer then
/// runs its own session, which "will mix and duck other audio, and its active
/// state will be managed automatically". Ducking, routing and interruptions
/// become Apple's problem, and the app claims nothing new to the system — no
/// `UIBackgroundModes`, no category, no interruption handling, and so none of
/// the iOS 27 `AVAudioSession` deprecation split to straddle. Speech therefore
/// STOPS when the app backgrounds or the screen locks. That is stage C's
/// decision to take, not this one's.
///
/// ONE VOICE AT A TIME, ACROSS THE APP. A singleton rather than per-view state
/// because the reader who taps "Speak the last reply" and then walks back to
/// the list is still listening — a synthesizer owned by the view would be
/// deallocated out from under them. It also makes "is this session the one
/// speaking" answerable from any surface, which is what lets the menu offer
/// Stop where it offered Speak.
///
/// NOT AUTOMATIC, EVER. Nothing here starts on its own: an answer arriving must
/// not begin talking at somebody, and with VoiceOver running an app that speaks
/// unbidden is two voices over one sentence. A tap is the only trigger.
/// Whose reply is being read. BOTH HALVES, like every other identity on the
/// phone: a session id is unique per ENGINE, so two paired Macs can mint the
/// same one and Stop must never land on the wrong session's speech. The host
/// is optional only because a session view can be built without one.
struct SpokenSession: Equatable {
    var hostId: HostID?
    var sessionId: EngineID
}

@MainActor @Observable final class Talkback {
    static let shared = Talkback()

    /// Which session is being read aloud, or nil.
    private(set) var speaking: SpokenSession?

    private let synthesizer = AVSpeechSynthesizer()
    private let monitor = SpeechMonitor()

    private init() {
        synthesizer.usesApplicationAudioSession = false
        monitor.onStop = { [weak self] in
            Task { @MainActor in self?.speaking = nil }
        }
        synthesizer.delegate = monitor
    }

    func isSpeaking(_ target: SpokenSession) -> Bool { speaking == target }

    /// Read `text` aloud, replacing whatever was being read.
    func speak(_ text: String, for target: SpokenSession) {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        // A second tap while speaking is a NEW reply, not a queue: the
        // synthesizer's own queue would read both, back to back, with no way
        // to tell the reader why.
        synthesizer.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: body)
        // FOLLOW THE READER'S OWN SPOKEN CONTENT SETTINGS — voice and rate —
        // whenever an assistive technology is on. Somebody who has already
        // told iOS how they like to be read to has said it once.
        utterance.prefersAssistiveTechnologySettings = true
        speaking = target
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        // `didCancel` clears this too; doing it here as well means the menu
        // flips on the tap rather than on the callback.
        speaking = nil
    }
}

/// The delegate, apart from the store. `AVSpeechSynthesizerDelegate` is an
/// `NSObject` protocol whose callbacks carry no actor, so the hop onto the main
/// actor happens here rather than by isolating a protocol conformance that
/// makes no promise about where it is called.
private final class SpeechMonitor: NSObject, AVSpeechSynthesizerDelegate {
    /// Set once, before the synthesizer is ever given work.
    var onStop: (@Sendable () -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onStop?()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onStop?()
    }
}
