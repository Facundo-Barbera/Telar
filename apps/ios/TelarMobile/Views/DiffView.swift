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
                    }
                    if !diff.commits.isEmpty {
                        Section {
                            ForEach(diff.commits) { commit in
                                HStack(spacing: 10) {
                                    Text(commit.shortSha)
                                        .font(.system(size: 12, design: .monospaced))
                                        .foregroundStyle(Theme.textTertiary)
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
                                .foregroundStyle(Theme.textTertiary)
                        }
                    }
                    if diff.files.isEmpty && diff.commits.isEmpty {
                        Text("No changes yet.")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textMuted2)
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
                        .foregroundStyle(Theme.textMuted2)
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
                    .foregroundStyle(Theme.textTertiary)
            }
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
                    .foregroundStyle(Theme.textTertiary)
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
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(patch.patch.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                                Text(String(line))
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(lineColor(line))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(lineBackground(line))
                            }
                        }
                        .padding(12)
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

    private func lineColor(_ line: Substring) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Theme.statusEmerald }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Theme.statusRed }
        if line.hasPrefix("@@") { return Theme.statusSky }
        return Theme.textMuted2
    }

    private func lineBackground(_ line: Substring) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Theme.statusEmerald.opacity(0.08) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Theme.statusRed.opacity(0.08) }
        return .clear
    }
}
