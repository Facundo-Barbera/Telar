import SwiftUI

/// THE LIST OF PROMPTS YOU SET ASIDE — the web's `ComposerStashMenu`, as a
/// sheet. Each row is the entry's first line; a tap restores it into the box
/// that opened the sheet, a swipe drops it.
struct StashSheet: View {
    let onPick: (StashEntry) -> Void
    @Environment(\.dismiss) private var dismiss
    private var stash: PromptStash { .shared }

    var body: some View {
        NavigationStack {
            Group {
                if stash.entries.isEmpty {
                    // THE ONLY PLACE THE GESTURE IS WRITTEN DOWN: the badge is
                    // hidden while the stash is empty, so this line is the
                    // whole of the feature's discoverability.
                    ContentUnavailableView(
                        "Nothing stashed",
                        systemImage: "tray",
                        description: Text("Tap the tray in the composer with something in the box to set it aside for another conversation.")
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
                                        .font(.system(size: 14))
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

/// The web's `fmtAgo`: coarse, and "just now" under a minute.
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

/// The tray button that sits in the composer's toolbar: hidden while the stash
/// is empty and the box is empty (a "0" is chrome advertising a feature you
/// have not used); "put in" when the box has text, "take out" when it does
/// not and the stash has something. Long-press always opens the list.
struct StashButton: View {
    let hasDraft: Bool
    let onStash: () -> Void
    let onOpen: () -> Void
    private var count: Int { PromptStash.shared.entries.count }

    var body: some View {
        if hasDraft || count > 0 {
            Button {
                if hasDraft { onStash() } else { onOpen() }
            } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: hasDraft ? "tray.and.arrow.down" : "tray.full")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.text)
                        .frame(width: 44, height: 44)
                        .background(Theme.subtle)
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                    if count > 0 {
                        Text("\(count)")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.primaryGlyph)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Theme.accent, in: Capsule())
                            .offset(x: 4, y: -2)
                    }
                }
            }
            .accessibilityLabel(hasDraft ? "Stash this prompt" : "Stashed prompts")
            .contextMenu {
                if hasDraft { Button("Stash this prompt", systemImage: "tray.and.arrow.down", action: onStash) }
                Button("Show stashed prompts", systemImage: "tray.full", action: onOpen)
            }
            .keyboardShortcut("s", modifiers: .command)
        }
    }
}
