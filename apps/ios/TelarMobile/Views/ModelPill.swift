import SwiftUI

/// The provider's mark, from t3's own SVGs: Claude keeps its brand color,
/// the OpenAI knot is a template so it follows the ink.
struct ProviderIconView: View {
    let driver: String
    var size: CGFloat = 16

    var body: some View {
        if driver == "codex" {
            Image("ProviderOpenAI")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(Theme.text)
        } else {
            Image("ProviderClaude")
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
        }
    }
}

/// What will run the next turn, whole: provider, model, effort, window, fast
/// mode — the web cockpit's fused control, phone-sized.
struct ModelChoice: Equatable {
    var driver: String
    var model: String?
    var effort: String?
    var fastMode: Bool?
}

/// ONE pill for provider + model + per-turn knobs. The menu lists model
/// FAMILIES (the window is a setting, not a row), then Reasoning, Context
/// window (only when the family comes in more than one), and Fast mode
/// (only when the model offers it) — options a model does not publish are
/// simply not there.
struct ModelPillView: View {
    /// Catalogues by driver. The pill shows what has loaded; menus say
    /// "Loading…" for the rest.
    let catalogues: [String: ModelCatalogue]
    let choice: ModelChoice
    /// Before a session exists the provider is still a choice; after, it
    /// is not — the picker then lists one driver's families only.
    let driversSwitchable: Bool
    let onChange: (ModelChoice) -> Void

    private var models: [ProviderModel] {
        (catalogues[choice.driver]?.models ?? []).filter { !$0.hidden }
    }
    private var families: [ModelFamilies.Family] {
        ModelFamilies.group(models).filter { !$0.hidden }
    }
    /// An absent model still SELECTS a row: the provider's default is what
    /// will run, and a menu with nothing ticked reads as broken.
    private var selectedRow: ProviderModel? {
        ModelFamilies.row(of: models, id: choice.model)
            ?? models.first { $0.isDefault }
            ?? models.first
    }
    private var selectedFamily: ModelFamilies.Family? {
        ModelFamilies.family(of: families, id: selectedRow?.id)
    }
    private var window: ModelFamilies.ContextWindow {
        selectedRow.map { ModelFamilies.contextWindow(of: $0) } ?? .standard
    }

    /// "Opus 4.6 · High · 1M" / "Fable 5.1 · High · 200k" — the window is
    /// named whenever there is a choice, the same rule the web pill follows:
    /// bare "High" on a model with a 1M variant read as "already 1M" to a
    /// person who was on 200k. A single-window model still prints nothing.
    private var label: String {
        var parts: [String] = [selectedFamily?.label ?? "Model"]
        if let effort = choice.effort { parts.append(ModelFamilies.effortLabel(effort)) }
        if ModelFamilies.windows(of: selectedFamily).count > 1 { parts.append(window.label) }
        if choice.fastMode == true { parts.append("Fast") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        Menu {
            if driversSwitchable {
                familySection("Claude", driver: "claude")
                familySection("Codex", driver: "codex")
            } else {
                familySection(nil, driver: choice.driver)
            }
            if let row = selectedRow, !row.efforts.isEmpty {
                Section("Reasoning") {
                    Button { change { $0.effort = nil } } label: { check("Auto", choice.effort == nil) }
                    ForEach(row.efforts, id: \.self) { level in
                        Button { change { $0.effort = level } } label: {
                            check(ModelFamilies.effortLabel(level), choice.effort == level)
                        }
                    }
                }
            }
            if let family = selectedFamily {
                let windows = ModelFamilies.windows(of: family)
                if windows.count > 1 {
                    Section("Context window") {
                        ForEach(windows, id: \.self) { option in
                            let row = ModelFamilies.row(for: family, window: option)
                            Button {
                                if let row { select(row, driver: choice.driver) }
                            } label: {
                                // "1M · Default" — the provider's own default window
                                // for this model, a fact to read; the tap still
                                // sends the row you pick.
                                check(row?.defaultWindow == true ? "\(option.label) · Default" : option.label, window == option)
                            }
                        }
                    }
                }
            }
            if selectedRow?.fastMode == true {
                Section {
                    Button {
                        change { $0.fastMode = choice.fastMode == true ? nil : true }
                    } label: {
                        check("Fast mode", choice.fastMode == true)
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                ProviderIconView(driver: choice.driver, size: 16)
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .medium))
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .frame(maxWidth: 200)
            .background(Theme.subtle)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        }
    }

    @ViewBuilder private func familySection(_ header: String?, driver: String) -> some View {
        let list = ModelFamilies.group((catalogues[driver]?.models ?? []).filter { !$0.hidden }).filter { !$0.hidden }
        Section(header ?? "") {
            if list.isEmpty {
                Button("Loading models…") {}.disabled(true)
            }
            ForEach(list) { family in
                Button {
                    select(ModelFamilies.pick(in: family, window: window), driver: driver)
                } label: {
                    check(family.label, driver == choice.driver && family.id == selectedFamily?.id)
                }
            }
        }
    }

    @ViewBuilder private func check(_ label: String, _ selected: Bool) -> some View {
        if selected {
            Label(label, systemImage: "checkmark")
        } else {
            Text(label)
        }
    }

    /// Move to a row, DROPPING WHAT IT CANNOT HONOUR: an effort it does not
    /// list fails the turn; a fast-mode it does not offer silently does
    /// nothing. Both dropped here, the one place that decides.
    private func select(_ row: ProviderModel, driver: String) {
        var next = choice
        next.driver = driver
        next.model = row.id
        if let effort = next.effort, !row.efforts.contains(effort) { next.effort = nil }
        if next.fastMode == true, !row.fastMode { next.fastMode = nil }
        onChange(next)
    }

    private func change(_ mutate: (inout ModelChoice) -> Void) {
        var next = choice
        // Writing any knob pins the model it applies to — the provider's
        // default can move, and the knob was chosen against THIS row.
        if next.model == nil { next.model = selectedRow?.id }
        mutate(&next)
        onChange(next)
    }
}
