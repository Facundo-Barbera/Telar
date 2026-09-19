import SwiftUI

/// A project's mark, in four honesties — the web's `ProjectAvatar`, 1:1: the
/// glyph a person CHOSE, else the icon its checkout actually carries, else a
/// tinted initial from its name, else the plain folder that says "a directory,
/// and nothing more is known".
///
/// THE CHOSEN MARK IS FIRST, and that ordering is the whole point of being able
/// to choose one (#365): a project whose checkout carries a favicon nobody likes
/// has no other way to say so. The chosen glyph and the discovered file are
/// separate fields on the record for the reason `Project.iconName` gives, so
/// preferring one here costs no branch anywhere else.
///
/// `currentColor` ON PURPOSE — a chosen glyph takes the ink of whatever list it
/// is in (rail row, project header) rather than carrying a colour of its own, so
/// it reads as part of the row instead of as a sticker on it. That is the web's
/// rule for the same glyph.
///
/// FAILS FORWARD, TWICE OVER. An id this build has no symbol for falls through
/// to the answers behind it (`telarIconSymbol`), and the checkout's icon key is
/// derived when the Mac lists projects and the file can vanish between the list
/// and the fetch — so a fetch that fails draws the initial, never a broken-image
/// glyph.
struct ProjectAvatar: View {
    var name: String?
    var projectId: EngineID?
    var hostId: HostID?
    /// `ProjectRef.icon`. Absent means no file was found.
    var icon: String?
    /// `ProjectRef.iconName` — the glyph a person picked. Outranks `icon`.
    var iconName: String?
    /// `ProjectRef.iconEmoji` — a mark typed before the picker existed.
    /// Outranks `icon`.
    var iconEmoji: String?
    var api: (any EngineAPI)?
    /// The rendered box, in points. The type stays square at any size.
    var size: CGFloat = 16

    /// The same view, built from a record's whole answer rather than from three
    /// of its fields — see `ProjectMark`.
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

    /// EVERY SIZE BELOW IS ALREADY RIGHT, and the Dynamic Type sweep (#248)
    /// deliberately leaves them. They are not absolute literals standing in
    /// for a rung — each is a fraction of `size`, the box the caller asked
    /// for, so the glyph is proportional to its own square by construction.
    /// A caller that wants a bigger avatar passes a bigger `size` and
    /// everything follows; a text style would break that relationship
    /// outright and overflow a frame fixed in both dimensions.
    ///
    /// They are also `accessibilityHidden` marks rather than text anybody
    /// reads — the name they stand for is announced by the row around them.
    var body: some View {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let symbol = telarIconSymbol(iconName) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.82))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else if let iconEmoji, !iconEmoji.isEmpty {
            // Sized off the box like the initial below, so a mark and a letter
            // sit at the same weight wherever the two appear in one list.
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
