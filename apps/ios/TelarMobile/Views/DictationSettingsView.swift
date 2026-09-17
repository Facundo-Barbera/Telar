import SwiftUI

/// ONE MAC'S DICTATION SETTINGS, FROM THE PHONE (#544).
///
/// ── WHY THIS SCREEN IS HERE AT ALL ──────────────────────────────────────────
/// The setting belongs to the MACHINE, not to the phone: the key is spent
/// there, and the mic button on this composer only exists because that Mac said
/// it could. So it lives under that Mac's panel beside Connection and Devices,
/// which is where every other fact about a cockpit is answered — and it is the
/// same set of rows the desktop draws on its own Dictation pane, in the same
/// order, because two screens that describe one setting differently is two
/// bugs waiting.
///
/// ── OFF IS THE FIRST ROW AND THE DEFAULT ────────────────────────────────────
/// iOS's own keyboard dictation already works in the composer, and so does
/// anything else somebody has set up. A mic button that appeared uninvited
/// would be Telar claiming a job that may already be done. With `off` there is
/// no key row here and no mic button on any composer, on this phone or on that
/// Mac.
///
/// ── THE KEY FIELD NEVER SHOWS A STORED KEY ──────────────────────────────────
/// It shows WHETHER one is there. The engine answers `configured` and nothing
/// else by design, so there is no stored value to put in the field — typing a
/// new one replaces it, and Remove clears it. `SecureField` keeps it off the
/// screen on the way in.
///
/// ── AND WHICH LANGUAGE, WHICH IS A ROW BECAUSE IT WAS A BUG (#560) ──────────
/// Nothing sent a language on the socket and the service defaults to English,
/// so dictating in Spanish on this phone produced English-shaped nonsense —
/// which is worse than a refusal, because it looks like it worked. The row
/// answers Automatic by default: code-switching between supported languages
/// inside one sentence. Naming one is the NARROWING, offered for the accuracy
/// it buys in a single tongue.
///
/// THE NAMES COME FROM THE MAC. Seventy of them, per provider — a copy in this
/// app would be the list that is wrong the day the provider adds one, and there
/// is already one on the desktop.
///
/// ── SAVE PER INTERACTION, AND THE MAC'S ANSWER IS THE STATE ─────────────────
/// The same two rules the desktop's panes follow. A refused write leaves the
/// controls showing what is actually stored and says why underneath, rather
/// than keeping an optimistic value nobody's engine agrees with.
struct DictationSettingsView: View {
    let api: any EngineAPI

    @State private var provider = DictationProvider.off
    @State private var configured = false
    @State private var language = DictationLanguages.automatic
    /// What that Mac offers. EMPTY UNTIL IT HAS ANSWERED, and empty is what
    /// keeps the row from being a menu with nothing in it.
    @State private var languages: [DictationLanguageOption] = []
    /// True until that Mac has answered once. The controls stay inert rather
    /// than offering a choice that might be wrong.
    @State private var loading = true
    @State private var keyDraft = ""
    @State private var saving = false
    /// Why the last write did not land, in that Mac's own words.
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
                            // A MENU RATHER THAN A PICKER WHEEL: two choices,
                            // and the row already reads as a value with a
                            // chevron everywhere else on this screen.
                            Menu {
                                Button("Off") { save(provider: DictationProvider.off) }
                                Button("Deepgram") { save(provider: DictationProvider.deepgram) }
                            } label: {
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(Theme.chevron)
                            }
                            .disabled(loading || saving)
                        }
                    }
                    SettingsFootnote(providerFootnote)
                }

                // THE PROVIDER'S OWN ROWS, and only when there is a provider. A
                // key field under "Off" asks for a credential nothing will
                // spend. Switching off keeps the key — it is the row that goes
                // away, not the secret.
                if provider == DictationProvider.deepgram {
                    VStack(spacing: 0) {
                        SettingsSectionLabel("Language")
                        SettingsCard {
                            CardRow(icon: "globe", title: "Transcribe", subtitle: languageLabel) {
                                // A MENU, like the provider row above it, and
                                // for the same reason — but this one is long,
                                // so it is the system's own scrolling menu
                                // rather than seventy rows on this screen.
                                // AUTOMATIC IS FIRST because the Mac puts it
                                // first; nothing here hoists a code by name.
                                Menu {
                                    ForEach(languages) { option in
                                        Button(option.label) { save(language: option.code) }
                                    }
                                } label: {
                                    Image(systemName: "chevron.up.chevron.down")
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(Theme.chevron)
                                }
                                // NO OPTIONS MEANS THAT MAC HAS NOT ANSWERED,
                                // or is on a build from before this field — an
                                // empty menu would be a control that does
                                // nothing when tapped.
                                .disabled(loading || saving || languages.isEmpty)
                            }
                        }
                        SettingsFootnote(languageFootnote)
                    }

                    VStack(spacing: 0) {
                        SettingsSectionLabel("Deepgram")
                        SettingsCard {
                            CardField(
                                label: configured ? "A key is saved on that Mac" : "Paste a Deepgram API key",
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
                            "The key stays on that Mac and is never shown again. Each dictation spends it once for a token that expires in five minutes, and that token is what this phone gets — the audio goes straight to Deepgram and never passes through the Mac."
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
        // A provider chosen on a Mac running a newer build. Named rather than
        // hidden: "Off" would be a lie, and the person can see what it is even
        // though this phone cannot drive it.
        default: provider
        }
    }

    /// The Mac's own name for what is stored. FALLING BACK TO THE CODE rather
    /// than to "Automatic": a language this build's list does not contain is
    /// still the one being transcribed, and showing the wrong name would be a
    /// screen quietly disagreeing with the socket.
    private var languageLabel: String {
        languages.first { $0.code == language }?.label ?? language
    }

    private var languageFootnote: String {
        language == DictationLanguages.automatic
            ? "Words are transcribed in whichever supported language they are spoken in, including switching between two of them inside one sentence. Narrow it only if you speak one language and want the accuracy of saying so."
            : "Only this language is transcribed. More accurate than Automatic within it, and wrong for anything else — a sentence in another language comes back as whatever this one sounded closest to."
    }

    private var providerFootnote: String {
        switch provider {
        case DictationProvider.deepgram:
            "A mic button on every message box, here and on that Mac."
        case DictationProvider.off:
            "No mic button anywhere. This phone’s own keyboard dictation keeps working in the message box exactly as it does now — Telar simply does not add one of its own."
        default:
            "Chosen on that Mac, and not one this version of Telar knows how to use. Update the app, or pick another here."
        }
    }

    private func load() async {
        // UNREACHABLE READS AS OFF rather than as an error: a Mac that is
        // asleep has no dictation to offer either way, and a banner about a
        // setting nobody was editing would be noise.
        if let answer = try? await api.dictation() {
            adopt(answer)
        }
        loading = false
    }

    /// One write, one field. THE MAC'S ANSWER IS WHAT THE SCREEN THEN SHOWS —
    /// never the value that was sent, so a refused change leaves the controls
    /// on what is actually stored.
    private func save(provider newProvider: String? = nil, apiKey: String? = nil, language newLanguage: String? = nil) {
        saving = true
        refusal = nil
        Task {
            do {
                let answer = try await api.setDictation(provider: newProvider, apiKey: apiKey, language: newLanguage)
                adopt(answer)
                if apiKey != nil { keyDraft = "" }
            } catch {
                refusal = error.localizedDescription
            }
            saving = false
        }
    }

    /// The whole answer in one place, so a read and a write cannot drift into
    /// adopting different subsets of it. A Mac on a build from before #560
    /// sends neither language field; the defaults already here are the right
    /// answer for it, so `??` keeps them rather than blanking the row.
    private func adopt(_ answer: DictationAnswer) {
        provider = answer.dictation.provider
        configured = answer.dictation.configured
        language = answer.dictation.language ?? DictationLanguages.automatic
        languages = answer.dictation.languages ?? []
    }
}
