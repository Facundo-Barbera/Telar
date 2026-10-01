import SwiftUI

struct AddProjectView: View {
    let api: any EngineAPI
    let onAdded: (ProjectRef) -> Void

    var body: some View {
        DirectoryBrowserView(api: api, path: nil, onAdded: onAdded)
    }
}

struct DirectoryBrowserView: View {
    let api: any EngineAPI
    let path: String?
    let onAdded: (ProjectRef) -> Void

    @State private var listing: DirectoryListing?
    @State private var error: String?
    @State private var naming = false
    @State private var name = ""
    @State private var registering = false
    @State private var typed = ""
    @State private var typedError: String?
    @State private var checking = false
    @State private var jump: DirectoryEntry?

    var body: some View {
        Group {
            if let listing {
                ScrollView {
                    VStack(spacing: 12) {
                        useThisFolder(listing)
                        if path == nil {
                            pathField
                            let roots = FolderPath.otherRoots(of: listing)
                            if !roots.isEmpty { card(roots, icon: { _ in "externaldrive" }) }
                        }
                        if !listing.dirs.isEmpty {
                            card(listing.dirs, icon: { $0.git ? "arrow.triangle.branch" : "folder" })
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
                }
            } else if let error {
                ContentUnavailableView("Could not browse", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .background(Theme.sheet)
        .navigationTitle(listing?.name ?? "Browse")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: DirectoryEntry.self) { dir in
            DirectoryBrowserView(api: api, path: dir.path, onAdded: onAdded)
        }
        .navigationDestination(item: $jump) { dir in
            DirectoryBrowserView(api: api, path: dir.path, onAdded: onAdded)
        }
        .alert("Name the project", isPresented: $naming) {
            TextField("Name", text: $name)
            Button("Add project") { Task { await register() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(listing?.path ?? "")
        }
        .task {
            do {
                listing = try await api.listDirectories(path: path)
            } catch {
                self.error = message(for: error)
            }
        }
    }

    private var pathField: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "text.cursor")
                    .foregroundStyle(Theme.textMuted)
                TextField("/Volumes/Drive/project", text: $typed)
                    .font(.system(Theme.footnote, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { Task { await openTyped() } }
                if checking { ProgressView() }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            if let typedError {
                Text(typedError)
                    .font(.system(Theme.footnote))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
            }
        }
    }

    private func card(_ entries: [DirectoryEntry], icon: @escaping (DirectoryEntry) -> String) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, dir in
                NavigationLink(value: dir) {
                    HStack(spacing: 12) {
                        Image(systemName: icon(dir))
                            .font(.system(Theme.subhead))
                            .foregroundStyle(dir.git ? Theme.accent : Theme.textMuted)
                            .frame(width: 27)
                        Text(dir.name)
                            .font(.system(.callout, weight: dir.git ? .bold : .regular))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.system(Theme.footnote, weight: .medium))
                            .foregroundStyle(Theme.chevron)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if index < entries.count - 1 {
                    Rectangle().fill(Theme.borderSubtle).frame(height: 1)
                }
            }
        }
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func useThisFolder(_ listing: DirectoryListing) -> some View {
        Button {
            name = listing.name
            naming = true
        } label: {
            HStack(spacing: 10) {
                if registering {
                    ProgressView()
                } else {
                    Image(systemName: "plus.circle.fill").font(.system(.body))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Use this folder")
                        .font(.system(Theme.subhead, weight: .bold))
                    Text(listing.path)
                        .font(.system(Theme.footnote, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.head)
                        .opacity(0.7)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.primaryGlyph)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(Theme.primaryFill)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .disabled(registering)
    }

    private func openTyped() async {
        switch FolderPath.parse(typed) {
        case .failure(let invalid):
            typedError = invalid.message
        case .success(let target):
            checking = true
            defer { checking = false }
            do {
                let found = try await api.listDirectories(path: target)
                typedError = nil
                jump = DirectoryEntry(name: found.name, path: found.path, git: false)
            } catch {
                typedError = message(for: error)
            }
        }
    }

    private func register() async {
        guard let listing else { return }
        registering = true
        defer { registering = false }
        do {
            let trimmed = name.trimmingCharacters(in: .whitespaces)
            let project = try await api.registerProject(
                name: trimmed.isEmpty ? listing.name : trimmed,
                root: listing.path
            )
            onAdded(project)
        } catch {
            self.error = message(for: error)
        }
    }

    private func message(for error: Error) -> String {
        (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
    }
}
