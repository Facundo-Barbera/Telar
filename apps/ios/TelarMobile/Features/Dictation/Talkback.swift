import AVFoundation
import Foundation

struct SpokenSession: Equatable {
    var hostId: HostID?
    var sessionId: EngineID
}

@MainActor @Observable final class Talkback {
    static let shared = Talkback()

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

    func speak(_ text: String, for target: SpokenSession) {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }

        synthesizer.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: body)

        utterance.prefersAssistiveTechnologySettings = true
        speaking = target
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)

        speaking = nil
    }
}

private final class SpeechMonitor: NSObject, AVSpeechSynthesizerDelegate {
    var onStop: (@Sendable () -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onStop?()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onStop?()
    }
}
