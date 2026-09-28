import SwiftUI

/// Register a project from the phone: drill through the MAC's folders
/// (`/api/fs` — directories only, repositories badged), land on the one you
/// want, name it, register. The browser starts at the Mac's home folder.
struct AddProjectView: View {
    let api: any EngineAPI
    /// Called with the registered project — the caller refreshes its list.
    let onAdded: (ProjectRef) -> Void

    var body: some View {
        DirectoryBrowserView(api: api, path: nil, onAdded: onAdded)
    }
}

struct DirectoryBrowserView: View {
    let api: any EngineAPI
    /// nil = the Mac's home folder.
    let path: String?
    let onAdded: (ProjectRef) -> Void

    @State private var listing: DirectoryListing?
    @State private var error: String?
    @State private var naming = false
    @State private var name = ""
    @State private var registering = false

    var body: some View {
        Group {
            if let listing {
                ScrollView {
                    VStack(spacing: 12) {
                        useThisFolder(listing)
                        if !listing.dirs.isEmpty {
                            VStack(spacing: 0) {
                                ForEach(Array(listing.dirs.enumerated()), id: \.element.id) { index, dir in
                                    NavigationLink(value: dir) {
                                        HStack(spacing: 12) {
                                            Image(systemName: dir.git ? "arrow.triangle.branch" : "folder")
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
                                    if index < listing.dirs.count - 1 {
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
                self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
            }
        }
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
            self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
