import SwiftUI

/// Host + port → base URL, with a probe that validates the WHOLE chain:
/// Next.js up → TELAR_HOME set → engine reachable → worker registered.
/// When the cockpit requires pairing, the probe says so and the pairing-link
/// field (Settings → Remote access → copy the link under the QR) completes
/// the exchange; the device token lands in the Keychain.
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
        Form {
            Section {
                TextField("Tailscale IP or hostname", text: $host)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                TextField("Port", text: $port)
                    .keyboardType(.numberPad)
            } header: {
                Text("Cockpit address")
            } footer: {
                Text("The Mac must run the cockpit bound to its tailnet address (TELAR_WEB_HOST), and this phone must be on the same tailnet.")
            }

            Section {
                // Camera scanning needs the Neural Engine — real hardware.
                // The paste field below is the simulator (and automation) path.
                if QRScannerView.isUsable {
                    Button {
                        scanning = true
                    } label: {
                        Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                    }
                    .disabled(probing)
                }
                TextField("Paste the pairing link", text: $pairingLink)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .font(Theme.mono)
                Button("Pair") {
                    Task { await pair() }
                }
                .disabled(Pairing.parsePairingURL(pairingLink) == nil || probing)
                if settings.deviceToken != nil {
                    // The other half of pairing: without this, the only way
                    // to shed a credential was revoking it from the Mac.
                    Button("Forget pairing", role: .destructive) {
                        settings.deviceToken = nil
                        probeResult = nil
                    }
                    .disabled(probing)
                }
            } header: {
                Text("Pairing")
            } footer: {
                Text(settings.deviceToken == nil
                     ? "When the cockpit requires pairing: Settings → Remote access → show the code, then copy the link under the QR."
                     : "This phone is paired. Pasting a new link replaces the credential; Forget removes it from this phone (revoke it on the Mac to kill it everywhere).")
            }

            Section {
                Button {
                    Task { await probe() }
                } label: {
                    if probing {
                        ProgressView()
                    } else {
                        Text("Test connection")
                    }
                }
                .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty || probing)

                switch probeResult {
                case .ok(let daemonId, let workerRegistered):
                    Label {
                        VStack(alignment: .leading) {
                            Text("Connected — engine \(daemonId.prefix(14))…")
                            if !workerRegistered {
                                Text("No worker registered: turns will queue but not run.")
                                    .font(Theme.metaSmall)
                                    .foregroundStyle(Theme.statusAmber)
                            }
                        }
                    } icon: {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.statusEmerald)
                    }
                    Button("Use this cockpit") {
                        settings.baseURLString = AppSettings.normalize(host: host, port: port)
                    }
                    .buttonStyle(.borderedProminent)
                case .unpaired:
                    Label {
                        Text("Reachable, but this cockpit requires pairing. Paste a pairing link above.")
                    } icon: {
                        Image(systemName: "lock.circle").foregroundStyle(Theme.statusAmber)
                    }
                    .font(Theme.meta)
                case .failed(let message):
                    Label(message, systemImage: "xmark.circle")
                        .foregroundStyle(Theme.statusRed)
                        .font(Theme.meta)
                case nil:
                    EmptyView()
                }
            }
        }
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
            if pairingLink.isEmpty, let seeded = UserDefaults.standard.string(forKey: "pairingLink") {
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
