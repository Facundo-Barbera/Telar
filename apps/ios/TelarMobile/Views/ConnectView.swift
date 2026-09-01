import SwiftUI

/// Host + port → base URL, with a probe that validates the WHOLE chain:
/// Next.js up → TELAR_HOME set → engine reachable → worker registered.
/// When the cockpit requires pairing, the probe says so and the pairing-link
/// field (Settings → Remote access → copy the link under the QR) completes
/// the exchange; the device token lands in the Keychain.
///
/// Styled with the SettingsKit card idiom — this screen doubles as the
/// app's front door (the root view before a cockpit is configured), so it
/// wears the same clothes as the rest of the app, not a stock Form.
struct ConnectView: View {
    let settings: AppSettings
    @State private var host = ""
    @State private var port = "3000"
    @State private var pairingLink = ""
    @State private var probing = false
    @State private var probeResult: ProbeResult?
    @State private var scanning = false

    enum ProbeResult: Equatable {
        case ok(daemonId: String, workerRegistered: Bool)
        /// Reachable, but the pairing gate refused us.
        case unpaired
        case failed(String)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 0) {
                    SettingsSectionLabel("Cockpit address")
                    SettingsCard {
                        CardField(label: "Host", placeholder: "Tailscale IP or hostname", text: $host, keyboard: .URL)
                        CardDivider()
                        CardField(label: "Port", placeholder: "3000", text: $port, keyboard: .numberPad)
                    }
                    SettingsFootnote("The Mac must run the cockpit bound to its tailnet address (TELAR_WEB_HOST), and this phone must be on the same tailnet.")
                }

                VStack(spacing: 0) {
                    SettingsSectionLabel("Pairing")
                    SettingsCard {
                        if settings.deviceToken != nil {
                            StatusBanner(
                                icon: "checkmark.seal.fill", color: Theme.statusEmerald,
                                title: "This phone is paired.",
                                detail: "Pasting a new link replaces the credential."
                            )
                            CardDivider()
                        }
                        // Camera scanning needs the Neural Engine — real
                        // hardware. The paste field below is the simulator
                        // (and automation) path.
                        if QRScannerView.isUsable {
                            Button {
                                scanning = true
                            } label: {
                                CardRow(
                                    icon: "qrcode.viewfinder", iconColor: Theme.accent,
                                    title: "Scan pairing code", titleColor: Theme.accent
                                ) { EmptyView() }
                            }
                            .buttonStyle(.plain)
                            .disabled(probing)
                            CardDivider()
                        }
                        CardField(label: "Or paste the pairing link", placeholder: "http://…/pair#token=tlr_…", text: $pairingLink, mono: true, keyboard: .URL)
                        if Pairing.parsePairingURL(pairingLink) != nil {
                            CardDivider()
                            Button {
                                Task { await pair() }
                            } label: {
                                CardRow(icon: "link", iconColor: Theme.accent, title: "Pair", titleColor: Theme.accent) { EmptyView() }
                            }
                            .buttonStyle(.plain)
                            .disabled(probing)
                        }
                        if settings.deviceToken != nil {
                            CardDivider()
                            // The other half of pairing: without this, the
                            // only way to shed a credential was revoking it
                            // from the Mac.
                            Button {
                                settings.deviceToken = nil
                                probeResult = nil
                            } label: {
                                CardRow(icon: "xmark.seal", iconColor: Theme.statusRed, title: "Forget pairing", titleColor: Theme.statusRed) { EmptyView() }
                            }
                            .buttonStyle(.plain)
                            .disabled(probing)
                        }
                    }
                    SettingsFootnote(settings.deviceToken == nil
                        ? "When the cockpit requires pairing: Settings → Remote access → show the code, then copy the link under the QR."
                        : "Forget removes the credential from this phone only — revoke the device on the Mac to kill it everywhere.")
                }

                VStack(spacing: 12) {
                    PrimaryActionButton(
                        title: "Test connection",
                        busy: probing,
                        enabled: !host.trimmingCharacters(in: .whitespaces).isEmpty
                    ) {
                        Task { await probe() }
                    }

                    switch probeResult {
                    case .ok(let daemonId, let workerRegistered):
                        SettingsCard {
                            StatusBanner(
                                icon: "checkmark.circle.fill", color: Theme.statusEmerald,
                                title: "Connected — engine \(daemonId.prefix(14))…",
                                detail: workerRegistered ? nil : "No worker registered: turns will queue but not run."
                            )
                            CardDivider()
                            Button {
                                settings.baseURLString = AppSettings.normalize(host: host, port: port)
                            } label: {
                                CardRow(icon: "arrow.right.circle.fill", iconColor: Theme.accent, title: "Use this cockpit", titleColor: Theme.accent) { EmptyView() }
                            }
                            .buttonStyle(.plain)
                        }
                    case .unpaired:
                        SettingsCard {
                            StatusBanner(
                                icon: "lock.circle", color: Theme.statusAmber,
                                title: "Reachable, but this cockpit requires pairing.",
                                detail: "Scan or paste a pairing link above."
                            )
                        }
                    case .failed(let message):
                        SettingsCard {
                            StatusBanner(icon: "xmark.circle", color: Theme.statusRed, title: message)
                        }
                    case nil:
                        EmptyView()
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(Theme.sheet)
        .navigationTitle("Connect to Telar")
        .sheet(isPresented: $scanning) {
            QRScannerSheet { payload in
                pairingLink = payload
                Task { await pair() }
            }
        }
        .onAppear {
            if let url = settings.baseURL {
                host = url.host() ?? ""
                port = url.port.map(String.init) ?? (url.scheme == "https" ? "443" : "3000")
            }
        }
        .task {
            // `simctl launch … -pairingLink <url>` — the automation affordance,
            // same shape as -openSession: seeds the field and runs the
            // exchange, so the whole pairing path is drivable headlessly.
            // Inert in normal use.
            // Already-paired guard: the seeded link is one-time; re-running it
            // on every appearance would paint an "already used" error on a
            // phone that is in fact paired.
            if pairingLink.isEmpty, settings.deviceToken == nil,
               let seeded = UserDefaults.standard.string(forKey: "pairingLink") {
                pairingLink = seeded
                await pair()
            }
        }
    }

    private func probe() async {
        probing = true
        defer { probing = false }
        let base = AppSettings.normalize(host: host, port: port)
        guard let url = URL(string: base) else {
            probeResult = .failed("That doesn't look like a host.")
            return
        }
        let api = HTTPEngineAPI(baseURL: url, deviceToken: settings.deviceToken)
        do {
            let health = try await api.health()
            probeResult = .ok(daemonId: health.daemonId, workerRegistered: health.worker.registered)
        } catch let error as EngineAPIError {
            if error.isUnauthorized {
                // The gate said no. Reachability is still worth confirming so
                // "wrong network" and "needs pairing" read differently.
                probeResult = (try? await api.ping()) == true
                    ? .unpaired
                    : .failed("No answer. Is this phone on the tailnet?")
                return
            }
            switch error {
            case .engine(let code, _, _) where code == "engine_unavailable":
                probeResult = .failed("Cockpit answered, but the engine on the Mac is down.")
            case .transport:
                probeResult = .failed("No answer. Is the cockpit running and bound to the tailnet IP (TELAR_WEB_HOST)? Is this phone on the tailnet?")
            default:
                probeResult = .failed(error.errorDescription ?? "Failed.")
            }
        } catch {
            probeResult = .failed(error.localizedDescription)
        }
    }

    private func pair() async {
        guard let parsed = Pairing.parsePairingURL(pairingLink) else { return }
        probing = true
        defer { probing = false }
        do {
            let token = try await Pairing.exchange(
                base: parsed.base, token: parsed.token,
                deviceName: UIDevice.current.name
            )
            settings.deviceToken = token
            settings.baseURLString = parsed.base.absoluteString
            pairingLink = ""
            host = parsed.base.host() ?? host
            port = parsed.base.port.map(String.init) ?? (parsed.base.scheme == "https" ? "443" : port)
            await probe()
        } catch let error as EngineAPIError {
            probeResult = .failed(error.errorDescription ?? "Pairing failed.")
        } catch {
            probeResult = .failed("Pairing failed.")
        }
    }
}
