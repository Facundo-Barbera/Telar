import SwiftUI

/// The card pinned above the composer while a request is open. While one is
/// open, NO further work happens on the session — this card is the phone's
/// reason to exist.
struct RequestCardView: View {
    let request: EngineRequest
    let store: SessionStore
    @State private var declining = false
    @State private var declineReason = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch request.detail {
            case .commandExecution(let command):
                header("Run a command", icon: "terminal")
                if let cwd = command.cwd {
                    Text(cwd).font(.caption2).foregroundStyle(.tertiary)
                }
                CodeBlockView(code: command.command)
                approvalButtons
            case .fileChange(let change):
                header("\(change.kind.capitalized) \(change.path)", icon: "pencil")
                if let diff = change.unifiedDiff {
                    CodeBlockView(code: diff).frame(maxHeight: 200)
                }
                approvalButtons
            case .fileRead(let read):
                header("Read \(read.path)", icon: "doc.text")
                approvalButtons
            case .toolCall(let call):
                header(displayToolName(call.name), icon: "wrench.and.screwdriver")
                if let input = call.input {
                    CodeBlockView(code: input.prettyPrinted).frame(maxHeight: 200)
                }
                approvalButtons
            case .userInput(let prompt, let fields):
                header("Question", icon: "questionmark.bubble")
                UserInputFormView(prompt: prompt, fields: fields) { answers in
                    Task { await store.resolve(request, decision: .accept, answers: answers) }
                }
            case .unknown(let kind):
                header("Approval needed (\(kind))", icon: "questionmark.diamond")
                Text("This build doesn't know this request kind — you can still answer it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                approvalButtons
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.orange.opacity(0.5)))
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
        Label(title, systemImage: icon)
            .font(.subheadline.weight(.semibold))
            .lineLimit(2)
    }

    private var approvalButtons: some View {
        HStack(spacing: 8) {
            Button("Accept") {
                Task { await store.resolve(request, decision: .accept) }
            }
            .buttonStyle(.borderedProminent)
            Button("Always") {
                Task { await store.resolve(request, decision: .acceptForSession) }
            }
            .buttonStyle(.bordered)
            Button("Decline", role: .destructive) {
                declining = true
            }
            .buttonStyle(.bordered)
            Spacer()
            Menu {
                Button("Withdraw the turn", role: .destructive) {
                    Task { await store.resolve(request, decision: .cancel) }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
        .controlSize(.small)
    }
}

/// A real form: the agent is asking, not asking permission. Never
/// auto-resolved in any runtime mode — it is genuinely waiting on the person
/// holding this phone.
struct UserInputFormView: View {
    let prompt: String
    let fields: [UserInputField]
    let submit: ([String: AnswerValue]) -> Void

    @State private var textAnswers: [String: String] = [:]
    @State private var boolAnswers: [String: Bool] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            MarkdownText(text: prompt)
            ForEach(fields) { field in
                fieldView(field)
            }
            Button("Submit") {
                var answers: [String: AnswerValue] = [:]
                for field in fields {
                    switch field.kind {
                    case "boolean":
                        answers[field.key] = .bool(boolAnswers[field.key] ?? false)
                    default:
                        let value = textAnswers[field.key] ?? ""
                        if !value.isEmpty { answers[field.key] = .text(value) }
                    }
                }
                submit(answers)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(!requiredFilled)
        }
    }

    private var requiredFilled: Bool {
        fields.allSatisfy { field in
            guard field.required == true else { return true }
            if field.kind == "boolean" { return true }
            return !(textAnswers[field.key] ?? "").isEmpty
        }
    }

    @ViewBuilder
    private func fieldView(_ field: UserInputField) -> some View {
        switch field.kind {
        case "choice":
            VStack(alignment: .leading, spacing: 4) {
                Text(field.label).font(.caption).foregroundStyle(.secondary)
                Picker(field.label, selection: binding(field)) {
                    Text("—").tag("")
                    ForEach(field.choices ?? [], id: \.self) { choice in
                        Text(choice).tag(choice)
                    }
                }
                .pickerStyle(.menu)
            }
        case "boolean":
            Toggle(field.label, isOn: Binding(
                get: { boolAnswers[field.key] ?? false },
                set: { boolAnswers[field.key] = $0 }
            ))
            .font(.caption)
        case "secret":
            SecureField(field.label, text: binding(field))
                .textFieldStyle(.roundedBorder)
        default:
            TextField(field.label, text: binding(field), axis: .vertical)
                .textFieldStyle(.roundedBorder)
        }
    }

    private func binding(_ field: UserInputField) -> Binding<String> {
        Binding(
            get: { textAnswers[field.key] ?? "" },
            set: { textAnswers[field.key] = $0 }
        )
    }
}
