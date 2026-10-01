import SwiftUI

struct ComposerSuggestionList: View {
    let rows: [ComposerCompletion]
    let active: Int
    let loading: Bool
    let onPick: (ComposerCompletion) -> Void

    @ScaledMetric(relativeTo: .body) private var maxHeight: CGFloat = 260

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if index == 0 || rows[index - 1].group != row.group { header(row.group) }
                        button(row, active: index == active).id(row.id)
                    }
                    if loading {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Reading skills…").font(.system(Theme.footnote)).foregroundStyle(Theme.textMuted)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                    }
                }
                .padding(.vertical, 6)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: maxHeight)
            .fixedSize(horizontal: false, vertical: true)
            .onChange(of: active) { _, index in
                guard rows.indices.contains(index) else { return }
                proxy.scrollTo(rows[index].id)
            }
        }
        .composerGlass(cornerRadius: 18)
    }

    private func header(_ title: String) -> some View {
        Text(title)
            .font(.system(Theme.caption, weight: .semibold))
            .textCase(.uppercase)
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private func button(_ row: ComposerCompletion, active: Bool) -> some View {
        Button { onPick(row) } label: {
            HStack(spacing: 10) {
                Image(systemName: row.symbol)
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.label)
                        .font(.system(Theme.subhead, weight: .medium))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    Text(row.detail)
                        .font(.system(Theme.footnote))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(active ? Theme.accent.opacity(0.14) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(row.detail)
    }
}
