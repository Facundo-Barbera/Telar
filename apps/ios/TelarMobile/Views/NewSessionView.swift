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
    @State private var addingProject = false

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
                    if loadError != nil {
                        VStack(spacing: 0) { addProjectRow }
                            .background(Theme.card)
                            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    }
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
                        Rectangle().fill(Theme.borderSubtle).frame(height: 1)
                        addProjectRow
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
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    addingProject = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add project")
            }
        }
        .sheet(isPresented: $addingProject) {
            NavigationStack {
                AddProjectView(api: api) { project in
                    addingProject = false
                    if !projects.contains(project) { projects.append(project) }
                    projects.sort { $0.name < $1.name }
                    // Straight into the draft for the folder just added.
                    autoProject = project
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { addingProject = false }
                    }
                }
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

    /// The registration entry INSIDE the card, not only the nav-bar `+` —
    /// a control at the end of the list you are already reading.
    private var addProjectRow: some View {
        Button {
            addingProject = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 27, height: 27)
                Text("Add project…")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Theme.text)
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
    @State private var choice = ModelChoice(driver: "claude")
    @State private var envMode = "worktree"
    /// nil = the checkout's HEAD, which is also what absent always meant.
    @State private var baseRef: String?
    @State private var runtimeMode: String?
    @State private var catalogues: [String: ModelCatalogue] = [:]
    @State private var git: GitOverview?
    @State private var submitting = false
    @State private var pickingBranch = false
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
                            ModelPillView(
                                catalogues: catalogues,
                                choice: choice,
                                driversSwitchable: true,
                                onChange: { choice = $0 }
                            )
                            chip(icon: "slider.horizontal.3",
                                 label: ComposerView.runtimeModes.first { $0.0 == runtimeMode }?.1 ?? "Configuration") {
                                ForEach(ComposerView.runtimeModes, id: \.0) { mode, label in
                                    Button { runtimeMode = mode } label: { menuRow(label, selected: mode == runtimeMode) }
                                }
                            }
                            workspaceChip
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
        .task {
            // `-newSessionPrompt <text>` — automation affordance like
            // -openSession: seeds the draft and starts it, so the whole
            // create-and-enter path is drivable headlessly. Inert in normal use.
            if prompt.isEmpty, let seeded = UserDefaults.standard.string(forKey: "newSessionPrompt") {
                prompt = seeded
                await start()
                return
            }
            // FocusState set at push time fires before the field is installed
            // on real devices and silently does nothing — the keyboard never
            // appears and the screen reads as dead. Wait out the push.
            try? await Task.sleep(for: .milliseconds(500))
            focused = true
        }
        .task {
            await loadCatalogues()
            git = try? await api.projectGit(project.id)
        }
        .sheet(isPresented: $pickingBranch) {
            BranchPickerSheet(git: git, selected: baseRef) { picked in
                baseRef = picked
            }
        }
    }

    /// t3's workspace label: "New worktree · main" / "Current checkout".
    private var workspaceLabel: String {
        let mode = envMode == "worktree" ? "New worktree" : "Current"
        if let baseRef { return "\(mode) · \(shortRef(baseRef))" }
        return envMode == "worktree" ? "New worktree" : "Current checkout"
    }

    private func shortRef(_ ref: String) -> String {
        ref.hasPrefix("origin/") ? String(ref.dropFirst("origin/".count)) : ref
    }

    private var workspaceChip: some View {
        chip(icon: "point.topleft.down.curvedto.point.bottomright.up", label: workspaceLabel) {
            Section("Mode") {
                Button { envMode = "worktree" } label: { menuRow("New worktree", selected: envMode == "worktree") }
                Button { envMode = "local"; baseRef = nil } label: { menuRow("Current checkout", selected: envMode == "local") }
            }
            if envMode == "worktree" {
                // The branch list is a SHEET, not a submenu — a menu cannot
                // search, and a real repo has too many branches to scroll.
                Button {
                    pickingBranch = true
                } label: {
                    Label(baseRef.map { "Start from: \(shortRef($0))" } ?? "Start from…", systemImage: "arrow.triangle.branch")
                }
            }
        }
    }

    /// Both drivers' catalogues — the fused pill lists them side by side.
    private func loadCatalogues() async {
        for driver in ["claude", "codex"] where catalogues[driver] == nil {
            catalogues[driver] = try? await api.models(driver: driver)
        }
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
                input: NewSessionInput(
                    title: nil, driver: choice.driver, envMode: envMode,
                    baseRef: envMode == "worktree" ? baseRef : nil
                )
            )
            // createSession takes neither a model nor a runtime mode — they
            // are session PATCHes, applied before the first turn runs.
            let modelTouched = choice.model != nil || choice.effort != nil || choice.fastMode != nil
            if modelTouched || runtimeMode != nil {
                var patch = SessionPatch()
                if let runtimeMode { patch.runtimeMode = runtimeMode }
                if modelTouched, let instanceId = session.providerInstanceId ?? session.model?.instanceId {
                    patch.model = ModelSelection(
                        instanceId: instanceId, model: choice.model,
                        effort: choice.effort, fastMode: choice.fastMode
                    )
                }
                try? await api.patchSession(session.id, patch: patch)
            }
            _ = try await api.submitTurn(session.id, runId: RunID.newRunId(), input: prompt, attachments: nil)
            // The caller closes the sheet and replaces it with the live
            // conversation — no back-stack detour (t3's replace()).
            onCreated(session.id)
        } catch {
            self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
