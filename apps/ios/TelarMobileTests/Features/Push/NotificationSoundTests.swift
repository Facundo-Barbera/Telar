import Foundation
import Testing
@testable import TelarMobile

@Suite struct NotificationSoundTests {
    @Test func everySetShipsEachAlertsFileInTheApp() throws {
        for sound in NotificationSound.allCases where sound != .off {
            for event in [NotificationSound.Event.done, .needs, .error] {
                let file = try #require(sound.file(event))
                #expect(file == "telar-\(sound.rawValue)-\(event.rawValue).caf")
                #expect(Bundle.main.url(forResource: file, withExtension: nil) != nil, "\(file) is bundled")
            }
        }
    }

    @Test func offIsSilent() {
        #expect(NotificationSound.off.file(.needs) == nil)
        #expect(NotificationSound.off.sound(.error) == nil)
    }

    @Test func theRegistrationTellsTheMacWhichSetToPlay() throws {
        let registration = PushRegistration(hostId: "h", token: "t", topic: "io.github.novarix.telar", sandbox: true, enabled: true,
            completions: true, previews: false, sounds: NotificationSound.felt.rawValue, mutedSessions: [], activities: [])
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(registration)) as? [String: Any])
        #expect(json["sounds"] as? String == "felt")
    }
}
