import SwiftUI

struct StashSheet: View {
    let onPick: (StashEntry) -> Void
    @Environment(\.dismiss) private var dismiss
    private var stash: PromptStash { .shared }

    var body: some View {
        NavigationStack {
            Group {
                if stash.entries.isEmpty {
                    ContentUnavailableView(
                        "Nothing stashed",
                        systemImage: "tray",
                        description: Text("Choose Stash this prompt from the composer's + menu to set a draft aside for another conversation.")
                    )
                } else {
                    List {
                        ForEach(stash.entries) { entry in
                            Button {
                                onPick(entry)
                                dismiss()
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: entry.images.isEmpty ? "text.alignleft" : "photo.on.rectangle")
                                        .font(.system(Theme.subhead))
                                        .foregroundStyle(Theme.textMuted)
                                        .frame(width: 20)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(entry.summary).foregroundStyle(Theme.text).lineLimit(1)
                                        Text(stashAgo(entry.at)).font(.caption2).foregroundStyle(Theme.textMuted)
                                    }
                                    Spacer(minLength: 0)
                                    if !entry.images.isEmpty {
                                        Text("\(entry.images.count)")
                                            .font(.caption2.weight(.medium))
                                            .foregroundStyle(Theme.textMuted)
                                            .padding(.horizontal, 6).padding(.vertical, 2)
                                            .background(Theme.subtle, in: Capsule())
                                    }
                                }
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) { stash.drop(entry.id) } label: { Label("Delete", systemImage: "trash") }
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Stash")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

func stashAgo(_ at: Timestamp, now: Date = Date()) -> String {
    let seconds = Int(now.timeIntervalSince1970) - at / 1000
    if seconds < 60 { return "just now" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h ago" }
    let days = hours / 24
    if days < 7 { return "\(days)d ago" }
    return "\(days / 7)w ago"
}
