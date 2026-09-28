import Foundation

enum PanelRaise {
    static func flags(open: Bool, wantsColumn: Bool, fullScreen: Bool) -> (column: Bool, push: Bool) {
        (column: open && wantsColumn && !fullScreen, push: open && !wantsColumn)
    }

    static func isDismissal(_ shown: Bool) -> Bool { !shown }
}
