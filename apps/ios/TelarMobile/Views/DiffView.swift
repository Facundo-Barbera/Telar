import SwiftUI

/// The session's review, from the phone: what it has done to the repository
/// since it started — committed and uncommitted together, from the recorded
/// base. File rows open one patch at a time (the list is light, patches are
/// not). Read-only on purpose: committing stays a desk decision.
struct DiffView: View {
    let api: any EngineAPI
    let sessionId: EngineID

    @State private var diff: SessionDiff?
    @State private var error: String?
    /// Files whose patch is open UNDER their row — the desktop's expand, which
    /// is how a diff is read there: several files at once, in place. A tap
    /// still pushes the full-page patch; this is the menu's half.
    @State private var expanded: Set<String> = []
    @Environment(\.panel) private var panel

    var body: some View {
        Group {
            if let diff {
                List {
                    header(diff)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 20))
                    ForEach(diff.files) { file in
                        NavigationLink(value: file) {
                            fileRow(file)
                        }
                        .listRowBackground(Color.clear)
                        .listRowSeparatorTint(Theme.borderSubtle)
                        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                        .contextMenu { fileMenu(file) }
                        if expanded.contains(file.path) {
                            InlinePatch(api: api, sessionId: sessionId, file: file)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 8, trailing: 20))
                        }
                    }
                    if !diff.commits.isEmpty {
                        Section {
                            ForEach(diff.commits) { commit in
                                HStack(spacing: 10) {
                                    Text(commit.shortSha)
                                        .font(.system(size: 12, design: .monospaced))
                                        .foregroundStyle(Theme.textMuted)
                                    Text(commit.subject)
                                        .font(.system(size: 14))
                                        .foregroundStyle(Theme.text)
                                        .lineLimit(1)
                                }
                                .listRowBackground(Color.clear)
                                .listRowSeparatorTint(Theme.borderSubtle)
                                .listRowInsets(EdgeInsets(top: 6, leading: 20, bottom: 6, trailing: 20))
                            }
                        } header: {
                            Text("Commits")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.textMuted)
                        }
                    }
                    if diff.files.isEmpty && diff.commits.isEmpty {
                        Text("No changes yet.")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textMuted)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            } else if let error {
                ContentUnavailableView("Could not load changes", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .background(Theme.canvas)
        .navigationTitle("Changes")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: GitFileChange.self) { file in
            PatchView(api: api, sessionId: sessionId, file: file)
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            diff = try await api.sessionDiff(sessionId)
            error = nil
        } catch {
            self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func header(_ diff: SessionDiff) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if let branch = diff.branch {
                    Text(branch)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("+\(diff.linesAdded)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.statusEmerald)
                    .tabularNumbers()
                Text("−\(diff.linesRemoved)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.statusRed)
                    .tabularNumbers()
            }
            if diff.base == nil {
                Text("No recorded base — committed work is not included.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.statusAmber)
            }
            if diff.truncated {
                Text("File list truncated.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    /// The desktop's diff-row menu. A DELETED FILE HAS NOTHING TO OPEN, so
    /// that row is absent on one rather than greyed — its path is still worth
    /// copying and still worth handing to the agent.
    @ViewBuilder private func fileMenu(_ file: GitFileChange) -> some View {
        if let panel, file.status != "deleted" {
            Button("Open in Editor", systemImage: "sidebar.trailing") { panel.openFile(file.path) }
            Divider()
        }
        Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = file.path }
        if let panel {
            Button("Insert as reference", systemImage: "text.badge.plus") {
                panel.insertReference(ComposerReference.file(file.path))
            }
        }
        Divider()
        let open = expanded.contains(file.path)
        Button(open ? "Collapse patch" : "Expand patch", systemImage: open ? "chevron.up" : "chevron.down") {
            if open { expanded.remove(file.path) } else { expanded.insert(file.path) }
        }
    }

    private func fileRow(_ file: GitFileChange) -> some View {
        HStack(spacing: 10) {
            Text(statusLetter(file.status))
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(statusColor(file.status))
                .frame(width: 14)
            Text(file.path)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 8)
            if file.binary == true {
                Text("binary")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            } else {
                if let added = file.linesAdded {
                    Text("+\(added)")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.statusEmerald)
                        .tabularNumbers()
                }
                if let removed = file.linesRemoved {
                    Text("−\(removed)")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.statusRed)
                        .tabularNumbers()
                }
            }
        }
        .padding(.vertical, 8)
    }

    private func statusLetter(_ status: String) -> String {
        switch status {
        case "added": "A"
        case "deleted": "D"
        case "renamed": "R"
        case "untracked": "?"
        default: "M"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "added", "untracked": Theme.statusEmerald
        case "deleted": Theme.statusRed
        default: Theme.statusAmber
        }
    }
}

/// One file's patch, colorized by line prefix on the code background.
struct PatchView: View {
    let api: any EngineAPI
    let sessionId: EngineID
    let file: GitFileChange

    @State private var patch: FilePatch?
    @State private var error: String?

    var body: some View {
        Group {
            if let patch {
                if patch.binary {
                    ContentUnavailableView("Binary file", systemImage: "doc", description: Text("No text diff to show."))
                } else {
                    ScrollView([.vertical, .horizontal]) {
                        PatchLines(patch: patch.patch).padding(12)
                    }
                    .background(Theme.codeBackground)
                }
            } else if let error {
                ContentUnavailableView("Could not load the patch", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .background(Theme.canvas)
        .navigationTitle((file.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                patch = try await api.filePatch(sessionId, path: file.path, untracked: file.status == "untracked")
            } catch {
                self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

}

/// A patch, colorized by line prefix. Shared by the pushed page and the
/// inline expand so the two cannot drift into two ideas of what a `+` is.
struct PatchLines: View {
    let patch: String
    /// How many lines to draw before saying how many were left — nil for all
    /// of them, which is what the page with the screen to itself asks for.
    var limit: Int?

    var body: some View {
        let all = patch.split(separator: "\n", omittingEmptySubsequences: false)
        let shown = limit.map { Array(all.prefix($0)) } ?? Array(all)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                Text(String(line))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(patchLineColor(line))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(patchLineBackground(line))
            }
            if shown.count < all.count {
                Text("\(all.count - shown.count) more lines — tap the row to read the whole patch.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.top, 4)
            }
        }
    }
}

/// THE PATCH UNDER ITS OWN ROW. Capped rather than scrolled: a scroll view
/// inside a list row steals the list's own gesture, and a patch long enough to
/// need one is a patch worth opening on its own page.
private struct InlinePatch: View {
    let api: any EngineAPI
    let sessionId: EngineID
    let file: GitFileChange

    @State private var patch: FilePatch?
    @State private var error: String?

    private static let lineCap = 60

    var body: some View {
        Group {
            if let patch {
                if patch.binary {
                    Text("Binary file — no text diff to show.")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        PatchLines(patch: patch.patch, limit: Self.lineCap).padding(10)
                    }
                    .background(Theme.codeBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            } else if let error {
                Text(error).font(.system(size: 11)).foregroundStyle(Theme.statusRed)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task {
            do {
                patch = try await api.filePatch(sessionId, path: file.path, untracked: file.status == "untracked")
            } catch {
                self.error = describe(error)
            }
        }
    }
}

private func patchLineColor(_ line: Substring) -> Color {
    if line.hasPrefix("+") && !line.hasPrefix("+++") { return Theme.statusEmerald }
    if line.hasPrefix("-") && !line.hasPrefix("---") { return Theme.statusRed }
    if line.hasPrefix("@@") { return Theme.statusSky }
    return Theme.textMuted
}

private func patchLineBackground(_ line: Substring) -> Color {
    if line.hasPrefix("+") && !line.hasPrefix("+++") { return Theme.statusEmerald.opacity(0.08) }
    if line.hasPrefix("-") && !line.hasPrefix("---") { return Theme.statusRed.opacity(0.08) }
    return .clear
}
