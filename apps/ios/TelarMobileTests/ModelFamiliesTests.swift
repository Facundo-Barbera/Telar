import Foundation
import Testing
@testable import TelarMobile

/// The fold's pinned cases, ported from apps/web/lib/model-families.test.ts.
@Suite struct ModelFamiliesTests {
    private func model(_ id: String, label: String, resolves: String? = nil,
                       isDefault: Bool = false, efforts: [String] = [], fastMode: Bool = false) -> ProviderModel {
        ProviderModel(id: id, label: label, description: nil, isDefault: isDefault,
                      hidden: false, efforts: efforts, defaultEffort: nil,
                      resolves: resolves, fastMode: fastMode)
    }

    @Test func windowVariantsFoldIntoOneFamily() {
        let models = [
            model("sonnet", label: "Sonnet", resolves: "claude-sonnet-5"),
            model("sonnet[1m]", label: "Sonnet 5 (1M context)", resolves: "claude-sonnet-5[1m]"),
            model("opus[1m]", label: "Opus (1M context)", resolves: "claude-opus-5[1m]", isDefault: true),
        ]
        let families = ModelFamilies.group(models)
        #expect(families.count == 2)
        // The standard row names the family; version restored from the key.
        #expect(families[0].label == "Sonnet 5")
        #expect(families[0].rows.count == 2)
        // No standard row → long row's label, window stripped.
        #expect(families[1].label == "Opus 5")
        #expect(families[1].isDefault)
        #expect(ModelFamilies.windows(of: families[0]) == [.standard, .long])
        #expect(ModelFamilies.windows(of: families[1]) == [.long])
    }

    @Test func legacyDecodesAndIsOptional() throws {
        let row = #"{"id":"claude-fable-5[1m]","label":"Fable","isDefault":false,"hidden":false,"efforts":[],"fastMode":false,"legacy":true}"#
        #expect(try JSONDecoder().decode(ProviderModel.self, from: Data(row.utf8)).legacy == true)
        let older = #"{"id":"sonnet","label":"Sonnet","isDefault":true,"hidden":false,"efforts":[],"fastMode":false}"#
        #expect(try JSONDecoder().decode(ProviderModel.self, from: Data(older.utf8)).legacy == nil)
    }

    @Test func aFixedWindowBeatsTheSuffix() throws {
        // Opus 4.8 is always 1M and publishes its bare slug (#914).
        let fixed = #"{"id":"claude-opus-4-8","label":"Opus 4.8","isDefault":false,"hidden":false,"efforts":[],"fastMode":true,"contextWindow":1000000}"#
        #expect(ModelFamilies.contextWindow(of: try JSONDecoder().decode(ProviderModel.self, from: Data(fixed.utf8))) == .long)
        #expect(ModelFamilies.contextWindow(of: model("haiku", label: "Haiku")) == .standard)
        #expect(ModelFamilies.contextWindow(of: model("opus[1m]", label: "Opus")) == .long)
    }

    @Test func datedBuildsFoldToo() {
        let models = [model("haiku", label: "Haiku", resolves: "claude-haiku-4-5-20251001")]
        #expect(ModelFamilies.group(models)[0].label == "Haiku 4.5")
        #expect(ModelFamilies.familyKey(models[0]) == "claude-haiku-4-5")
    }

    @Test func aPointReleaseIsItsOwnFamily() {
        // Fable 5.1: `-5-1` is a version, not an 8-digit dated build — the
        // strip must not eat it, and the label restores the dotted version.
        let models = [
            model("claude-fable-5[1m]", label: "Fable", resolves: "claude-fable-5[1m]"),
            model("claude-fable-5-1[1m]", label: "Fable", resolves: "claude-fable-5-1[1m]"),
        ]
        let families = ModelFamilies.group(models)
        #expect(families.count == 2)
        #expect(families[0].label == "Fable 5")
        #expect(families[1].label == "Fable 5.1")
        #expect(ModelFamilies.familyKey(models[1]) == "claude-fable-5-1")
    }

    @Test func labelsWithDigitsAreNotDoubled() {
        let models = [model("gpt-5.6-sol", label: "GPT-5.6-Sol")]
        #expect(ModelFamilies.group(models)[0].label == "GPT-5.6-Sol")
    }

    @Test func rowMatchesIdThenResolves() {
        let models = [model("sonnet", label: "Sonnet", resolves: "claude-sonnet-5")]
        #expect(ModelFamilies.row(of: models, id: "sonnet")?.id == "sonnet")
        #expect(ModelFamilies.row(of: models, id: "claude-sonnet-5")?.id == "sonnet")
        #expect(ModelFamilies.row(of: models, id: "nope") == nil)
    }

    @Test func pickPrefersTheWindowYouAreOn() {
        let standard = model("sonnet", label: "Sonnet", resolves: "claude-sonnet-5")
        let long = model("sonnet[1m]", label: "Sonnet (1M context)", resolves: "claude-sonnet-5[1m]")
        let family = ModelFamilies.group([standard, long])[0]
        #expect(ModelFamilies.pick(in: family, window: .long).id == "sonnet[1m]")
        #expect(ModelFamilies.pick(in: family, window: .standard).id == "sonnet")
    }
}

/// The per-model knobs: which sections show, the Default markers, what a tap
/// stores.
@Suite struct ModelOptionsTests {
    private func decode(_ json: String) throws -> ProviderModel {
        try JSONDecoder().decode(ProviderModel.self, from: Data(json.utf8))
    }

    private let codexJSON = #"{"id":"gpt-5.6","label":"GPT-5.6","isDefault":true,"hidden":false,"efforts":["low","medium","high"],"defaultEffort":"medium","fastMode":false,"serviceTiers":[{"id":"flex","name":"Flex","description":"Cheaper, slower"},{"id":"priority","name":"Priority"}],"defaultServiceTier":"flex"}"#

    private func claude(_ id: String, resolves: String, defaultWindow: Bool? = nil,
                        efforts: [String] = ["low", "medium", "high", "xhigh"], defaultEffort: String? = "high",
                        fastMode: Bool = true) -> ProviderModel {
        ProviderModel(id: id, label: "Opus", description: nil, isDefault: defaultWindow == true, hidden: false,
                      efforts: efforts, defaultEffort: defaultEffort, resolves: resolves,
                      fastMode: fastMode, defaultWindow: defaultWindow)
    }

    @Test func serviceTiersDecodeAndAreOptional() throws {
        let row = try decode(codexJSON)
        #expect(row.serviceTiers?.map(\.id) == ["flex", "priority"])
        #expect(row.serviceTiers?[0].description == "Cheaper, slower")
        #expect(row.serviceTiers?[1].description == nil)
        #expect(row.defaultServiceTier == "flex")
        let older = try decode(#"{"id":"sonnet","label":"Sonnet","isDefault":true,"hidden":false,"efforts":[],"fastMode":false}"#)
        #expect(older.serviceTiers == nil)
        #expect(older.defaultServiceTier == nil)
    }

    @Test func sectionsFollowWhatTheRowPublishes() throws {
        let codex = try decode(codexJSON)
        #expect(ModelOptions.sections(row: codex, family: ModelFamilies.group([codex])[0]) == [.reasoning, .serviceTier])

        let rows = [claude("opus", resolves: "claude-opus-5"),
                    claude("opus[1m]", resolves: "claude-opus-5[1m]", defaultWindow: true)]
        let family = ModelFamilies.group(rows)[0]
        #expect(ModelOptions.sections(row: rows[1], family: family) == [.reasoning, .contextWindow, .fastMode])

        let bare = claude("haiku", resolves: "claude-haiku-4-5", efforts: [], defaultEffort: nil, fastMode: false)
        #expect(ModelOptions.sections(row: bare, family: ModelFamilies.group([bare])[0]).isEmpty)
        #expect(ModelOptions.sections(row: nil, family: nil).isEmpty)
    }

    @Test func bothWindowsAreSelectableAndTheDefaultIsMarked() {
        let rows = [claude("opus", resolves: "claude-opus-5"),
                    claude("opus[1m]", resolves: "claude-opus-5[1m]", defaultWindow: true)]
        let family = ModelFamilies.group(rows)[0]
        #expect(ModelFamilies.windows(of: family) == [.standard, .long])
        let standard = ModelFamilies.row(for: family, window: .standard)
        #expect(standard?.id == "opus")
        #expect(standard?.defaultWindow != true)
        #expect(ModelFamilies.row(for: family, window: .long)?.defaultWindow == true)
        // Picking 200k from 1M keeps what the row honours.
        let from = ModelChoice(driver: "claude", model: "opus[1m]", effort: "low", fastMode: true, ultracode: nil)
        let moved = ModelOptions.moving(from, to: standard!, driver: "claude")
        #expect(moved.model == "opus")
        #expect(moved.effort == "low")
        #expect(moved.fastMode == true)
    }

    @Test func theDefaultEffortClearsThePick() {
        let row = claude("opus", resolves: "claude-opus-5")
        #expect(!ModelOptions.showsAutoEffort(row))
        #expect(ModelOptions.isDefaultEffort("high", row: row))
        #expect(ModelOptions.storedEffort(for: "high", row: row) == nil)
        #expect(ModelOptions.storedEffort(for: "low", row: row) == "low")
        let none = ModelChoice(driver: "claude")
        #expect(ModelOptions.isEffortSelected("high", choice: none, row: row))
        #expect(!ModelOptions.isEffortSelected("low", choice: none, row: row))

        let unknown = claude("opus", resolves: "claude-opus-5", defaultEffort: nil)
        #expect(ModelOptions.showsAutoEffort(unknown))
        #expect(ModelOptions.storedEffort(for: "high", row: unknown) == "high")
    }

    @Test func ultracodeIsClaudeWithExtraHighOnly() throws {
        let row = claude("opus", resolves: "claude-opus-5")
        #expect(ModelOptions.offersUltracode(driver: "claude", row: row))
        #expect(!ModelOptions.offersUltracode(driver: "claude", row: claude("x", resolves: "x", efforts: ["low", "high"])))
        #expect(!ModelOptions.offersUltracode(driver: "codex", row: try decode(codexJSON)))
        let on = ModelChoice(driver: "claude", model: "opus", ultracode: true)
        #expect(!ModelOptions.isEffortSelected("high", choice: on, row: row))
        // Moving to a row without xhigh drops it.
        let moved = ModelOptions.moving(on, to: claude("sonnet", resolves: "claude-sonnet-5", efforts: ["high"]), driver: "claude")
        #expect(moved.ultracode == nil)
    }

    @Test func thePillNamesTheEffectiveLevel() {
        let row = claude("opus", resolves: "claude-opus-5")
        #expect(ModelOptions.levelLabel(choice: ModelChoice(driver: "claude", effort: "low"), row: row) == "Low")
        #expect(ModelOptions.levelLabel(choice: ModelChoice(driver: "claude", ultracode: true), row: row) == "Ultracode")
        #expect(ModelOptions.levelLabel(choice: ModelChoice(driver: "claude"), row: row) == "High")
        let unknown = claude("opus", resolves: "claude-opus-5", defaultEffort: nil)
        #expect(ModelOptions.levelLabel(choice: ModelChoice(driver: "claude"), row: unknown) == "Auto")
        let bare = claude("haiku", resolves: "claude-haiku-4-5", efforts: [], defaultEffort: nil)
        #expect(ModelOptions.levelLabel(choice: ModelChoice(driver: "claude"), row: bare) == nil)
    }

    @Test func theDefaultTierClearsThePick() throws {
        let row = try decode(codexJSON)
        #expect(!ModelOptions.showsAutoTier(row))
        #expect(ModelOptions.storedTier(for: "flex", row: row) == nil)
        #expect(ModelOptions.storedTier(for: "priority", row: row) == "priority")
        #expect(ModelOptions.isTierSelected("flex", choice: ModelChoice(driver: "codex"), row: row))
        #expect(ModelOptions.isTierSelected("priority", choice: ModelChoice(driver: "codex", serviceTier: "priority"), row: row))
        // A row that does not list the tier drops it.
        let plain = try decode(#"{"id":"gpt-mini","label":"Mini","isDefault":false,"hidden":false,"efforts":[],"fastMode":false}"#)
        #expect(ModelOptions.moving(ModelChoice(driver: "codex", serviceTier: "priority"), to: plain, driver: "codex").serviceTier == nil)
    }

    @Test func selectionOmitsAbsentFields() throws {
        let json = String(decoding: try JSONEncoder().encode(ModelSelection(instanceId: "codex", model: "gpt-5.6", effort: nil, fastMode: nil)), as: UTF8.self)
        #expect(!json.contains("serviceTier") && !json.contains("ultracode"))
        let full = String(decoding: try JSONEncoder().encode(ModelSelection(instanceId: "claude", model: nil, effort: nil, fastMode: nil, serviceTier: "priority", ultracode: true)), as: UTF8.self)
        #expect(full.contains(#""serviceTier":"priority""#) && full.contains(#""ultracode":true"#))
    }
}
