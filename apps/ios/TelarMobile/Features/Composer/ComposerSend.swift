import Foundation

@MainActor final class ComposerSend {
    private(set) var busy = false

    func run(finishing finish: (() async -> Void)?, take: () -> String?, send: (String) -> Void) async {
        guard !busy else { return }
        busy = true
        if let finish { await finish() }
        busy = false
        guard let text = take() else { return }
        send(text)
    }
}
