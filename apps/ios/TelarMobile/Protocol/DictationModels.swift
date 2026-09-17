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

    var expiry: Date { Date(timeIntervalSince1970: expiresAt / 1000) }
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
    }
    var dictation: State
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
