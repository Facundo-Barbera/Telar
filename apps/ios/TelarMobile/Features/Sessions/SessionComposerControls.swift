import SwiftUI

enum SessionComposerControls {
    @MainActor static func make(store: SessionStore) -> ComposerControls {
        ComposerControls(
            model: AnyView(SessionModelMenu(store: store)),
            options: AnyView(RuntimeModePill(mode: store.sync.session?.runtimeMode ?? "approval-required") { mode in
                Task { await store.setRuntimeMode(mode) }
            })
        )
    }
}

private struct SessionModelMenu: View {
    let store: SessionStore

    var body: some View {
        let driver = store.sync.session?.driver ?? "claude"
        let selection = store.sync.session?.model
        ModelMenu(
            catalogues: store.catalogue.map { [driver: $0] } ?? [:],
            choice: ModelChoice(
                driver: driver, model: selection?.model,
                effort: selection?.effort, fastMode: selection?.fastMode,
                serviceTier: selection?.serviceTier, ultracode: selection?.ultracode
            ),
            driversSwitchable: false,
            onChange: { next in Task { await store.setModelChoice(next) } }
        )
        .task { await store.loadModels() }
    }
}
