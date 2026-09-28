import AVFoundation
import Foundation

@MainActor final class AudioSessionClaim {
    private(set) var isHeld = false

    private let activate: () throws -> Void
    private let deactivate: () throws -> Void

    init() {
        let session = AVAudioSession.sharedInstance()
        activate = { try session.setActive(true, options: []) }

        deactivate = { try session.setActive(false, options: [.notifyOthersOnDeactivation]) }
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
