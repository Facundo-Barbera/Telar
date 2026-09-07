import SwiftUI

struct NotificationSettingsView: View {
    @State private var notifications = MobileNotifications.shared
    @State private var enabled = MobileNotifications.shared.enabled
    @State private var completions = MobileNotifications.shared.completions
    @State private var previews = MobileNotifications.shared.previews
    var body: some View {
        Form {
            Section {
                Toggle("Notifications", isOn: $enabled)
                    .onChange(of: enabled) { _, value in
                        Task {
                            if value { await notifications.enable(); enabled = notifications.enabled }
                            else { notifications.enabled = false; await notifications.syncRegistrations() }
                        }
                    }
                Toggle("Work completed", isOn: $completions)
                    .onChange(of: completions) { _, value in
                        notifications.completions = value
                        Task { await notifications.syncRegistrations() }
                    }
                Toggle("Show session titles", isOn: $previews)
                    .onChange(of: previews) { _, value in
                        notifications.previews = value
                        Task { await notifications.refreshActivityPrivacy(); await notifications.syncRegistrations() }
                    }
            } header: { Text("Stay in touch with your work") } footer: {
                Text("Get notified when a session needs you or fails. Session titles stay private unless you enable previews. You can mute individual sessions from their menu.")
            }
            Section("Connection") {
                Text(notifications.status).font(.subheadline)
                Button("Check connection") { Task { await notifications.syncRegistrations() } }
                Button("Open system Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
            Section("Live Activities") {
                Text("Choose Follow session from a conversation’s menu to see its status on the Lock Screen and Dynamic Island. Background updates require push delivery from that Mac.")
                Text("Following \(notifications.followed.count) session(s)").foregroundStyle(Theme.textMuted)
            }
        }.navigationTitle("Notifications & activities")
    }
}
