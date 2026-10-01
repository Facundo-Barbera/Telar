import Foundation
import Testing
@testable import TelarMobile

@Suite struct ComposerTriggerTests {
    @Test func aSlashOpeningTheLineIsACommandAndTheRestOfTheLineIsTheQuery() {
        let trigger = ComposerTrigger.detect(in: "/model op", caret: 9)
        #expect(trigger == ComposerTrigger(kind: .command, query: "model op", range: NSRange(location: 0, length: 9)))
    }

    @Test func aSlashOnALaterLineCountsFromThatLine() {
        let trigger = ComposerTrigger.detect(in: "fix this\n/rev", caret: 13)
        #expect(trigger == ComposerTrigger(kind: .command, query: "rev", range: NSRange(location: 9, length: 4)))
    }

    @Test func aSlashInsideProseOpensNothing() {
        #expect(ComposerTrigger.detect(in: "give it 9/10", caret: 12) == nil)
        #expect(ComposerTrigger.detect(in: "see apps/web", caret: 12) == nil)
    }

    @Test func onlyTheTextBeforeTheCaretCounts() {
        #expect(ComposerTrigger.detect(in: "/stop now", caret: 3)?.query == "st")
        #expect(ComposerTrigger.detect(in: "hello /stop", caret: 2) == nil)
    }

    @Test func aDollarStartingAWordIsASkill() {
        let trigger = ComposerTrigger.detect(in: "use $vercel", caret: 11)
        #expect(trigger == ComposerTrigger(kind: .skill, query: "vercel", range: NSRange(location: 4, length: 7)))
    }

    @Test func shellSnippetsDoNotOpenSkills() {
        #expect(ComposerTrigger.detect(in: "echo ${HOME}", caret: 12) == nil)
        #expect(ComposerTrigger.detect(in: "PATH=$HOME", caret: 10) == nil)
    }

    @Test func rangesAreMeasuredInTheTextViewsUnits() {
        let trigger = ComposerTrigger.detect(in: "🎉 $sk", caret: 6)
        #expect(trigger?.range == NSRange(location: 3, length: 3))
    }

    @Test func replacingSwapsOnlyTheTriggerAndPutsTheCaretAfterIt() {
        let trigger = ComposerTrigger.detect(in: "fix\n/orch", caret: 9)!
        let result = trigger.replace(in: "fix\n/orch", with: "the \"orchestrate\" skill ")
        #expect(result.text == "fix\nthe \"orchestrate\" skill ")
        #expect(result.caret == (result.text as NSString).length)
    }

    @Test func openingTheMenuStartsANewLineOnlyWhenNeeded() {
        #expect(ComposerTrigger.opening("") == "/")
        #expect(ComposerTrigger.opening("fix it\n") == "fix it\n/")
        #expect(ComposerTrigger.opening("fix it") == "fix it\n/")
    }
}

@Suite struct ComposerCompletionsTests {
    private let skills = ProviderSkills(
        skills: [
            ProviderSkill(name: "vercel:deploy", description: "Deploy the project", source: "plugin"),
            ProviderSkill(name: "orchestrate", description: "", source: "user"),
            ProviderSkill(name: "security-audit", description: "Audit for vulnerabilities", source: "project"),
        ],
        commands: [ProviderSkill(name: "review", description: "Review the diff", source: "project")]
    )

    private func command(_ query: String, _ context: ComposerCommandContext = ComposerCommandContext()) -> [ComposerCompletion] {
        ComposerCompletions.list(for: ComposerTrigger(kind: .command, query: query, range: NSRange()), context: context, skills: skills)
    }

    @Test func aBareSlashListsCommandsThenProviderCommandsThenSkills() {
        let groups = command("").map(\.group)
        #expect(groups.first == ComposerCompletions.commandsGroup)
        #expect(groups.firstIndex(of: ComposerCompletions.providerGroup)! < groups.firstIndex(of: ComposerCompletions.skillsGroup)!)
        #expect(groups.lastIndex(of: ComposerCompletions.commandsGroup)! < groups.firstIndex(of: ComposerCompletions.providerGroup)!)
    }

    @Test func stopIsOfferedOnlyWhileATurnRuns() {
        #expect(!command("stop").contains { $0.id == "stop" })
        #expect(command("stop", ComposerCommandContext(busy: true)).first?.action == .stop)
    }

    @Test func agentAndWorkspaceCommandsBelongToANewConversation() {
        #expect(!command("").contains { $0.id == "env:worktree" || $0.id == "driver:codex" })
        let fresh = command("", ComposerCommandContext(fresh: true, driver: "claude", envMode: "worktree"))
        #expect(fresh.first { $0.id == "driver:codex" }?.action == .driver("codex"))
        #expect(fresh.first { $0.id == "env:worktree" }?.detail.hasSuffix("(current)") == true)
    }

    @Test func theCurrentAccessModeIsMarked() {
        let rows = command("", ComposerCommandContext(runtimeMode: "full-access"))
        #expect(rows.first { $0.id == "access:full-access" }?.detail.hasSuffix("(current)") == true)
        #expect(rows.first { $0.id == "access:auto" }?.detail.hasSuffix("(current)") == false)
    }

    @Test func initialsReachAHyphenatedCommand() {
        #expect(command("fa").first?.id == "access:full-access")
    }

    @Test func filteringDropsWhatDoesNotMatch() {
        let rows = command("diff")
        #expect(rows.map(\.id) == ["provider:review"])
    }

    @Test func orchestrateAppearsOnlyWhenTheSkillIsInstalled() {
        let row = command("orch").first { $0.id == "orchestrate" }
        #expect(row?.action == .insert("Use the \"orchestrate\" skill to coordinate this list:"))
        let without = ComposerCompletions.list(for: ComposerTrigger(kind: .command, query: "orch", range: NSRange()), context: ComposerCommandContext(), skills: .empty)
        #expect(!without.contains { $0.id == "orchestrate" })
    }

    @Test func aProviderCommandInsertsItsSlashName() {
        #expect(command("review").first { $0.group == ComposerCompletions.providerGroup }?.action == .insert("/review"))
    }

    @Test func aSkillInsertsItsReferenceAndFallsBackToItsSourceForADetail() {
        let rows = ComposerCompletions.list(for: ComposerTrigger(kind: .skill, query: "", range: NSRange()), context: ComposerCommandContext(), skills: skills)
        #expect(rows.allSatisfy { $0.group == ComposerCompletions.skillsGroup })
        #expect(rows.first { $0.label == "orchestrate" }?.detail == "This computer")
        #expect(rows.first?.action == .insert("the \"vercel:deploy\" skill"))
    }

    @Test func aNamespaceIsABoundaryForSkills() {
        #expect(ComposerCompletions.rankSkills(skills.skills, query: "deploy").first?.label == "vercel:deploy")
        #expect(ComposerCompletions.rankSkills(skills.skills, query: "vulnerab").first?.label == "security-audit")
    }

    @Test func aNameMatchOutranksADescriptionMatch() {
        let rows = ComposerCompletions.rankSkills([
            ProviderSkill(name: "notes", description: "audit trail", source: "user"),
            ProviderSkill(name: "audit", description: "", source: "user"),
        ], query: "audit")
        #expect(rows.map(\.label) == ["audit", "notes"])
    }

    @Test func quotesInASkillNameCannotCloseTheReference() {
        #expect(ComposerCompletions.skillReference("say \"hi\"") == "the \"say 'hi'\" skill")
    }
}
