import SwiftUI

/// THE AGENT'S THREE COMPOSER CONTROLS — model, effort, access (#539).
///
/// ── WHY NOT THE SESSION'S ───────────────────────────────────────────────────
/// `SessionComposerControls` reads a provider catalogue and a session record:
/// `ModelPillView` takes a driver and a `ModelChoice`, and the runtime-mode pill
/// takes one of the engine's four session modes. The Agent has none of those —
/// it has `GET /api/agent/models`, one model id, and two enums on `agent.json`.
///
/// SO: THE SAME FURNITURE, A DIFFERENT SOURCE. `ComposerLabeledPill` and
/// `composerMenuRow` are the composer toolbar's own shapes, shared rather than
/// redrawn, because the one thing that must NOT differ is what these look like
/// beside a session's.
///
/// ── ABSENT IS NOT A DEFAULT VALUE, TWICE AND DIFFERENTLY ────────────────────
/// An unset EFFORT means `reasoning_effort` is not sent at all — the provider's
/// own behaviour, and what every turn did before the field existed — so its
/// menu offers "Auto" rather than a level, and the pill names the QUESTION.
/// An unset ACCESS means `ask`, which is a real default with a name, so the
/// pill says "Ask".
struct AgentComposerControls: View {
    let state: AgentState?
    let catalogue: AgentModelList
    /// Writes `PATCH /api/agent`. Fields by presence; `""` clears one.
    let onPatch: (AgentSettingsPatch) async -> Void

    @State private var picking = false

    private static let efforts: [(String, String)] = [("low", "Low"), ("medium", "Medium"), ("high", "High")]
    private static let accesses: [(String, String)] = [("ask", "Ask"), ("auto", "Auto")]

    var body: some View {
        // THE MODEL — a searchable sheet rather than a menu (#551).
        //
        // It was a flat `Menu` of OpenCode Go's raw ids in Go's own order,
        // because the endpoint answered ids and nothing else. It answers a
        // described catalogue now, and thirty-eight rows across thirteen
        // families is not something a menu can present: it cannot search and it
        // cannot section. See `AgentModelPickerSheet`.
        Button { picking = true } label: {
            ComposerPillLabel(icon: obstacle == nil ? "sparkles" : "exclamationmark.triangle.fill", label: modelLabel, tint: obstacle == nil ? Theme.text : Theme.statusAmber)
        }
        .buttonStyle(.plain)
        // THE MODEL ABOUT TO RUN IS ONE THIS CLIENT CANNOT SPEAK TO. Reachable
        // without going through this picker at all — typed into the Mac's own
        // settings field, or moved to another endpoint by Go since. The pill is
        // the last thing read before send, so it is where the warning belongs.
        .accessibilityLabel(obstacle.map { "Model: \(modelLabel) — \($0)" } ?? "Model: \(modelLabel)")
        .sheet(isPresented: $picking) {
            AgentModelPickerSheet(catalogue: catalogue, selected: state?.model) { next in
                patch(AgentSettingsPatch(model: next))
            }
        }

        // THE EFFORT. Three levels rather than a per-model list: the Agent's
        // model endpoint publishes ids and nothing else, so there is nothing to
        // read, and low/medium/high are what every server that honours
        // `reasoning_effort` accepts. One that does not ignores an unknown key.
        ComposerLabeledPill(icon: "gauge.with.dots.needle.33percent", label: effortLabel) {
            Button { patch(AgentSettingsPatch(effort: "")) } label: {
                composerMenuRow("Auto", selected: state?.effort == nil)
            }
            ForEach(Self.efforts, id: \.0) { value, label in
                Button { patch(AgentSettingsPatch(effort: value)) } label: {
                    composerMenuRow(label, selected: state?.effort == value)
                }
            }
        }

        // THE ACCESS — which is active is on the PILL, not only inside the menu.
        // It is the setting a person most wants to confirm before pressing send.
        ComposerLabeledPill(icon: "shield.lefthalf.filled", label: accessLabel) {
            ForEach(Self.accesses, id: \.0) { value, label in
                Button { patch(AgentSettingsPatch(access: value)) } label: {
                    composerMenuRow(label, selected: (state?.access ?? "ask") == value)
                }
            }
        }
    }

    /// THE NAME, NOT THE ID (#551). "Kimi K3" is what the row said when it was
    /// picked; `kimi-k3` is still what goes on the wire. A stored model the
    /// catalogue does not carry has no name to fall back on, so it shows as
    /// itself — the pill must never read as running something it is not.
    private var modelLabel: String {
        guard let model = state?.model else { return "Model" }
        return catalogue.models.first { $0.id == model }?.name ?? model
    }

    /// Set when what will run is on an endpoint this client cannot speak to.
    /// See `agentModelObstacle`.
    private var obstacle: String? { agentModelObstacle(catalogue, state?.model) }

    /// An unchosen level names the QUESTION rather than repeating "Auto" beside
    /// the access pill, which would be one word twice with nothing to say which
    /// was which.
    private var effortLabel: String {
        guard let effort = state?.effort else { return "Reasoning" }
        return Self.efforts.first { $0.0 == effort }?.1 ?? effort
    }

    private var accessLabel: String {
        let active = state?.access ?? "ask"
        return Self.accesses.first { $0.0 == active }?.1 ?? active
    }

    private func patch(_ next: AgentSettingsPatch) {
        Task { await onPatch(next) }
    }
}
