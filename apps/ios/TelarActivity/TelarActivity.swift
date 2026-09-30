import ActivityKit
import SwiftUI
import WidgetKit

@main
struct TelarActivityBundle: WidgetBundle {
    var body: some Widget { SessionLiveActivity() }
}

struct SessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    TelarLogo(size: 22)
                    Text(context.attributes.hostName).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Spacer()
                    Text(headline(context.state, stale: context.isStale)).font(.caption).foregroundStyle(color(context.state))
                    if !context.state.ended && !context.isStale {
                        Text(context.state.startedAt, style: .timer).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(maxWidth: 52, alignment: .trailing)
                    }
                }
                if let rows = context.state.rows, !rows.isEmpty {
                    ForEach(rows) { row in
                        Link(destination: context.attributes.url(sessionId: row.id)) { RowView(row: row, color: statusColor(row.status), host: context.attributes.hostName) }
                    }
                } else {
                    Text(context.state.title).font(.headline).lineLimit(2).privacySensitive()
                }
            }
            .padding(16)
            .activityBackgroundTint(Color(white: 0.10))
            .activitySystemActionForegroundColor(.white)
            .foregroundStyle(.white)
            .widgetURL(context.attributes.url(sessionId: context.state.sessionId))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label { Text(context.attributes.hostName).lineLimit(1) } icon: { TelarLogo(size: 16) }.font(.caption)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(headline(context.state, stale: context.isStale)).font(.caption).foregroundStyle(color(context.state))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let rows = context.state.rows, !rows.isEmpty {
                            ForEach(rows.prefix(3)) { row in
                                Link(destination: context.attributes.url(sessionId: row.id)) { RowView(row: row, color: statusColor(row.status), host: context.attributes.hostName, compact: true) }
                            }
                        } else {
                            Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                TelarLogo(size: 20)
            } compactTrailing: {
                if let count = context.state.activeCount, count > 1 { Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(color(context.state)) }
                else { Image(systemName: statusSymbol(context.state.status, ended: context.state.ended, stale: context.isStale)).foregroundStyle(color(context.state)) }
            } minimal: {
                Image(systemName: statusSymbol(context.state.status, ended: context.state.ended, stale: context.isStale)).foregroundStyle(color(context.state))
            }
            .widgetURL(context.attributes.url(sessionId: context.state.sessionId))
            .keylineTint(color(context.state))
        }
    }

    private func headline(_ state: SessionActivityAttributes.ContentState, stale: Bool) -> String {
        if stale { return "Waiting for an update" }
        if state.rows?.contains(where: \.needsYou) == true { return "Needs you" }
        guard let count = state.activeCount, count > 0, state.rows != nil else { return state.status }
        return "\(count) active"
    }
    private func color(_ state: SessionActivityAttributes.ContentState) -> Color {
        state.rows?.contains(where: \.needsYou) == true ? .orange : state.ended && state.status != "Failed" ? .mint : statusColor(state.status)
    }
}

private func statusColor(_ status: String) -> Color {
    switch status {
    case "Needs you": .orange
    case "Failed": .red
    case "Done": .mint
    case "Queued", "Background": .secondary
    default: .cyan
    }
}

private func statusSymbol(_ status: String, ended: Bool, stale: Bool) -> String {
    if stale { return "wifi.slash" }
    if status == "Needs you" || status == "Failed" { return "exclamationmark" }
    return ended || status == "Done" ? "checkmark" : "ellipsis"
}

private struct RowView: View {
    var row: SessionActivityRow
    var color: Color
    var host: String
    var compact = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: statusSymbol(row.status, ended: false, stale: false)).font(.caption2.weight(.bold)).foregroundStyle(color).frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title ?? row.project ?? host).font(compact ? .caption : .subheadline).lineLimit(1).privacySensitive()
                let detail = [row.title == nil ? nil : row.project, row.workersLabel].compactMap { $0 }.joined(separator: " · ")
                if !compact, !detail.isEmpty {
                    Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Text(row.status).font(.caption2).foregroundStyle(color)
        }
    }
}
