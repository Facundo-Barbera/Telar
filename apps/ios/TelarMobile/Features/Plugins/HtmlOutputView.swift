import SwiftUI
import WebKit

struct HtmlOutputView: View {
    let html: String
    var truncated: Bool = false

    static let restingHeight: CGFloat = 220
    static let expandedHeight: CGFloat = 480

    @State private var contentHeight: CGFloat = 80
    @State private var expanded = false
    @Environment(\.colorScheme) private var scheme

    private var cap: CGFloat { expanded ? Self.expandedHeight : Self.restingHeight }
    private var height: CGFloat { min(contentHeight, cap) }
    private var overflows: Bool { contentHeight > cap + 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HtmlWebView(html: document, height: $contentHeight)
                .frame(height: height)
                .background(Theme.codeBackground)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusRow))
                .hairline(Theme.radiusRow)
            if overflows || expanded {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                } label: {
                    Text(expanded ? "Show less" : "Taller output — expand")
                        .font(.system(Theme.caption, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .frame(minHeight: 28)
                }
                .buttonStyle(.plain)
            }
            if truncated {
                Text("truncated").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var document: String {
        let text = scheme == .dark ? "#F5F5F5" : "#27272A"
        let background = scheme == .dark ? "#252525" : "#F4F4F5"
        let rule = scheme == .dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.14)"
        return """
        <!doctype html><html><head>
        <meta name="viewport" content="width=device-width">
        <style>
          :root { color-scheme: light dark; }
          html, body { margin: 0; padding: 4px 6px; background: \(background); color: \(text); }
          body { font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
          table { border-collapse: collapse; }
          td, th { padding: 2px 6px; border: 1px solid \(rule); text-align: left; }
          thead th { font-weight: 600; }
          img { max-width: 100%; height: auto; }
          /* A wide frame scrolls sideways rather than squeezing its columns. */
          body { overflow-x: auto; }
        </style>
        </head><body>\(html)</body></html>
        """
    }
}

private struct HtmlWebView: UIViewRepresentable {
    let html: String
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(height: $height) }

    func makeUIView(context: Context) -> WKWebView {
        let pageConfiguration = WKWebpagePreferences()

        pageConfiguration.allowsContentJavaScript = false
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences = pageConfiguration
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear

        view.scrollView.bounces = false
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        context.coordinator.allowsNextLoad = true
        view.loadHTMLString(html, baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding var height: CGFloat
        var loaded: String?

        var allowsNextLoad = false

        init(height: Binding<CGFloat>) { _height = height }

        func webView(_ view: WKWebView,
                     decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if allowsNextLoad {
                allowsNextLoad = false
                decisionHandler(.allow)
                return
            }

            if action.navigationType == .linkActivated, let url = action.request.url,
               url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
            view.evaluateJavaScript("document.documentElement.scrollHeight") { [weak self] value, _ in
                guard let measured = value as? CGFloat ?? (value as? NSNumber).map({ CGFloat($0.doubleValue) }) else { return }

                self?.height = max(24, measured + 8)
            }
        }
    }
}
