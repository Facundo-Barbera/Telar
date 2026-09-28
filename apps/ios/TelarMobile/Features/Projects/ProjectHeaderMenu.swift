import Foundation

enum ProjectHeaderMenu {
    static func collapseOthers(all: [String], keeping id: String) -> Set<String> {
        Set(all).subtracting([id])
    }
}
