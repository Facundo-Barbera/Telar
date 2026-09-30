import SwiftUI

enum FloatingInset {
    static func pinsToTail(from old: CGFloat, to new: CGFloat) -> Bool {
        old <= 0 && new > 0
    }
}

extension View {
    func floatingComposer<Bar: View>(
        height: Binding<CGFloat>,
        onFirstLayout: @escaping () -> Void = {},
        @ViewBuilder bar: () -> Bar
    ) -> some View {
        contentMargins(.bottom, height.wrappedValue, for: .scrollContent)
            .contentMargins(.bottom, height.wrappedValue, for: .scrollIndicators)
            .overlay(alignment: .bottom) {
                bar().onGeometryChange(for: CGFloat.self) { $0.size.height } action: { next in
                    let first = FloatingInset.pinsToTail(from: height.wrappedValue, to: next)
                    height.wrappedValue = next
                    if first { onFirstLayout() }
                }
            }
    }
}
