import AVFoundation
import Foundation

@MainActor final class AudioSessionClaim {
    private(set) var isHeld = false

    private let activate: () throws -> Void
    private let deactivate: () throws -> Void

    init() {
        let session = AVAudioSession.sharedInstance()
        var prior = (session.category, session.mode, session.categoryOptions)
        activate = {
            prior = (session.category, session.mode, session.categoryOptions)
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: [])
        }
        deactivate = {
            try session.setActive(false, options: [.notifyOthersOnDeactivation])
            try session.setCategory(prior.0, mode: prior.1, options: prior.2)
        }
    }

    static func describe() -> String {
        let session = AVAudioSession.sharedInstance()
        return "\(session.category.rawValue.replacingOccurrences(of: "AVAudioSessionCategory", with: ""))/\(session.mode.rawValue.replacingOccurrences(of: "AVAudioSessionMode", with: ""))"
    }

    init(activate: @escaping () throws -> Void, deactivate: @escaping () throws -> Void) {
        self.activate = activate
        self.deactivate = deactivate
    }

    func take() throws {
        try activate()
        isHeld = true
    }

    func handBack() {
        guard isHeld else { return }
        do {
            try deactivate()
            isHeld = false
        } catch {
        }
    }
}
