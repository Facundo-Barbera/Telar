import Foundation

enum SidebarMode: String, CaseIterable, Identifiable {
    case grouped, flat

    static let storageKey = "telar.sidebar.mode"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .grouped: return "Project"
        case .flat: return "None"
        }
    }
}
