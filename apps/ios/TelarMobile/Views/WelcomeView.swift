import SwiftUI

/// The front door. An unconfigured app should welcome, not interrogate:
/// one hero, one headline gesture (scan the Mac's pairing code — the whole
/// multi-device story in a single tap), and manual setup as a quiet second
/// path for open cockpits and simulators. ConnectView remains the full
/// configuration surface; this screen only gets you through the door.
struct WelcomeView: View {
    let settings: AppSettings
    @State private var scanning = false
    @State private var pasting = false
    @State private var pastedLink = ""
    @State private var manual = false
    @State private var busy = false
    @State private var error: String?
    /// THE WORDMARK KEEPS ITS 40, AND SCALES ANYWAY. Every other size in this
    /// app maps onto a Dynamic Type style, because a 13 or a 16 is an
    /// approximation of a rung somebody reached for. 40 is not: Apple's ramp
    /// stops at `.largeTitle` (34), so there is no rung to land on, and
    /// mapping it down would shrink the first thing a new reader sees by six
    /// points — a brand change smuggled in under an accessibility sweep.
    ///
    /// `@ScaledMetric(relativeTo:)` is the exception the rest of the sweep
    /// deliberately avoids: it keeps the literal and still grows with the
    /// reader's setting, which is the whole point of #248. It is right HERE
    /// and wrong almost everywhere else — if you are reading this because you
    /// are "finishing the sweep", this site is finished. Do not turn it into
    /// `.largeTitle`.
    @ScaledMetric(relativeTo: .largeTitle) private var wordmark: CGFloat = 40

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // The hero: your Mac and this phone, one pair.
            TelarMark(color: Theme.accent)
                .frame(width: 112, height: 112)
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
                    // Simulator / no camera: the paste path leads.
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
                        .frame(height: 44)
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
            // `-pairingLink <url>` — the automation affordance ConnectView
            // honors, honored here too since this screen is now the root.
            if let seeded = UserDefaults.standard.string(forKey: "pairingLink"), settings.deviceToken == nil {
                await pair(link: seeded)
            }
        }
    }

    /// The same exchange ConnectView runs, minus the form: success configures
    /// the app and the root swaps to the inbox on its own (settings.api).
    private func pair(link: String) async {
        guard let parsed = Pairing.parsePairingURL(link) else {
            error = "That doesn't look like a Telar pairing link."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let token = try await Pairing.exchange(
                base: parsed.base, token: parsed.token,
                deviceName: UIDevice.current.name
            )
            // ADDS a host (or refreshes a known one) — never evicts others.
            settings.upsert(baseURLString: parsed.base.absoluteString, token: token)
            // AND ASKS FOR NOTIFICATION PERMISSION, ONCE (#579) — see
            // `promptAfterPairing`. This is the first pairing on a fresh
            // install, which is the one that used to leave the app absent from
            // iOS's Notifications list entirely.
            await MobileNotifications.shared.promptAfterPairing()
            error = nil
        } catch let apiError as EngineAPIError {
            error = apiError.errorDescription ?? "Pairing failed."
        } catch {
            // Name the address — "couldn't reach 192.168.x" and "couldn't
            // reach 100.x" point at different fixes (Local Network permission
            // / same wifi vs. the Tailscale VPN toggle).
            let where_ = parsed.base.host() ?? "the cockpit"
            self.error = "Couldn't reach \(where_). If that's a local address, check this phone is on the same wifi and Telar may use the local network; if it's a 100.x address, check Tailscale is connected on this phone."
        }
    }
}
