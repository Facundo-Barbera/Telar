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
