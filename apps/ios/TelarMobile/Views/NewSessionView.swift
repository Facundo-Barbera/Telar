import SwiftUI

/// Start a conversation from the phone: pick a project, optionally a title,
/// the driver and the workspace mode — the same knobs the cockpit's new-
/// session flow exposes. The engine validates driver/envMode against its own
/// lists, so this form only offers what it knows.
struct NewSessionView: View {
    let api: any EngineAPI
    /// Called with the created session's id — the caller navigates into it.
    let onCreated: (EngineID) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var projects: [ProjectRef] = []
    @State private var projectId: EngineID?
    @State private var title = ""
    @State private var driver = "claude"
    @State private var envMode = "worktree"
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        Form {
            Section("Project") {
                if projects.isEmpty {
                    Text("Loading projects…")
                        .font(Theme.meta)
                        .foregroundStyle(Theme.textMuted)
                } else {
                    Picker("Project", selection: $projectId) {
                        ForEach(projects) { project in
                            Text(project.name).tag(EngineID?.some(project.id))
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
            }

            Section {
                TextField("Title (optional)", text: $title)
                Picker("Driver", selection: $driver) {
                    Text("Claude").tag("claude")
                    Text("Codex").tag("codex")
                }
                .pickerStyle(.segmented)
                Picker("Workspace", selection: $envMode) {
                    Text("Worktree").tag("worktree")
                    Text("Project folder").tag("local")
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Session")
            } footer: {
                Text(envMode == "worktree"
                     ? "An isolated git worktree — safe to run beside other sessions."
                     : "Works directly in the project folder.")
            }

            Section {
                Button {
                    Task { await create() }
                } label: {
                    if creating {
                        ProgressView()
                    } else {
                        Text("Start session")
                    }
                }
                .disabled(projectId == nil || creating)

                if let error {
                    Label(error, systemImage: "xmark.circle")
                        .foregroundStyle(Theme.statusRed)
                        .font(Theme.meta)
                }
            }
        }
        .navigationTitle("New session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
        }
        .task {
            do {
                let live = try await api.liveSessions()
                projects = live.projects.sorted { $0.name < $1.name }
                if projectId == nil { projectId = projects.first?.id }
            } catch {
                self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func create() async {
        guard let projectId else { return }
        creating = true
        defer { creating = false }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let session = try await api.createSession(
                projectId: projectId,
                input: NewSessionInput(
                    title: trimmed.isEmpty ? nil : trimmed,
                    driver: driver,
                    envMode: envMode
                )
            )
            dismiss()
            onCreated(session.id)
        } catch {
            self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
