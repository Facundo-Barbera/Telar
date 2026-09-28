import SwiftUI

/// The base-ref picker as a searchable sheet — a nested menu cannot search,
/// and a repo with a hundred branches makes a flat list unusable.
///
/// Browsing shows the three answers most picks want pinned on top (Current
/// HEAD, the remote's default, the branch you are on), then locals with
/// same-named `origin/` twins folded away. SEARCHING SUSPENDS THE FOLD:
/// a typed query means "show me everything that matches", including the
/// shadowed remote that may be ahead. Same rules as the web's picker.
struct BranchPickerSheet: View {
    let git: GitOverview?
    /// nil = the checkout's HEAD.
    let selected: String?
    let onPick: (String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var refs: [GitRefEntry] { git?.refs ?? [] }
    private var trimmed: String { query.trimmingCharacters(in: .whitespaces).lowercased() }
    private var browsing: Bool { trimmed.isEmpty }

    private func short(_ ref: GitRefEntry) -> String {
        guard ref.kind == "remote", let slash = ref.name.firstIndex(of: "/") else { return ref.name }
        return String(ref.name[ref.name.index(after: slash)...])
    }

    private var visible: [GitRefEntry] {
        if !browsing {
            return refs.filter { $0.name.lowercased().contains(trimmed) }
        }
        let pinned: Set<String> = Set([git?.defaultBase, git?.branch].compactMap { $0 })
        let localNames = Set(refs.filter { $0.kind == "local" }.map(\.name))
        return refs.filter { ref in
            !pinned.contains(ref.name) && !(ref.kind == "remote" && localNames.contains(short(ref)))
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if browsing {
                    pickRow(nil, label: "Current HEAD", badge: nil, mono: false)
                    if let base = git?.defaultBase {
                        pickRow(base, label: base, badge: "default", mono: true)
                    }
                    if let current = git?.branch, current != git?.defaultBase {
                        pickRow(current, label: current, badge: "current", mono: true)
                    }
                }
                section("Local", visible.filter { $0.kind == "local" }.prefix(40)) { ref in
                    pickRow(ref.name, label: ref.name, badge: ref.head == true ? "current" : nil, mono: true)
                }
                section("Origin", visible.filter { $0.kind == "remote" }.prefix(40)) { ref in
                    pickRow(ref.name, label: ref.name, badge: "remote", mono: true)
                }
                if !browsing && visible.isEmpty {
                    Text("No matching branches.")
                        .font(.system(Theme.footnote))
                        .foregroundStyle(Theme.textMuted)
                        .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.sheet)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search branches")
            .navigationTitle("Start from")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder private func section<Rows: RandomAccessCollection>(
        _ title: String, _ rows: Rows, @ViewBuilder row: @escaping (GitRefEntry) -> some View
    ) -> some View where Rows.Element == GitRefEntry {
        if !rows.isEmpty {
            Section {
                ForEach(Array(rows)) { row($0) }
            } header: {
                Text(title)
                    .font(.system(Theme.footnote, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    private func pickRow(_ value: String?, label: String, badge: String?, mono: Bool) -> some View {
        Button {
            onPick(value)
            dismiss()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.textMuted)
                Text(label)
                    .font(mono ? .system(Theme.subhead, design: .monospaced) : .system(Theme.subhead))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 8)
                if let badge {
                    Text(badge)
                        .font(.system(Theme.caption))
                        .foregroundStyle(Theme.textMuted)
                }
                if selected == value {
                    Image(systemName: "checkmark")
                        .font(.system(Theme.footnote, weight: .medium))
                        .foregroundStyle(Theme.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Theme.borderSubtle)
    }
}
