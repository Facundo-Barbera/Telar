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
