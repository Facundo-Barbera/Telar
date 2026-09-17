import Foundation

/// WHAT THE AGENT'S SETTINGS SAY — every choice and every sentence, as values
/// rather than as a view (#556).
///
/// ── WHY THIS IS NOT INSIDE THE SCREEN ───────────────────────────────────────
/// The Agent's settings screen and the composer's three pills configure the same
/// document through the same route, and they used to hold two private copies of
/// "which levels exist" and "what does Auto mean". Two copies of a vocabulary is
/// how one screen ends up offering a level the other has dropped — and neither
/// copy could be held by a test, because both were `private static` inside a
/// `View`.
///
/// So the vocabulary lives here, `AgentComposerControls` reads it, the settings
/// screen reads it, and `AgentSettingsTests` holds it. Nothing in this file
/// imports SwiftUI: it is strings and small decisions, which is exactly the part
/// worth pinning.
///
/// ── IT IS THE DESKTOP'S WORDS, NOT A PARAPHRASE ─────────────────────────────
/// Every sentence below is `apps/web/components/agent/agent-composer-controls
/// .tsx` and `apps/web/components/settings/agent-section.tsx`, kept word for
/// word. A phone that explained `auto` differently from the Mac would be two
/// answers to one question about who may approve what.
/// One answer a menu or a picker offers: what goes on the wire, and what the
/// person reads. `Identifiable` by its wire value so `ForEach` needs nothing
/// said at the call site — a labelled tuple could not carry a key path.
struct AgentChoice: Identifiable, Equatable {
    let value: String
    let label: String
    var id: String { value }
}

enum AgentSettings {
    /// The environment variable the engine falls back to. Named in a sentence
    /// the reader is expected to act on, so it is spelled once.
    static let keyVariable = "OPENCODE_API_KEY"

    /// What runs when nobody picks — the desktop's `DEFAULT_AGENT_MODEL`,
    /// mirroring the engine's own `DEFAULT_GO_MODEL`. The ENGINE is what
    /// applies it; this is only what the screen says while saying so.
    static let defaultModel = "kimi-k3"

    /// THREE LEVELS, NOT THE PROVIDER'S OWN LIST. `GET /api/agent/models`
    /// publishes ids and nothing else, so there is nothing to read per model:
    /// low/medium/high are what every server honouring `reasoning_effort`
    /// accepts, and one that does not ignores an unknown key.
    static let efforts: [AgentChoice] = [
        AgentChoice(value: "low", label: "Low"),
        AgentChoice(value: "medium", label: "Medium"),
        AgentChoice(value: "high", label: "High"),
    ]

    static let accesses: [AgentChoice] = [AgentChoice(value: "ask", label: "Ask"), AgentChoice(value: "auto", label: "Auto")]

    /// AN UNCHOSEN LEVEL NAMES THE QUESTION rather than repeating "Auto" beside
    /// the access pill, which would be one word twice with nothing to say which
    /// was which. A stored level this build does not know shows as itself — the
    /// label must never read as running something it is not.
    static func effortPillLabel(_ effort: String?) -> String {
        guard let effort else { return "Reasoning" }
        return efforts.first { $0.value == effort }?.label ?? effort
    }

    /// THE SETTINGS ROW SAYS "AUTO" WHERE THE PILL SAYS "REASONING". The pill
    /// sits beside two others and has to name which question it answers; a row
    /// already has its label above it, so the control states the ANSWER — and
    /// the answer to an unset effort is Auto.
    static func effortRowLabel(_ effort: String?) -> String {
        guard let effort else { return "Auto" }
        return efforts.first { $0.value == effort }?.label ?? effort
    }

    /// ABSENT MEANS `ask`, which is a real default with a name — unlike effort,
    /// where absent means the parameter is not sent at all.
    static func accessLabel(_ access: String?) -> String {
        let active = access ?? "ask"
        return accesses.first { $0.value == active }?.label ?? active
    }

    /// WHAT EACH ACCESS MODE ACTUALLY DOES, in the words a person decides on.
    /// The `auto` sentence is the one that matters: it does not widen what the
    /// Agent may do, only who says yes.
    static func accessHelp(_ access: String?) -> String {
        switch access ?? "ask" {
        case "auto":
            return "Policy approves them and the transcript records it. The same calls are still gated; nothing new is allowed."
        default:
            return "You approve each gated call — sending work to a session, creating one, stopping one, deleting a note."
        }
    }

    /// WHAT THE EFFORT ROW EXPLAINS — an unset level is the interesting case, so
    /// it gets the longer sentence.
    static func effortHelp(_ effort: String?) -> String {
        effort == nil
            ? "Auto — reasoning_effort is not sent at all, which is the model's own behaviour and what every turn did before this setting existed."
            : "Sent as reasoning_effort on every turn. A model with no reasoning mode ignores it."
    }

    /// WHICH RUNG ANSWERED, as the sentence under the key field — never the key.
    ///
    /// FOUR CASES AND THEY ARE ALL DIFFERENT. `nil` is an engine too old to
    /// report one, which must NOT read as "no key": the difference is a quiet
    /// row versus one demanding setup from somebody whose Agent works. A
    /// credential with no `source` is genuinely nothing anywhere, and that is
    /// the only case that tells the reader what to do about it.
    static func credentialLine(_ credential: AgentCredential?) -> String {
        guard let credential else { return "This Mac does not report where its key comes from." }
        switch credential.source {
        case "setting": return "Using the key saved on that Mac."
        case "environment": return "No key saved there — using \(keyVariable) from the engine's environment."
        case "cli": return "No key saved there — using the OpenCode CLI's own sign-in."
        default:
            return "No key anywhere. Paste one here, or set \(keyVariable) in the engine's environment, or sign in with the OpenCode CLI."
        }
    }

    /// WHETHER A KEY IS STORED ON THAT MAC — what the field's placeholder and
    /// the Remove button key off. `nil` credential is "cannot say", which is not
    /// "yes".
    static func hasStoredKey(_ credential: AgentCredential?) -> Bool {
        credential?.set == true
    }

    /// NOTHING TO RESET BEFORE THERE IS A THREAD. An Agent that has never been
    /// switched on has no conversation to replace, so the row is offered and
    /// refused rather than pressed into a no-op.
    static func canReset(_ state: AgentState?) -> Bool {
        state?.threadId?.isEmpty == false
    }

    /// THE MODEL ROW'S VALUE — the NAME when the catalogue carries it, the id
    /// when it does not, and the engine's default named rather than left as a
    /// word when nothing is stored.
    static func modelRowLabel(_ catalogue: AgentModelList, _ model: String?) -> String {
        guard let model, !model.isEmpty else {
            return "Default (\(catalogue.models.first(where: \.isDefault)?.name ?? defaultModel))"
        }
        return catalogue.models.first { $0.id == model }?.name ?? model
    }
}
