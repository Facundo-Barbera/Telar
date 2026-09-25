import Foundation

/// Ported from `apps/web/lib/model-families.ts` — the cockpit's own fold.
///
/// ONE ROW PER MODEL, NOT ONE ROW PER CONTEXT WINDOW: `sonnet` and
/// `sonnet[1m]` are the same Sonnet with a different window, so the picker
/// lists FAMILIES and the window becomes a setting beside the reasoning
/// level. It is still the provider's own model id on the wire — a family is
/// a way of READING the catalogue, not a thing the contract knows about.
enum ModelFamilies {
    enum ContextWindow: String, CaseIterable {
        case standard, long
        /// The number, not the word — `200k | 1M`, matching the web pill.
        var label: String { self == .long ? "1M" : "200k" }
    }

    struct Family: Identifiable, Equatable {
        var id: String
        var label: String
        var isDefault: Bool
        var hidden: Bool
        /// The provider's own rows, in catalogue order. Never empty.
        var rows: [ProviderModel]
    }

    /// The row's own `contextWindow` first (a fixed-window model), then
    /// `[1m]` — Claude Code's own spelling.
    static func contextWindow(of model: ProviderModel) -> ContextWindow {
        if let tokens = model.contextWindow { return tokens >= 1_000_000 ? .long : .standard }
        let id = model.id.lowercased()
        let resolves = (model.resolves ?? "").lowercased()
        return id.hasSuffix("[1m]") || resolves.hasSuffix("[1m]") ? .long : .standard
    }

    /// The id two rows share when they are the same model: the RESOLVED id
    /// minus the window suffix and a trailing dated build.
    static func familyKey(_ model: ProviderModel) -> String {
        var key = model.resolves ?? model.id
        if key.lowercased().hasSuffix("[1m]") { key = String(key.dropLast(4)) }
        if let range = key.range(of: #"-\d{8}$"#, options: .regularExpression) {
            key.removeSubrange(range)
        }
        return key
    }

    /// "Opus (1M context)" is a label repeating a setting the reader can now
    /// reach — strip it.
    static func stripWindow(_ label: String) -> String {
        guard let range = label.range(of: #"\s*\([^)]*context[^)]*\)\s*$"#, options: [.regularExpression, .caseInsensitive]) else {
            return label
        }
        return label.replacingCharacters(in: range, with: "").trimmingCharacters(in: .whitespaces)
    }

    /// The version, restored to a bare label from the family key —
    /// "Sonnet" + `claude-sonnet-5` → "Sonnet 5". Only when the label
    /// carries no digit of its own.
    static func versionedLabel(_ label: String, id: String) -> String {
        guard label.rangeOfCharacter(from: .decimalDigits) == nil else { return label }
        guard let match = id.range(of: #"-(\d+(?:-\d+)*)$"#, options: .regularExpression) else { return label }
        let version = String(id[match]).dropFirst().replacingOccurrences(of: "-", with: ".")
        return "\(label) \(version)"
    }

    /// Fold a catalogue into families, in catalogue order. Hidden only if
    /// every variant is hidden.
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

    /// Matched on the id first and `resolves` second — a session can carry
    /// either.
    static func row(of models: [ProviderModel], id: String?) -> ProviderModel? {
        guard let id else { return nil }
        return models.first { $0.id == id } ?? models.first { $0.resolves == id }
    }

    static func family(of families: [Family], id: String?) -> Family? {
        guard let id else { return nil }
        return families.first { $0.rows.contains { $0.id == id || $0.resolves == id } }
    }

    /// The windows this model comes in, standard first. One entry means
    /// nothing to choose.
    static func windows(of family: Family?) -> [ContextWindow] {
        let present = Set((family?.rows ?? []).map { contextWindow(of: $0) })
        return ContextWindow.allCases.filter { present.contains($0) }
    }

    static func row(for family: Family?, window: ContextWindow) -> ProviderModel? {
        family?.rows.first { contextWindow(of: $0) == window }
    }

    /// Which row runs when you pick this family — the window you are on, if
    /// it has one; else default, else standard.
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

/// The per-model knobs beside the model list — which sections a row offers,
/// which option is the provider's default, and what a tap stores. Kept apart
/// from the view so the rules are testable without a menu.
enum ModelOptions {
    enum Section: Equatable { case reasoning, contextWindow, fastMode, serviceTier }

    /// Menu order; a section a row does not publish is simply absent.
    static func sections(row: ProviderModel?, family: ModelFamilies.Family?) -> [Section] {
        guard let row else { return [] }
        var out: [Section] = []
        if !row.efforts.isEmpty { out.append(.reasoning) }
        if ModelFamilies.windows(of: family).count > 1 { out.append(.contextWindow) }
        if row.fastMode { out.append(.fastMode) }
        if !(row.serviceTiers ?? []).isEmpty { out.append(.serviceTier) }
        return out
    }

    // MARK: reasoning

    static func offersUltracode(driver: String, row: ProviderModel?) -> Bool {
        driver == "claude" && row?.efforts.contains("xhigh") == true
    }

    /// "Auto" is only a row while the provider's default level is unknown;
    /// once known, the Default-marked level IS the automatic choice.
    static func showsAutoEffort(_ row: ProviderModel) -> Bool { row.defaultEffort == nil }

    static func isDefaultEffort(_ level: String, row: ProviderModel) -> Bool { row.defaultEffort == level }

    /// Picking the default level stores nothing, so the session follows the
    /// provider if its default moves.
    static func storedEffort(for level: String, row: ProviderModel) -> String? {
        isDefaultEffort(level, row: row) ? nil : level
    }

    static func isEffortSelected(_ level: String, choice: ModelChoice, row: ProviderModel) -> Bool {
        if choice.ultracode == true { return false }
        if let effort = choice.effort { return effort == level }
        return isDefaultEffort(level, row: row)
    }

    /// What the pill names: the pick, else Ultracode, else the default level,
    /// else Auto. Nil when the row has no reasoning control at all.
    static func levelLabel(choice: ModelChoice, row: ProviderModel?) -> String? {
        if let effort = choice.effort { return ModelFamilies.effortLabel(effort) }
        if choice.ultracode == true { return "Ultracode" }
        guard let row, !row.efforts.isEmpty else { return nil }
        return row.defaultEffort.map(ModelFamilies.effortLabel) ?? "Auto"
    }

    // MARK: service tier

    static func showsAutoTier(_ row: ProviderModel) -> Bool { row.defaultServiceTier == nil }

    static func storedTier(for id: String, row: ProviderModel) -> String? {
        row.defaultServiceTier == id ? nil : id
    }

    static func isTierSelected(_ id: String, choice: ModelChoice, row: ProviderModel) -> Bool {
        (choice.serviceTier ?? row.defaultServiceTier) == id
    }

    // MARK: moving rows

    /// Move to a row, DROPPING WHAT IT CANNOT HONOUR: an effort or tier it does
    /// not list fails the turn; fast mode or ultracode it does not offer
    /// silently does nothing.
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
