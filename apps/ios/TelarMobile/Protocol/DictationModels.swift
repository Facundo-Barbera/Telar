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

/// Whether this Mac can dictate at all, and whose service it would use. Read by
/// nothing on the phone today — the key is pasted on the Mac, and the mic
/// button learns "no key" from the token route's own refusal, which carries the
/// sentence. Declared because the route answers it and a client that decoded
/// half a document would be the surprising half.
struct DictationAnswer: Decodable, Sendable {
    struct State: Decodable, Sendable {
        var provider: String
        var configured: Bool
    }
    var dictation: State
}
