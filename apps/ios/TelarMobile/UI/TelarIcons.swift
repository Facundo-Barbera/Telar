import UIKit

/// ID → SF SYMBOL, and nothing else — the phone's half of the identity
/// vocabulary (`packages/engine-client/src/icons.ts`, rendered on the web by
/// `apps/web/lib/telar-icons.tsx`).
///
/// THE STORED VALUE IS A LUCIDE ID, and it stays one. `Project.iconName` is
/// written by the Mac's icon picker in lucide's own kebab-case (`flask-conical`,
/// `terminal`, `rocket`), so this phone cannot store its own vocabulary without
/// the two surfaces disagreeing about what a person picked. The id is the
/// contract; the glyph is each platform's answer to it — lucide there, SF
/// Symbols here.
///
/// THE MAP IS WRITTEN OUT, NOT DERIVED. There is no rule that turns a lucide id
/// into an SF Symbol name (`house` happens to match, `flask-conical` does not,
/// and SF Symbols has no rocket at all), so every pairing is a decision and is
/// written down as one.
///
/// AN ID THIS BUILD CANNOT DRAW IS NOT A MARK. `telarIconSymbol` answers nil
/// both for an id outside the set — a registry written by a newer Mac — and for
/// a symbol this OS does not ship, and `ProjectAvatar` then falls through to the
/// three answers behind it (the checkout's icon, the tinted initial, the
/// folder). That is the same fail-forward the web's `isTelarIcon` guard buys:
/// a downgrade draws a project, never a blank box.
private let telarIconSymbols: [String: String] = [
    // Work, people, places
    "globe": "globe",
    "briefcase": "briefcase",
    "house": "house",
    "building-2": "building.2",
    "user-round": "person",
    "users-round": "person.2",
    "compass": "safari",
    "map": "map",
    // Making and running
    "code": "chevron.left.forwardslash.chevron.right",
    "terminal": "terminal",
    "database": "cylinder.split.1x2",
    "server": "server.rack",
    "cloud": "cloud",
    "box": "shippingbox",
    "layers": "square.stack.3d.up",
    "cpu": "cpu",
    "bot": "brain.head.profile",
    "wrench": "wrench.adjustable",
    "hammer": "hammer",
    "puzzle": "puzzlepiece",
    // Craft
    "pen-tool": "pencil.tip",
    "palette": "paintpalette",
    "camera": "camera",
    "music": "music.note",
    "film": "film",
    "feather": "pencil",
    // Money and study
    "shopping-cart": "cart",
    "credit-card": "creditcard",
    "book": "book",
    "graduation-cap": "graduationcap",
    "flask-conical": "testtube.2",
    // Nature and weather
    "leaf": "leaf",
    "tree-pine": "tree",
    "sun": "sun.max",
    "moon": "moon",
    "flame": "flame",
    // Marks
    "star": "star",
    "heart": "heart",
    "shield": "shield",
    "rocket": "paperplane",
]

/// The SF Symbol for a stored `Project.iconName`, or nil when this build has no
/// glyph for it — see the note above. The `UIImage` probe is the half that
/// matters on an OS older than a symbol: a name that does not resolve renders as
/// nothing at all, which is worse than the initial it would otherwise fall to.
func telarIconSymbol(_ iconName: String?) -> String? {
    guard let iconName, let symbol = telarIconSymbols[iconName] else { return nil }
    return UIImage(systemName: symbol) == nil ? nil : symbol
}

/// Every id this build can draw — the test's handle on the map, and the one
/// place the pairing list is enumerable.
var telarIconIds: [String] { telarIconSymbols.keys.sorted() }
