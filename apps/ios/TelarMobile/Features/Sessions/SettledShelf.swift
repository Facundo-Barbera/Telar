import Foundation

struct SettledShelf {
    private(set) var live: LiveSessions?
    private(set) var etag: String?
    var stale = true

    func needsRead(listChanged: Bool) -> Bool {
        live == nil || stale || listChanged
    }

    @discardableResult
    mutating func absorb(_ read: LiveSessionsRead) -> Bool {
        stale = false
        guard let fresh = read.live else {
            if read.etag != nil { etag = read.etag }
            return false
        }
        live = fresh
        etag = read.etag
        return true
    }

    func merged(into list: [Session]) -> [Session] {
        guard let live else { return list }
        let listed = Set(list.map(\.id))
        return list + live.sessions.filter { !listed.contains($0.id) }
    }

    func assignments(over list: [EngineID: [SessionAssignment]]) -> [EngineID: [SessionAssignment]] {
        list.merging(live?.assignments ?? [:]) { kept, _ in kept }
    }

    struct Record: Codable {
        var etag: String?
        var body: Data
    }

    func record(_ body: Data) -> Data? {
        try? JSONEncoder().encode(Record(etag: etag, body: body))
    }

    static func restored(_ data: Data) -> SettledShelf? {
        guard let record = try? JSONDecoder().decode(Record.self, from: data),
              let live = try? JSONDecoder().decode(LiveSessions.self, from: record.body)
        else { return nil }
        var shelf = SettledShelf()
        shelf.live = live
        shelf.etag = record.etag
        return shelf
    }
}
