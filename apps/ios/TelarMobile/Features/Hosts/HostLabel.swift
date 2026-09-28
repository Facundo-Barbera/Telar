import Foundation

enum HostLabel {
    static let unknown = "Mac"

    static func name(_ raw: String?) -> String {
        guard let raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return unknown }
        return raw
    }

    static func header(name raw: String?, hostCount: Int) -> String? {
        guard hostCount > 1 else { return nil }
        return name(raw)
    }

    static func row(name raw: String?, hostCount: Int, placesAbove: Int) -> String? {
        guard hostCount > 1 else { return nil }
        guard placesAbove != 1 else { return nil }
        return name(raw)
    }
}
