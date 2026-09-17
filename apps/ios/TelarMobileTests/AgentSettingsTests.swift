import Foundation
import Testing
@testable import TelarMobile

/// THE AGENT'S SETTINGS SCREEN (#556) — the decisions it makes, without it.
///
/// ── WHY THERE IS ANYTHING TO TEST HERE AT ALL ───────────────────────────────
/// A settings screen is mostly furniture, and furniture is not worth a test. What
/// IS worth one is the handful of places where ABSENT and a VALUE mean different
/// things, because those are the ones that read as bugs when they are wrong and
/// as nothing when they are right:
///
///   - An absent EFFORT is not a level — the parameter is not sent at all.
///   - An absent ACCESS *is* a value, `ask`, and has to name itself.
///   - An absent CREDENTIAL is "this Mac cannot say", which must never be shown
///     as "no key": that would demand setup from somebody whose Agent works.
///   - An absent THREAD is nothing to reset, not a reset that does nothing.
///
/// Every one of those is a `nil` that three different rows read three different
/// ways, which is exactly the shape of thing that rots silently.
///
/// ── AND WHY THE VOCABULARY IS SHARED ────────────────────────────────────────
/// The composer's pills and this screen configure the same two fields. They held
/// two private copies of the levels; `AgentSettings` is now the one copy, and the
/// last test here is what keeps the patch they both send by presence.
@Suite struct AgentSettingsTests {

    // ── EFFORT: ABSENT IS NOT A LEVEL ────────────────────────────────────────

    @Test func anUnsetEffortNamesTheQuestionOnAPillAndTheAnswerOnARow() {
        // The pill sits beside two others and has to say WHICH question it
        // answers; a settings row already has its label, so its control states
        // the answer — and the answer to an unset effort is Auto.
        #expect(AgentSettings.effortPillLabel(nil) == "Reasoning")
        #expect(AgentSettings.effortRowLabel(nil) == "Auto")

        #expect(AgentSettings.effortPillLabel("high") == "High")
        #expect(AgentSettings.effortRowLabel("high") == "High")
    }

    @Test func aLevelThisBuildDoesNotKnowShowsAsItself() {
        // A Mac on a newer engine may store a level this build has never heard
        // of. Falling back to "Auto" would claim the parameter is not being sent
        // when it is — the label must never read as running something it is not.
        #expect(AgentSettings.effortRowLabel("blistering") == "blistering")
        #expect(AgentSettings.effortPillLabel("blistering") == "blistering")
    }

    @Test func theEffortHelpDistinguishesNotSentFromALevel() {
        #expect(AgentSettings.effortHelp(nil).contains("not sent at all"))
        #expect(!AgentSettings.effortHelp("low").contains("not sent at all"))
    }

    // ── ACCESS: ABSENT IS A REAL DEFAULT WITH A NAME ─────────────────────────

    @Test func anUnsetAccessIsAskAndSaysSo() {
        #expect(AgentSettings.accessLabel(nil) == "Ask")
        #expect(AgentSettings.accessLabel("ask") == "Ask")
        #expect(AgentSettings.accessLabel("auto") == "Auto")
    }

    @Test func autoIsExplainedAsWhoApproves_notAsWhatIsAllowed() {
        // The sentence that matters: `auto` does not widen what the Agent may
        // do, only who says yes. A screen that let people read it the other way
        // would be asking for consent to something it is not doing.
        let auto = AgentSettings.accessHelp("auto")
        #expect(auto.contains("nothing new is allowed"))
        #expect(AgentSettings.accessHelp(nil) == AgentSettings.accessHelp("ask"))
        #expect(AgentSettings.accessHelp("ask").contains("You approve each gated call"))
    }

    // ── THE CREDENTIAL: FOUR CASES, AND THEY ARE ALL DIFFERENT ───────────────

    @Test func aMacThatCannotSayIsNotAMacWithNoKey() {
        // `nil` is an engine too old to report a rung. Reading it as "no key"
        // would print setup instructions over somebody's working Agent.
        let cannotSay = AgentSettings.credentialLine(nil)
        #expect(cannotSay.contains("does not report"))
        #expect(!cannotSay.contains("No key anywhere"))
        #expect(!AgentSettings.hasStoredKey(nil))
    }

    @Test func eachRungGetsItsOwnSentence() {
        let saved = AgentCredential(source: "setting", set: true)
        let environment = AgentCredential(source: "environment", set: false)
        let cli = AgentCredential(source: "cli", set: false)
        let nothing = AgentCredential(source: nil, set: false)

        #expect(AgentSettings.credentialLine(saved) == "Using the key saved on that Mac.")
        // WHICH RUNG ANSWERED IS THE POINT: "it works, and it is not the key you
        // pasted" is the confusing state this feature can be in.
        #expect(AgentSettings.credentialLine(environment).contains(AgentSettings.keyVariable))
        #expect(AgentSettings.credentialLine(cli).contains("OpenCode CLI"))
        // The only case that tells the reader what to do about it — and the only
        // one that names all three rungs.
        let none = AgentSettings.credentialLine(nothing)
        #expect(none.contains("No key anywhere"))
        #expect(none.contains(AgentSettings.keyVariable))

        // `set` is what the field's placeholder and the Remove button key off,
        // and it is independent of the rung: a key in the environment is not a
        // key saved here.
        #expect(AgentSettings.hasStoredKey(saved))
        #expect(!AgentSettings.hasStoredKey(environment))
    }

    @Test func theCredentialDecodesFromTheMacsOwnAnswer() throws {
        let json = #"{"agent":{"enabled":true,"running":false,"queued":0},"credential":{"source":"environment","set":false}}"#
        let answer = try JSONDecoder().decode(AgentAnswer.self, from: Data(json.utf8))
        #expect(AgentSettings.credentialLine(answer.credential).contains(AgentSettings.keyVariable))
        #expect(!AgentSettings.hasStoredKey(answer.credential))
    }

    // ── THE MODEL ROW ────────────────────────────────────────────────────────

    @Test func anUnsetModelNamesWhatWillActuallyRun() {
        let catalogue = AgentModelList(models: [AgentModel(id: "kimi-k3", name: "Kimi K3", isDefault: true)], message: nil)
        // NAMED RATHER THAN LEFT AS A WORD: the engine marks the row it means, so
        // nobody has to go and look up what "Default" runs.
        #expect(AgentSettings.modelRowLabel(catalogue, nil) == "Default (Kimi K3)")
        // `""` reaches this row too — it is what the picker writes to clear the
        // setting, and it must not draw a blank chip.
        #expect(AgentSettings.modelRowLabel(catalogue, "") == "Default (Kimi K3)")
    }

    @Test func aCatalogueThatCouldNotBeReadStillNamesTheEnginesFallback() {
        let empty = AgentModelList(models: [], message: "That Mac could not reach OpenCode Go.")
        #expect(AgentSettings.modelRowLabel(empty, nil) == "Default (\(AgentSettings.defaultModel))")
    }

    @Test func aStoredModelReadsAsItsNameAndFallsBackToItsId() {
        let catalogue = AgentModelList(models: [AgentModel(id: "glm-5", name: "GLM 5")], message: nil)
        #expect(AgentSettings.modelRowLabel(catalogue, "glm-5") == "GLM 5")
        // An id the catalogue does not carry has no name to fall back on, so it
        // shows as itself rather than as the default it is not running.
        #expect(AgentSettings.modelRowLabel(catalogue, "withdrawn-v1") == "withdrawn-v1")
    }

    // ── THE RESET ────────────────────────────────────────────────────────────

    @Test func thereIsNothingToResetBeforeThereIsAThread() {
        #expect(!AgentSettings.canReset(nil))
        #expect(!AgentSettings.canReset(AgentState(enabled: true)))
        #expect(!AgentSettings.canReset(AgentState(enabled: true, threadId: "")))
        #expect(AgentSettings.canReset(AgentState(enabled: true, threadId: "thread_1")))
    }

    // ── THE PATCH ────────────────────────────────────────────────────────────

    /// What actually goes on the wire for a patch — which is the only thing
    /// "by presence" can be checked against.
    private func encode(_ patch: AgentSettingsPatch) throws -> [String: Any] {
        let data = try JSONEncoder().encode(patch)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    @Test func everyFieldTheScreenWritesGoesByPresence() throws {
        // A SWITCH MUST NOT RE-DECIDE THE MODEL, and — the one that matters —
        // `reset` must never ride along: the thing it archives is the
        // conversation, so a patch carrying `reset: false` by default would be
        // one refactor from carrying `true`.
        let switched = try encode(AgentSettingsPatch(enabled: true))
        #expect(switched.keys.sorted() == ["enabled"])

        let effort = try encode(AgentSettingsPatch(effort: "high"))
        #expect(effort.keys.sorted() == ["effort"])

        // `""` IS A REAL VALUE AND HAS TO SURVIVE ENCODING: it is how Auto is
        // said on the wire, and how Remove clears the key.
        let auto = try encode(AgentSettingsPatch(effort: ""))
        #expect(auto["effort"] as? String == "")

        let cleared = try encode(AgentSettingsPatch(apiKey: ""))
        #expect(cleared.keys.sorted() == ["apiKey"])
        #expect(cleared["apiKey"] as? String == "")

        let reset = try encode(AgentSettingsPatch(reset: true))
        #expect(reset.keys.sorted() == ["reset"])
    }

    // ── ONE VOCABULARY, NOT TWO ──────────────────────────────────────────────

    @Test func theComposersLevelsAndTheSettingsRowsLevelsAreOneList() {
        // They were two private copies inside two views, which is how one screen
        // ends up offering a level the other has dropped. The list is short on
        // purpose: `GET /api/agent/models` publishes ids and nothing else, so
        // there is no per-model list to read and low/medium/high are what every
        // server honouring `reasoning_effort` accepts.
        #expect(AgentSettings.efforts.map(\.value) == ["low", "medium", "high"])
        #expect(AgentSettings.accesses.map(\.value) == ["ask", "auto"])
    }
}
