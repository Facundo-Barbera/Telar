import Foundation

indirect enum FileTreeNode: Equatable, Identifiable {
    case file(path: String, name: String)
    case directory(path: String, name: String, children: [FileTreeNode])

    var id: String { path }
    var path: String {
        switch self {
        case .file(let path, _), .directory(let path, _, _): path
        }
    }
    var name: String {
        switch self {
        case .file(_, let name), .directory(_, let name, _): name
        }
    }
    var isDirectory: Bool {
        if case .directory = self { return true }
        return false
    }
    var children: [FileTreeNode] {
        if case .directory(_, _, let children) = self { return children }
        return []
    }
}

private final class Building {
    var dirs: [String: Building] = [:]
    var files: [String] = []
}

func buildFileTree(_ paths: [String]) -> [FileTreeNode] {
    let root = Building()
    for path in paths {
        var segments = path.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        guard let name = segments.popLast() else { continue }
        var cursor = root
        for segment in segments {
            if let next = cursor.dirs[segment] {
                cursor = next
            } else {
                let next = Building()
                cursor.dirs[segment] = next
                cursor = next
            }
        }
        cursor.files.append(name)
    }
    return toNodes(root, prefix: "").map(collapse)
}

private func toNodes(_ building: Building, prefix: String) -> [FileTreeNode] {
    var nodes: [FileTreeNode] = []
    for (name, child) in building.dirs {
        let path = prefix.isEmpty ? name : prefix + "/" + name
        nodes.append(.directory(path: path, name: name, children: toNodes(child, prefix: path)))
    }
    for name in building.files {
        nodes.append(.file(path: prefix.isEmpty ? name : prefix + "/" + name, name: name))
    }
    return nodes.sorted(by: compareNodes)
}

private func compareNodes(_ left: FileTreeNode, _ right: FileTreeNode) -> Bool {
    if left.isDirectory != right.isDirectory { return left.isDirectory }
    let order = left.name.compare(right.name, options: [.numeric, .caseInsensitive, .diacriticInsensitive])
    if order == .orderedSame { return left.name < right.name }
    return order == .orderedAscending
}

private func collapse(_ node: FileTreeNode) -> FileTreeNode {
    guard case .directory(let path, let name, let children) = node else { return node }
    let collapsed = children.map(collapse)
    if collapsed.count == 1, case .directory(let childPath, let childName, let grand) = collapsed[0] {
        return .directory(path: childPath, name: name + "/" + childName, children: grand)
    }
    return .directory(path: path, name: name, children: collapsed)
}

struct FileTreeRow: Identifiable, Equatable {
    var node: FileTreeNode
    var depth: Int
    var id: String { node.path }
}

func flattenTree(_ nodes: [FileTreeNode], expanded: Set<String>, depth: Int = 0) -> [FileTreeRow] {
    var rows: [FileTreeRow] = []
    for node in nodes {
        rows.append(FileTreeRow(node: node, depth: depth))
        if node.isDirectory, expanded.contains(node.path) {
            rows.append(contentsOf: flattenTree(node.children, expanded: expanded, depth: depth + 1))
        }
    }
    return rows
}

let maxSearchMatches = 400

func matchFiles(_ paths: [String], query: String) -> (matches: [String], dropped: Int) {
    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !needle.isEmpty else { return (paths, 0) }
    var matches: [String] = []
    var dropped = 0
    for path in paths where path.lowercased().contains(needle) {
        if matches.count < maxSearchMatches { matches.append(path) } else { dropped += 1 }
    }
    return (matches, dropped)
}

func ancestorsOf(_ paths: [String]) -> Set<String> {
    var result = Set<String>()
    for path in paths {
        var segments = path.split(separator: "/").map(String.init)
        segments.removeLast()
        var prefix = ""
        for segment in segments {
            prefix = prefix.isEmpty ? segment : prefix + "/" + segment
            result.insert(prefix)
        }
    }
    return result
}

func directoryPaths(_ nodes: [FileTreeNode]) -> [String] {
    var out: [String] = []
    for node in nodes where node.isDirectory {
        out.append(node.path)
        out.append(contentsOf: directoryPaths(node.children))
    }
    return out
}
