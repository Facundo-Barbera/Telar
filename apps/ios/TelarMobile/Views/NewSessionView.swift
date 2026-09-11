import PhotosUI
import SwiftUI

/// t3 mobile's creation flow, ported: two steps, both in the sheet's stack.
/// Step 1 — "Choose project": one inset 24pt card of project rows.
/// Step 2 — the draft: a composer-first screen; the auto-focused prompt owns
/// the whole sheet, every setting is a chip at the bottom you MAY touch, and
/// the arrow creates the session, sends the prompt as its first turn, and
/// drops you straight into the live conversation.
struct NewSessionView: View {
    let settings: AppSettings
    /// Called with the created session's scoped ref — the caller navigates
    /// into it on the right Mac.
    let onCreated: (ScopedSessionID) -> Void

    @Environment(\.dismiss) private var dismiss
    /// t3's environment selector: the Mac is picked FIRST — the project
    /// list is per Mac, so picking later would only invalidate it.
    @State private var hostId: HostID
    @State private var projects: [ProjectRef] = []
    @State private var loadError: String?
    /// `-newSessionProject <id>` launch arg — jumps straight to the draft.
    @State private var autoProject: ProjectRef?
    @State private var addingProject = false

    init(settings: AppSettings, draft: MobileDraft? = nil, onCreated: @escaping (ScopedSessionID) -> Void) {
        self.settings = settings
        self.onCreated = onCreated
        _hostId = State(initialValue: draft?.hostId ?? settings.hosts.first?.id ?? HostID())
        _autoProject = State(initialValue: draft?.project)
    }

    private var api: any EngineAPI {
        settings.api(for: hostId) ?? HTTPEngineAPI(baseURL: URL(string: "http://invalid.local")!)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if settings.hosts.count > 1 {
                    VStack(spacing: 0) {
                        Menu {
                            ForEach(settings.hosts) { host in
                                Button {
                                    hostId = host.id
                                } label: {
                                    if host.id == hostId {
                                        Label(host.name, systemImage: "checkmark")
                                    } else {
                                        Text(host.name)
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "desktopcomputer")
                                    .font(.system(size: 17))
                                    .foregroundStyle(Theme.textMuted2)
                                    .frame(width: 27, height: 27)
                                Text(settings.host(hostId)?.name ?? "Mac")
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundStyle(Theme.text)
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(Theme.chevron)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 14)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .background(Theme.card)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                }
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
                                    ProjectAvatar(name: project.name, projectId: project.id, hostId: hostId, icon: project.icon, api: settings.api(for: hostId), size: 27)
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
            NewSessionDraftView(api: api, project: project, hostId: hostId, hostName: draftHostName) { sessionId in
                onCreated(ScopedSessionID(hostId: hostId, sessionId: sessionId))
            }
        }
        .navigationDestination(item: $autoProject) { project in
            NewSessionDraftView(api: api, project: project, hostId: hostId, hostName: draftHostName) { sessionId in
                onCreated(ScopedSessionID(hostId: hostId, sessionId: sessionId))
            }
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
        // Re-runs when the Mac changes — the project list is per Mac.
        .task(id: hostId) {
            projects = []
            loadError = nil
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

    /// The draft names the Mac only when there is a choice to remember.
    private var draftHostName: String? {
        settings.hosts.count > 1 ? settings.host(hostId)?.name : nil
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
    /// Which Mac runs this session — shown as a quiet chip when the phone
    /// knows more than one. Not a control here: switching after the project
    /// is chosen would only invalidate the choice.
    var hostId: HostID
    var hostName: String?
    let onCreated: (EngineID) -> Void

    /// A photo held locally until the session exists — uploads need a
    /// session id, and the draft has none yet.
    struct DraftAttachment: Identifiable, Equatable {
        let id = UUID()
        let data: Data
        let name: String
        let mediaType: String
    }

    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    /// Optional subject line; empty = derived from the message (web's rule).
    @State private var title = ""
    @State private var choice = ModelChoice(driver: "claude")
    @State private var envMode = "worktree"
    /// nil = the checkout's HEAD, which is also what absent always meant.
    @State private var baseRef: String?
    /// The worktree's own branch name; empty = the engine invents one.
    @State private var branchName = ""
    @State private var namingBranch = false
    @State private var branchDraft = ""
    @State private var runtimeMode: String?
    @State private var catalogues: [String: ModelCatalogue] = [:]
    @State private var git: GitOverview?
    @State private var draftAttachments: [DraftAttachment] = []
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var submitting = false
    @State private var pickingBranch = false
    @State private var showingStash = false
    @State private var error: String?
    /// A file the intake turned away — said out loud, never swallowed.
    @State private var intakeNote: String?
    @State private var dropping = false
    /// Set the moment the create succeeds: a retry after a failed upload or
    /// turn must resume this session, never create a second one.
    @State private var createdSessionId: EngineID?
    @State private var submissionRunId = RunID.newRunId()
    /// Plain state rather than `@FocusState`: the prompt is a `UITextView`
    /// now (see `ComposerTextView`), which mirrors its own first responder.
    @State private var focused = false

    private func saveTextDraft() {
        MobileDrafts.shared.save(MobileDraft(hostId: hostId, project: project, prompt: prompt, title: title, createdSessionId: createdSessionId, submissionRunId: submissionRunId))
    }

    private var canStart: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !submitting
    }

    var body: some View {
        VStack(spacing: 0) {
            // A subject line, not a rival composer: one quiet row above the
            // prompt. Left empty, the message's first line becomes the title.
            TextField("Title — optional, taken from your message", text: $title)
                .font(.system(size: 14))
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
            Rectangle().fill(Theme.borderSubtle).frame(height: 1)
                .padding(.horizontal, 20)
            // The same UIKit field the session's composer uses, for the same
            // reason: a screenshot on the clipboard has to have a Paste to tap.
            ComposerTextView(
                text: $prompt,
                placeholder: "Describe a coding task in \(project.name)",
                focused: $focused,
                fontSize: 18,
                maxLines: nil,
                onPaste: { intake($0) }
            )
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .contentShape(Rectangle())
                .onTapGesture { focused = true }
                // The whole message area takes a drag, not just a small target:
                // on an iPad the drop lands wherever the finger lets go.
                .onDrop(of: ComposerIntake.accepted, isTargeted: $dropping) { providers in
                    intake(providers)
                    return true
                }
                .overlay {
                    if dropping {
                        RoundedRectangle(cornerRadius: Theme.radiusCard, style: .continuous)
                            .strokeBorder(Theme.accent, lineWidth: 2)
                            .padding(.horizontal, 12)
                    }
                }

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
                if let intakeNote {
                    Text(intakeNote)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                }
                if !draftAttachments.isEmpty {
                    attachmentStrip
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                }
                HStack(spacing: 8) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            PhotosPicker(selection: $pickedPhotos, maxSelectionCount: 8, matching: .images) {
                                Image(systemName: "plus")
                                    .font(.system(size: 16))
                                    .foregroundStyle(Theme.text)
                                    .frame(width: 44, height: 44)
                                    .background(Theme.subtle)
                                    .clipShape(Circle())
                                    .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                            }
                            .accessibilityLabel("Attach photos")
                            StashButton(
                                hasDraft: !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                                onStash: {
                                    let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                                    if PromptStash.shared.stash(StashEntry(id: UUID().uuidString, at: Timestamp(Date().timeIntervalSince1970 * 1000), prompt: text, images: [])) {
                                        prompt = ""
                                    } else {
                                        error = "There was no room to stash this. Nothing was taken from the box."
                                    }
                                },
                                onOpen: { showingStash = true }
                            )
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
                            if let hostName {
                                HStack(spacing: 8) {
                                    Image(systemName: "desktopcomputer").font(.system(size: 14))
                                    Text(hostName)
                                        .font(.system(size: 14, weight: .semibold))
                                        .lineLimit(1)
                                }
                                .foregroundStyle(Theme.textMuted2)
                                .padding(.horizontal, 14)
                                .frame(height: 44)
                                .background(Theme.subtle)
                                .clipShape(Capsule())
                                .overlay(Capsule().strokeBorder(Theme.borderSubtle, lineWidth: 1))
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
        .onAppear {
            if let saved = MobileDrafts.shared.draft(host: hostId, project: project.id) {
                prompt = saved.prompt; title = saved.title
                createdSessionId = saved.createdSessionId
                if let runId = saved.submissionRunId { submissionRunId = runId }
            }
        }
        .onChange(of: prompt) { saveTextDraft() }
        .onChange(of: title) { saveTextDraft() }
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
        .sheet(isPresented: $showingStash) {
            StashSheet { entry in
                if let taken = PromptStash.shared.take(entry.id, room: 0) {
                    prompt = StashRules.appendPrompt(prompt, taken.prompt)
                    focused = true
                }
            }
        }
        .sheet(isPresented: $pickingBranch) {
            BranchPickerSheet(git: git, selected: baseRef) { picked in
                baseRef = picked
            }
        }
        .alert("Name the branch", isPresented: $namingBranch) {
            TextField("branch-name", text: $branchDraft)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            Button("Use it") { branchName = branchDraft.trimmingCharacters(in: .whitespaces) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The worktree's own branch. Leave the field empty to let the engine invent one.")
        }
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            pickedPhotos = []
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        draftAttachments.append(DraftAttachment(
                            data: data,
                            name: (item.itemIdentifier ?? "photo") + ".jpg",
                            mediaType: item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
                        ))
                    }
                }
            }
        }
    }

    /// A paste or a drop, through the same rules the session composer uses.
    /// Nothing is uploaded here: this sheet has no session id until the arrow
    /// is pressed, so the bytes wait in the draft.
    private func intake(_ providers: [NSItemProvider]) {
        Task {
            let (files, refusals) = await composerFiles(from: providers)
            for file in files {
                draftAttachments.append(DraftAttachment(data: file.data, name: file.name, mediaType: file.mediaType))
            }
            intakeNote = refusals.isEmpty ? nil : refusals.joined(separator: " ")
        }
    }

    /// The composer's 72×72 strip, held locally: uploads need the session id,
    /// which doesn't exist until the arrow is pressed.
    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(draftAttachments) { attachment in
                    AttachmentChip(
                        name: attachment.name,
                        mediaType: attachment.mediaType,
                        // Nothing is uploaded yet, so the bytes are right here.
                        preview: attachment.data.count <= ComposerIntake.previewCap ? attachment.data : nil,
                        onRemove: { draftAttachments.removeAll { $0.id == attachment.id } }
                    )
                }
            }
        }
    }

    /// t3's workspace label: "New worktree · main" / "Current checkout".
    /// A named branch outranks the base ref, mirroring the web draft chip.
    private var workspaceLabel: String {
        let mode = envMode == "worktree" ? "New worktree" : "Current"
        if envMode == "worktree", !branchName.isEmpty { return "\(mode) · \(branchName)" }
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
                Button {
                    branchDraft = branchName
                    namingBranch = true
                } label: {
                    Label(branchName.isEmpty ? "Name the branch…" : "Branch: \(branchName)", systemImage: "signature")
                }
            }
        }
    }

    /// Both drivers' catalogues — the fused pill lists them side by side.
    private func loadCatalogues() async {
        for driver in ["claude", "codex", "opencode"] where catalogues[driver] == nil {
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
    /// arrow means "start the work", not "make an empty room". The created
    /// id is remembered the moment it exists: a retry after a failed upload
    /// or turn RESUMES that session rather than minting a duplicate.
    private func start() async {
        submitting = true
        defer { submitting = false }
        do {
            let sessionId: EngineID
            if let createdSessionId {
                sessionId = createdSessionId
            } else {
                let session = try await api.createSession(
                    projectId: project.id,
                    input: NewSessionInput(
                        title: SessionDraft.title(explicit: title, prompt: prompt),
                        driver: choice.driver, envMode: envMode,
                        baseRef: envMode == "worktree" ? baseRef : nil,
                        branchName: envMode == "worktree" && !branchName.isEmpty ? branchName : nil
                    )
                )
                sessionId = session.id
                createdSessionId = session.id
                saveTextDraft()
                // createSession takes neither a model nor a runtime mode —
                // they are session PATCHes, applied before the first turn runs.
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
            }
            // Every photo lands before the message that refers to it; a
            // failed upload stops the send and NAMES the file — silently
            // dropping something the human picked is the worst outcome.
            var attachmentIds: [EngineID] = []
            for attachment in draftAttachments {
                do {
                    let uploaded = try await api.uploadAttachment(
                        sessionId, name: attachment.name,
                        mediaType: attachment.mediaType, data: attachment.data
                    )
                    attachmentIds.append(uploaded.id)
                } catch {
                    self.error = "Couldn't upload \(attachment.name) — nothing was sent. Try again."
                    return
                }
            }
            _ = try await api.submitTurn(
                sessionId, runId: submissionRunId, input: prompt,
                attachments: attachmentIds.isEmpty ? nil : attachmentIds
            )
            // The caller closes the sheet and replaces it with the live
            // conversation — no back-stack detour (t3's replace()).
            MobileDrafts.shared.remove(host: hostId, project: project.id)
            onCreated(sessionId)
        } catch {
            self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
