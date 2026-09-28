import PhotosUI
import SwiftUI

struct NewSessionView: View {
    let settings: AppSettings

    let onCreated: (ScopedSessionID) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var targets: [NewConversationTarget] = []
    @State private var query = ""
    @State private var loading = true

    @State private var unreachable: [String] = []

    @State private var autoTarget: NewConversationTarget?
    @State private var addingProject = false

    @ScaledMetric(relativeTo: .callout) private var targetMark: CGFloat = 27

    @State private var addHostId: HostID?

    @State private var draftBaseRef: String?

    init(settings: AppSettings, draft: MobileDraft? = nil, onCreated: @escaping (ScopedSessionID) -> Void) {
        self.settings = settings
        self.onCreated = onCreated
        _draftBaseRef = State(initialValue: draft?.baseRef)
        if let draft, let host = settings.host(draft.hostId) {
            _autoTarget = State(initialValue: NewConversationTarget(hostId: host.id, hostName: host.name, project: draft.project))
        }
    }

    private var matches: [NewConversationTarget] { matchNewConversationTargets(targets, query: query) }

    private var addHost: Host? {
        settings.host(addHostId ?? settings.hosts.first?.id ?? HostID()) ?? settings.hosts.first
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if !unreachable.isEmpty {
                    Label("\(unreachable.joined(separator: ", ")) didn't answer — showing the rest.", systemImage: "wifi.slash")
                        .font(.caption).foregroundStyle(Theme.statusAmber)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if matches.isEmpty {
                    VStack(spacing: 12) {
                        if loading { ProgressView() }

                        Text(loading ? "Loading projects" : targets.isEmpty ? "No projects found" : "No project matches that")
                            .font(.system(.headline, weight: .bold))
                            .foregroundStyle(Theme.text)
                        Text(loading ? "Reading every paired Mac's registry."
                             : targets.isEmpty ? "No Mac reported a project. Add one below."
                             : "Try another name, Mac or path.")
                            .font(.system(Theme.subhead))
                            .foregroundStyle(Theme.textMuted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 32)
                    .background(Theme.card)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                }
                VStack(spacing: 0) {
                    ForEach(Array(matches.enumerated()), id: \.element.id) { index, target in
                        NavigationLink(value: target) { targetRow(target) }
                            .buttonStyle(.plain)

                            .modifier(QuickPick(index: index))
                        if index < matches.count - 1 {
                            Rectangle().fill(Theme.borderSubtle).frame(height: 1)
                        }
                    }
                    if !matches.isEmpty {
                        Rectangle().fill(Theme.borderSubtle).frame(height: 1)
                    }
                    addProjectRow
                }
                .background(Theme.card)
                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
        .background(Theme.sheet)
        .navigationTitle("New conversation")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search projects, Macs, paths")
        .navigationDestination(for: NewConversationTarget.self) { target in draft(target) }
        .navigationDestination(item: $autoTarget) { target in draft(target) }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if settings.hosts.count > 1 {
                    Menu {
                        ForEach(settings.hosts) { host in
                            Button(host.name, systemImage: "desktopcomputer") { addHostId = host.id; addingProject = true }
                        }
                    } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add project")
                } else {
                    Button {
                        addHostId = settings.hosts.first?.id
                        addingProject = true
                    } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add project")
                }
            }
        }
        .sheet(isPresented: $addingProject) {
            NavigationStack {
                if let host = addHost, let api = settings.api(for: host.id) {
                    AddProjectView(api: api) { project in
                        addingProject = false
                        let target = NewConversationTarget(hostId: host.id, hostName: host.name, project: project)
                        if !targets.contains(where: { $0.id == target.id }) { targets.append(target) }

                        autoTarget = target
                    }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { addingProject = false }
                        }
                    }
                }
            }
        }

        .task(id: settings.book.membershipFingerprint) { await load() }
    }

    @ViewBuilder private func draft(_ target: NewConversationTarget) -> some View {
        if let api = settings.api(for: target.hostId) {
            NewSessionDraftView(
                api: api, project: target.project, hostId: target.hostId,
                hostName: settings.hosts.count > 1 ? target.hostName : nil,
                baseRefSeed: draftBaseRef
            ) { sessionId in
                onCreated(ScopedSessionID(hostId: target.hostId, sessionId: sessionId))
            }
        } else {
            ContentUnavailableView("That Mac is gone", systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                                   description: Text("It was unpaired while this was open."))
        }
    }

    private func targetRow(_ target: NewConversationTarget) -> some View {
        HStack(spacing: 12) {
            ProjectAvatar(name: target.project.name, projectId: target.project.id, hostId: target.hostId,
                          icon: target.project.icon, api: settings.api(for: target.hostId), size: targetMark)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(target.project.name)
                        .font(.system(.callout, weight: .bold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    HStack(spacing: 3) {
                        Image(systemName: "desktopcomputer").font(.system(Theme.caption))
                        Text(target.hostName).font(.system(Theme.caption)).lineLimit(1)
                    }
                    .foregroundStyle(Theme.textMuted)
                }
                if let root = target.root {
                    Text(root)
                        .font(.system(Theme.caption, design: .monospaced))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.system(Theme.footnote, weight: .medium))
                .foregroundStyle(Theme.chevron)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }

    private func load() async {
        loading = true
        defer { loading = false }
        let hosts = settings.hosts
        var found: [HostID: [ProjectRef]] = [:]
        var failed: [HostID: String] = [:]
        await withTaskGroup(of: (HostID, [ProjectRef]?).self) { group in
            for host in hosts {
                guard let api = settings.api(for: host.id) else { continue }
                group.addTask { (host.id, try? await api.liveSessions().projects) }
            }
            for await (id, projects) in group {
                if let projects { found[id] = projects } else { failed[id] = "" }
            }
        }
        targets = newConversationTargets(hosts: hosts, projects: found)
        unreachable = hosts.filter { failed[$0.id] != nil }.map(\.name)
        if autoTarget == nil, let seeded = UserDefaults.standard.string(forKey: "newSessionProject") {
            autoTarget = targets.first { $0.project.id == seeded }
        }
    }

    @ViewBuilder private var addProjectRow: some View {
        if settings.hosts.count > 1 {
            Menu {
                ForEach(settings.hosts) { host in
                    Button(host.name, systemImage: "desktopcomputer") { addHostId = host.id; addingProject = true }
                }
            } label: { addProjectLabel }
                .buttonStyle(.plain)
        } else {
            Button {
                addHostId = settings.hosts.first?.id
                addingProject = true
            } label: { addProjectLabel }
                .buttonStyle(.plain)
        }
    }

    private var addProjectLabel: some View {
        HStack(spacing: 12) {
            Image(systemName: "plus.circle.fill")
                .foregroundStyle(Theme.accent)
                .scaledGlyphBox(27, glyph: 17)
            Text("Add project…")
                .font(.system(.callout, weight: .bold))
                .foregroundStyle(Theme.text)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.system(Theme.footnote, weight: .medium))
                .foregroundStyle(Theme.chevron)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }
}

private struct QuickPick: ViewModifier {
    let index: Int
    func body(content: Content) -> some View {
        if index < 9, let key = "123456789".dropFirst(index).first {
            content.keyboardShortcut(KeyEquivalent(key), modifiers: .command)
        } else {
            content
        }
    }
}

struct NewSessionDraftView: View {
    let api: any EngineAPI
    let project: ProjectRef

    var hostId: HostID
    var hostName: String?

    var baseRefSeed: String?
    let onCreated: (EngineID) -> Void

    struct DraftAttachment: Identifiable, Equatable {
        let id = UUID()
        let data: Data
        let name: String
        let mediaType: String
    }

    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""

    @State private var title = ""
    @State private var choice = ModelChoice(driver: "claude")
    @State private var envMode = "worktree"

    @State private var baseRef: String?

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

    @State private var intakeNote: String?
    @State private var dropping = false

    @State private var createdSessionId: EngineID?
    @State private var submissionRunId = RunID.newRunId()

    @State private var focused = false

    private func saveTextDraft() {
        MobileDrafts.shared.save(MobileDraft(hostId: hostId, project: project, prompt: prompt, title: title, createdSessionId: createdSessionId, submissionRunId: submissionRunId, baseRef: baseRef))
    }

    private var canStart: Bool {
        SessionDraft.canSend(text: prompt, mediaTypes: draftAttachments.map(\.mediaType)) && !submitting
    }

    var body: some View {
        VStack(spacing: 0) {
            promptEditor
            footer
        }
        .background(Theme.sheet)
        .onAppear {
            baseRef = baseRefSeed
            if let saved = MobileDrafts.shared.draft(host: hostId, project: project.id) {
                prompt = saved.prompt; title = saved.title
                createdSessionId = saved.createdSessionId
                if let runId = saved.submissionRunId { submissionRunId = runId }
                if let saved = saved.baseRef { baseRef = saved }
            }
        }
        .onChange(of: prompt) { saveTextDraft() }
        .onChange(of: title) { saveTextDraft() }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if prompt.isEmpty, let seeded = UserDefaults.standard.string(forKey: "newSessionPrompt") {
                prompt = seeded
                await start()
                return
            }

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

    @ViewBuilder private var promptEditor: some View {
        TextField("Title — optional, taken from your message", text: $title)
            .font(.system(Theme.subhead))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        Rectangle().fill(Theme.borderSubtle).frame(height: 1)
            .padding(.horizontal, 20)

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
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.border).frame(height: 1)
            if let error {
                Text(error)
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.statusRed)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
            }
            if let intakeNote {
                Text(intakeNote)
                    .font(.system(Theme.footnote))
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
                                .foregroundStyle(Theme.text)
                                .scaledGlyphBox(44, glyph: 16)
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
                             label: SessionComposerControls.runtimeModes.first { $0.0 == runtimeMode }?.1 ?? "Configuration") {
                            ForEach(SessionComposerControls.runtimeModes, id: \.0) { mode, label in
                                Button { runtimeMode = mode } label: { composerMenuRow(label, selected: mode == runtimeMode) }
                            }
                        }
                        workspaceChip
                        if let hostName {
                            HStack(spacing: 8) {
                                Image(systemName: "desktopcomputer").font(.system(Theme.subhead))
                                Text(hostName)
                                    .font(.system(Theme.subhead, weight: .semibold))
                                    .lineLimit(1)
                            }
                            .foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, 14)
                            .scaledHeight(44, relativeTo: .subheadline)
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
                            .scaledSquare(44)
                            .background(Theme.subtleStrong)
                            .clipShape(Circle())
                    } else {
                        Image(systemName: "arrow.up")
                            .foregroundStyle(canStart ? Theme.primaryGlyph : Theme.textMuted)
                            .scaledGlyphBox(44, glyph: 16, weight: .semibold)
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

    private func intake(_ providers: [NSItemProvider]) {
        Task {
            let (files, refusals) = await composerFiles(from: providers)
            for file in files {
                draftAttachments.append(DraftAttachment(data: file.data, name: file.name, mediaType: file.mediaType))
            }
            intakeNote = refusals.isEmpty ? nil : refusals.joined(separator: " ")
        }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(draftAttachments) { attachment in
                    AttachmentChip(
                        name: attachment.name,
                        mediaType: attachment.mediaType,

                        preview: attachment.data.count <= ComposerIntake.previewCap ? attachment.data : nil,
                        onRemove: { draftAttachments.removeAll { $0.id == attachment.id } }
                    )
                }
            }
        }
    }

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
                Button { envMode = "worktree" } label: { composerMenuRow("New worktree", selected: envMode == "worktree") }
                Button { envMode = "local"; baseRef = nil } label: { composerMenuRow("Current checkout", selected: envMode == "local") }
            }
            if envMode == "worktree" {
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

    private func loadCatalogues() async {
        for driver in ["claude", "codex", "opencode"] where catalogues[driver] == nil {
            catalogues[driver] = try? await api.models(driver: driver)
        }
    }

    private func chip<Items: View>(icon: String, label: String, @ViewBuilder items: () -> Items) -> some View {
        Menu {
            items()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.system(Theme.subhead))
                Text(label)
                    .font(.system(Theme.subhead, weight: .semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.system(Theme.caption, weight: .medium))
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .scaledHeight(44, relativeTo: .subheadline)
            .background(Theme.subtle)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        }
    }

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
                        title: SessionDraft.title(
                            explicit: title, prompt: prompt,
                            imageNames: draftAttachments.filter { $0.mediaType.hasPrefix("image/") }.map(\.name)
                        ),
                        driver: choice.driver, envMode: envMode,
                        baseRef: envMode == "worktree" ? baseRef : nil,
                        branchName: envMode == "worktree" && !branchName.isEmpty ? branchName : nil
                    )
                )
                sessionId = session.id
                createdSessionId = session.id
                saveTextDraft()

                let modelTouched = choice.isTouched
                if modelTouched || runtimeMode != nil {
                    var patch = SessionPatch()
                    if let runtimeMode { patch.runtimeMode = runtimeMode }
                    if modelTouched, let instanceId = session.providerInstanceId ?? session.model?.instanceId {
                        patch.model = ModelSelection(
                            instanceId: instanceId, model: choice.model,
                            effort: choice.effort, fastMode: choice.fastMode,
                            serviceTier: choice.serviceTier, ultracode: choice.ultracode
                        )
                    }
                    try? await api.patchSession(session.id, patch: patch)
                }
            }

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

            MobileDrafts.shared.remove(host: hostId, project: project.id)
            onCreated(sessionId)
        } catch {
            self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
