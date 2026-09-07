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
            HStack(alignment: .top, spacing: 12) {
                TelarMark(color: color(context.state)).frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text("TELAR").font(.caption2.weight(.semibold))
                        Spacer()
                        Text(context.attributes.hostName).font(.caption2).lineLimit(1)
                    }.foregroundStyle(.secondary)
                    Text(context.state.title).font(.headline).lineLimit(2).privacySensitive()
                    HStack {
                        Text(context.isStale ? "Waiting for an update" : context.state.status).font(.subheadline).foregroundStyle(color(context.state))
                        Spacer()
                        if !context.state.ended && !context.isStale {
                            Text(context.state.startedAt, style: .timer).font(.caption.monospacedDigit()).multilineTextAlignment(.trailing)
                        }
                    }
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
                    Label("Telar", systemImage: "point.3.connected.trianglepath.dotted").font(.caption).foregroundStyle(color(context.state))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if !context.state.ended && !context.isStale { Text(context.state.startedAt, style: .timer).font(.caption.monospacedDigit()) }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
                        Text(context.isStale ? "Waiting for an update" : context.state.status).font(.caption).foregroundStyle(color(context.state))
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                TelarMark(color: color(context.state)).frame(width: 20, height: 20)
            } compactTrailing: {
                if let count = context.state.activeCount, count > 1 { Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(color(context.state)) }
                else { Image(systemName: symbol(context.state, stale: context.isStale)).foregroundStyle(color(context.state)) }
            } minimal: {
                Image(systemName: symbol(context.state, stale: context.isStale)).foregroundStyle(color(context.state))
            }
            .widgetURL(context.attributes.url(sessionId: context.state.sessionId))
            .keylineTint(color(context.state))
        }
    }
    private func color(_ state: SessionActivityAttributes.ContentState) -> Color {
        if state.status == "Needs you" { return .orange }
        if state.status == "Failed" { return .red }
        if state.ended { return .mint }
        return .cyan
    }
    private func symbol(_ state: SessionActivityAttributes.ContentState, stale: Bool) -> String {
        if stale { return "wifi.slash" }
        if state.status == "Needs you" || state.status == "Failed" { return "exclamationmark" }
        return state.ended ? "checkmark" : "ellipsis"
    }
}
