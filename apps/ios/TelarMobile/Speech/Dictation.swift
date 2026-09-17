import AVFoundation
import Foundation

/// PUSH-TO-TALK ON THE PHONE (#544).
///
/// ── THE SHAPE, WHICH IS THE WEB'S ───────────────────────────────────────────
/// Tap the mic: ask the paired Mac for a token that dies in five minutes, ask
/// iOS for the microphone, open a socket straight to the transcription service
/// with that token, and push 16 kHz mono PCM up it. Finalised phrases are
/// merged into the composer's draft. Tap again and everything unwinds.
///
/// THE AUDIO NEVER TOUCHES THE MAC, which is the whole reason the route is a
/// token route: a phone on a tailnet relaying every frame through a Mac that
/// has no reason to see them would add a hop to a real-time stream for nothing.
///
/// ── WHY LINEAR16 HERE AND A CONTAINER ON THE WEB ────────────────────────────
/// The browser has `MediaRecorder`, which hands over WebM/Opus and lets the
/// service read the container's own header. `AVAudioEngine` hands over raw PCM
/// buffers at whatever the hardware runs at — 48 kHz float on every recent
/// iPhone — so this end has to say what it is sending, and has to convert. 16
/// kHz mono `linear16` is what the streaming API wants and is a quarter the
/// bytes of the hardware format, which matters on a phone's uplink.
///
/// `AVAudioConverter` DOES THE RESAMPLE, not a hand-rolled decimation: the tap
/// delivers a hardware-rate buffer and the conversion is a rate change plus a
/// format change plus a channel fold, which is three places to be subtly wrong
/// and produce audio that transcribes as nothing.
///
/// ── THE HEADER IS AVAILABLE HERE, SO IT IS USED ─────────────────────────────
/// The browser cannot send a header on a websocket at all, which is why the web
/// client puts the token in the query. `URLSessionWebSocketTask` takes a
/// `URLRequest`, so the phone sends `Authorization: Bearer <jwt>` — the scheme
/// the service's own guide documents for a grant JWT, and the one that keeps
/// the credential out of a URL.
///
/// ── TOGGLE, AND LOUD ABOUT IT ───────────────────────────────────────────────
/// Hold-to-talk on a phone means holding a finger on the screen while the
/// keyboard is up, over the thing you are dictating about. So it is a toggle,
/// and the failure mode of a toggle is a recording somebody forgot: `phase` is
/// what the button draws in red, and `heard` is printed under the composer.
@MainActor @Observable final class Dictation {
    enum Phase: Equatable {
        /// Nothing running, microphone released.
        case idle
        /// Minting a token and asking for the microphone.
        case starting
        /// The socket is open and audio is going up.
        case listening
    }

    private(set) var phase: Phase = .idle
    /// The current guess at what is still being said. SHOWN, never merged —
    /// see `DictationTranscript`.
    private(set) var heard = ""
    /// Why it stopped, or would not start. A sentence: the only move a button
    /// has is to show it to a person.
    private(set) var error: String?

    /// Where a finalised phrase goes. Set by the composer that owns this.
    var onCommit: ((String) -> Void)?

    private let api: EngineAPI
    private let engine = AVAudioEngine()
    private var socket: URLSessionWebSocketTask?
    private var converter: AVAudioConverter?
    /// WHICH DICTATION THIS IS. Starting is asynchronous — a token round trip,
    /// a permission prompt — and stopping is not, so a second tap lands in the
    /// middle of the first tap's `await`. Every stop moves this on; a start
    /// whose generation is stale drops what it built instead of adopting it.
    private var generation = 0

    init(api: EngineAPI) {
        self.api = api
    }

    /// What the service wants, and what everything below converts to.
    private static let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
    )

    func toggle() {
        // Stopping is synchronous and starting is not, so a tap during
        // `starting` still stops — the fence above is what makes that true.
        if phase == .idle {
            Task { await start() }
        } else {
            stop()
        }
    }

    // MARK: starting

    private func start() async {
        let mine = generation
        error = nil
        phase = .starting
        do {
            // THE TOKEN FIRST, because it is the step that fails for a reason
            // the person can fix — no key on that Mac, the service refusing.
            // Asking for the microphone first would raise a permission prompt
            // on a Mac that cannot dictate at all, which is a prompt with
            // nothing behind it.
            let minted = try await api.dictationToken()
            guard generation == mine else { return }
            guard try await allowedToRecord() else {
                phase = .idle
                error = "Telar does not have permission to use the microphone. Allow it in Settings and tap again."
                return
            }
            guard generation == mine else { return }
            try open(minted)
            guard generation == mine else {
                stop()
                return
            }
            phase = .listening
            listen()
        } catch {
            // A FAILURE NOBODY IS WAITING FOR IS NOT WORTH A SENTENCE: the
            // person tapped stop, and a message about the start they cancelled
            // would be the app arguing with them.
            guard generation == mine else { return }
            teardownAudio()
            phase = .idle
            self.error = sentence(for: error)
        }
    }

    /// iOS's own permission, asked once and remembered by the system. Wrapped
    /// because the callback API predates concurrency and every caller here is
    /// already in an `async` function.
    private func allowedToRecord() async throws -> Bool {
        await withCheckedContinuation { resume in
            AVAudioApplication.requestRecordPermission { granted in resume.resume(returning: granted) }
        }
    }

    private func open(_ minted: DictationTokenAnswer) throws {
        guard let wire = Self.wireFormat else { throw DictationFailure.audio("This device cannot record in the format the service needs.") }

        // A CATEGORY IS CLAIMED HERE, unlike `Talkback`, and it has to be:
        // `AVAudioEngine`'s input node is silent — not an error, SILENT — under
        // the default `.soloAmbient` category, and a dictation that records
        // nothing and reports nothing is the worst outcome this file has.
        // `.duckOthers` rather than interrupting, so a podcast dips for the
        // length of a sentence instead of stopping.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
        try session.setActive(true, options: [])

        var request = URLRequest(url: DeepgramListen.url())
        // THE HEADER, WHICH THE BROWSER CANNOT SEND. `Bearer` is the JWT's own
        // scheme; `Token` is for a long-lived API key and is refused for a
        // grant token.
        request.setValue("Bearer \(minted.token)", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.webSocketTask(with: request)
        socket = task
        task.resume()

        let input = engine.inputNode
        let hardware = input.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0 else { throw DictationFailure.audio("No microphone input is available right now.") }
        converter = AVAudioConverter(from: hardware, to: wire)

        // 4096 FRAMES is about 85 ms at 48 kHz — short enough that the first
        // interim word appears while it is still being said, long enough that
        // the socket is not being written to on every render of the waveform.
        input.installTap(onBus: 0, bufferSize: 4096, format: hardware) { [weak self] buffer, _ in
            guard let bytes = Self.pcm16(from: buffer, using: self?.converter, to: wire) else { return }
            // OFF THE AUDIO THREAD BEFORE ANYTHING ELSE. This closure runs on a
            // real-time thread; doing anything that can block on it is how an
            // audio glitch becomes a dropped word.
            task.send(.data(bytes)) { _ in }
        }
        engine.prepare()
        try engine.start()
    }

    /// Resample and narrow one tap buffer to 16 kHz mono `linear16`.
    ///
    /// `nonisolated` AND STATIC because it is called from the audio thread and
    /// touches nothing but its arguments — an instance method here would be a
    /// main-actor hop per buffer, eighty times a second.
    private nonisolated static func pcm16(from buffer: AVAudioPCMBuffer, using converter: AVAudioConverter?, to wire: AVAudioFormat) -> Data? {
        guard let converter else { return nil }
        let ratio = wire.sampleRate / buffer.format.sampleRate
        // +1 FRAME OF HEADROOM: the ratio rarely divides evenly, and a capacity
        // one frame short makes the converter fail rather than truncate.
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: capacity) else { return nil }
        var handed = false
        var failure: NSError?
        converter.convert(to: out, error: &failure) { _, status in
            // ONE BUFFER, ONCE. Answering the same input twice makes the
            // converter loop; `.noDataNow` is how a tap-driven feed says "that
            // is all there is until the next callback".
            if handed {
                status.pointee = .noDataNow
                return nil
            }
            handed = true
            status.pointee = .haveData
            return buffer
        }
        guard failure == nil, out.frameLength > 0, let channel = out.int16ChannelData else { return nil }
        return Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }

    // MARK: hearing

    /// One read at a time, re-armed after each — `URLSessionWebSocketTask`'s
    /// own shape. A read that fails is the socket ending, which is either the
    /// stop below (already idle, nothing to say) or a drop worth a sentence.
    private func listen() {
        guard let task = socket else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message, let frame = DictationFrame.read(text) {
                        let step = DictationTranscript.step(frame)
                        self.heard = step.interim
                        // ONE COMMIT PER FINAL, and the reducer hands back only
                        // what THIS frame finalised.
                        if !step.commit.isEmpty { self.onCommit?(step.commit) }
                    }
                    self.listen()
                case .failure:
                    self.error = "The connection to the transcription service ended."
                    self.stop()
                }
            }
        }
    }

    // MARK: stopping

    /// EVERY PATH OUT COMES THROUGH HERE, including the ones that failed before
    /// anything opened. Releasing the microphone is the step that must not be
    /// conditional: a phone holding a live input after the button says idle
    /// keeps the system's orange recording dot lit.
    func stop() {
        generation += 1
        // FLUSH BEFORE CLOSING. The service holds the tail of an utterance
        // until it hears silence or this, and that tail is the words just
        // spoken.
        if let task = socket {
            task.send(.string(#"{"type":"CloseStream"}"#)) { _ in }
            task.cancel(with: .goingAway, reason: nil)
        }
        socket = nil
        teardownAudio()
        heard = ""
        phase = .idle
    }

    private func teardownAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        converter = nil
        // HANDED BACK, so whatever was ducked comes up again and the next app
        // to want the microphone is not fighting a session nobody is using.
        // `.notifyOthersOnDeactivation` is what actually un-ducks them.
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// The Mac's own words where there are some — "no key is configured" names
    /// the pane to fix it on, which nothing here could have worked out.
    /// `EngineAPIError` is a `LocalizedError` whose `errorDescription` already
    /// passes an unrecognised code's message through, so a 409 about a missing
    /// key arrives as its sentence rather than as a status.
    private func sentence(for error: Error) -> String {
        if case DictationFailure.audio(let said) = error { return said }
        return error.localizedDescription
    }
}

private enum DictationFailure: Error {
    case audio(String)
}

/// The socket's address. Its own type rather than a string in `open` so the
/// query is readable, and so the web client's equivalent
/// (`apps/web/lib/dictation/deepgram.ts`) has something to be kept in step
/// with.
enum DeepgramListen {
    /// `nova-3` is what the headset already dictates with, so the same words
    /// come out on every surface. `encoding` and `sample_rate` ARE declared
    /// here, unlike the web's, because this end sends raw PCM with no container
    /// header for the service to read.
    static func url() -> URL {
        var components = URLComponents(string: "wss://api.deepgram.com/v1/listen")!
        components.queryItems = [
            URLQueryItem(name: "model", value: "nova-3"),
            URLQueryItem(name: "interim_results", value: "true"),
            URLQueryItem(name: "smart_format", value: "true"),
            URLQueryItem(name: "endpointing", value: "300"),
            URLQueryItem(name: "encoding", value: "linear16"),
            URLQueryItem(name: "sample_rate", value: "16000"),
            URLQueryItem(name: "channels", value: "1"),
        ]
        return components.url!
    }
}
