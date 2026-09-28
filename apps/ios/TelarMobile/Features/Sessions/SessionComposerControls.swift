import SwiftUI

struct SessionComposerControls: View {
    let store: SessionStore

    private var runtimeMode: String {
        store.sync.session?.runtimeMode ?? "approval-required"
    }

    private var modelPill: some View {
        let driver = store.sync.session?.driver ?? "claude"
        let selection = store.sync.session?.model
        return ModelPillView(
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

    var body: some View {
        modelPill
        ComposerLabeledPill(
            icon: "slider.horizontal.3",
            label: SessionComposerControls.runtimeModes.first { $0.0 == runtimeMode }?.1 ?? "Configuration"
        ) {
            ForEach(SessionComposerControls.runtimeModes, id: \.0) { mode, label in
                Button {
                    Task { await store.setRuntimeMode(mode) }
                } label: {
                    composerMenuRow(label, selected: mode == runtimeMode)
                }
            }
        }
    }

    static let runtimeModes: [(String, String)] = [
        ("approval-required", "Supervised"),
        ("auto-accept-edits", "Auto-accept edits"),
        ("auto", "Auto"),
        ("full-access", "Full access"),
    ]
}
