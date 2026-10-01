import SwiftUI

struct HostMark: View {
    let hostId: HostID
    let name: String
    let size: CGFloat

    var body: some View {
        let hue = Self.hue(hostId)
        Text(projectInitial(name))
            .font(.system(size: max(7, (size * 0.62).rounded()), weight: .semibold))
            .foregroundStyle(Color(hue: hue / 360, saturation: 0.55, brightness: 0.36))
            .frame(width: size, height: size)
            .background(Color(hue: hue / 360, saturation: 0.55, brightness: 0.5).opacity(0.3), in: Circle())
            .accessibilityElement()
            .accessibilityLabel("On \(name)")
    }

    static func hue(_ hostId: HostID) -> Double { projectHue(hostId.uuidString.lowercased()) }
}
