import Foundation

/// THE PROJECT HEADER'S MENU, the one rule in it worth a test.
///
/// The other four rows are a label and a call the sidebar already had; this
/// one is a set operation on the collapsed set, and getting it backwards
/// (collapsing everything, or collapsing nothing) looks the same from the
/// outside until you open the app.
enum ProjectHeaderMenu {
    /// LEAVE ONLY THIS GROUP OPEN. Every other group the rail is showing goes
    /// into the collapsed set, and the kept one comes out of it — so pressing
    /// it on an already-collapsed group expands that group, which is the
    /// desktop's behaviour and the only reading of "leaves only that one".
    static func collapseOthers(all: [String], keeping id: String) -> Set<String> {
        Set(all).subtracting([id])
    }
}
