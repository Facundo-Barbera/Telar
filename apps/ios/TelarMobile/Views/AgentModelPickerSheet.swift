import SwiftUI

/// THE AGENT'S MODEL PICKER, on the phone — a searchable sectioned sheet (#551).
///
/// ── WHY A SHEET AND NOT THE MENU IT REPLACES ────────────────────────────────
/// The pill opened a `Menu` listing OpenCode Go's thirty-eight raw ids in Go's
/// own order, because that is all `GET /api/agent/models` used to answer. A
/// menu cannot search and cannot section, so finding a model meant scrolling
/// past `deepseek-v4-flash-vision-exp` hoping to recognise the next one —
/// `BranchPickerSheet` is here for exactly the same reason, one screen over.
///
/// The engine describes the list now: names, families, context limits, and
/// which of Go's three endpoints each id answers on. So this is the desktop's
/// picker in this platform's own furniture — `List` with `Section`s and
/// `.searchable`, rather than a popover with a text field.
///
/// ── UNSUPPORTED ROWS ARE SHOWN AND UNPICKABLE ───────────────────────────────
/// Telar's Agent speaks `chat/completions` and only that; Go also serves an
/// Anthropic-shaped `/messages` and OpenAI's `/responses`. Hiding those rows
/// would answer the "Go is withholding models" suspicion by actually
/// withholding them. Disabled, dimmed, with the reason beneath, says the true
/// thing: the model exists, Telar cannot reach it yet.
struct AgentModelPickerSheet: View {
    let catalogue: AgentModelList
    /// The stored id, or nil for "whatever the engine defaults to".
    let selected: String?
    /// `""` clears the setting, which is what the engine reads as "use the
    /// default" — the same string the desktop's picker writes.
    let onPick: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces).lowercased() }
    private var browsing: Bool { trimmed.isEmpty }

    /// Name, id AND family — the three a person might know. Someone who read
    /// the release notes types "Kimi K3"; someone with a config file types
    /// "kimi-k3"; someone who just wants a GLM types "glm".
    private func matches(_ model: AgentModel) -> Bool {
        browsing || "\(model.name) \(model.id) \(model.family)".lowercased().contains(trimmed)
    }

    /// The families, IN THE ENGINE'S OWN ORDER — newest generation first,
    /// decided once on the Mac so this screen and the desktop cannot disagree
    /// about what "newest" means. Consecutive rows fold; nothing is re-sorted.
    private var sections: [(family: String, models: [AgentModel])] {
        var out: [(family: String, models: [AgentModel])] = []
        for model in catalogue.models where matches(model) {
            if out.last?.family == model.family { out[out.count - 1].models.append(model) } else { out.append((model.family, [model])) }
        }
        return out
    }

    var body: some View {
        NavigationStack {
            List {
                // THE DEFAULT IS A ROW, not an empty state: storing nothing IS
                // asking for the engine's default, and a list with nothing
                // ticked reads as broken rather than unset. Hidden while
                // searching — it matches no query, and left pinned above a
                // filtered list it makes the first result look like the second.
                if browsing {
                    defaultRow
                }
                ForEach(sections, id: \.family) { section in
                    Section {
                        ForEach(section.models) { row($0) }
                    } header: {
                        Text(section.family)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.textMuted)
                    }
                }
                if !browsing && sections.isEmpty {
                    note("Nothing matches “\(query.trimmingCharacters(in: .whitespaces))” — names and ids are searched.")
                }
                if browsing && catalogue.models.isEmpty {
                    note(catalogue.message ?? "That Mac could not read OpenCode Go's model list.")
                }
                // WHERE THE NAMES CAME FROM, and only when they did not come. A
                // full list of raw ids looks exactly like the picker this
                // replaces, so it has to say this is a degraded state.
                if browsing && !catalogue.models.isEmpty && catalogue.source.modelsDev == nil {
                    note("Names and context limits come from models.dev, which that Mac could not reach — these are OpenCode Go's ids.")
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.sheet)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search models")
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var defaultRow: some View {
        Button {
            onPick("")
            dismiss()
        } label: {
            HStack(spacing: 10) {
                Text("Default")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.text)
                Spacer(minLength: 8)
                // Named rather than left as a word — the engine marks which row
                // it means, so nobody has to go and look it up.
                if let fallback = catalogue.models.first(where: \.isDefault) {
                    Text(fallback.name)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                }
                if selected == nil {
                    Image(systemName: "checkmark").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Theme.borderSubtle)
    }

    private func row(_ model: AgentModel) -> some View {
        Button {
            onPick(model.id)
            dismiss()
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 10) {
                    Text(model.name)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    // WHAT IT CAN HOLD, which is the fact that decides whether
                    // a long conversation survives on this model.
                    if let context = model.context {
                        Text(tokens(context)).font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.textMuted)
                    }
                    // Go's own path segment, not a paraphrase. `unknown` gets
                    // no badge: it is this build admitting it has not been told
                    // which endpoint the id answers on, not a fact about the
                    // model.
                    if model.route != "unknown" {
                        Text(model.route)
                            .font(.system(size: 10))
                            .foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.borderSubtle, lineWidth: 1))
                    }
                    if selected == model.id {
                        Image(systemName: "checkmark").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.accent)
                    }
                }
                if let obstacle = agentRouteObstacle(model.route) {
                    Text(obstacle).font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!model.supported)
        // The dimming is the UNSUPPORTED signal and nothing else borrows it.
        .opacity(model.supported ? 1 : 0.45)
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Theme.borderSubtle)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13))
            .foregroundStyle(Theme.textMuted)
            .listRowBackground(Color.clear)
    }

    /// `1.0M`, `262.1k` — the desktop's `fmtTokens`, so one number reads the
    /// same on both screens.
    private func tokens(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return String(format: "%.1fk", Double(count) / 1_000) }
        return String(count)
    }
}

/// WHY A ROUTE CANNOT BE RUN, in the words the person reads — the desktop's
/// `agentRouteObstacle`, kept word for word so the two screens do not explain
/// the same refusal differently. `nil` for the two that can run.
func agentRouteObstacle(_ route: String) -> String? {
    switch route {
    case "messages":
        return "Not supported by Telar's Agent yet — Go serves this one in Anthropic's shape, which the Agent's chat/completions request cannot use."
    case "responses":
        return "Not supported by Telar's Agent yet — Go serves this one on the Responses API, which the Agent cannot send."
    default:
        return nil
    }
}

/// THE MODEL THAT WILL ACTUALLY RUN, and whether Telar can run it.
///
/// The picker disables the rows it lists; this answers the question the PILL
/// has to ask about the model already chosen — an id can reach `agent.json` by
/// being typed into the Mac's settings field, or moved to another endpoint by
/// Go since. An absent model checks the engine's default, because that is what
/// runs. A model the catalogue does not carry is deliberately not flagged:
/// nothing here knows its route, and warning about what it cannot know is how a
/// picker teaches people to ignore its warnings.
func agentModelObstacle(_ catalogue: AgentModelList, _ model: String?) -> String? {
    let running = model.map { id in catalogue.models.first { $0.id == id } } ?? catalogue.models.first(where: \.isDefault)
    guard let running, !running.supported else { return nil }
    return agentRouteObstacle(running.route)
}
