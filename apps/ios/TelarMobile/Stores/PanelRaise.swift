import Foundation

/// WHICH PRESENTATION THE PANEL IS SHOWN IN, AND WHAT A PRESENTATION FLAG
/// COMING BACK MEANS.
///
/// A rule rather than two lines inside `SessionView`, because the second half
/// is what froze the app and there are no view tests to catch it going wrong
/// again.
///
/// WHAT WAS BROKEN. `SessionView` mirrors `PanelModel.isOpen` into a `@State`
/// flag per presentation (`inspectorShown`, `pushShown`) and mirrored the flag
/// back into the model on every change, in BOTH directions. Popping the push on
/// a compact width closed the ring: `panel.close()` and an echo of it flip
/// `isOpen` twice inside one update pass, so `.onChange(of: panel.isOpen)` is
/// also handed the superseded `true`; raising the push off that put `pushShown`
/// back up against a panel that was already closed; and reading THAT as the
/// reader opening the panel called `panel.open()`, which made the stale value
/// true again. The two flags then ping-ponged inside the CoreAnimation commit —
/// `PanelModel.persist()` writing UserDefaults on every lap — and the app never
/// drew another frame.
///
/// THE FIX IS DIRECTIONAL. `.navigationDestination` and `.inspector` never raise
/// their own binding: the app is the only thing that writes `true`, and the
/// system only ever writes `false`, when the reader pops or closes. So a `true`
/// arriving from a presentation is always our own write echoing and carries no
/// intent at all. (`.fullScreenCover`'s watcher in `SessionView` had always
/// been dismissal-only; these two were not.)
enum PanelRaise {
    /// Which presentation an open panel wants at this width.
    ///
    /// ONE AT A TIME. Leaving the column mounted behind a full-screen cover
    /// would run a second copy of every surface — two file reads, two kernels
    /// asked for their state, two editors over one draft.
    static func flags(open: Bool, wantsColumn: Bool, fullScreen: Bool) -> (column: Bool, push: Bool) {
        (column: open && wantsColumn && !fullScreen, push: open && !wantsColumn)
    }

    /// Whether a presentation writing its own flag back is the reader leaving.
    ///
    /// - Parameter shown: the flag as the presentation left it.
    static func isDismissal(_ shown: Bool) -> Bool { !shown }
}
