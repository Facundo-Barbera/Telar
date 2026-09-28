import Foundation

enum SessionMenuVerb: Equatable {
    case newSession(projectId: EngineID, baseRef: String?)

    case pin(Bool)
    case settle(Bool)

    case snooze(Timestamp?)
    case rename
    case copy(String)
    case delete
}

struct SessionMenuItem: Identifiable, Equatable {
    var id: String
    var label: String
    var systemImage: String

    var detail: String?

    var disabled: String?
    var destructive = false
    var verb: SessionMenuVerb?
    var children: [SessionMenuItem]?
}

enum SessionRowMenu {
    static let noProject = "This session belongs to no project."
    static let waiting = "Something here is waiting on you."
    static let running = "A turn is running here."
    static let archived = "This conversation is over."
    static let runningDelete = "A turn is running. Stop it before deleting."
    static let waitingDelete = "A request here is waiting on you. Answer or stop it first."

    static func items(
        session: Session,
        projectName: String?,
        settled: Bool,
        cockpitURL: URL?,
        now: Date
    ) -> [SessionMenuItem] {
        var items: [SessionMenuItem] = []
        let stamp = Timestamp(now.timeIntervalSince1970 * 1000)
        let branch = session.workspace.branch

        items.append(SessionMenuItem(
            id: "new-session",
            label: branch.map { "New session on \($0)" } ?? "New session in \(projectName ?? "this project")",
            systemImage: "square.and.pencil",
            disabled: session.projectId == nil ? noProject : nil,
            verb: session.projectId.map { .newSession(projectId: $0, baseRef: branch) }
        ))

        if session.state != .archived {
            let pinned = session.settledOverride == "active"
            items.append(SessionMenuItem(
                id: "pin",
                label: pinned ? "Unpin" : "Pin to the list",
                systemImage: pinned ? "pin.slash" : "pin",
                verb: .pin(!pinned)
            ))

            items.append(SessionMenuItem(
                id: "settle",
                label: settled ? "Un-settle" : "Settle",
                systemImage: settled ? "arrow.uturn.backward" : "checkmark",
                disabled: settled ? nil : settleRefusal(session),
                verb: .settle(!settled)
            ))

            if Settling.isSnoozed(session, now: stamp), let until = session.snoozedUntil {
                items.append(SessionMenuItem(
                    id: "snooze",
                    label: "Wake now",
                    systemImage: "arrow.uturn.backward",
                    detail: wakeLabel(until, now: stamp),
                    verb: .snooze(nil)
                ))
            } else {
                items.append(SessionMenuItem(
                    id: "snooze",
                    label: "Snooze",
                    systemImage: "moon.zzz",
                    disabled: session.activity == .blocked ? waiting : nil,
                    children: snoozePresets(now: now).map { preset in
                        SessionMenuItem(
                            id: "snooze-\(preset.id)",
                            label: preset.label,
                            systemImage: "moon.zzz",
                            detail: preset.when,
                            verb: .snooze(preset.until)
                        )
                    }
                ))
            }
        }

        items.append(SessionMenuItem(
            id: "rename",
            label: "Rename",
            systemImage: "pencil",
            disabled: session.state == .archived ? archived : nil,
            verb: .rename
        ))

        var copies: [SessionMenuItem] = []
        if let cockpitURL {
            copies.append(SessionMenuItem(id: "copy-link", label: "Link", systemImage: "link",
                                          verb: .copy(cockpitURL.absoluteString)))
        }

        if let path = session.workspace.path {
            copies.append(SessionMenuItem(id: "copy-path", label: "Path", systemImage: "folder",
                                          verb: .copy(path)))
        }
        if let branch {
            copies.append(SessionMenuItem(id: "copy-branch", label: "Branch", systemImage: "arrow.triangle.branch",
                                          verb: .copy(branch)))
        }
        copies.append(SessionMenuItem(id: "copy-id", label: "Session ID", systemImage: "number",
                                      verb: .copy(session.id)))
        items.append(SessionMenuItem(id: "copy", label: "Copy", systemImage: "doc.on.doc", children: copies))

        items.append(SessionMenuItem(
            id: "delete",
            label: "Delete session",
            systemImage: "trash",
            disabled: deleteRefusal(session),
            destructive: true,
            verb: .delete
        ))

        return items
    }

    static func settleRefusal(_ session: Session) -> String? {
        if session.activity == .blocked { return waiting }
        return Settling.isWorking(session) ? running : nil
    }

    static func deleteRefusal(_ session: Session) -> String? {
        if session.activity == .blocked { return waitingDelete }
        return Settling.isWorking(session) ? runningDelete : nil
    }

    static func wakeLabel(_ snoozedUntil: Timestamp, now: Timestamp) -> String {
        let remaining = Double(snoozedUntil - now)
        guard remaining > 0 else { return "now" }
        let minute = 60_000.0, hour = 3_600_000.0, day = 86_400_000.0
        if remaining < hour { return "\(max(1, Int(ceil(remaining / minute))))m" }
        if remaining < day { return "\(Int(ceil(remaining / hour)))h" }
        return "\(Int(ceil(remaining / day)))d"
    }
}
