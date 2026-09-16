import PhotosUI
import SwiftUI

/// t3 mobile's creation flow, ported: two steps, both in the sheet's stack.
/// Step 1 — the palette: every project on every paired Mac, in one searchable
/// list. Step 2 — the draft: a composer-first screen; the auto-focused prompt
/// owns the whole sheet, every setting is a chip at the bottom you MAY touch,
/// and the arrow creates the session, sends the prompt as its first turn, and
/// drops you straight into the live conversation.

/**
 ONE FLAT LIST, THIS PHONE'S DEFAULT MAC FIRST — the Mac's palette (#332).

 WHAT THIS REPLACES, AND WHY. The picker used to ask for the Mac FIRST, as a
 menu above a per-Mac list. That made the host a MODE rather than a fact: the
 reachable set was one Mac at a time, so "start this on the mini" needed a
 change of mode before it was even visible, and the order of the list was
 whatever that one Mac happened to return. Naming the Mac on each row costs one
 line of muted text and removes the question — the same argument the dialog on
 the Mac makes about its own local/remote sections.

 THE DEFAULT MAC IS FIRST because the phone's host book is ordered by when each
 was paired, and the first one is the Mac this phone was set up against. That is
 the closest thing a phone has to the cockpit's "this Mac", and it is the one
 most rows belong to.

 THE ROOT PATH IS UNDER THE NAME, which is the whole answer to "which of my two
 clones is that" — and the reason a search over paths is worth having.

 NO KEYBOARD LEGEND. The Mac's footer explains ⌘1..⌘9 to a reader whose hands
 are already on a keyboard; a phone has none to explain, and a strip of key caps
 on a touch screen is chrome. The shortcuts themselves stay, for the iPad.
 */
struct NewSessionView: View {
    let settings: AppSettings
    /// Called with the created session's scoped ref — the caller navigates
    /// into it on the right Mac.
    let onCreated: (ScopedSessionID) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var targets: [NewConversationTarget] = []
    @State private var query = ""
    @State private var loading = true
    /// The Macs that did not answer this read, by name. ONE MAC GOING DARK
    /// MUST NOT BLANK THE LIST — the merged inbox's rule, and the same one
    /// applies to a palette drawn from every Mac at once.
    @State private var unreachable: [String] = []
    /// `-newSessionProject <id>` launch arg, and the resumed draft — both jump
    /// straight past the palette into the draft.
    @State private var autoTarget: NewConversationTarget?
    @State private var addingProject = false
    /// Which Mac the `+` registers a folder on. Nil until the sheet opens.
    @State private var addHostId: HostID?
    /// The branch a "New session on `<branch>`" carried in, handed to the
    /// draft so the worktree is cut from where the session that offered it
    /// works (#326). Nil for every other way in, which means HEAD.
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

    /// The Mac a newly registered folder lands on: the one the `+` named, or
    /// the default when there is only one to name.
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
                            .font(.system(size: 18, weight: .bold))
                            .foregroundStyle(Theme.text)
                        Text(loading ? "Reading every paired Mac's registry."
                             : targets.isEmpty ? "No Mac reported a project. Add one below."
                             : "Try another name, Mac or path.")
                            .font(.system(size: 14))
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
                            // ⌘1..⌘9 TAKE THE FIRST NINE ROWS AS FILTERED,
                            // which is what makes them useful with a query
                            // typed: the number is the row's place in front of
                            // you, not its place in an unfiltered registry.
                            // Inert on a phone, which is why nothing draws them.
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
                // WHICH MAC IS A QUESTION ONLY WHEN THERE ARE TWO. With one
                // paired the `+` is the button it always was.
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
                        // Straight into the draft for the folder just added.
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
        // RE-READ WHEN THE HOST BOOK CHANGES, not when a picker moves: there
        // is no picker any more, and the list is every Mac's at once.
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

    /// THE HOST IS A FACT ON THE ROW, not a heading above a section — a reader
    /// scrolling a mixed list should not have to remember which section they
    /// passed. The path is the second line, in a monospaced face because it is
    /// something you compare character by character rather than read.
    private func targetRow(_ target: NewConversationTarget) -> some View {
        HStack(spacing: 12) {
            ProjectAvatar(name: target.project.name, projectId: target.project.id, hostId: target.hostId,
                          icon: target.project.icon, api: settings.api(for: target.hostId), size: 27)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(target.project.name)
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    HStack(spacing: 3) {
                        Image(systemName: "desktopcomputer").font(.system(size: 10))
                        Text(target.hostName).font(.system(size: 11)).lineLimit(1)
                    }
                    .foregroundStyle(Theme.textMuted)
                }
                if let root = target.root {
                    Text(root)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.chevron)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }

    /// EVERY PAIRED MAC AT ONCE, in the host book's order so the default Mac
    /// leads. Read concurrently and assembled in that order afterwards: a slow
    /// Mac must not decide where its projects sit, and a dead one must not
    /// hold up the ones that answered.
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

    /// The registration entry INSIDE the card, not only the nav-bar `+` —
    /// a control at the end of the list you are already reading.
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
}

/// ⌘1..⌘9 on the first nine rows, and nothing at all on the tenth — a
/// modifier rather than an inline `if` so the row itself stays one expression.
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
    /// The branch this draft was opened ON, when it came from a session that
    /// has one ("New session on `<branch>`"). Seeds `baseRef` once, at appear;
    /// the workspace chip owns it from there.
    var baseRefSeed: String?
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
        MobileDrafts.shared.save(MobileDraft(hostId: hostId, project: project, prompt: prompt, title: title, createdSessionId: createdSessionId, submissionRunId: submissionRunId, baseRef: baseRef))
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
                                 label: SessionComposerControls.runtimeModes.first { $0.0 == runtimeMode }?.1 ?? "Configuration") {
                                ForEach(SessionComposerControls.runtimeModes, id: \.0) { mode, label in
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
                                .foregroundStyle(Theme.textMuted)
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
                                .foregroundStyle(canStart ? Theme.primaryGlyph : Theme.textMuted)
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
            // THE SEED LOSES TO THE SAVED DRAFT, which is the ordering every
            // other field here already has: a branch picked in this draft and
            // left behind is a decision, and the row that opened it is only a
            // starting point.
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
