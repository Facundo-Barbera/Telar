import Foundation
import Observation

@MainActor @Observable final class TableWindows {
    static let page = 200

    private(set) var meta: TableWindow?
    private(set) var rows: [Int: [JSONValue]] = [:]
    private(set) var error: String?
    private var inflight: Set<Int> = []
    @ObservationIgnored private let read: (Int) async throws -> TableWindow

    init(read: @escaping (Int) async throws -> TableWindow) {
        self.read = read
    }

    static func pageOffset(of index: Int) -> Int { (index / page) * page }

    @discardableResult func ensure(_ index: Int) -> Task<Void, Never>? {
        let offset = Self.pageOffset(of: index)
        guard rows[offset] == nil, inflight.insert(offset).inserted else { return nil }
        return Task { await load(offset) }
    }

    private func load(_ offset: Int) async {
        defer { inflight.remove(offset) }
        do {
            let window = try await read(offset)
            if meta == nil { meta = window }
            for (i, cells) in window.rows.enumerated() { rows[window.offset + i] = cells }
        } catch {
            if meta == nil { self.error = describe(error) }
        }
    }
}
