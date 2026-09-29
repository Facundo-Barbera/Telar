import AVFoundation
import UserNotifications

enum NotificationSound: String, CaseIterable, Identifiable {
    case hilo, armonico, felt, off

    enum Event: String { case done, needs, error }

    var id: String { rawValue }
    var label: String {
        switch self {
        case .hilo: "Hilo"
        case .armonico: "Armónico"
        case .felt: "Felt"
        case .off: "Off"
        }
    }

    func file(_ event: Event) -> String? {
        self == .off ? nil : "telar-\(rawValue)-\(event.rawValue).caf"
    }

    func sound(_ event: Event) -> UNNotificationSound? {
        file(event).map { UNNotificationSound(named: UNNotificationSoundName($0)) }
    }
}

@MainActor enum SoundPreview {
    private static var player: AVAudioPlayer?

    static func play(_ sound: NotificationSound) {
        guard let url = sound.file(.done).flatMap({ Bundle.main.url(forResource: $0, withExtension: nil) }) else { return }
        player = try? AVAudioPlayer(contentsOf: url)
        player?.play()
    }
}
