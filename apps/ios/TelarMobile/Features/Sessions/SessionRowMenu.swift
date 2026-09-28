import Foundation

/**
 THE SESSION ROW'S LONG-PRESS MENU, AS A DECISION RATHER THAN A VIEW — the
 phone's half of `apps/web/lib/session-action-menu.ts`, and ported for the
 reason that file states about itself: the menu IS a list of decisions (which
 verbs exist, in what order, and when each one is refused), and every one of
 them is answerable without drawing anything.

 WHY IT IS NOT WRITTEN INLINE IN THE `.contextMenu`. The Mac's list is the
 thing this must match, item for item and label for label (#326), and a
 `.contextMenu` closure can only be checked by a person opening the app and
 reading it. Here the order and the words are a value a test can hold, so the
 two menus can be compared rather than trusted.

 ══ WHAT THE VIEW STILL OWNS ══

 Every side effect, and all the chrome. `SessionMenuVerb` says WHAT a row does
 — this file never calls the engine, never touches the clipboard and never
 navigates. `SessionSidebar` maps the verbs onto the calls it already makes.

 ══ WHERE THE PHONE IS ALLOWED TO DIFFER ══

   - OPEN IS ABSENT, and so is "Open in a new window". The long-press target is
     the row, and a tap on it opens the session; the Mac keeps `Open` because
     three surfaces render one list and a breadcrumb has no default gesture.
     There is one surface here, and no window shell to open a second of.
   - PROJECT SETTINGS IS ABSENT because the phone has no per-project settings
     screen to send anyone to (#192, #308). A row that could only ever be inert
     is worse than none — the same call `session-action-menu.ts` makes about
     "Open in a new window" on the web.

 Everything else is the Mac's, in the Mac's order and with the Mac's words.
 */
enum SessionMenuVerb: Equatable {
    /// `baseRef` is this session's OWN branch, so the sibling is cut from
    /// where this one works. Nil for a local session, which has none of its
    /// own — see `SessionWorkspace.branch`.
    case newSession(projectId: EngineID, baseRef: String?)
    /// `true` pins the session to the list, `false` clears the pin.
    case pin(Bool)
    case settle(Bool)
    /// Nil wakes it now.
    case snooze(Timestamp?)
    case rename
    case copy(String)
    case delete
}

/// One row. An item carries a verb or children, never both — the two submenus
/// (Snooze, Copy) are exactly one level deep, which is what lets the view
/// render them without a recursive `@ViewBuilder`.
struct SessionMenuItem: Identifiable, Equatable {
    /// Stable across a toggle: `pin` is `pin` whether it reads Pin or Unpin,
    /// so a test can follow one row through the swap.
    var id: String
    var label: String
    var systemImage: String
    /// The right-hand column — a resolved snooze time, a wake countdown. It
    /// COMPLEMENTS the label rather than repeating it.
    var detail: String?
    /// WHY it cannot be done, or nil when it can. A reason rather than a
    /// boolean, because a disabled row that does not say why is a dead end.
    var disabled: String?
    var destructive = false
    var verb: SessionMenuVerb?
    var children: [SessionMenuItem]?
}

enum SessionRowMenu {
    /// Kept in one place so two rows cannot word the same refusal twice —
    /// the Mac's sentences, verbatim.
    static let noProject = "This session belongs to no project."
    static let waiting = "Something here is waiting on you."
    static let running = "A turn is running here."
    static let archived = "This conversation is over."
    static let runningDelete = "A turn is running. Stop it before deleting."
    static let waitingDelete = "A request here is waiting on you. Answer or stop it first."

    /**
     THE MENU, IN THE MAC'S ORDER.

     Pure: same arguments in, same list out. `settled` is folded by the caller
     rather than derived here, for the reason `SessionActionTarget.settled`
     gives — deciding it needs the reader's inbox policy, and a menu has no
     business fetching one. A session settled by the inactivity clock has no
     override to clear, so its toggle must still read "Un-settle".

     `cockpitURL` absent drops Copy ▸ Link rather than copying a path: a
     relative link pasted into somebody's message is not a link.
     */
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

        /* ── Another one of these ─────────────────────────────────────────── */

        // THE LABEL NAMES WHERE IT WILL RUN, which is what makes "another one
        // of these" a checkable claim rather than navigation.
        items.append(SessionMenuItem(
            id: "new-session",
            label: branch.map { "New session on \($0)" } ?? "New session in \(projectName ?? "this project")",
            systemImage: "square.and.pencil",
            disabled: session.projectId == nil ? noProject : nil,
            verb: session.projectId.map { .newSession(projectId: $0, baseRef: branch) }
        ))

        /* ── The inbox verbs ──────────────────────────────────────────────── */

        // THE WHOLE GROUP IS ABSENT ON AN ARCHIVED SESSION. Pinning, settling
        // and snoozing are all about the LIST, and an archived session is off
        // it by a decision that outranks every one of them.
        if session.state != .archived {
            let pinned = session.settledOverride == "active"
            items.append(SessionMenuItem(
                id: "pin",
                label: pinned ? "Unpin" : "Pin to the list",
                systemImage: pinned ? "pin.slash" : "pin",
                verb: .pin(!pinned)
            ))

            // ONLY THE SETTLING DIRECTION IS GATED. Coming back from settled is
            // always allowed: the refusal is about shelving a session somebody
            // still needs, never about un-shelving one.
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
                // THE REFUSAL SITS ON THE PARENT. A submenu whose five rows are
                // all inert for one reason should not have to be opened to
                // learn it. A RUNNING session is snoozable — snoozing only
                // changes what you are shown — and a blocked one is not.
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

        /* ── The name ─────────────────────────────────────────────────────── */

        items.append(SessionMenuItem(
            id: "rename",
            label: "Rename",
            systemImage: "pencil",
            disabled: session.state == .archived ? archived : nil,
            verb: .rename
        ))

        /* ── Facts about it ───────────────────────────────────────────────── */

        // THE LINK LEADS, because it is the one people copy to give to someone
        // else — the other three are facts you copy to use yourself. The branch
        // is only a worktree session's own.
        var copies: [SessionMenuItem] = []
        if let cockpitURL {
            copies.append(SessionMenuItem(id: "copy-link", label: "Link", systemImage: "link",
                                          verb: .copy(cockpitURL.absoluteString)))
        }
        // A conversation with no checkout has no path to copy — the item is
        // absent rather than copying an empty string (#526).
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

        /* ── The end of the lifecycle ─────────────────────────────────────── */

        // THE ENGINE REFUSES A DELETE UNDER A LIVE TURN, so the row says so
        // here rather than being offered and then rejected. "Stop it" and
        // "answer it" are different things to go and do, so they are different
        // sentences.
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

    /// `canSettle` with its refusal spelled out — a reader learns whether to
    /// stop the work or answer the question.
    static func settleRefusal(_ session: Session) -> String? {
        if session.activity == .blocked { return waiting }
        return Settling.isWorking(session) ? running : nil
    }

    static func deleteRefusal(_ session: Session) -> String? {
        if session.activity == .blocked { return waitingDelete }
        return Settling.isWorking(session) ? runningDelete : nil
    }

    /// How long is left on the snooze — the Mac's `wakeLabel`, to the unit.
    static func wakeLabel(_ snoozedUntil: Timestamp, now: Timestamp) -> String {
        let remaining = Double(snoozedUntil - now)
        guard remaining > 0 else { return "now" }
        let minute = 60_000.0, hour = 3_600_000.0, day = 86_400_000.0
        if remaining < hour { return "\(max(1, Int(ceil(remaining / minute))))m" }
        if remaining < day { return "\(Int(ceil(remaining / hour)))h" }
        return "\(Int(ceil(remaining / day)))d"
    }
}
