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
    let models: [ProviderModel]
    /// The service's own words when the list could not be fetched.
    let modelsMessage: String?
    /// Writes `PATCH /api/agent`. Fields by presence; `""` clears one.
    let onPatch: (AgentSettingsPatch) async -> Void

    private static let efforts: [(String, String)] = [("low", "Low"), ("medium", "Medium"), ("high", "High")]
    private static let accesses: [(String, String)] = [("ask", "Ask"), ("auto", "Auto")]

    var body: some View {
        // THE MODEL. No families, no stars, no connections — those are the
        // provider catalogue's apparatus and the Agent has no provider. One flat
        // list of ids from one OpenAI-compatible endpoint.
        ComposerLabeledPill(icon: "sparkles", label: state?.model ?? "Model") {
            // THE DEFAULT IS A ROW, not an empty state: sending no model IS
            // asking for the service's default, and a menu with nothing ticked
            // reads as broken rather than unset.
            Button { patch(AgentSettingsPatch(model: "")) } label: {
                composerMenuRow("Default", selected: state?.model == nil)
            }
            ForEach(models) { row in
                Button { patch(AgentSettingsPatch(model: row.id)) } label: {
                    composerMenuRow(row.id, selected: state?.model == row.id)
                }
            }
            if models.isEmpty, let modelsMessage {
                Text(modelsMessage)
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
