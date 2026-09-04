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
    /// Which Mac this screen configures: a NEW one (fields empty, pairing
    /// adds a host) or an EXISTING one (fields seeded, forget scoped to it).
    enum Target: Hashable {
        case new
        case existing(HostID)
    }

    let settings: AppSettings
    var target: Target = .new
    @State private var host = ""
    @State private var port = "3000"
    @State private var pairingLink = ""
    @State private var probing = false
    @State private var probeResult: ProbeResult?
    @State private var scanning = false

    private var targetHost: Host? {
        if case .existing(let id) = target { return settings.host(id) }
        return nil
    }

    private var targetToken: String? {
        targetHost.flatMap { settings.token(for: $0.id) }
    }

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
                        if targetToken != nil {
                            StatusBanner(
                                icon: "checkmark.seal.fill", color: Theme.statusEmerald,
                                title: "This phone is paired with \(targetHost?.name ?? "this Mac").",
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
                        CardField(label: "Or paste the pairing link", placeholder: "http://…/pair#token=…", text: $pairingLink, mono: true, keyboard: .URL)
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
                        if let hostRecord = targetHost, targetToken != nil {
                            CardDivider()
                            // The other half of pairing: without this, the
                            // only way to shed a credential was revoking it
                            // from the Mac. Scoped to THIS Mac only.
                            Button {
                                settings.setToken(nil, for: hostRecord.id)
                                probeResult = nil
                            } label: {
                                CardRow(icon: "xmark.seal", iconColor: Theme.statusRed, title: "Forget pairing", titleColor: Theme.statusRed) { EmptyView() }
                            }
                            .buttonStyle(.plain)
                            .disabled(probing)
                        }
                    }
                    SettingsFootnote(targetToken == nil
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
                                // ADDS (or updates) a host — open cockpits
                                // need no credential.
                                settings.upsert(baseURLString: AppSettings.normalize(host: host, port: port), token: nil)
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
            // Seed the fields from the TARGET Mac; a .new screen starts blank.
            if let url = targetHost?.baseURL {
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
            if pairingLink.isEmpty, settings.hosts.isEmpty,
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
        let api = HTTPEngineAPI(baseURL: url, deviceToken: targetToken)
        do {
            let health = try await api.health()
            probeResult = .ok(daemonId: health.daemonId, workerRegistered: health.worker.registered)
        } catch let error as EngineAPIError {
            if error.isUnauthorized {
                // The gate said no. Reachability is still worth confirming so
                // "wrong network" and "needs pairing" read differently.
                probeResult = (try? await api.ping())?.ok == true
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
            // ADDS a host (or refreshes a known one) — never evicts others.
            settings.upsert(baseURLString: parsed.base.absoluteString, token: token)
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
