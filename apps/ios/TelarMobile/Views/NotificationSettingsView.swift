import SwiftUI

struct NotificationSettingsView: View {
    @State private var notifications = MobileNotifications.shared
    @State private var enabled = MobileNotifications.shared.enabled
    @State private var completions = MobileNotifications.shared.completions
    @State private var liveActivities = MobileNotifications.shared.liveActivities
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
                // AND THE ONE THAT IS NOT ABOUT THIS PHONE (#579). A Mac with
                // no push relay will send nothing however this screen is set,
                // and the fix is on that machine — so it is said here in full,
                // under the toggle it makes irrelevant, rather than folded into
                // a status line somebody would read as a network hiccup.
                if !notifications.readiness.missingRelay.isEmpty {
                    PushRelayBanner()
                }
                Button("Check connection") { Task { await notifications.syncRegistrations() } }
                Button("Open system Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
            Section("Live Activities") {
                Toggle("Automatic Live Activities", isOn: $liveActivities)
                    .onChange(of: liveActivities) { _, value in Task { await notifications.setLiveActivities(value) } }
                Text("A Live Activity starts automatically when a Mac has active agent work, highlights sessions that need you, and finishes when the work is done. Updates appear on the Lock Screen and Dynamic Island, including while Telar is in the background.")
                // WHY THERE IS NO CARD, when there is none: this phone's side
                // first, then what each Mac says happened to its last start.
                ForEach(notifications.liveActivityDiagnosis, id: \.self) { line in
                    Text(line).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Notifications & activities")
        // Each Mac's Live Activity report rides on the registration reply, so
        // opening this screen asks again rather than showing an old answer.
        .task { await notifications.syncRegistrations() }
    }
}
