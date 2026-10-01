import SwiftUI

struct DictationSettingsView: View {
    let api: any EngineAPI

    @State private var provider = DictationProvider.off
    @State private var configured = false
    @State private var language = DictationLanguages.automatic

    @State private var languages: [DictationLanguageOption] = []

    @State private var vocabulary: [String] = []

    @State private var loading = true
    @State private var keyDraft = ""

    @State private var vocabularyDraft = ""
    @State private var saving = false

    @State private var refusal: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 0) {
                    SettingsSectionLabel("Provider")
                    SettingsCard {
                        CardRow(
                            icon: provider == DictationProvider.off ? "mic.slash" : "waveform",
                            title: "Transcription",
                            subtitle: providerLabel
                        ) {
                            Menu {
                                Button("Off") { save(provider: DictationProvider.off) }
                                Button("Deepgram") { save(provider: DictationProvider.deepgram) }
                            } label: {
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.system(Theme.footnote, weight: .medium))
                                    .foregroundStyle(Theme.chevron)
                            }
                            .disabled(loading || saving)
                        }
                    }
                    SettingsFootnote(providerFootnote)
                        .contextMenu {
                            Button("Copy typing log", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = ComposerLog.shared.exported
                            }
                            Button("Clear typing log", systemImage: "trash") { ComposerLog.shared.clear() }
                        }
                }

                if provider == DictationProvider.deepgram {
                    VStack(spacing: 0) {
                        SettingsSectionLabel("Language")
                        SettingsCard {
                            CardRow(icon: "globe", title: "Transcribe", subtitle: languageLabel) {
                                Menu {
                                    ForEach(languages) { option in
                                        Button(option.label) { save(language: option.code) }
                                    }
                                } label: {
                                    Image(systemName: "chevron.up.chevron.down")
                                        .font(.system(Theme.footnote, weight: .medium))
                                        .foregroundStyle(Theme.chevron)
                                }

                                .disabled(loading || saving || languages.isEmpty)
                            }
                        }
                        SettingsFootnote(languageFootnote)
                    }

                    VStack(spacing: 0) {
                        SettingsSectionLabel("Deepgram")
                        SettingsCard {
                            CardField(
                                label: configured ? "A key is saved on that computer" : "Paste a Deepgram API key",
                                placeholder: configured ? "Replace it" : "Paste a key",
                                text: $keyDraft,
                                mono: true,
                                secure: true
                            )
                            CardDivider()
                            if configured && keyDraft.trimmingCharacters(in: .whitespaces).isEmpty {
                                Button { save(apiKey: "") } label: {
                                    CardRow(icon: "trash", iconColor: Theme.statusRed, title: "Remove the key", titleColor: Theme.statusRed) { EmptyView() }
                                }
                                .buttonStyle(.plain)
                                .disabled(saving)
                            } else {
                                Button { save(apiKey: keyDraft.trimmingCharacters(in: .whitespaces)) } label: {
                                    CardRow(icon: "checkmark", title: "Save the key") { EmptyView() }
                                }
                                .buttonStyle(.plain)
                                .disabled(saving || keyDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                        }
                        SettingsFootnote(
                            "The key stays on that computer and is never shown again. Each dictation spends it once for a token that expires in five minutes, and that token is what this phone gets — the audio goes straight to Deepgram and never passes through the computer."
                        )
                    }

                    VStack(spacing: 0) {
                        SettingsSectionLabel("Vocabulary")
                        SettingsCard {
                            CardField(
                                label: "One term per line",
                                placeholder: "Kubernetes\nZarigüeya",
                                text: $vocabularyDraft,
                                multiline: true
                            )
                            CardDivider()
                            Button { save(vocabulary: vocabularyTerms) } label: {
                                CardRow(icon: "checkmark", title: "Save the vocabulary") { EmptyView() }
                            }
                            .buttonStyle(.plain)

                            .disabled(saving || vocabularyTerms == vocabulary)
                        }
                        SettingsFootnote(
                            "Words the recogniser has no reason to expect — a product name, a colleague’s surname, a piece of jargon. Your conversations, your projects and their branches are already sent; this is for the rest."
                        )
                    }

                    VStack(spacing: 0) {
                        SettingsCard {
                            CardRow(icon: "mic", title: "How it works", subtitle: nil) { EmptyView() }
                        }
                        SettingsFootnote(
                            "Tap the mic on the message box to start and tap again to stop — a toggle, not a hold, so it works with the keyboard up. Words appear in the box as they are heard and are rewritten in place until they settle. Nothing sends on its own."
                        )
                    }
                }

                if let refusal {
                    SettingsCard {
                        StatusBanner(icon: "exclamationmark.triangle", color: Theme.statusRed, title: "That change was refused", detail: refusal)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(Theme.sheet)
        .navigationTitle("Dictation")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var providerLabel: String {
        switch provider {
        case DictationProvider.deepgram: "Deepgram"
        case DictationProvider.off: "Off"

        default: provider
        }
    }

    private var languageLabel: String {
        languages.first { $0.code == language }?.label ?? language
    }

    private var languageFootnote: String {
        language == DictationLanguages.automatic
            ? "Words are transcribed in whichever supported language they are spoken in, including switching between two of them inside one sentence. Narrow it only if you speak one language and want the accuracy of saying so."
            : "Only this language is transcribed. More accurate than Automatic within it, and wrong for anything else — a sentence in another language comes back as whatever this one sounded closest to."
    }

    private var vocabularyTerms: [String] {
        vocabularyDraft
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private var providerFootnote: String {
        switch provider {
        case DictationProvider.deepgram:
            "A mic button on every message box, here and on that computer."
        case DictationProvider.off:
            "No mic button anywhere. This phone’s own keyboard dictation keeps working in the message box exactly as it does now — Telar simply does not add one of its own."
        default:
            "Chosen on that computer, and not one this version of Telar knows how to use. Update the app, or pick another here."
        }
    }

    private func load() async {
        if let answer = try? await api.dictation() {
            adopt(answer)
        }
        loading = false
    }

    private func save(
        provider newProvider: String? = nil,
        apiKey: String? = nil,
        language newLanguage: String? = nil,
        vocabulary newVocabulary: [String]? = nil
    ) {
        saving = true
        refusal = nil
        Task {
            do {
                let answer = try await api.setDictation(
                    provider: newProvider, apiKey: apiKey, language: newLanguage, vocabulary: newVocabulary
                )
                adopt(answer)
                if apiKey != nil { keyDraft = "" }
            } catch {
                refusal = error.localizedDescription
            }
            saving = false
        }
    }

    private func adopt(_ answer: DictationAnswer) {
        provider = answer.dictation.provider
        configured = answer.dictation.configured
        language = answer.dictation.language ?? DictationLanguages.automatic
        languages = answer.dictation.languages ?? []
        vocabulary = answer.dictation.vocabulary ?? []

        vocabularyDraft = vocabulary.joined(separator: "\n")
    }
}
