import SwiftUI

/// THE LATEX TAB: the last compile, its diagnostics, and the log tail. The
/// PDF is not rendered here — the compile writes it beside its source and
/// Open PDF opens a file in Files, the way every other file opens.
///
/// Diagnostics are tappable: an error knows its file, and the fix lives
/// there. A status read that fails is SHOWN — a Mac with the plugin off
/// should say so rather than look like a project that never compiled.
struct LatexSurface: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let active: Bool
    let panel: PanelModel

    @State private var status: LatexCompileStatus?
    @State private var statusError: String?
    @State private var target = ""
    @State private var defaultFile: String?
    @State private var compiling = false
    @State private var failure: String?
    @State private var logOpen = false
    @State private var log: [String]?

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let statusError {
                        note("Could not read the compile status", statusError, tone: Theme.statusRed)
                    }
                    if let failure {
                        note("Compile failed", failure, tone: Theme.statusRed)
                    }
                    if let status, status.status != .never {
                        diagnostics(status)
                    } else if statusError == nil {
                        Text("Nothing has been compiled in this session yet. Type a .tex path and press Compile, or ask the agent; its latex_compile lands here too.")
                            .font(.system(Theme.footnote)).foregroundStyle(Theme.textMuted)
                    }
                }
                .padding(12)
            }
        }
        .task(id: "\(sessionId):\(active)") {
            await read()
            if defaultFile == nil, let toolchain = try? await api.latexToolchain(sessionId) {
                defaultFile = toolchain.mainFile
                if target.isEmpty, let main = toolchain.mainFile { target = main }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            TextField(defaultFile.map { "Default: \($0)" } ?? "report/main.tex", text: $target)
                .font(.system(Theme.caption, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 8).scaledHeight(26, relativeTo: .caption)
                .background(Theme.subtle, in: RoundedRectangle(cornerRadius: 6))
                .accessibilityLabel("LaTeX document to compile")
            Button { Task { await compile() } } label: {
                HStack(spacing: 4) {
                    Image(systemName: compiling ? "hourglass" : "play.fill").font(.system(Theme.caption))
                    Text(compiling ? "Compiling…" : "Compile").font(.system(Theme.footnote, weight: .medium))
                }
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 10).scaledHeight(26, relativeTo: .footnote)
                .background(Theme.subtleStrong, in: RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.plain)
            .disabled(compiling)
            if let status, status.status != .never {
                statusPill(status.status)
            }
            if let pdf = status?.pdfPath {
                Button { panel.openFile(pdf) } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "doc.richtext").font(.system(Theme.caption))
                        Text("Open PDF").font(.system(Theme.footnote, weight: .medium))
                    }
                    .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .scaledHeight(38, relativeTo: .footnote)
        .background(Theme.sheet)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.borderSubtle) }
    }

    private func statusPill(_ status: LatexJobStatus) -> some View {
        let (label, tone): (String, Color) = switch status {
        case .ok: ("Compiled", Theme.statusEmerald)
        case .failed: ("Failed", Theme.statusRed)
        case .running: ("Running", Theme.textMuted)
        case .cancelled: ("Cancelled", Theme.textMuted)
        case .never, .unknown: (status.rawValue, Theme.textMuted)
        }
        return Text(label)
            .font(.system(Theme.caption, weight: .semibold))
            .foregroundStyle(tone)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(tone.opacity(0.12), in: Capsule())
    }

    private func note(_ title: String, _ body: String, tone: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(Theme.footnote, weight: .semibold)).foregroundStyle(tone)
            Text(body).font(.system(Theme.footnote)).foregroundStyle(Theme.text).textSelection(.enabled)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private func diagnostics(_ status: LatexCompileStatus) -> some View {
        let errors = status.diagnostics.filter { $0.severity == .error }
        let warnings = status.diagnostics.filter { $0.severity == .warning }
        return VStack(alignment: .leading, spacing: 10) {
            if let path = status.path {
                Text(path).font(.system(Theme.caption, design: .monospaced)).foregroundStyle(Theme.textMuted)
            }
            if status.diagnostics.isEmpty && status.status == .ok {
                Label("Clean compile — no errors, no warnings.", systemImage: "checkmark.circle")
                    .font(.system(Theme.footnote)).foregroundStyle(Theme.statusEmerald)
            }
            ForEach(status.diagnostics) { diagnostic in
                Button {
                    if let file = diagnostic.file { panel.openFile(file) }
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: diagnostic.severity == .error ? "xmark.octagon" : "exclamationmark.triangle")
                            .font(.system(Theme.caption))
                            .foregroundStyle(diagnostic.severity == .error ? Theme.statusRed : Theme.statusAmber)
                            .padding(.top, 2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(diagnostic.message).font(.system(Theme.footnote)).foregroundStyle(Theme.text).multilineTextAlignment(.leading)
                            HStack(spacing: 6) {
                                if let file = diagnostic.file {
                                    Text(diagnostic.line.map { "\(file):\($0)" } ?? file).font(.system(Theme.caption, design: .monospaced)).foregroundStyle(Theme.textMuted)
                                }
                                if let code = diagnostic.code { Text(code).font(.system(Theme.caption)).foregroundStyle(Theme.textMuted) }
                            }
                            if let suggestion = diagnostic.suggestion {
                                Text(suggestion).font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
                            }
                        }
                        Spacer(minLength: 0)
                        if diagnostic.file != nil { Image(systemName: "chevron.right").font(.system(Theme.captionTiny)).foregroundStyle(Theme.textMuted) }
                    }
                    .padding(8)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.borderSubtle, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(diagnostic.file == nil)
            }
            if !status.logTail.isEmpty {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { logOpen.toggle() }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "chevron.right").font(.system(Theme.captionTiny, weight: .semibold)).rotationEffect(.degrees(logOpen ? 90 : 0))
                        Text("Log tail").font(.system(Theme.footnote, weight: .medium))
                    }
                    .foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain)
                if logOpen {
                    CodeBlockView(code: (log ?? status.logTail).joined(separator: "\n"))
                }
            }
            Text("\(errors.count) error\(errors.count == 1 ? "" : "s") · \(warnings.count) warning\(warnings.count == 1 ? "" : "s")")
                .font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
        }
    }

    private func read() async {
        do {
            status = try await api.latexStatus(sessionId)
            statusError = nil
        } catch {
            statusError = describe(error)
        }
    }

    private func compile() async {
        compiling = true
        failure = nil
        defer { compiling = false }
        do {
            let path = target.trimmingCharacters(in: .whitespaces)
            let answer = try await api.latexCompile(sessionId, path: path.isEmpty ? nil : path)
            if !answer.ok, let error = answer.error { failure = error }
        } catch {
            failure = describe(error)
        }
        await read()
    }
}
