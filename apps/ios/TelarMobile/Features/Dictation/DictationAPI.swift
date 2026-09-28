import Foundation

protocol DictationAPI: Sendable {
    func dictationToken() async throws -> DictationTokenAnswer
    func dictationDiagnosis() async throws -> DictationDiagnosisAnswer
    func dictation() async throws -> DictationAnswer
    func setDictation(provider: String?, apiKey: String?, language: String?, vocabulary: [String]?) async throws -> DictationAnswer
}

extension DictationAPI {
    func dictationToken() async throws -> DictationTokenAnswer {
        throw EngineAPIError.engine(code: "conflict", message: "This Mac cannot dictate.", status: 409)
    }

    func dictationDiagnosis() async throws -> DictationDiagnosisAnswer {
        throw EngineAPIError.engine(code: "conflict", message: "This Mac cannot dictate.", status: 409)
    }

    func dictation() async throws -> DictationAnswer {
        DictationAnswer(
            dictation: DictationAnswer.State(
                provider: DictationProvider.off, configured: false, language: DictationLanguages.automatic, languages: []
            )
        )
    }

    func setDictation(provider: String?, apiKey: String?, language: String?, vocabulary: [String]?) async throws -> DictationAnswer {
        throw EngineAPIError.engine(code: "conflict", message: "This Mac cannot change dictation settings.", status: 409)
    }
}

extension HTTPEngineAPI: DictationAPI {
    func dictationToken() async throws -> DictationTokenAnswer {
        try await post("api/dictation/token", body: [:])
    }

    func dictationDiagnosis() async throws -> DictationDiagnosisAnswer {
        try await post("api/dictation/diagnose", body: [:])
    }

    func dictation() async throws -> DictationAnswer {
        try await get("api/dictation")
    }

    func setDictation(provider: String?, apiKey: String?, language: String?, vocabulary: [String]?) async throws -> DictationAnswer {
        var patch: [String: AnyEncodable] = [:]
        if let provider { patch["provider"] = AnyEncodable(provider) }
        if let apiKey { patch["apiKey"] = AnyEncodable(apiKey) }
        if let language { patch["language"] = AnyEncodable(language) }
        if let vocabulary { patch["vocabulary"] = AnyEncodable(vocabulary) }
        return try await send("PATCH", "api/dictation", body: patch)
    }
}
