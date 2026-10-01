import Foundation
import Observation

@MainActor @Observable final class ComposerSkillsCache {
    private(set) var key: String?
    private(set) var skills: ProviderSkills = .empty
    private(set) var loading = false
    private var reading: String?

    func skills(for key: String) -> ProviderSkills { self.key == key ? skills : .empty }

    func load(_ key: String, read: @escaping @MainActor () async throws -> ProviderSkills) async {
        guard self.key != key, reading != key else { return }
        reading = key
        loading = true
        let answer = (try? await read()) ?? .empty
        guard reading == key else { return }
        self.key = key
        skills = answer
        reading = nil
        loading = false
    }
}
