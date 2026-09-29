import SwiftUI

struct WelcomeView: View {
    let settings: AppSettings
    @State private var scanning = false
    @State private var pasting = false
    @State private var pastedLink = ""
    @State private var manual = false
    @State private var busy = false
    @State private var error: String?

    @ScaledMetric(relativeTo: .largeTitle) private var wordmark: CGFloat = 40

    @ScaledMetric(relativeTo: .largeTitle) private var mark: CGFloat = 112

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            TelarLogo(size: mark)
                .padding(.bottom, 28)

            Text("Telar")
                .font(.system(size: wordmark, weight: .bold))
                .foregroundStyle(Theme.text)
                .padding(.bottom, 10)

            Text("Your work, within reach.")
                .font(.system(.body))
                .foregroundStyle(Theme.textMuted)
                .multilineTextAlignment(.center)
                .padding(.bottom, 6)

            Text("Follow your agents. Review their work.\nPick up the conversation anywhere.")
                .font(.system(Theme.footnote))
                .foregroundStyle(Theme.textMuted)
                .multilineTextAlignment(.center)

            Spacer()

            if busy {
                ProgressView()
                    .padding(.bottom, 24)
            }

            if let error {
                SettingsCard {
                    StatusBanner(icon: "xmark.circle", color: Theme.statusRed, title: error)
                }
                .padding(.bottom, 16)
            }

            VStack(spacing: 12) {
                if QRScannerView.isUsable {
                    PrimaryActionButton(title: "Scan pairing code", busy: busy) {
                        scanning = true
                    }
                } else {
                    PrimaryActionButton(title: "Paste pairing link", busy: busy) {
                        pastedLink = ""
                        pasting = true
                    }
                }
                Button {
                    manual = true
                } label: {
                    Text("Connect manually")
                        .font(.system(Theme.subhead, weight: .medium))
                        .foregroundStyle(Theme.textMuted)
                        .frame(maxWidth: .infinity)
                        .scaledHeight(44, relativeTo: .subheadline)
                }
            }

            Text("The code lives on the Mac: Settings → Remote access.")
                .font(.system(Theme.footnote))
                .foregroundStyle(Theme.textMuted)
                .padding(.top, 8)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: 520)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.sheet)
        .sheet(isPresented: $scanning) {
            QRScannerSheet { payload in
                Task { await pair(link: payload) }
            }
        }
        .alert("Paste the pairing link", isPresented: $pasting) {
            TextField("http://…/pair#token=…", text: $pastedLink)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            Button("Pair") {
                let link = pastedLink
                Task { await pair(link: link) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Copy it from under the QR in the Mac's Remote access panel.")
        }
        .navigationDestination(isPresented: $manual) {
            ConnectView(settings: settings)
        }
        .task {
            if let seeded = UserDefaults.standard.string(forKey: "pairingLink"), settings.deviceToken == nil {
                await pair(link: seeded)
            }
        }
    }

    private func pair(link: String) async {
        guard let parsed = Pairing.parsePairingURL(link) else {
            error = "That doesn't look like a Telar pairing link."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let paired = try await Pairing.exchange(
                base: parsed.base, token: parsed.token,
                deviceName: UIDevice.current.name
            )

            settings.upsert(baseURLString: parsed.base.absoluteString, token: paired.deviceToken, addresses: paired.addresses ?? [])

            await MobileNotifications.shared.promptAfterPairing()
            error = nil
        } catch let apiError as EngineAPIError {
            error = apiError.errorDescription ?? "Pairing failed."
        } catch {
            let where_ = parsed.base.host() ?? "the cockpit"
            self.error = "Couldn't reach \(where_). If that's a local address, check this phone is on the same wifi and Telar may use the local network; if it's a 100.x address, check Tailscale is connected on this phone."
        }
    }
}
