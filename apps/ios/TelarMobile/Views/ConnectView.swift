import SwiftUI

/// Host + port → base URL, with a probe that validates the WHOLE chain:
/// Next.js up → TELAR_HOME set → engine reachable → worker registered.
struct ConnectView: View {
    let settings: AppSettings
    @State private var host = ""
    @State private var port = "3000"
    @State private var probing = false
    @State private var probeResult: ProbeResult?

    enum ProbeResult: Equatable {
        case ok(daemonId: String, workerRegistered: Bool)
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
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                            }
                        }
                    } icon: {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    }
                    Button("Use this cockpit") {
                        settings.baseURLString = AppSettings.normalize(host: host, port: port)
                    }
                    .buttonStyle(.borderedProminent)
                case .failed(let message):
                    Label(message, systemImage: "xmark.circle")
                        .foregroundStyle(.red)
                        .font(.caption)
                case nil:
                    EmptyView()
                }
            }
        }
        .navigationTitle("Connect to Telar")
        .onAppear {
            if let url = settings.baseURL {
                host = url.host() ?? ""
                port = url.port.map(String.init) ?? "3000"
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
        do {
            let health = try await HTTPEngineAPI(baseURL: url).health()
            probeResult = .ok(daemonId: health.daemonId, workerRegistered: health.worker.registered)
        } catch let error as EngineAPIError {
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
}
