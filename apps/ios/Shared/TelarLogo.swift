import SwiftUI

struct TelarLogo: View {
    var size: CGFloat

    var body: some View {
        Image("TelarLogo")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
            .accessibilityHidden(true)
    }
}
