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
        } else if driver == "opencode" {
            // Proportional to its own square, like ProjectAvatar's glyphs:
            // `size` is the caller's, so a bigger badge is asked for rather
            // than derived. Correct as it stands, not waiting on #674.
            Text("OC").font(.system(size: size * 0.65, weight: .semibold)).frame(width: size, height: size)
        } else {
            Image("ProviderClaude")
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
        }
    }
}

/// What will run the next turn, whole: provider, model, effort, window, fast
/// mode, service tier, ultracode — the web cockpit's fused control, phone-sized.
struct ModelChoice: Equatable {
    var driver: String
    var model: String?
    var effort: String?
    var fastMode: Bool?
    var serviceTier: String? = nil
    var ultracode: Bool? = nil

    /// Anything beyond the provider's own defaults — worth sending.
    var isTouched: Bool {
        model != nil || effort != nil || fastMode != nil || serviceTier != nil || ultracode != nil
    }
}

/// ONE pill for provider + model + per-turn knobs. The menu lists model
/// FAMILIES (the window is a setting, not a row), then Reasoning, Context
/// window, Fast mode and Service tier — each only when the chosen model
/// publishes it, with the provider's default marked "Default".
struct ModelPillView: View {
    /// Catalogues by driver. The pill shows what has loaded; menus say
    /// "Loading…" for the rest.
    let catalogues: [String: ModelCatalogue]
    let choice: ModelChoice
    /// Before a session exists the provider is still a choice; after, it
    /// is not — the picker then lists one driver's families only.
    let driversSwitchable: Bool
    let onChange: (ModelChoice) -> Void

    /// The capsule grows with the words in it (#674) — the label converted in
    /// #248 but its frame did not, so at large text sizes it clipped the model
    /// name it exists to show. Same seeds and same style as
    /// `ComposerPillLabel`, which is the same control on the other screen.
    @ScaledMetric(relativeTo: .subheadline) private var height: CGFloat = 44
    @ScaledMetric(relativeTo: .subheadline) private var cap: CGFloat = 200
    /// The provider mark is an image, not a glyph in a box, so it takes the
    /// caller's `size` — scaled here so it keeps pace with the label.
    @ScaledMetric(relativeTo: .subheadline) private var badge: CGFloat = 16

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
        if let level = ModelOptions.levelLabel(choice: choice, row: selectedRow) { parts.append(level) }
        if ModelFamilies.windows(of: selectedFamily).count > 1 { parts.append(window.label) }
        if choice.fastMode == true { parts.append("Fast") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        Menu {
            if driversSwitchable {
                familySection("Claude", driver: "claude")
                familySection("Codex", driver: "codex")
                familySection("OpenCode", driver: "opencode")
            } else {
                familySection(nil, driver: choice.driver)
            }
            if let row = selectedRow {
                let sections = ModelOptions.sections(row: row, family: selectedFamily)
                if sections.contains(.reasoning) { reasoningSection(row) }
                if sections.contains(.contextWindow), let family = selectedFamily { windowSection(family) }
                if sections.contains(.fastMode) { fastModeSection() }
                if sections.contains(.serviceTier) { serviceTierSection(row) }
            }
        } label: {
            HStack(spacing: 8) {
                ProviderIconView(driver: choice.driver, size: badge)
                // THIS PILL AND SESSIONVIEW'S TWIN NOW MATCH (#674). Both are
                // icon + label + chevron in a height-fixed, width-CAPPED
                // capsule, so neither was ever fixed in both dimensions and
                // both convert under the sweep's rule; #449 had grouped
                // SessionView's with the fixed 44pt hit targets, which is the
                // one place that grouping did not hold. They were resolved by
                // converting that one, not by reverting this one.
                Text(label)
                    .font(.system(Theme.subhead, weight: .semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.system(Theme.caption, weight: .medium))
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .frame(height: height)
            .frame(maxWidth: cap)
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
                    option(family.label, selected: driver == choice.driver && family.id == selectedFamily?.id)
                }
            }
        }
    }

    @ViewBuilder private func reasoningSection(_ row: ProviderModel) -> some View {
        Section("Reasoning") {
            if ModelOptions.showsAutoEffort(row) {
                Button { change { $0.effort = nil; $0.ultracode = nil } } label: {
                    option("Auto", selected: choice.effort == nil && choice.ultracode != true)
                }
            }
            ForEach(row.efforts, id: \.self) { level in
                Button {
                    change { $0.effort = ModelOptions.storedEffort(for: level, row: row); $0.ultracode = nil }
                } label: {
                    option(ModelFamilies.effortLabel(level),
                           isDefault: ModelOptions.isDefaultEffort(level, row: row),
                           selected: ModelOptions.isEffortSelected(level, choice: choice, row: row))
                }
            }
            if ModelOptions.offersUltracode(driver: choice.driver, row: row) {
                Button { change { $0.ultracode = true; $0.effort = nil } } label: {
                    option("Ultracode",
                           subtitle: "Extra-high reasoning that can also plan and run multi-step workflows on its own.",
                           selected: choice.ultracode == true)
                }
            }
        }
    }

    @ViewBuilder private func windowSection(_ family: ModelFamilies.Family) -> some View {
        Section("Context window") {
            ForEach(ModelFamilies.windows(of: family), id: \.self) { window in
                let row = ModelFamilies.row(for: family, window: window)
                Button {
                    if let row { select(row, driver: choice.driver) }
                } label: {
                    option(window.label, isDefault: row?.defaultWindow == true, selected: self.window == window)
                }
            }
        }
    }

    @ViewBuilder private func fastModeSection() -> some View {
        Section("Fast mode") {
            Button { change { $0.fastMode = true } } label: {
                option("On", selected: choice.fastMode == true)
            }
            Button { change { $0.fastMode = nil } } label: {
                option("Off", isDefault: true, selected: choice.fastMode != true)
            }
        }
    }

    @ViewBuilder private func serviceTierSection(_ row: ProviderModel) -> some View {
        Section("Service tier") {
            if ModelOptions.showsAutoTier(row) {
                Button { change { $0.serviceTier = nil } } label: {
                    option("Auto", selected: choice.serviceTier == nil)
                }
            }
            ForEach(row.serviceTiers ?? []) { tier in
                Button {
                    change { $0.serviceTier = ModelOptions.storedTier(for: tier.id, row: row) }
                } label: {
                    option(tier.name, subtitle: tier.description,
                           isDefault: row.defaultServiceTier == tier.id,
                           selected: ModelOptions.isTierSelected(tier.id, choice: choice, row: row))
                }
            }
        }
    }

    /// A menu row: title (with "· Default" on the provider's default), an
    /// optional subtitle the menu draws beneath it, and a tick when chosen.
    @ViewBuilder private func option(_ title: String, subtitle: String? = nil,
                                     isDefault: Bool = false, selected: Bool) -> some View {
        let text = isDefault ? "\(title) · Default" : title
        if selected {
            Label {
                Text(text)
                if let subtitle { Text(subtitle) }
            } icon: {
                Image(systemName: "checkmark")
            }
        } else {
            Text(text)
            if let subtitle { Text(subtitle) }
        }
    }

    private func select(_ row: ProviderModel, driver: String) {
        onChange(ModelOptions.moving(choice, to: row, driver: driver))
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
