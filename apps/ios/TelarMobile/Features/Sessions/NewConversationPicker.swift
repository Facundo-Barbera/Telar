import SwiftUI

struct NewConversationPicker: View {
    let model: NewConversationModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var addingOn: Host?
    @ScaledMetric(relativeTo: .callout) private var mark: CGFloat = 27

    private var sections: [NewConversationSection] {
        NewConversationTargets.sections(model.targets, activity: model.activity, lastUsed: model.memory.lastTarget, query: query)
    }

    var body: some View {
        NavigationStack {
            List {
                if sections.isEmpty {
                    Text(model.loading ? "Loading projects…" : model.targets.isEmpty ? "No computer reported a project." : "No project matches that.")
                        .foregroundStyle(Theme.textMuted)
                }
                ForEach(sections) { section in
                    Section {
                        ForEach(section.targets) { target in row(target, recent: section.title == "Recent") }
                    } header: {
                        if let title = section.title { Text(title) }
                    }
                }
                Section { addProject }
            }
            .navigationTitle("Project")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Search projects")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .sheet(item: $addingOn) { host in
                NavigationStack {
                    if let api = model.settings.api(for: host.id) {
                        AddProjectView(api: api) { project in
                            model.pick(NewConversationTarget(hostId: host.id, hostName: host.name, project: project))
                            addingOn = nil
                            dismiss()
                        }
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { addingOn = nil } } }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ target: NewConversationTarget, recent: Bool) -> some View {
        Button {
            model.pick(target)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                ProjectAvatar(name: target.project.name, projectId: target.project.id, hostId: target.hostId,
                              icon: target.project.icon, api: model.settings.api(for: target.hostId), size: mark)
                VStack(alignment: .leading, spacing: 2) {
                    Text(target.project.name).font(.system(.callout, weight: .semibold)).foregroundStyle(Theme.text)
                    if let detail = detail(target, recent: recent) {
                        Text(detail).font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                if target.id == model.draft.target?.id {
                    Image(systemName: "checkmark").foregroundStyle(Theme.accent)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(target.project.name)
    }

    private func detail(_ target: NewConversationTarget, recent: Bool) -> String? {
        let host = recent && model.hostCount > 1 ? target.hostName : nil
        let path = NewConversationTargets.showsPath(target, among: model.targets) ? target.root : nil
        let parts = [host, path].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder private var addProject: some View {
        let hosts = model.settings.hosts
        if hosts.count > 1 {
            Menu {
                ForEach(hosts) { host in Button(host.name, systemImage: "desktopcomputer") { addingOn = host } }
            } label: { Label("Add project…", systemImage: "plus.circle") }
        } else if let host = hosts.first {
            Button("Add project…", systemImage: "plus.circle") { addingOn = host }
        }
    }
}
