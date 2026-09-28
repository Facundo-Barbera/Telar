import UIKit

private let telarIconSymbols: [String: String] = [

    "globe": "globe",
    "briefcase": "briefcase",
    "house": "house",
    "building-2": "building.2",
    "user-round": "person",
    "users-round": "person.2",
    "compass": "safari",
    "map": "map",

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

    "pen-tool": "pencil.tip",
    "palette": "paintpalette",
    "camera": "camera",
    "music": "music.note",
    "film": "film",
    "feather": "pencil",

    "shopping-cart": "cart",
    "credit-card": "creditcard",
    "book": "book",
    "graduation-cap": "graduationcap",
    "flask-conical": "testtube.2",

    "leaf": "leaf",
    "tree-pine": "tree",
    "sun": "sun.max",
    "moon": "moon",
    "flame": "flame",

    "star": "star",
    "heart": "heart",
    "shield": "shield",
    "rocket": "paperplane",
]

func telarIconSymbol(_ iconName: String?) -> String? {
    guard let iconName, let symbol = telarIconSymbols[iconName] else { return nil }
    return UIImage(systemName: symbol) == nil ? nil : symbol
}

var telarIconIds: [String] { telarIconSymbols.keys.sorted() }
