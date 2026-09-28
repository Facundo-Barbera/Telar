import SwiftUI

struct ProjectAvatar: View {
    var name: String?
    var projectId: EngineID?
    var hostId: HostID?

    var icon: String?

    var iconName: String?

    var iconEmoji: String?
    var api: (any EngineAPI)?

    var size: CGFloat = 16

    init(name: String?, projectId: EngineID? = nil, hostId: HostID? = nil, mark: ProjectMark, api: (any EngineAPI)? = nil, size: CGFloat = 16) {
        self.init(name: name, projectId: projectId, hostId: hostId,
                  icon: mark.icon, iconName: mark.iconName, iconEmoji: mark.iconEmoji, api: api, size: size)
    }

    init(name: String? = nil, projectId: EngineID? = nil, hostId: HostID? = nil,
         icon: String? = nil, iconName: String? = nil, iconEmoji: String? = nil,
         api: (any EngineAPI)? = nil, size: CGFloat = 16) {
        self.name = name; self.projectId = projectId; self.hostId = hostId
        self.icon = icon; self.iconName = iconName; self.iconEmoji = iconEmoji
        self.api = api; self.size = size
    }

    private var icons: ProjectIconCache { .shared }

    var body: some View {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let symbol = telarIconSymbol(iconName) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.82))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else if let iconEmoji, !iconEmoji.isEmpty {
            Text(iconEmoji)
                .font(.system(size: (size * 0.72).rounded()))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else if let icon, let projectId, let hostId, let image = icons.image(host: hostId, projectId: projectId, icon: icon) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size / 4, style: .continuous))
                .accessibilityHidden(true)
        } else if !trimmed.isEmpty {
            let hue = projectHue(trimmed)
            Text(projectInitial(trimmed))
                .font(.system(size: max(7, (size * 0.62).rounded()), weight: .medium))
                .foregroundStyle(Color(hue: hue / 360, saturation: 0.45, brightness: 0.38))
                .frame(width: size, height: size)
                .background(Color(hue: hue / 360, saturation: 0.45, brightness: 0.5).opacity(0.25))
                .clipShape(RoundedRectangle(cornerRadius: size / 4, style: .continuous))
                .accessibilityHidden(true)
                .task(id: "\(hostId?.uuidString ?? "")/\(projectId ?? "")/\(icon ?? "")") {
                    guard let icon, let projectId, let hostId, let api else { return }
                    icons.load(host: hostId, projectId: projectId, icon: icon, api: api)
                }
        } else {
            Image(systemName: "folder")
                .font(.system(size: size * 0.75))
                .foregroundStyle(Theme.textMuted.opacity(0.6))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}

func projectHue(_ name: String) -> Double {
    var hash: UInt32 = 0x811c9dc5
    for unit in name.utf16 {
        hash ^= UInt32(unit)
        hash = hash &* 0x01000193
    }
    return Double(hash % 360)
}

func projectInitial(_ name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = trimmed.first else { return "?" }
    return String(first).uppercased()
}
