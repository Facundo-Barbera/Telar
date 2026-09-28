import SwiftUI

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
            Text("OC").font(.system(size: size * 0.65, weight: .semibold)).frame(width: size, height: size)
        } else {
            Image("ProviderClaude")
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
        }
    }
}

struct ModelChoice: Equatable {
    var driver: String
    var model: String?
    var effort: String?
    var fastMode: Bool?
    var serviceTier: String? = nil
    var ultracode: Bool? = nil

    var isTouched: Bool {
        model != nil || effort != nil || fastMode != nil || serviceTier != nil || ultracode != nil
    }
}

struct ModelPillView: View {
    let catalogues: [String: ModelCatalogue]
    let choice: ModelChoice

    let driversSwitchable: Bool
    let onChange: (ModelChoice) -> Void

    @ScaledMetric(relativeTo: .subheadline) private var height: CGFloat = 44
    @ScaledMetric(relativeTo: .subheadline) private var cap: CGFloat = 200

    @ScaledMetric(relativeTo: .subheadline) private var badge: CGFloat = 16

    private var models: [ProviderModel] {
        (catalogues[choice.driver]?.models ?? []).filter { !$0.hidden }
    }
    private var families: [ModelFamilies.Family] {
        ModelFamilies.group(models).filter { !$0.hidden }
    }

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

        if next.model == nil { next.model = selectedRow?.id }
        mutate(&next)
        onChange(next)
    }
}
