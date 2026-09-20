import SwiftUI

/// The approval panel, styled after t3code's composer pending-approval
/// drawer: content stacked above a right-aligned row of GHOST buttons —
/// no filled destructive button anywhere; "Decline" signals with red text
/// only, "Approve" with full-strength foreground. The surrounding surface
/// comes from ComposerDrawer.
struct RequestCardView: View {
    let request: EngineRequest
    let store: SessionStore
    @State private var declining = false
    @State private var declineReason = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch request.detail {
            case .commandExecution(let command):
                header("Run a command", icon: "terminal")
                if let cwd = command.cwd {
                    Text(cwd).font(Theme.monoSmall).foregroundStyle(Theme.textMuted.opacity(0.7)).lineLimit(1)
                }
                commandPreview(command.command)
                approvalButtons
            case .fileChange(let change):
                header("\(change.kind.capitalized) \(change.path)", icon: "pencil.line")
                if let diff = change.unifiedDiff {
                    ScrollView {
                        commandPreview(diff)
                    }
                    .frame(maxHeight: 160)
                }
                approvalButtons
            case .fileRead(let read):
                header("Read \(read.path)", icon: "doc.text")
                approvalButtons
            case .toolCall(let call):
                header(displayToolName(call.name), icon: "wrench.and.screwdriver")
                if let input = call.input {
                    ScrollView {
                        commandPreview(input.prettyPrinted)
                    }
                    .frame(maxHeight: 160)
                }
                approvalButtons
            case .userInput(let prompt, let fields):
                header("Question", icon: "questionmark.bubble")
                UserInputFormView(prompt: prompt, fields: fields) { answers in
                    Task { await store.resolve(request, decision: .accept, answers: answers) }
                }
            case .secretAccess(let secret):
                header("Fill login from 1Password", icon: "key.fill")
                SecretAccessCardView(secret: secret) { decision, itemId in
                    Task {
                        if let itemId {
                            await store.resolve(request, decision: decision, answers: ["item": .text(itemId)])
                        } else {
                            await store.resolve(request, decision: decision)
                        }
                    }
                }
            case .unknown(let kind):
                header("Approval needed (\(kind))", icon: "questionmark.diamond")
                Text("This build doesn't know this request kind — you can still answer it.")
                    .font(Theme.metaSmall)
                    .foregroundStyle(Theme.textMuted)
                approvalButtons
            }
        }
        .sheet(isPresented: $declining) {
            NavigationStack {
                Form {
                    Section("Why? (optional — fed back to the agent)") {
                        TextField("Reason", text: $declineReason, axis: .vertical)
                    }
                }
                .navigationTitle("Decline")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { declining = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Decline") {
                            declining = false
                            let reason = declineReason.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task { await store.resolve(request, decision: .decline, reason: reason.isEmpty ? nil : reason) }
                        }
                    }
                }
            }
            .presentationDetents([.medium])
        }
    }

    private func header(_ title: String, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(Theme.footnote, weight: .medium))
                .foregroundStyle(Theme.statusAmber)
            Text(title)
                .font(.system(Theme.footnote, weight: .medium))
                .foregroundStyle(Theme.text)
                .lineLimit(2)
        }
    }

    /// t3code's command preview: mono 11pt at 85% ink, no box of its own.
    private func commandPreview(_ text: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(Theme.monoSmall)
                .foregroundStyle(Theme.text.opacity(0.85))
                .textSelection(.enabled)
        }
        .frame(maxHeight: 80)
    }

    private var approvalButtons: some View {
        HStack(spacing: 4) {
            Menu {
                Button("Withdraw the turn", role: .destructive) {
                    Task { await store.resolve(request, decision: .cancel) }
                }
            } label: {
                // The menu's 28pt square scales with its glyph (#674).
                Image(systemName: "ellipsis")
                    .foregroundStyle(Theme.textMuted)
                    .scaledGlyphBox(28, glyph: 12)
                    .contentShape(Rectangle())
            }
            Spacer(minLength: 0)
            GhostButton("Decline", tint: Theme.statusRed) { declining = true }
            GhostButton("Always allow", tint: Theme.textMuted) {
                Task { await store.resolve(request, decision: .acceptForSession) }
            }
            GhostButton("Approve", tint: Theme.text) {
                Task { await store.resolve(request, decision: .accept) }
            }
        }
        .padding(.top, 2)
    }
}

/// t3code approval buttons: ghost — text only, a soft fill on press, color
/// carrying the meaning.
struct GhostButton: View {
    let label: String
    let tint: Color
    let action: () -> Void

    init(_ label: String, tint: Color, action: @escaping () -> Void) {
        self.label = label
        self.tint = tint
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(Theme.footnote, weight: .medium))
                .foregroundStyle(tint)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle())
    }
}

/// The 1Password fill card. NO "Always allow": a credential leaving the vault
/// is approved one fill at a time, in every runtime mode — the engine's
/// `autoResolution` refuses this kind unconditionally, and the phone is very
/// often the approval device that rule exists for. The human picks an ITEM;
/// values never pass through this app.
struct SecretAccessCardView: View {
    let secret: SecretAccessDetail
    let decide: (RequestDecision, String?) -> Void

    @State private var itemId: String?

    private var chosen: String? { itemId ?? secret.candidates.first?.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(secret.origin)
                .font(Theme.monoSmall)
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
            ForEach(secret.candidates) { candidate in
                Button {
                    itemId = candidate.id
                } label: {
                    HStack(spacing: 8) {
                        Text(candidate.title)
                            .font(Theme.body)
                            .foregroundStyle(Theme.text)
                        Spacer(minLength: 0)
                        // The matched domain — the human verifies the same
                        // binding the engine enforced.
                        Text(candidate.domain)
                            .font(Theme.monoSmall)
                            .foregroundStyle(Theme.textMuted)
                        if chosen == candidate.id {
                            Image(systemName: "checkmark")
                                .font(.system(Theme.caption, weight: .semibold))
                                .foregroundStyle(Theme.accent)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(chosen == candidate.id ? Theme.messageSurface : .clear)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusRow))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Text("Telar fills the values directly — they never enter the conversation.")
                .font(Theme.metaSmall)
                .foregroundStyle(Theme.textMuted)
            HStack(spacing: 4) {
                Spacer(minLength: 0)
                GhostButton("Decline", tint: Theme.statusRed) { decide(.decline, nil) }
                GhostButton("Fill", tint: Theme.text) { decide(.accept, chosen) }
            }
        }
    }
}

/// A real form: the agent is asking, not asking permission. Never
/// auto-resolved in any runtime mode — it is genuinely waiting on the person
/// holding this phone. Options render as full-width rows, t3code style.
struct UserInputFormView: View {
    let prompt: String
    let fields: [UserInputField]
    let submit: ([String: AnswerValue]) -> Void

    @State private var textAnswers: [String: String] = [:]
    @State private var boolAnswers: [String: Bool] = [:]
    /// Multi-select `choice` fields only — a set, because the rows toggle.
    @State private var listAnswers: [String: Set<String>] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            MarkdownText(text: prompt)
            ForEach(fields) { field in
                fieldView(field)
            }
            HStack {
                Spacer(minLength: 0)
                GhostButton("Submit", tint: requiredFilled ? Theme.accent : Theme.textMuted.opacity(0.5)) {
                    var answers: [String: AnswerValue] = [:]
                    for field in fields {
                        switch field.kind {
                        case "boolean":
                            answers[field.key] = .bool(boolAnswers[field.key] ?? false)
                        default:
                            if field.isMultiSelect {
                                // Choice order, not tap order: the engine reads
                                // these back as labels, and the question's own
                                // order is the one the person was reading.
                                let picked = listAnswers[field.key] ?? []
                                let ordered = (field.choices ?? []).filter(picked.contains)
                                if !ordered.isEmpty { answers[field.key] = .list(ordered) }
                            } else {
                                let value = textAnswers[field.key] ?? ""
                                if !value.isEmpty { answers[field.key] = .text(value) }
                            }
                        }
                    }
                    submit(answers)
                }
                .disabled(!requiredFilled)
            }
        }
    }

    private var requiredFilled: Bool {
        fields.allSatisfy { field in
            guard field.required == true else { return true }
            if field.kind == "boolean" { return true }
            if field.isMultiSelect { return !(listAnswers[field.key] ?? []).isEmpty }
            return !(textAnswers[field.key] ?? "").isEmpty
        }
    }

    @ViewBuilder
    private func fieldView(_ field: UserInputField) -> some View {
        switch field.kind {
        case "choice":
            let multiple = field.isMultiSelect
            VStack(alignment: .leading, spacing: 4) {
                Text(field.label)
                    .font(Theme.metaSmall)
                    .foregroundStyle(Theme.textMuted)
                if multiple {
                    Text("Pick any that apply")
                        .font(Theme.metaSmall)
                        .foregroundStyle(Theme.textMuted)
                }
                ForEach(field.choices ?? [], id: \.self) { choice in
                    let picked = multiple
                        ? (listAnswers[field.key] ?? []).contains(choice)
                        : textAnswers[field.key] == choice
                    Button {
                        if multiple { toggle(field.key, choice) }
                        else { textAnswers[field.key] = choice }
                    } label: {
                        HStack(spacing: 8) {
                            Text(choice)
                                .font(Theme.body)
                                .foregroundStyle(Theme.text)
                            Spacer(minLength: 0)
                            if picked {
                                Image(systemName: "checkmark")
                                    .font(.system(Theme.caption, weight: .semibold))
                                    .foregroundStyle(Theme.accent)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(picked ? Theme.messageSurface : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusRow))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        case "boolean":
            Toggle(field.label, isOn: Binding(
                get: { boolAnswers[field.key] ?? false },
                set: { boolAnswers[field.key] = $0 }
            ))
            .font(Theme.body)
            .tint(Theme.accent)
        case "secret":
            SecureField(field.label, text: binding(field))
                .font(Theme.body)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Theme.fill)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusControl))
                .hairline(Theme.radiusControl)
        default:
            TextField(field.label, text: binding(field), axis: .vertical)
                .font(Theme.body)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Theme.fill)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusControl))
                .hairline(Theme.radiusControl)
        }
    }

    private func toggle(_ key: String, _ choice: String) {
        var picked = listAnswers[key] ?? []
        if picked.contains(choice) { picked.remove(choice) } else { picked.insert(choice) }
        listAnswers[key] = picked
    }

    private func binding(_ field: UserInputField) -> Binding<String> {
        Binding(
            get: { textAnswers[field.key] ?? "" },
            set: { textAnswers[field.key] = $0 }
        )
    }
}
