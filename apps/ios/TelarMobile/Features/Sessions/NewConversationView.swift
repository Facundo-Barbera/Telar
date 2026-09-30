import SwiftUI

struct NewConversationView: View {
    @State private var model: NewConversationModel
    @State private var focused = false
    @State private var picking = false
    @State private var pickingBranch = false
    @State private var namingBranch = false
    @State private var branchDraft = ""
    @ScaledMetric(relativeTo: .subheadline) private var mark: CGFloat = 18

    init(settings: AppSettings, seed: MobileDraft?, onCreated: @escaping (ScopedSessionID) -> Void) {
        let model = NewConversationModel(settings: settings, seed: seed)
        model.onCreated = onCreated
        _model = State(initialValue: model)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView { header }
                .scrollDismissesKeyboard(.interactively)
                .frame(maxHeight: .infinity)
            footer
        }
        .background(Theme.canvas)
        .navigationTitle("New conversation")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .task(id: model.draft.target?.id) { await model.loadDetails() }
        .task {
            try? await Task.sleep(for: .milliseconds(400))
            focused = true
        }
        .sheet(isPresented: $picking) {
            NewConversationPicker(model: model)
        }
        .sheet(isPresented: $pickingBranch) {
            BranchPickerSheet(git: model.git, selected: model.draft.baseRef) { model.draft.baseRef = $0 }
        }
        .alert("Name the branch", isPresented: $namingBranch) {
            TextField("branch-name", text: $branchDraft)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            Button("Use it") { model.draft.branchName = branchDraft.trimmingCharacters(in: .whitespaces) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Leave it empty to let the engine name the worktree's branch.")
        }
    }

    private var header: some View {
        VStack(spacing: 14) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { projectChip; workspaceChip }
                VStack(spacing: 8) { projectChip; workspaceChip }
            }
            if !model.unreachable.isEmpty {
                Label("\(model.unreachable.joined(separator: ", ")) didn't answer.", systemImage: "wifi.slash")
                    .font(.caption).foregroundStyle(Theme.statusAmber)
            }
            if model.submitting {
                ProgressView("Starting the conversation…")
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .disabled(model.locked)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.top, 48)
    }

    private var projectChip: some View {
        Button { picking = true } label: {
            HStack(spacing: 8) {
                if let target = model.draft.target {
                    ProjectAvatar(name: target.project.name, projectId: target.project.id, hostId: target.hostId,
                                  icon: target.project.icon, api: model.api, size: mark)
                    Text(target.project.name).font(.system(Theme.subhead, weight: .semibold)).lineLimit(1)
                    if model.hostCount > 1 {
                        Text(target.hostName).font(.system(Theme.subhead)).foregroundStyle(Theme.textMuted).lineLimit(1)
                    }
                } else {
                    Image(systemName: "folder").font(.system(Theme.subhead))
                    Text(model.loading ? "Loading projects…" : "Choose a project")
                        .font(.system(Theme.subhead, weight: .semibold)).lineLimit(1)
                }
                Image(systemName: "chevron.down").font(.system(Theme.caption, weight: .medium))
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .scaledHeight(44, relativeTo: .subheadline)
            .background(Theme.subtle)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.draft.target.map { "Project: \($0.project.name)" } ?? "Choose a project")
    }

    private var workspaceChip: some View {
        ComposerLabeledPill(icon: "point.topleft.down.curvedto.point.bottomright.up", label: model.draft.workspaceLabel) {
            Section("Mode") {
                Button { model.draft.setMode("worktree") } label: { composerMenuRow("New worktree", selected: model.draft.envMode == "worktree") }
                Button { model.draft.setMode("local") } label: { composerMenuRow("Current checkout", selected: model.draft.envMode == "local") }
            }
            if model.draft.envMode == "worktree" {
                Button { pickingBranch = true } label: {
                    Label(model.draft.baseRef.map { "Start from: \(NewConversationDraft.shortRef($0))" } ?? "Start from…", systemImage: "arrow.triangle.branch")
                }
                Button {
                    branchDraft = model.draft.branchName
                    namingBranch = true
                } label: {
                    Label(model.draft.branchName.isEmpty ? "Name the branch…" : "Branch: \(model.draft.branchName)", systemImage: "signature")
                }
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 8) {
            if let error = model.error {
                StatusCard(tint: Theme.statusRed) {
                    HStack(spacing: 8) {
                        Text(error).font(.system(Theme.footnote)).foregroundStyle(Theme.statusRed).lineLimit(3)
                        Spacer(minLength: 0)
                        Button("Dismiss") { model.error = nil }
                            .font(.system(Theme.footnote, weight: .medium))
                            .buttonStyle(.plain)
                    }
                }
            }
            ComposerView(
                draft: $model.prompt,
                focus: $focused,
                host: DraftComposerHost(model: model),
                api: model.api ?? model.settings.hosts.first.flatMap { model.settings.api(for: $0.id) },
                controls: ComposerControls(
                    model: AnyView(ModelMenu(catalogues: model.catalogues, choice: model.choice, driversSwitchable: true,
                                             onChange: { model.choice = $0 })),
                    options: AnyView(RuntimeModePill(mode: model.runtimeMode) { model.runtimeMode = $0 })
                )
            )
        }
        .padding(.horizontal, 16)
        .readingColumn(gutter: Theme.readingGutter)
        .padding(.vertical, 8)
        .background(alignment: .bottom) { ComposerScrim() }
    }
}

struct DraftComposerHost: ComposerHost {
    let model: NewConversationModel

    var isRunning: Bool { false }
    var placeholder: String {
        model.draft.target.map { "Describe a coding task in \($0.project.name)" } ?? "Describe a coding task"
    }
    var pendingAttachments: [TurnAttachment] { model.attachments }
    var attachmentPreviews: [EngineID: Data] { model.previews }
    var uploading: Bool { false }
    var queuedTurns: [JournalTurn] { [] }
    var canPromoteQueued: Bool { false }

    func send(_ text: String) async { await model.send(text) }
    func stop() async {}
    func attach(data: Data, name: String, mediaType: String) async { model.attach(data: data, name: name, mediaType: mediaType) }
    func removeAttachment(_ id: EngineID) { model.removeAttachment(id) }
    func promote(_ runId: String) async {}
    func withdraw(_ runId: String) async {}
}
