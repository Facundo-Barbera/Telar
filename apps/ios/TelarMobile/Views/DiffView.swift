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
                                        .font(.system(Theme.footnote, design: .monospaced))
                                        .foregroundStyle(Theme.textMuted)
                                    Text(commit.subject)
                                        .font(.system(Theme.subhead))
                                        .foregroundStyle(Theme.text)
                                        .lineLimit(1)
                                }
                                .listRowBackground(Color.clear)
                                .listRowSeparatorTint(Theme.borderSubtle)
                                .listRowInsets(EdgeInsets(top: 6, leading: 20, bottom: 6, trailing: 20))
                            }
                        } header: {
                            Text("Commits")
                                .font(.system(Theme.footnote, weight: .medium))
                                .foregroundStyle(Theme.textMuted)
                        }
                    }
                    if diff.files.isEmpty && diff.commits.isEmpty {
                        // "NO CHANGES YET" IS A CLAIM ABOUT THE CHECKOUT (#654),
                        // and it is only safe when the reads that would have
                        // contradicted it answered. A diff the engine killed
                        // under load arrived here empty and this row read as a
                        // session that had done no work.
                        Text(diff.filesIncomplete == nil ? "No changes yet." : "Nothing was listed — which is not the same as nothing having changed.")
                            .font(.system(Theme.subhead))
                            .foregroundStyle(diff.filesIncomplete == nil ? Theme.textMuted : Theme.statusAmber)
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
                        .font(.system(Theme.footnote, design: .monospaced))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("+\(diff.linesAdded)")
                    .font(.system(Theme.footnote, weight: .medium))
                    .foregroundStyle(Theme.statusEmerald)
                    .tabularNumbers()
                Text("−\(diff.linesRemoved)")
                    .font(.system(Theme.footnote, weight: .medium))
                    .foregroundStyle(Theme.statusRed)
                    .tabularNumbers()
            }
            if diff.base == nil {
                Text("No recorded base — committed work is not included.")
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.statusAmber)
            }
            /// WHAT GIT DID NOT ANSWER (#654), above the rows rather than in
            /// place of them: the files that arrived are real changes worth
            /// reading, and the counts beside them are honest sums over those.
            /// Three sentences because they are three different doubts — a
            /// `git log` that was killed says nothing about the file list.
            ///
            /// PULL TO REFRESH IS THIS SCREEN'S "ask git again", and a timeout
            /// is the failure that clears on its own, so it is named.
            ForEach(unknowns(diff), id: \.self) { sentence in
                Text(sentence)
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.statusAmber)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if diff.truncated {
                Text("File list truncated.")
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    private func unknowns(_ diff: SessionDiff) -> [String] {
        var sentences: [String] = []
        if let files = diff.filesIncomplete {
            sentences.append(
                files == "timeout"
                    ? "git did not answer in time — this list may be missing files and the counts may be low. Pull to ask again."
                    : "git could not read this checkout's changes — this list may be missing files and the counts may be low."
            )
        }
        if let commits = diff.commitsIncomplete {
            sentences.append(
                commits == "timeout"
                    ? "git did not answer in time for this session's commits — work it has already committed may not be listed. Pull to ask again."
                    : "git could not read this session's commits — work it has already committed may not be listed."
            )
        }
        if diff.baseUnverified != nil {
            sentences.append("Nothing confirmed the starting point — it is the one recorded when this checkout was cut.")
        }
        return sentences
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
                .font(.system(Theme.footnote, design: .monospaced, weight: .bold))
                .foregroundStyle(statusColor(file.status))
                .frame(width: 14)
            Text(file.path)
                .font(.system(Theme.footnote, design: .monospaced))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 8)
            if file.binary == true {
                Text("binary")
                    .font(.system(Theme.caption))
                    .foregroundStyle(Theme.textMuted)
            } else {
                if let added = file.linesAdded {
                    Text("+\(added)")
                        .font(.system(Theme.footnote))
                        .foregroundStyle(Theme.statusEmerald)
                        .tabularNumbers()
                }
                if let removed = file.linesRemoved {
                    Text("−\(removed)")
                        .font(.system(Theme.footnote))
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
                // GIT DID NOT ANSWER IS NOT A FACT ABOUT THE FILE (#654). An
                // unread patch used to arrive as the empty string, and an empty
                // non-binary patch drew as a blank page — or, on the row below,
                // as "binary".
                if let incomplete = patch.incomplete {
                    ContentUnavailableView(
                        "git did not read this patch",
                        systemImage: "exclamationmark.triangle",
                        description: Text(incomplete == "timeout" ? "It did not answer in time. Open it again." : "It could not produce a diff for this file.")
                    )
                } else if patch.binary {
                    ContentUnavailableView("Binary file", systemImage: "doc", description: Text("No text diff to show."))
                } else if patch.patch.isEmpty {
                    ContentUnavailableView("No textual difference", systemImage: "equal", description: Text("git compared this file and found nothing changed."))
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
                    .font(.system(Theme.caption, design: .monospaced))
                    .foregroundStyle(patchLineColor(line))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(patchLineBackground(line))
            }
            if shown.count < all.count {
                Text("\(all.count - shown.count) more lines — tap the row to read the whole patch.")
                    .font(.system(Theme.caption))
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
                // Same three cases the pushed page tells apart — see `PatchView`.
                if let incomplete = patch.incomplete {
                    Text(incomplete == "timeout" ? "git did not answer in time — try again." : "git could not produce a diff for this file.")
                        .font(.system(Theme.caption))
                        .foregroundStyle(Theme.statusAmber)
                } else if patch.binary {
                    Text("Binary file — no text diff to show.")
                        .font(.system(Theme.caption))
                        .foregroundStyle(Theme.textMuted)
                } else if patch.patch.isEmpty {
                    Text("No textual difference.")
                        .font(.system(Theme.caption))
                        .foregroundStyle(Theme.textMuted)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        PatchLines(patch: patch.patch, limit: Self.lineCap).padding(10)
                    }
                    .background(Theme.codeBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            } else if let error {
                Text(error).font(.system(Theme.caption)).foregroundStyle(Theme.statusRed)
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
