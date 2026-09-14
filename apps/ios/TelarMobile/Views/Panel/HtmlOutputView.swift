import SwiftUI
import WebKit

/// HTML a kernel produced, RENDERED rather than printed.
///
/// The plan's first pass showed the source in a code block and said so; on a
/// real notebook that means a pandas repr arrives as three hundred characters
/// of `.dataframe tbody tr th { vertical-align: top; }` where a table should
/// be. Most of those are caught by `parsePandasHtmlTable` and drawn natively;
/// this is everything else — a plot library's widget, a styled frame, a repr
/// somebody wrote by hand.
///
/// HTML FROM A KERNEL IS TRUSTED THE WAY A TERMINAL IS: it is the user's own
/// code running in the user's own environment. It still gets a cage, because
/// "trusted" is not "given the run of the app":
///
/// - JAVASCRIPT IS OFF (`allowsContentJavaScript = false`), so a `<script>` in
///   a repr never executes. The desktop's `sandbox=""` says the same thing.
/// - NOTHING NAVIGATES. The delegate allows the one `loadHTMLString` and
///   cancels every other load, so a `<meta refresh>` or an auto-submitting
///   form cannot pull the view somewhere else, and a tapped link opens in the
///   browser rather than replacing the output.
///
/// Height follows the content because a fixed one is wrong for every output:
/// measured after the load and published back, capped so a tall document
/// scrolls inside its own box instead of pushing the next cell off the screen.
struct HtmlOutputView: View {
    let html: String
    var truncated: Bool = false

    /// Tall output starts capped, like the text outputs beside it.
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
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .frame(minHeight: 28)
                }
                .buttonStyle(.plain)
            }
            if truncated {
                Text("truncated").font(.system(size: 10)).foregroundStyle(Theme.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The desktop's style prelude, in this app's colours. `color-scheme`
    /// matters most: without it a dark notebook draws black text on the web
    /// view's white default the moment the HTML sets no colour of its own.
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
        // THE CAGE. A `<script>` in a repr never runs; `evaluateJavaScript`
        // from here still does, which is how the height is measured.
        pageConfiguration.allowsContentJavaScript = false
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences = pageConfiguration
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        // The SwiftUI frame owns the vertical size; the web view only scrolls
        // when the content is taller than the cap.
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
        /// Exactly one load is permitted: the string we handed it.
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
            // A LINK LEAVES, IT DOES NOT REPLACE THE OUTPUT. Anything else —
            // a meta refresh, a form — is simply refused.
            if action.navigationType == .linkActivated, let url = action.request.url,
               url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
            view.evaluateJavaScript("document.documentElement.scrollHeight") { [weak self] value, _ in
                guard let measured = value as? CGFloat ?? (value as? NSNumber).map({ CGFloat($0.doubleValue) }) else { return }
                // A little slack so a one-pixel rounding does not leave a
                // scrollbar on an output that fits.
                self?.height = max(24, measured + 8)
            }
        }
    }
}
