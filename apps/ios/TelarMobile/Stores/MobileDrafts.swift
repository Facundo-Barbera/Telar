import Foundation
import Observation

struct MobileDraft: Codable, Identifiable {
    var hostId: HostID
    var project: ProjectRef
    var prompt: String
    var title: String
    var createdSessionId: String?
    var submissionRunId: String?
    var id: String { "\(hostId):\(project.id)" }
}
@MainActor @Observable final class MobileDrafts {
    static let shared = MobileDrafts()
    private(set) var drafts: [MobileDraft] = []
    private let key = "telar.newSessionDrafts"
    init() {
        if let data = UserDefaults.standard.data(forKey: key), let rows = try? JSONDecoder().decode([MobileDraft].self, from: data) { drafts = rows }
    }
    func draft(host: HostID, project: String) -> MobileDraft? { drafts.first { $0.hostId == host && $0.project.id == project } }
    func save(_ draft: MobileDraft) {
        drafts.removeAll { $0.id == draft.id }
        if !draft.prompt.isEmpty || !draft.title.isEmpty { drafts.append(draft) }
        persist()
    }
    func remove(host: HostID, project: String? = nil) {
        drafts.removeAll { $0.hostId == host && (project == nil || $0.project.id == project) }; persist()
    }
    private func persist() { if let data = try? JSONEncoder().encode(drafts) { UserDefaults.standard.set(data, forKey: key) } }
}
