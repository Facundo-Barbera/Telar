import SwiftUI

/// t3 mobile's creation flow, ported: two steps, both in the sheet's stack.
/// Step 1 — "Choose project": one inset 24pt card of project rows.
/// Step 2 — the draft: a composer-first screen; the auto-focused prompt owns
/// the whole sheet, every setting is a chip at the bottom you MAY touch, and
/// the arrow creates the session, sends the prompt as its first turn, and
/// drops you straight into the live conversation.
struct NewSessionView: View {
    let api: any EngineAPI
    /// Called with the created session's id — the caller navigates into it.
    let onCreated: (EngineID) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var projects: [ProjectRef] = []
    @State private var loadError: String?
    /// `-newSessionProject <id>` launch arg — jumps straight to the draft.
    @State private var autoProject: ProjectRef?

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if projects.isEmpty {
                    VStack(spacing: 12) {
                        if loadError == nil { ProgressView() }
                        Text(loadError == nil ? "Loading projects" : "No projects found")
                            .font(.system(size: 18, weight: .bold))
                            .foregroundStyle(Theme.text)
                        Text(loadError ?? "Loading projects from the cockpit.")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textMuted2)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 32)
                    .background(Theme.card)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(projects.enumerated()), id: \.element.id) { index, project in
                            NavigationLink(value: project) {
                                HStack(spacing: 12) {
                                    Image(systemName: "folder.fill")
                                        .font(.system(size: 17))
                                        .foregroundStyle(Theme.textMuted2)
                                        .frame(width: 27, height: 27)
                                    Text(project.name)
                                        .font(.system(size: 16, weight: .bold))
                                        .foregroundStyle(Theme.text)
                                        .lineLimit(1)
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(Theme.chevron)
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 14)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if index < projects.count - 1 {
                                Rectangle().fill(Theme.borderSubtle).frame(height: 1)
                            }
                        }
                    }
                    .background(Theme.card)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
        .background(Theme.sheet)
        .navigationTitle("Choose project")
        .navigationDestination(for: ProjectRef.self) { project in
            NewSessionDraftView(api: api, project: project, onCreated: onCreated)
        }
        .navigationDestination(item: $autoProject) { project in
            NewSessionDraftView(api: api, project: project, onCreated: onCreated)
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
        }
        .task {
            do {
                let live = try await api.liveSessions()
                projects = live.projects.sorted { $0.name < $1.name }
                if projects.isEmpty { loadError = "The cockpit did not report any projects." }
                if let seeded = UserDefaults.standard.string(forKey: "newSessionProject") {
                    autoProject = projects.first { $0.id == seeded }
                }
            } catch {
                loadError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

/// Step 2: the composer-first draft. Prompt fills the sheet at 18pt; the
/// bottom control block (hairline on top) holds the chip bar and the 44pt
/// primary start button.
struct NewSessionDraftView: View {
    let api: any EngineAPI
    let project: ProjectRef
    let onCreated: (EngineID) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    @State private var driver = "claude"
    @State private var envMode = "worktree"
    @State private var submitting = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var canStart: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !submitting
    }

    var body: some View {
        VStack(spacing: 0) {
            TextField("Describe a coding task in \(project.name)", text: $prompt, axis: .vertical)
                .font(.system(size: 18))
                .foregroundStyle(Theme.text)
                .focused($focused)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .contentShape(Rectangle())
                .onTapGesture { focused = true }

            VStack(spacing: 0) {
                Rectangle().fill(Theme.border).frame(height: 1)
                if let error {
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.statusRed)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                }
                HStack(spacing: 8) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            chip(icon: driver == "claude" ? "sparkle" : "terminal",
                                 label: driver == "claude" ? "Claude" : "Codex") {
                                Button { driver = "claude" } label: { menuRow("Claude", selected: driver == "claude") }
                                Button { driver = "codex" } label: { menuRow("Codex", selected: driver == "codex") }
                            }
                            chip(icon: "point.topleft.down.curvedto.point.bottomright.up",
                                 label: envMode == "worktree" ? "New worktree" : "Current checkout") {
                                Button { envMode = "worktree" } label: { menuRow("New worktree", selected: envMode == "worktree") }
                                Button { envMode = "local" } label: { menuRow("Current checkout", selected: envMode == "local") }
                            }
                        }
                        .padding(.horizontal, 6)
                    }
                    Button {
                        Task { await start() }
                    } label: {
                        if submitting {
                            ProgressView()
                                .frame(width: 44, height: 44)
                                .background(Theme.subtleStrong)
                                .clipShape(Circle())
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(canStart ? Theme.primaryGlyph : Theme.textMuted2)
                                .frame(width: 44, height: 44)
                                .background(canStart ? Theme.primaryFill : Theme.subtleStrong)
                                .clipShape(Circle())
                        }
                    }
                    .disabled(!canStart)
                    .accessibilityLabel(submitting ? "Starting task" : "Start task")
                    .padding(.trailing, 6)
                }
                .padding(.top, 8)
                .padding(.bottom, 8)
            }
        }
        .background(Theme.sheet)
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { focused = true }
    }

    @ViewBuilder private func menuRow(_ label: String, selected: Bool) -> some View {
        if selected {
            Label(label, systemImage: "checkmark")
        } else {
            Text(label)
        }
    }

    private func chip<Items: View>(icon: String, label: String, @ViewBuilder items: () -> Items) -> some View {
        Menu {
            items()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 14))
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .medium))
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(Theme.subtle)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        }
    }

    /// Create the session, then send the prompt as its FIRST TURN — the
    /// arrow means "start the work", not "make an empty room".
    private func start() async {
        submitting = true
        defer { submitting = false }
        do {
            let session = try await api.createSession(
                projectId: project.id,
                input: NewSessionInput(title: nil, driver: driver, envMode: envMode)
            )
            _ = try await api.submitTurn(session.id, runId: RunID.newRunId(), input: prompt)
            // The caller closes the sheet and replaces it with the live
            // conversation — no back-stack detour (t3's replace()).
            onCreated(session.id)
        } catch {
            self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
