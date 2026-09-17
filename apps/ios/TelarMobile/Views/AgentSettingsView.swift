import SwiftUI

/// ONE MAC'S AGENT, CONFIGURED FROM THE PHONE (#556).
///
/// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
/// A sentence. `AgentView`'s off state said "Its switch, its model and its key
/// are set in Telar's Settings on that Mac", which is true and is a dead end:
/// the phone is holding a paired credential for that Mac and can already PATCH
/// the document — it simply had no screen that did. So somebody who opened the
/// Agent on their phone and found it switched off had to go and find a desktop.
///
/// ── THE SAME ROWS AS THE MAC'S TAB, IN THE SAME ORDER ───────────────────────
/// Switch, credential, model, the two defaults, reset. The order is the SETUP
/// order and the credential's position in it is the reason it is worth stating:
/// the model row below it is built from `GET /api/agent/models`, which answers
/// an EMPTY list on a Mac with no key — so asking for the key first is what
/// makes the next row a picker instead of an apology.
///
/// ── IT REUSES, IT DOES NOT MIRROR ───────────────────────────────────────────
/// The model row opens `AgentModelPickerSheet` — the composer's own searchable,
/// sectioned picker, with its unpickable rows and its context limits. The two
/// defaults read `AgentSettings`, which is where the composer's pills read their
/// levels and their sentences. Nothing here restates a vocabulary that already
/// exists one file over; #556 is about where the rows LIVE, not about a second
/// set of them.
///
/// ── THE MAC'S ANSWER IS THE STATE ───────────────────────────────────────────
/// Every control writes and then redraws from what came BACK, never from what it
/// sent — the rule the desktop's pane keeps, and the one that makes a settings
/// screen trustworthy: a switch that showed "on" after the Mac refused to turn
/// it on is worse than no switch.
struct AgentSettingsView: View {
    let api: any EngineAPI

    @State private var state: AgentState?
    @State private var credential: AgentCredential?
    @State private var catalogue = AgentModelList(models: [], message: nil)
    @State private var loading = true
    @State private var failure: String?
    @State private var keyDraft = ""
    /// Said once, after a key is written, and never again — the field cannot
    /// show what it stored, so this is the only acknowledgement there is.
    @State private var keySaved = false
    @State private var picking = false
    @State private var confirmReset = false

    private var enabled: Bool { state?.enabled == true }
    private var hasKey: Bool { AgentSettings.hasStoredKey(credential) }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                if let failure {
                    SettingsCard {
                        StatusBanner(icon: "exclamationmark.triangle.fill", color: Theme.statusAmber, title: failure)
                    }
                }

                switchCard
                // THE REST OF THE SCREEN IS GATED ON THE SWITCH. A key field, a
                // model picker and two defaults under an Agent that does not
                // exist are five controls configuring nothing — and the footnote
                // under the switch already says what turning it on does.
                if enabled {
                    credentialCard
                    modelCard
                    defaultsCard
                    resetCard
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(Theme.sheet)
        .navigationTitle("Agent")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(isPresented: $picking) {
            AgentModelPickerSheet(catalogue: catalogue, selected: state?.model) { next in
                Task { await save(AgentSettingsPatch(model: next)) }
            }
        }
        .confirmationDialog("Reset the Agent’s conversation?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset", role: .destructive) {
                Task { await save(AgentSettingsPatch(reset: true)) }
            }
        } message: {
            Text("This starts a new conversation. The old one is archived beside it on that Mac, not deleted — but it will not be reachable from the Agent again.")
        }
    }

    // ── THE SWITCH ───────────────────────────────────────────────────────────

    private var switchCard: some View {
        VStack(spacing: 0) {
            SettingsSectionLabel("Agent")
            SettingsCard {
                CardRow(icon: "sparkles", title: "Agent", subtitle: "Experimental") {
                    // `loading` keeps it out of reach rather than showing a
                    // position that might be wrong: off is the default, so a
                    // switch drawn before the Mac answered would read as "Telar
                    // did this without asking" for the length of one fetch.
                    Toggle("", isOn: Binding(get: { enabled }, set: { next in Task { await save(AgentSettingsPatch(enabled: next)) } }))
                        .labelsHidden()
                        .disabled(loading)
                        .accessibilityLabel("Agent (experimental)")
                }
            }
            SettingsFootnote(
                enabled
                    ? "On. One entry above the session list, on every device reading this Mac. It holds the sessions and notes tools and nothing else — no shell, no browser, no files — and runs nothing on a timer."
                    : "Off. The rail is unchanged and nothing is briefed. Turning it off later keeps the conversation and its history, and turning it back on resumes the same one."
            )
        }
    }

    // ── THE CREDENTIAL ───────────────────────────────────────────────────────

    private var credentialCard: some View {
        VStack(spacing: 0) {
            SettingsSectionLabel("OpenCode Go key")
            SettingsCard {
                CardField(
                    label: hasKey ? "A key is saved on that Mac" : "Paste a key",
                    placeholder: hasKey ? "Replace it" : "sk-…",
                    text: $keyDraft,
                    mono: true,
                    secure: true
                )
                CardDivider()
                // SAVE AND REMOVE ARE ONE ROW, and which one is offered follows
                // the field: a key typed is a Save, an empty field over a stored
                // key is a Remove, and an empty field over nothing is neither.
                if hasKey && keyDraft.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button { Task { await saveKey("") } } label: {
                        CardRow(icon: "trash", iconColor: Theme.statusRed, title: "Remove the key", titleColor: Theme.statusRed) { EmptyView() }
                    }
                    .buttonStyle(.plain)
                    .disabled(loading)
                } else {
                    Button { Task { await saveKey(keyDraft) } } label: {
                        CardRow(icon: "key.fill", title: "Save the key") { EmptyView() }
                    }
                    .buttonStyle(.plain)
                    .disabled(loading || keyDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            SettingsFootnote(
                keySaved
                    ? "Saved. It is stored with that Mac’s engine state and never shown again."
                    : AgentSettings.credentialLine(credential)
            )
        }
    }

    // ── THE MODEL ────────────────────────────────────────────────────────────

    private var modelCard: some View {
        VStack(spacing: 0) {
            SettingsSectionLabel("Model")
            SettingsCard {
                // THE COMPOSER'S OWN PICKER, not a menu that agrees with it. The
                // list is thirty-eight rows across thirteen families, it needs a
                // search field, and sixteen of its rows are unpickable — which is
                // exactly what `AgentModelPickerSheet` already draws.
                CardNavRow(
                    icon: "sparkles",
                    title: AgentSettings.modelRowLabel(catalogue, state?.model),
                    subtitle: catalogue.models.isEmpty ? (catalogue.message ?? "That Mac could not read OpenCode Go’s model list.") : nil
                ) { picking = true }
            }
            if let obstacle = agentModelObstacle(catalogue, state?.model) {
                // THE MODEL ABOUT TO RUN IS ONE THIS CLIENT CANNOT SPEAK TO. The
                // picker greys those rows, so an id in this state arrived another
                // way — typed into the Mac's own field, or moved to another
                // endpoint by Go since.
                SettingsFootnote(obstacle)
            } else {
                SettingsFootnote("What OpenCode Go serves this conversation. Telar keeps no list of its own — the Mac's engine applies the default.")
            }
        }
    }

    // ── THE TWO DEFAULTS ─────────────────────────────────────────────────────

    /// The composer's second and third pills, as standing settings. Same two
    /// fields, same route, same words — see `AgentSettings`.
    private var defaultsCard: some View {
        VStack(spacing: 0) {
            SettingsSectionLabel("Defaults")
            SettingsCard {
                CardRow(icon: "gauge.with.dots.needle.33percent", title: "Reasoning effort") {
                    Menu {
                        // AUTO IS NOT A LEVEL. `""` clears the field, and a
                        // cleared field means the parameter is not sent at all.
                        Button { Task { await save(AgentSettingsPatch(effort: "")) } } label: {
                            Label("Auto", systemImage: state?.effort == nil ? "checkmark" : "minus")
                        }
                        ForEach(AgentSettings.efforts) { level in
                            Button { Task { await save(AgentSettingsPatch(effort: level.value)) } } label: {
                                Label(level.label, systemImage: state?.effort == level.value ? "checkmark" : "gauge.with.dots.needle.33percent")
                            }
                        }
                    } label: {
                        valueChip(AgentSettings.effortRowLabel(state?.effort))
                    }
                    .disabled(loading)
                }
                CardDivider()
                CardRow(icon: "shield.lefthalf.filled", title: "Access") {
                    Menu {
                        ForEach(AgentSettings.accesses) { option in
                            Button { Task { await save(AgentSettingsPatch(access: option.value)) } } label: {
                                Label(option.label, systemImage: (state?.access ?? "ask") == option.value ? "checkmark" : "shield.lefthalf.filled")
                            }
                        }
                    } label: {
                        valueChip(AgentSettings.accessLabel(state?.access))
                    }
                    .disabled(loading)
                }
            }
            // THE ACCESS SENTENCE, NOT THE EFFORT ONE, when they compete for the
            // single footnote: "who may approve what the Agent does" is the one
            // a person needs before choosing, and the effort row's answer is
            // legible from its own chip.
            SettingsFootnote("\(AgentSettings.effortHelp(state?.effort))\n\n\(AgentSettings.accessHelp(state?.access))")
        }
    }

    // ── THE RESET ────────────────────────────────────────────────────────────

    private var resetCard: some View {
        VStack(spacing: 0) {
            SettingsCard {
                Button { confirmReset = true } label: {
                    CardRow(
                        icon: "arrow.counterclockwise",
                        iconColor: Theme.statusRed,
                        title: "Reset conversation",
                        titleColor: Theme.statusRed
                    ) { EmptyView() }
                }
                .buttonStyle(.plain)
                // NOTHING TO RESET BEFORE THERE IS A THREAD.
                .disabled(loading || !AgentSettings.canReset(state))
            }
            SettingsFootnote("Start again with an empty thread. The Agent keeps its switch, its model and its key; only the conversation is replaced.")
        }
    }

    /// The value end of a settings row — the same capsule `DevicesView`'s role
    /// chip uses, so a tappable value reads the same on both screens.
    private func valueChip(_ text: String) -> some View {
        HStack(spacing: 5) {
            Text(text).font(.system(size: 13, weight: .semibold)).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .medium))
        }
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 12)
        .frame(height: 32)
        .background(Theme.subtle)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
    }

    // ── READS AND WRITES ─────────────────────────────────────────────────────

    /// ONE READ AND ONE LIST, ON OPEN. This screen does not poll: nothing here
    /// moves on its own — a setting changes because somebody changed it, and the
    /// write's answer is what redraws the row.
    private func load() async {
        await refresh()
        // THE LIST FAILS SOFT and is read whatever the first call did: a Mac with
        // no key answers an empty catalogue and a sentence, which the model row
        // shows rather than treating as an error.
        if let list = try? await api.agentModels() { catalogue = list }
        loading = false
    }

    private func refresh() async {
        do {
            let answer = try await api.agent()
            state = answer.agent
            credential = answer.credential
            failure = nil
        } catch {
            failure = "That Mac did not answer."
        }
    }

    /// EVERY CONTROL GOES THROUGH HERE, and the answer is the new state.
    private func save(_ patch: AgentSettingsPatch) async {
        do {
            let answer = try await api.setAgent(patch)
            state = answer.agent
            credential = answer.credential
            failure = nil
        } catch {
            failure = "That Mac refused that change."
        }
    }

    /// The key's own write, because it has an acknowledgement and a field to
    /// clear that no other row does. An EMPTY STRING IS AN EXPLICIT CLEAR.
    private func saveKey(_ value: String) async {
        keySaved = false
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        await save(AgentSettingsPatch(apiKey: trimmed))
        keyDraft = ""
        // Only on a write that LANDED, and only for a key that was set: a
        // refusal already has the banner, and a Remove is not a "Saved".
        if failure == nil && !trimmed.isEmpty { keySaved = true }
    }
}
