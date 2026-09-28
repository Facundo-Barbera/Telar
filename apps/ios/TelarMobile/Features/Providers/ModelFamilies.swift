import Foundation

enum ModelFamilies {
    enum ContextWindow: String, CaseIterable {
        case standard, long

        var label: String { self == .long ? "1M" : "200k" }
    }

    struct Family: Identifiable, Equatable {
        var id: String
        var label: String
        var isDefault: Bool
        var hidden: Bool

        var rows: [ProviderModel]
    }

    static func contextWindow(of model: ProviderModel) -> ContextWindow {
        if let tokens = model.contextWindow { return tokens >= 1_000_000 ? .long : .standard }
        let id = model.id.lowercased()
        let resolves = (model.resolves ?? "").lowercased()
        return id.hasSuffix("[1m]") || resolves.hasSuffix("[1m]") ? .long : .standard
    }

    static func familyKey(_ model: ProviderModel) -> String {
        var key = model.resolves ?? model.id
        if key.lowercased().hasSuffix("[1m]") { key = String(key.dropLast(4)) }
        if let range = key.range(of: #"-\d{8}$"#, options: .regularExpression) {
            key.removeSubrange(range)
        }
        return key
    }

    static func stripWindow(_ label: String) -> String {
        guard let range = label.range(of: #"\s*\([^)]*context[^)]*\)\s*$"#, options: [.regularExpression, .caseInsensitive]) else {
            return label
        }
        return label.replacingCharacters(in: range, with: "").trimmingCharacters(in: .whitespaces)
    }

    static func versionedLabel(_ label: String, id: String) -> String {
        guard label.rangeOfCharacter(from: .decimalDigits) == nil else { return label }
        guard let match = id.range(of: #"-(\d+(?:-\d+)*)$"#, options: .regularExpression) else { return label }
        let version = String(id[match]).dropFirst().replacingOccurrences(of: "-", with: ".")
        return "\(label) \(version)"
    }

    static func group(_ models: [ProviderModel]) -> [Family] {
        var order: [String] = []
        var byKey: [String: [ProviderModel]] = [:]
        for model in models {
            let key = familyKey(model)
            if byKey[key] == nil { order.append(key) }
            byKey[key, default: []].append(model)
        }
        return order.map { key in
            let rows = byKey[key]!
            let named = rows.first { contextWindow(of: $0) == .standard } ?? rows[0]
            let base = stripWindow(named.label)
            return Family(
                id: key,
                label: versionedLabel(base.isEmpty ? named.label : base, id: key),
                isDefault: rows.contains { $0.isDefault },
                hidden: rows.allSatisfy { $0.hidden },
                rows: rows
            )
        }
    }

    static func row(of models: [ProviderModel], id: String?) -> ProviderModel? {
        guard let id else { return nil }
        return models.first { $0.id == id } ?? models.first { $0.resolves == id }
    }

    static func family(of families: [Family], id: String?) -> Family? {
        guard let id else { return nil }
        return families.first { $0.rows.contains { $0.id == id || $0.resolves == id } }
    }

    static func windows(of family: Family?) -> [ContextWindow] {
        let present = Set((family?.rows ?? []).map { contextWindow(of: $0) })
        return ContextWindow.allCases.filter { present.contains($0) }
    }

    static func row(for family: Family?, window: ContextWindow) -> ProviderModel? {
        family?.rows.first { contextWindow(of: $0) == window }
    }

    static func pick(in family: Family, window: ContextWindow) -> ProviderModel {
        row(for: family, window: window)
            ?? family.rows.first { $0.isDefault }
            ?? row(for: family, window: .standard)
            ?? family.rows[0]
    }

    static func effortLabel(_ effort: String) -> String {
        switch effort {
        case "xhigh": "Extra high"
        default: effort.prefix(1).uppercased() + effort.dropFirst()
        }
    }
}

enum ModelOptions {
    enum Section: Equatable { case reasoning, contextWindow, fastMode, serviceTier }

    static func sections(row: ProviderModel?, family: ModelFamilies.Family?) -> [Section] {
        guard let row else { return [] }
        var out: [Section] = []
        if !row.efforts.isEmpty { out.append(.reasoning) }
        if ModelFamilies.windows(of: family).count > 1 { out.append(.contextWindow) }
        if row.fastMode { out.append(.fastMode) }
        if !(row.serviceTiers ?? []).isEmpty { out.append(.serviceTier) }
        return out
    }

    static func offersUltracode(driver: String, row: ProviderModel?) -> Bool {
        driver == "claude" && row?.efforts.contains("xhigh") == true
    }

    static func showsAutoEffort(_ row: ProviderModel) -> Bool { row.defaultEffort == nil }

    static func isDefaultEffort(_ level: String, row: ProviderModel) -> Bool { row.defaultEffort == level }

    static func storedEffort(for level: String, row: ProviderModel) -> String? {
        isDefaultEffort(level, row: row) ? nil : level
    }

    static func isEffortSelected(_ level: String, choice: ModelChoice, row: ProviderModel) -> Bool {
        if choice.ultracode == true { return false }
        if let effort = choice.effort { return effort == level }
        return isDefaultEffort(level, row: row)
    }

    static func levelLabel(choice: ModelChoice, row: ProviderModel?) -> String? {
        if let effort = choice.effort { return ModelFamilies.effortLabel(effort) }
        if choice.ultracode == true { return "Ultracode" }
        guard let row, !row.efforts.isEmpty else { return nil }
        return row.defaultEffort.map(ModelFamilies.effortLabel) ?? "Auto"
    }

    static func showsAutoTier(_ row: ProviderModel) -> Bool { row.defaultServiceTier == nil }

    static func storedTier(for id: String, row: ProviderModel) -> String? {
        row.defaultServiceTier == id ? nil : id
    }

    static func isTierSelected(_ id: String, choice: ModelChoice, row: ProviderModel) -> Bool {
        (choice.serviceTier ?? row.defaultServiceTier) == id
    }

    static func moving(_ choice: ModelChoice, to row: ProviderModel, driver: String) -> ModelChoice {
        var next = choice
        next.driver = driver
        next.model = row.id
        if let effort = next.effort, !row.efforts.contains(effort) { next.effort = nil }
        if next.fastMode == true, !row.fastMode { next.fastMode = nil }
        if next.ultracode == true, !offersUltracode(driver: driver, row: row) { next.ultracode = nil }
        if let tier = next.serviceTier, !(row.serviceTiers ?? []).contains(where: { $0.id == tier }) {
            next.serviceTier = nil
        }
        return next
    }
}
