import AVFoundation
import Foundation

@MainActor @Observable final class Dictation {
    enum Phase: Equatable {
        case idle

        case starting

        case listening
    }

    private(set) var phase: Phase = .idle

    private(set) var error: String?

    private(set) var language: String?

    var onStart: (() -> Void)?

    var onWords: ((DictationWords) -> Void)?

    var onEnd: (() -> Void)?

    private let api: EngineAPI
    private var engine: AVAudioEngine?

    private let claim = AudioSessionClaim()
    private var socket: URLSessionWebSocketTask?
    private var converter: AVAudioConverter?

    private var generation = 0

    init(api: EngineAPI) {
        self.api = api
    }

    private static let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
    )

    func toggle() {
        if phase == .idle {
            Task { await start() }
        } else {
            stop()
        }
    }

    private func start() async {
        let mine = generation
        error = nil
        phase = .starting
        do {
            let minted = try await api.dictationToken()
            guard generation == mine else { return }

            guard DictationProvider.canDictateHere(minted.provider) else {
                throw DictationFailure.audio(
                    "This version of Telar cannot dictate with \(minted.provider). Update the app, or choose another provider in that computer's Dictation settings."
                )
            }
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
            onStart?()
            phase = .listening
            listen()
        } catch {
            guard generation == mine else { return }
            teardownAudio()
            phase = .idle
            self.error = sentence(for: error)
        }
    }

    private func allowedToRecord() async throws -> Bool {
        await withCheckedContinuation { resume in
            AVAudioApplication.requestRecordPermission { granted in resume.resume(returning: granted) }
        }
    }

    private func open(_ minted: DictationTokenAnswer) throws {
        guard let wire = Self.wireFormat else { throw DictationFailure.audio("This device cannot record in the format the service needs.") }

        try claim.take()

        language = minted.listenLanguage
        var request = URLRequest(url: DeepgramListen.url(language: minted.listenLanguage, keyterms: minted.listenKeyterms))

        request.setValue("Bearer \(minted.token)", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.webSocketTask(with: request)
        socket = task
        task.resume()

        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let hardware = input.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0 else { throw DictationFailure.audio("No microphone input is available right now.") }
        converter = AVAudioConverter(from: hardware, to: wire)

        input.installTap(onBus: 0, bufferSize: 4096, format: hardware) { [weak self] buffer, _ in
            guard let bytes = Self.pcm16(from: buffer, using: self?.converter, to: wire) else { return }

            task.send(.data(bytes)) { _ in }
        }
        engine.prepare()
        try engine.start()
    }

    private nonisolated static func pcm16(from buffer: AVAudioPCMBuffer, using converter: AVAudioConverter?, to wire: AVAudioFormat) -> Data? {
        guard let converter else { return nil }
        let ratio = wire.sampleRate / buffer.format.sampleRate

        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: capacity) else { return nil }
        var handed = false
        var failure: NSError?
        converter.convert(to: out, error: &failure) { _, status in

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

    private func listen() {
        guard let task = socket else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message,
                       let frame = DictationFrame.read(text),

                       let words = DictationTranscript.read(frame) {
                        self.onWords?(words)
                    }
                    self.listen()
                case .failure:

                    self.error = Self.socketEnded
                    self.stop()
                    self.diagnose(replacing: Self.socketEnded)
                }
            }
        }
    }

    func stop() {
        generation += 1

        if let task = socket {
            task.send(.string(#"{"type":"CloseStream"}"#)) { _ in }
            task.cancel(with: .goingAway, reason: nil)
        }
        socket = nil
        language = nil
        teardownAudio()

        onEnd?()
        phase = .idle
    }

    private func teardownAudio() {
        if let engine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
            engine.reset()
        }
        engine = nil
        converter = nil

        claim.handBack()
    }

    static let socketEnded = "The connection to the transcription service ended."

    private func diagnose(replacing said: String) {
        Task { @MainActor in
            guard let better = try? await api.dictationDiagnosis(), !better.reason.isEmpty else { return }
            guard self.phase == .idle, self.error == said else { return }
            self.error = better.reason
        }
    }

    private func sentence(for error: Error) -> String {
        if case DictationFailure.audio(let said) = error { return said }
        return error.localizedDescription
    }
}

private enum DictationFailure: Error {
    case audio(String)
}

enum DeepgramListen {
    static func url(language: String, keyterms: [String]) -> URL {
        var components = URLComponents(string: "wss://api.deepgram.com/v1/listen")!
        components.queryItems = [
            URLQueryItem(name: "model", value: "nova-3"),
            URLQueryItem(name: "interim_results", value: "true"),
            URLQueryItem(name: "smart_format", value: "true"),

            URLQueryItem(name: "numerals", value: "true"),
            URLQueryItem(name: "language", value: language),
            URLQueryItem(name: "endpointing", value: "300"),
            URLQueryItem(name: "encoding", value: "linear16"),
            URLQueryItem(name: "sample_rate", value: "16000"),
            URLQueryItem(name: "channels", value: "1"),
        ] + keyterms.map { URLQueryItem(name: "keyterm", value: $0) }
        return components.url!
    }
}
