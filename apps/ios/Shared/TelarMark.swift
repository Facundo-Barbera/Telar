import SwiftUI

/// The app icon's warp-and-weft mark, drawn natively at any display size.
struct TelarMark: View {
    var color: Color = .blue
    var body: some View {
        Canvas { context, size in
            let w = size.width, h = size.height
            var warp = Path()
            for x in [0.16, 0.33, 0.50, 0.67, 0.84] {
                warp.move(to: CGPoint(x: w*x, y: h*0.08))
                warp.addLine(to: CGPoint(x: w*x, y: h*0.92))
            }
            context.stroke(warp, with: .color(.secondary.opacity(0.35)), style: StrokeStyle(lineWidth: w*0.035, lineCap: .round))
            var thread = Path()
            thread.move(to: CGPoint(x: 0, y: h*0.5))
            thread.addCurve(to: CGPoint(x: w*0.5, y: h*0.5), control1: CGPoint(x: w*0.22, y: h*0.18), control2: CGPoint(x: w*0.28, y: h*0.82))
            thread.addCurve(to: CGPoint(x: w, y: h*0.5), control1: CGPoint(x: w*0.72, y: h*0.18), control2: CGPoint(x: w*0.78, y: h*0.82))
            context.stroke(thread, with: .color(color), style: StrokeStyle(lineWidth: w*0.065, lineCap: .round))
        }.accessibilityHidden(true)
    }
}
