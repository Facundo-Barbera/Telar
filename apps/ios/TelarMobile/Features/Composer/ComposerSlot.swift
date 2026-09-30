import CoreGraphics

enum ComposerSlot: Equatable {
    case send
    case dictate
    case stopDictating
    case stop

    static func resolve(canSend: Bool, running: Bool, listening: Bool, canDictate: Bool) -> ComposerSlot {
        if listening { return .stopDictating }
        if canSend { return .send }
        if running { return .stop }
        return canDictate ? .dictate : .send
    }
}

enum ComposerGrowth {
    static let maxLines = 6

    static func height(content: CGFloat, line: CGFloat, offered: CGFloat = .greatestFiniteMagnitude, maxLines: Int? = maxLines) -> CGFloat {
        let cap = min(maxLines.map { line * CGFloat($0) } ?? .greatestFiniteMagnitude, offered)
        return max(min(max(content, line), cap), line)
    }
}
