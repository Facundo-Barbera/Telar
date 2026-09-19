import SwiftUI

/// WHAT THIS MAC SPENT — the desktop's Usage page, reduced to the part a phone
/// can carry (#404).
///
/// WHAT IS HERE: the window, the headline figure, and one row per provider. That
/// is the fold the desktop leads with (`usage-page.tsx`), and it is the whole of
/// what this screen answers.
///
/// WHAT IS NOT, AND WHY. THE CHART is a shape you read at a glance across thirty
/// columns; at this width it is thirty columns three pixels wide, which is a
/// picture of a chart rather than a chart. THE MODEL BREAKDOWN is a four-column
/// table — a phone renders it as four lines per model, and a page of that is a
/// worse answer than the provider split it would elaborate. THE HUB QUOTA panel
/// (`UsageLimitsSection`) is configuration a person does on the Mac. Each of
/// those is a screen of its own if it is ever wanted; none of them is this one
/// drawn small.
///
/// ONE MAC, NEVER A SUM. The report is derived by scanning one machine's
/// provider transcripts, so two paired Macs are two ledgers of two machines'
/// work — see `UsageReport`. With more than one paired, the Mac is picked rather
/// than added up.
struct UsageView: View {
    let settings: AppSettings
    /// Which Mac's ledger, seeded from the rail's own filter. Nil only when
    /// nothing is paired, which the rail's footer already refuses to open.
    var hostId: HostID?

    @State private var window: UsageWindow = .week
    @State private var selected: HostID?
    /// The report, and the window it answers — so a switch shows a spinner
    /// rather than last window's figures wearing this window's label.
    @State private var loaded: (window: UsageWindow, report: UsageReport)?
    @State private var error: String?
    @State private var loading = false

    /// THE THREE WINDOWS #404 NAMES, which are the desktop's first three. Its
    /// 90-day window is left there: at that range the interesting answer is the
    /// shape over time, and the shape is the chart this screen does not draw.
    enum UsageWindow: String, CaseIterable, Identifiable {
        case day = "24h", week = "7d", month = "30d"
        var id: String { rawValue }
        var milliseconds: Timestamp {
            switch self {
            case .day: 24 * 3_600_000
            case .week: 7 * 86_400_000
            case .month: 30 * 86_400_000
            }
        }
        /// The engine buckets a day's worth by hour and anything longer by day —
        /// the desktop's pairing. Nothing here draws the buckets; the resolution
        /// still rides so the two surfaces ask the same question and the Mac's
        /// cache answers both.
        var resolution: String { self == .day ? "hour" : "day" }
    }

    private var host: HostID? { selected ?? hostId }
    private var report: UsageReport? { loaded?.window == window ? loaded?.report : nil }
    private var fold: UsageFold? { report.map(foldUsage) }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Picker("Window", selection: $window) {
                    ForEach(UsageWindow.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                if settings.hosts.count > 1 {
                    VStack(spacing: 0) {
                        SettingsSectionLabel("Mac")
                        SettingsCard {
                            ForEach(Array(settings.hosts.enumerated()), id: \.element.id) { index, mac in
                                if index > 0 { CardDivider() }
                                Button { selected = mac.id } label: {
                                    CardRow(icon: "desktopcomputer", title: mac.name) {
                                        if host == mac.id {
                                            Image(systemName: "checkmark").font(.system(Theme.footnote, weight: .semibold))
                                                .foregroundStyle(Theme.accent)
                                        }
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        SettingsFootnote("Each Mac counts what it ran, by reading its own provider transcripts. There is no combined figure.")
                    }
                }

                if let error {
                    SettingsCard { StatusBanner(icon: "exclamationmark.triangle", color: Theme.statusAmber, title: "Could not read usage", detail: error) }
                } else if let fold {
                    if fold.total.turns == 0 {
                        ContentUnavailableView("No activity in this window", systemImage: "chart.bar",
                                               description: Text("Nothing this Mac ran was counted between then and now."))
                    } else {
                        headline(fold)
                        providers(fold)
                        totals(fold)
                    }
                    if let report { scanned(report) }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(Theme.sheet)
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load(force: true) }
        .task(id: "\(window.rawValue):\(host?.uuidString ?? "-")") { await load(force: false) }
    }

    // MARK: the figures

    /// THE HEADLINE IS COST, with the tokens under it rather than beside it —
    /// the desktop offers a Cost/Tokens switch because it has a chart to redraw;
    /// here both figures fit, so a control that shows one of two things a reader
    /// can have at once would be a control that hides one.
    private func headline(_ fold: UsageFold) -> some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 4) {
                Text(formatUsd(fold.total.costUsd))
                    .font(.system(.largeTitle, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.text)
                Text("\(formatTokens(fold.total.processed)) tokens · \(fold.sessions) session\(fold.sessions == 1 ? "" : "s") · API estimate")
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.textMuted)
                // A FLOOR IS STILL WORTH SHOWING, and saying it is a floor is
                // the desktop's own sentence: a model with no known rate counts
                // its tokens and not its money.
                if !fold.total.priced {
                    Text("Some models have no known rate; their cost is not counted.")
                        .font(.system(Theme.footnote))
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        }
    }

    private func providers(_ fold: UsageFold) -> some View {
        VStack(spacing: 0) {
            SettingsSectionLabel("By provider")
            SettingsCard {
                ForEach(Array(fold.providers.enumerated()), id: \.element.id) { index, provider in
                    if index > 0 { CardDivider() }
                    HStack(spacing: 12) {
                        Text(usageDriverLabel(provider.driver))
                            .font(.system(.callout, weight: .semibold))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(formatShare(provider.share))
                            .font(.system(Theme.footnote)).monospacedDigit()
                            .foregroundStyle(Theme.textMuted)
                        // THE DASH IS "NO COST KNOWN AT ALL", never "$0.00" —
                        // Codex reports none, and a zero would read as free.
                        Text(provider.totals.costUsd > 0 ? formatUsd(provider.totals.costUsd) : "—")
                            .font(.system(Theme.subhead, weight: .medium)).monospacedDigit()
                            .foregroundStyle(Theme.text)
                            .frame(width: 72, alignment: .trailing)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(usageDriverLabel(provider.driver)), \(formatShare(provider.share)), \(formatTokens(provider.totals.processed)) tokens")
                }
            }
        }
    }

    /// The four-way token split and the request count — the desktop's Totals
    /// tiles, as rows because a phone has one column.
    private func totals(_ fold: UsageFold) -> some View {
        VStack(spacing: 0) {
            SettingsSectionLabel("Totals")
            SettingsCard {
                totalRow("Processed tokens", formatTokens(fold.total.processed))
                CardDivider()
                totalRow("Uncached input", formatTokens(fold.total.tokens.input))
                CardDivider()
                totalRow("Cached input", formatTokens(fold.total.tokens.cacheRead))
                CardDivider()
                totalRow("Output", formatTokens(fold.total.tokens.output))
                CardDivider()
                totalRow("Requests", formatTokens(fold.total.turns))
            }
        }
    }

    private func totalRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.system(Theme.subhead)).foregroundStyle(Theme.textMuted)
            Spacer(minLength: 8)
            Text(value).font(.system(Theme.subhead, weight: .medium)).monospacedDigit().foregroundStyle(Theme.text)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    /// WHERE THE NUMBERS CAME FROM — a provider this Mac has never installed
    /// must read as "not scanned", never as "spent nothing".
    private func scanned(_ report: UsageReport) -> some View {
        SettingsFootnote(
            report.sources.map { source in
                source.status == "ok"
                    ? "\(usageDriverLabel(source.provider)): \(source.sessions) session\(source.sessions == 1 ? "" : "s") scanned"
                    : "\(usageDriverLabel(source.provider)): no transcripts at \(source.path)"
            }.joined(separator: " · ")
            + (report.pricing == "unavailable" ? " · Rate table unreachable — unreported costs are not counted." : "")
        )
    }

    // MARK: the read

    private func load(force: Bool) async {
        guard let host, let api = settings.api(for: host) else {
            error = "This Mac is not paired."
            return
        }
        guard force || loaded?.window != window else { return }
        loading = true
        defer { loading = false }
        let until = Timestamp(Date().timeIntervalSince1970 * 1000)
        do {
            let report = try await api.usageReport(
                sinceMs: until - window.milliseconds,
                untilMs: until,
                resolution: window.resolution,
                // The READER's zone, not the Mac's: a day boundary is a fact
                // about the person looking, and the engine buckets to whatever
                // zone it is handed.
                timeZone: TimeZone.current.identifier
            )
            loaded = (window, report)
            error = nil
        } catch {
            self.error = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
