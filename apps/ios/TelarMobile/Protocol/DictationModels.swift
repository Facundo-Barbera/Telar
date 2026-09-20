import Foundation

/// A CREDENTIAL FOR ONE DICTATION, MINTED BY THE MAC (#544).
///
/// The phone holds no transcription key and must not: a key on a device is a
/// key on every device it is ever restored to. What it gets is
/// `POST /api/dictation/token` on the cockpit it is paired to — through the
/// host proxy when that cockpit is a remote Mac — answering a JWT that expires
/// in minutes and can only reach the voice APIs.
///
/// `provider` RIDES THE ANSWER rather than being assumed here, because it
/// decides which socket to open and what to encode. Decoded as a plain string
/// rather than an enum on purpose: a Mac that has moved on to another provider
/// must not fail to decode on a phone that has not been updated yet — it should
/// say it does not know that one, which `DictationProvider` is where it does.
struct DictationTokenAnswer: Decodable, Sendable {
    var provider: String
    var token: String
    /// Epoch MILLISECONDS, as every instant on this wire is. An instant rather
    /// than a duration so the phone compares it against its own clock instead
    /// of timing a request it did not observe the start of.
    var expiresAt: Double
    /// WHAT TO ASK THE SOCKET TO TRANSCRIBE (#560), already in the provider's
    /// own spelling — the Mac maps the setting before it answers, so nothing
    /// here holds a vendor's language table.
    ///
    /// IT RIDES THE TOKEN so one round trip serves the whole tap: this phone
    /// asks for a credential on every press and does not read the settings
    /// route on that path.
    ///
    /// OPTIONAL, AND ABSENT MEANS `multi`. A Mac on a build from before this
    /// field existed answers without it, and the phone must not fail to decode
    /// a token it could have spent — code-switching is also the better guess
    /// than English for a Mac that never got to be asked.
    var language: String?
    /// WHAT TO PRIME THE RECOGNISER WITH (#581), in the provider's own shape —
    /// for Deepgram, the values of the repeated `keyterm` parameter.
    ///
    /// BUILT ON THAT MAC AND CARRIED HERE because only it can: the list is the
    /// person's stored glossary plus its unsettled conversations, its projects
    /// and their branches. This phone appends them and decides nothing.
    ///
    /// OPTIONAL, AND ABSENT MEANS NONE — a Mac on a build from before this
    /// field existed answers without it, and a dictation with no glossary is
    /// exactly what every dictation was until now.
    var keyterms: [String]?

    var expiry: Date { Date(timeIntervalSince1970: expiresAt / 1000) }
    var listenLanguage: String { language ?? DictationLanguages.automatic }
    var listenKeyterms: [String] { keyterms ?? [] }
}

/// WHY A DICTATION FAILED, ASKED OF THE MAC (#711).
///
/// THIS PHONE CANNOT LEARN IT ON ITS OWN. A `URLSessionWebSocketTask` that is
/// refused reports a read failure and nothing about the refusal, the same way a
/// browser's `WebSocket` error event carries no reason — so a
/// `400 Bad Request — Keyterm limit exceeded` arrives here as "the connection
/// ended", which is exactly what sent the owner to replace a working key.
///
/// THE MAC HOLDS THE KEY AND CAN ASK. `POST /api/dictation/diagnose` is the one
/// route every surface shares for this question; the phone reaches it through
/// the host proxy like the mint beside it.
///
/// `fault` IS DECODED AS A PLAIN STRING for `provider`'s reason: a Mac that has
/// learned a fifth kind of fault must not fail to decode on a phone that has
/// not been updated. Nothing here switches on it — `reason` is the whole of
/// what this screen shows.
struct DictationDiagnosisAnswer: Decodable, Sendable {
    var fault: String?
    /// One sentence for a person, already written for a reader. Shown instead
    /// of the honest-and-useless one the phone could say by itself.
    var reason: String
}

/// WHO TRANSCRIBES ON THAT MAC, AND WHETHER IT COULD.
///
/// READ BEFORE THE MIC BUTTON IS DRAWN. `provider` defaults to `off` and there
/// is no button until it is something else: iOS dictation works on this
/// composer already, so a mic button that appeared uninvited would be Telar
/// claiming a job the person may have given to the keyboard's own.
///
/// `provider` IS A PLAIN STRING, not an enum, and that is the point: a Mac that
/// has moved on to a provider this build has never heard of must not fail to
/// decode. It should say it does not know that one — which is what
/// `DictationProvider.canDictateHere` is for.
struct DictationAnswer: Decodable, Sendable {
    struct State: Decodable, Sendable {
        var provider: String
        var configured: Bool
        /// Which language that Mac transcribes, or `multi` for all of them at
        /// once (#560). Optional for the same reason `provider` is a plain
        /// string: a Mac on an older build answers without it, and that is a
        /// screen with one fewer row rather than a decode failure.
        var language: String?
        /// What may be chosen, named by that Mac. The phone renders this list
        /// and holds none of its own — seventy language names copied onto a
        /// client are seventy names that go stale the day the provider adds
        /// one, and there would be a second copy on the desktop.
        var languages: [DictationLanguageOption]?
        /// THE PERSON'S OWN WORDS FOR THE RECOGNISER (#581) — a plain list of
        /// terms, kept on that Mac beside the language.
        ///
        /// NOT `keyterm`S, which is Deepgram's name for the wire parameter: the
        /// Mac merges this with what it knows about itself and expresses the
        /// result the provider's way, so the setting outlives the provider it
        /// was typed under.
        ///
        /// OPTIONAL FOR `language`'S REASON — a Mac on a build from before this
        /// existed answers without it, which is a screen with one fewer card
        /// rather than a decode failure.
        var vocabulary: [String]?
    }
    var dictation: State
}

/// One language the Mac offers, with the name to offer it under. NAMED BY THE
/// ENGINE, not translated here — see `DictationAnswer.State.languages`.
struct DictationLanguageOption: Decodable, Sendable, Identifiable, Hashable {
    var code: String
    var label: String

    var id: String { code }
}

enum DictationLanguages {
    /// Code-switching across everything the provider supports, which is the
    /// default and the answer for a Mac that has not said. Not sending a
    /// language at all is what made dictation English-only (#560).
    static let automatic = "multi"

    /// What `multi` is called where there are four characters to say it in.
    static let automaticBadge = "AUTO"

    /// THE LANGUAGE, IN THE TWO OR THREE CHARACTERS A BADGE HAS ROOM FOR (#561).
    ///
    /// The indicator at the caret is the size of the caret, and the person
    /// reading it is the person who chose the setting — what they want at a
    /// glance is which of the two they are dictating under, not the full name
    /// of a language they are in the middle of speaking. So it is the code,
    /// upper-cased, which is what iOS puts in its own dictation badge.
    ///
    /// AND `multi` READS AS "AUTO": the code is the vendor's word and AUTO is
    /// the setting's own ("Automatic" in the picker). "MULTI" would be a third
    /// name for one thing, and the one a reader has never seen on a screen.
    static func badge(_ code: String?) -> String {
        let trimmed = (code ?? "").trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return automaticBadge }
        return trimmed == automatic ? automaticBadge : trimmed.uppercased()
    }
}

enum DictationProvider {
    /// Nobody chose one. The default, and an ordinary state rather than a
    /// misconfiguration.
    static let off = "off"
    /// The only one this phone can actually drive: it opens its own socket with
    /// a minted token and sends 16 kHz PCM. An OpenAI or on-device provider is
    /// a different shape and a later build's job.
    static let deepgram = "deepgram"

    /// Whether a mic button belongs on this screen at all. FALSE FOR A NAME
    /// THIS BUILD DOES NOT KNOW, not just for `off`: a button that opened the
    /// wrong kind of socket and sent the wrong bytes would fail at the
    /// handshake with nothing on screen explaining why.
    static func canDictateHere(_ provider: String) -> Bool {
        provider == deepgram
    }
}
