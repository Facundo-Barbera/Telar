import SwiftUI

/// A project's mark, in three honesties — the web's `ProjectAvatar`, 1:1:
/// the icon its checkout actually carries, else a tinted initial from its
/// name, else the plain folder that says "a directory, and nothing more is
/// known".
///
/// FAILS FORWARD. The icon key is derived when the Mac lists projects and the
/// file can vanish between the list and the fetch; a fetch that fails draws
/// the initial, never a broken-image glyph.
struct ProjectAvatar: View {
    var name: String?
    var projectId: EngineID?
    var hostId: HostID?
    /// `ProjectRef.icon`. Absent means no file was found.
    var icon: String?
    var api: (any EngineAPI)?
    /// The rendered box, in points. The type stays square at any size.
    var size: CGFloat = 16

    private var icons: ProjectIconCache { .shared }

    var body: some View {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let icon, let projectId, let hostId, let image = icons.image(host: hostId, projectId: projectId, icon: icon) {
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

/// FNV-1a over UTF-16 code units — the web's `projectHue`, bit for bit, so
/// the phone and the Mac agree on what colour "Telar" is.
func projectHue(_ name: String) -> Double {
    var hash: UInt32 = 0x811c9dc5
    for unit in name.utf16 {
        hash ^= UInt32(unit)
        hash = hash &* 0x01000193
    }
    return Double(hash % 360)
}

/// The first GRAPHEME, not the first code unit — "Ålesund" is Å and an emoji
/// name keeps its whole emoji. Uppercased for latin; everything else is
/// already its own mark.
func projectInitial(_ name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = trimmed.first else { return "?" }
    return String(first).uppercased()
}
