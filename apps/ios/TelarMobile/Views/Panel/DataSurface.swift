import SwiftUI

/// THE DATA TAB: plots, variables and the environment behind one tab, with
/// the kernel's pill and controls once, at the strip's trailing edge — a
/// kernel's controls belong next to its state, not inside whichever view is
/// showing. The sub-tab is a habit, remembered per device, not per session.
struct DataSurface: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let active: Bool

    enum Sub: String, CaseIterable, Identifiable {
        case plots, variables, environment
        var id: String { rawValue }
        var label: String { rawValue.capitalized }
        var icon: String {
            switch self {
            case .plots: "chart.line.uptrend.xyaxis"
            case .variables: "curlybraces"
            case .environment: "shippingbox"
            }
        }
    }

    @AppStorage("telar.data.subtab") private var subRaw = Sub.plots.rawValue
    @State private var kernel: KernelState = .none
    @State private var acting = false
    private var sub: Sub { Sub(rawValue: subRaw) ?? .plots }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ForEach(Sub.allCases) { tab in
                    Button { subRaw = tab.rawValue } label: {
                        HStack(spacing: 4) {
                            Image(systemName: tab.icon).font(.system(size: 11))
                            Text(tab.label).font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(sub == tab ? Theme.text : Theme.textMuted)
                        .padding(.horizontal, 8).frame(height: 26)
                        .background(sub == tab ? Theme.subtleStrong : .clear, in: RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(sub == tab ? .isSelected : [])
                }
                Spacer(minLength: 0)
                KernelPill(state: kernel)
                if kernel.isLive {
                    Button { Task { await act(.interrupt) } } label: { Image(systemName: "stop.fill").font(.system(size: 11)) }
                        .buttonStyle(.plain).foregroundStyle(Theme.statusRed).disabled(acting).accessibilityLabel("Interrupt kernel")
                }
                if kernel != .none {
                    Button { Task { await act(.restart) } } label: { Image(systemName: "arrow.clockwise").font(.system(size: 11)) }
                        .buttonStyle(.plain).foregroundStyle(Theme.textMuted).disabled(acting).accessibilityLabel("Restart kernel")
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 34)
            .background(Theme.sheet)
            .overlay(alignment: .bottom) { Divider().overlay(Theme.borderSubtle) }
            switch sub {
            case .plots: PlotsSurface(api: api, sessionId: sessionId, hostId: hostId, active: active)
            case .variables: VariablesSurface(api: api, sessionId: sessionId, active: active, kernel: kernel)
            case .environment: EnvironmentSurface(api: api, sessionId: sessionId, active: active)
            }
        }
        .task(id: "\(sessionId):\(active)") { await readKernel() }
    }

    private func readKernel() async {
        kernel = (try? await api.kernel(sessionId))?.state ?? .none
    }

    private enum KernelAction { case interrupt, restart }

    private func act(_ action: KernelAction) async {
        acting = true
        defer { acting = false }
        switch action {
        case .interrupt: try? await api.kernelInterrupt(sessionId)
        case .restart: try? await api.kernelRestart(sessionId)
        }
        await readKernel()
    }
}

/// A plot is an attachment tagged `plot`. Pinned plots sort first; tap opens
/// the lightbox. A failed read is an error, not "no plots yet".
struct PlotsSurface: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let active: Bool

    @State private var plots: [TurnAttachment]?
    @State private var error: String?
    @State private var lightbox: EngineID?

    var body: some View {
        Group {
            if let plots {
                if plots.isEmpty {
                    ContentUnavailableView("No plots yet", systemImage: "chart.line.uptrend.xyaxis", description: Text("A figure drawn in a notebook cell or by ds_plot lands here."))
                } else {
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 12)], spacing: 12) {
                            ForEach(plots.sorted { $0.isPinned && !$1.isPinned }) { plot in
                                PlotCard(api: api, sessionId: sessionId, hostId: hostId, plot: plot, onOpen: { lightbox = plot.id }, onPin: { await pin(plot) })
                            }
                        }
                        .padding(12)
                    }
                    .refreshable { await load() }
                }
            } else if let error {
                ContentUnavailableView("Could not read plots", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(sessionId):\(active)") { await load() }
        .sheet(item: Binding(get: { lightbox.map { Lightbox(id: $0) } }, set: { lightbox = $0?.id })) { item in
            ImageLightbox(api: api, sessionId: sessionId, hostId: hostId, attachmentId: item.id)
        }
    }

    private struct Lightbox: Identifiable { let id: EngineID }

    private func load() async {
        do {
            plots = try await api.attachments(sessionId, tag: "plot")
            error = nil
        } catch {
            self.error = describe(error)
        }
    }

    private func pin(_ plot: TurnAttachment) async {
        var tags = plot.tags ?? []
        if plot.isPinned { tags.removeAll { $0 == "pinned" } } else { tags.append("pinned") }
        if let updated = try? await api.tagAttachment(sessionId, attachmentId: plot.id, tags: tags),
           let index = plots?.firstIndex(where: { $0.id == plot.id }) {
            plots?[index] = updated
        }
    }
}

private struct PlotCard: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let plot: TurnAttachment
    let onOpen: () -> Void
    let onPin: () async -> Void

    @State private var image: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                } else {
                    ProgressView().frame(height: 120)
                }
            }
            .frame(maxWidth: .infinity)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
            .onTapGesture(perform: onOpen)
            HStack(spacing: 6) {
                Text(plot.producer ?? plot.name).font(.system(size: 11)).foregroundStyle(Theme.textMuted).lineLimit(1)
                Spacer(minLength: 0)
                if let at = plot.createdAt {
                    Text(at.date.formatted(date: .omitted, time: .shortened)).font(.system(size: 10)).foregroundStyle(Theme.textTertiary)
                }
                Button { Task { await onPin() } } label: {
                    Image(systemName: plot.isPinned ? "pin.fill" : "pin").font(.system(size: 10)).foregroundStyle(plot.isPinned ? Theme.accent : Theme.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(plot.isPinned ? "Unpin plot" : "Pin plot")
            }
        }
        .padding(8)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.borderSubtle, lineWidth: 1))
        .task(id: plot.id) { image = await AttachmentImageCache.shared.image(host: hostId, session: sessionId, attachmentId: plot.id, api: api) }
    }
}

/// The kernel's namespace: one row per variable, tap to inspect. Opening
/// this never starts a kernel.
struct VariablesSurface: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let active: Bool
    let kernel: KernelState

    @State private var vars: [VarRow]?
    @State private var error: String?
    @State private var open: String?
    @State private var detail: JSONValue?

    var body: some View {
        Group {
            if let vars {
                if vars.isEmpty {
                    ContentUnavailableView(
                        kernel == .none ? "No kernel yet" : "Empty namespace",
                        systemImage: "curlybraces",
                        description: Text(kernel == .none ? "Run a cell or ask the agent to use ds_scratch." : "Nothing assigned since the last restart.")
                    )
                } else {
                    List {
                        ForEach(vars) { row in
                            VStack(alignment: .leading, spacing: 4) {
                                Button { Task { await inspect(row.name) } } label: {
                                    HStack(spacing: 8) {
                                        Text(row.name).font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(Theme.text)
                                        Text(row.type).font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                                        if let shape = row.shape { Text(shape.map(String.init).joined(separator: "×")).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.textTertiary) }
                                        else if let len = row.len { Text("len \(len)").font(.system(size: 11)).foregroundStyle(Theme.textTertiary) }
                                        Spacer(minLength: 0)
                                        if let size = row.sizeBytes { Text(humanBytes(size)).font(.system(size: 10)).foregroundStyle(Theme.textTertiary) }
                                    }
                                }
                                .buttonStyle(.plain)
                                if open == row.name {
                                    CodeBlockView(code: detail?.prettyPrinted ?? row.repr ?? "…")
                                }
                            }
                            .listRowBackground(Color.clear)
                            .listRowSeparatorTint(Theme.borderSubtle)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            } else if let error {
                ContentUnavailableView("Could not read variables", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(sessionId):\(active):\(kernel.rawValue)") { await load() }
    }

    private func load() async {
        guard kernel.isLive || kernel == .idle else { vars = []; return }
        do {
            vars = try await api.kernelVars(sessionId)
            error = nil
        } catch {
            self.error = describe(error)
        }
    }

    private func inspect(_ name: String) async {
        if open == name { open = nil; detail = nil; return }
        open = name
        detail = nil
        detail = try? await api.kernelInspect(sessionId, name: name)
    }
}

/// The session's Python environment: manager, interpreter, packages.
/// Read-only in this pass.
struct EnvironmentSurface: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let active: Bool

    @State private var list: PackageList?
    @State private var error: String?
    @State private var query = ""

    var body: some View {
        Group {
            if let list {
                List {
                    if let env = list.environment {
                        Section {
                            LabeledContent("Manager", value: env.manager)
                            LabeledContent("Python", value: env.python).font(.system(size: 12, design: .monospaced))
                            LabeledContent("Root", value: env.root).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.head)
                        }
                        .font(.system(size: 12))
                        .listRowBackground(Color.clear)
                    }
                    Section("\(list.packages.count) packages") {
                        ForEach(list.packages.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { package in
                            HStack {
                                Text(package.name).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.text)
                                Spacer()
                                Text(package.version).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.textMuted)
                                if package.direct == true { Image(systemName: "pin").font(.system(size: 9)).foregroundStyle(Theme.textTertiary) }
                            }
                            .listRowBackground(Color.clear)
                            .listRowSeparatorTint(Theme.borderSubtle)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .searchable(text: $query, prompt: "Filter packages")
            } else if let error {
                ContentUnavailableView("Could not read the environment", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(sessionId):\(active)") {
            do { list = try await api.packages(sessionId); error = nil } catch { self.error = describe(error) }
        }
    }
}
