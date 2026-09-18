/**
 * WHAT THE AGENT IS TOLD — one paragraph, at the prompt seam (#531).
 *
 * ADAPTED FROM `MAIN_SESSION_BRIEFING` RATHER THAN REPLACED, because almost all
 * of it was already about the ROLE and not about the designation. Three things
 * changed and they are the three the Agent actually is:
 *
 *   1. IT IS NOT A SESSION. The old text opened "You are this Telar's Main
 *      session" and that is now false in a way a model would act on: it has no
 *      session id, nothing wakes it by sending it a turn as a peer, and
 *      `sessions_read` on itself answers not-found. It says what it is instead.
 *   2. IT HAS THREE MORE READS. `sessions_find`, `sessions_outline` and
 *      `sessions_answer` exist for exactly the question a coordinator asks most
 *      — "which conversation was this, and what did it conclude" — and a model
 *      that does not know they are there pages a journal instead.
 *   3. APPROVALS ARE ITS OWN. A turn parks for a person on five specific calls,
 *      and a model that does not expect that reads the pause as a failure and
 *      retries. So the paragraph says which calls, in the same breath as the
 *      permissions sentence that survives verbatim.
 *
 * STILL WRITTEN AS LIMITS RATHER THAN POWERS. What a coordinator gets wrong is
 * not the doing, it is the deciding: creating a session that already exists,
 * subscribing to conversations nobody assigned it, treating a peer as a child,
 * routing a refused action through somebody else. Each sentence names the thing
 * not to do and the cheaper thing to do instead.
 *
 * LANGUAGE AND REGISTER ARE IN THE BRIEFING, NOT IN THE STANDING STATE. The
 * owner speaks Spanish and English by turns, and the Agent kept answering in
 * voseo — the Rioplatense register a model falls into by default when the
 * person says "vos" once. The Agent had written the rule into its own
 * preferences section, but that section sits BELOW the briefing and the
 * orientation, is prose the model wrote for itself, and can be rewritten or
 * cleared by a reset — three reasons it lost to the default. So the rule is
 * here, second sentence, and it names the forms it excludes: "be neutral"
 * alone is exactly the instruction that fails.
 *
 * HOW IT SPENDS ITS LAPS IS NOW ONE OF THE LIMITS (#570). Asked "how are
 * things", the Agent made SIXTEEN sequential tool calls — one per lap, ten of
 * them `sessions_answer` — and died on the graph's ceiling with no answer. The
 * engine half of that is fixed elsewhere (the tools node runs a message's calls
 * together, and a turn out of laps answers instead of throwing); what belongs
 * HERE is the half no code can enforce, which is that a model choosing one call
 * per message is choosing to spend sixteen laps on four seconds of work.
 *
 * THE 2,800-CHARACTER CEILING IS WHY THE PROSE AROUND IT MOVED. Adding a rule to
 * a full paragraph means taking the words from somewhere, and the somewhere was
 * clause-level fat rather than any rule: "rewritten one at a time and always in
 * this prompt" lost two words, "the same action under another name" became "the
 * same action renamed", and the closing "You own no project and no session by
 * default" went entirely because sentence three already says it outright. Every
 * limit that was in this paragraph is still in it. The language rule was not
 * touched: its list of excluded forms IS the rule (see above).
 *
 * IT IS NOW WITHIN ~10 CHARACTERS OF THAT CEILING. Said plainly because the
 * next person to add a sentence here will not find fat to take: the choice at
 * that point is to retire a rule or to raise the number deliberately, and
 * quietly raising it to fit one more sentence is how a paragraph becomes a page.
 *
 * AND THE NUMBER HAS NOT MOVED SINCE (#601). Two sentences were paid out of it
 * rather than one, because #601's rule REPLACED a sentence in the same slot and
 * still needed more room than that slot held. See the two sections below.
 *
 * WHICH IS EXACTLY WHAT #592 COST, AND THE SENTENCE RETIRED WAS `github_status`'s.
 * Asked to wake a session and say where things stood, the Agent spent 22 calls
 * and 77,627 input tokens surveying thirteen sessions and took no action at all;
 * the person's target was ambiguous and the honest answer to that is one
 * question, not thirteen reads. `LOOK BEFORE YOU CREATE` had no other half —
 * nothing here said when looking was FINISHED — so that half is now a sentence,
 * and it had to be paid for.
 *
 * THE `github_status` SENTENCE WAS THE MOST EXPENDABLE THING IN THE PARAGRAPH
 * because it was the only one that was not a limit. "github_status reads one
 * issue or pull request by number — state, checks, mergeable, last comment. All
 * you see outside Telar, and it changes nothing there." is a DESCRIPTION OF A
 * TOOL, and the tool's own description — bound beside this paragraph, on every
 * lap of every turn — already says all of it, read-only included:
 * `agent/tools.ts`'s `GITHUB_STATUS`. Every other sentence here names something
 * not to do and the cheaper thing to do instead, which is the one thing a tool
 * schema cannot carry. Retiring a duplicate costs nothing; retiring a limit
 * would have cost the limit.
 *
 * ANSWERING IS NOW THE DEFAULT AND LOOKING IS THE EXCEPTION (#601). This is the
 * one the owner feels: "No logro tener conversaciones normales con el agente."
 * Every message opened with a pile of reads before any answer — measured over
 * 119 turns, `fleet_status` as a per-turn ritual, `sessions_status` fanned out
 * across five ids and `sessions_list` on top, fired identically for a real
 * status question and for "¿Estás ahí?", at ~30,000 input tokens a lap.
 *
 * AND THE NEWS WAS ALREADY IN THE PROMPT WHEN IT WENT ASKING. `wake()` writes a
 * row for every session that finished, failed, stopped or parked a request, with
 * no model call and no tokens; `runTurn` renders those rows into the digest at
 * the top of every human-started turn. The Agent had been told what happened
 * before the person's message arrived, and then spent seven laps confirming it.
 * The owner demonstrated the fix himself mid-log — "solo necesito que me
 * contestes rápido" — and the next turn answered in one line with zero calls, at
 * 24,218 input tokens against the previous turn's 77,627.
 *
 * SO THE RULE NAMES BOTH HALVES OF THE PROMPT, NOT JUST THE DIGEST, and that is
 * a fact about the digest's shape rather than a flourish. `renderDigest` reports
 * TRANSITIONS — finished, failed, stopped, waiting on you — so a session still
 * WORKING right now has no row in it. What carries in-flight work is the
 * standing state's "who is on what", which `remember` keeps and which sits
 * directly above the digest in the same system block. A rule that said "answer
 * from the digest" alone would be pointing at a block that genuinely cannot
 * answer "what is running", and the Agent would go looking for the honest half
 * of the reason. The digest and the notes together are what a check-in needs.
 *
 * AND `undefined` IS NEWS TOO. `renderDigest` returns nothing at all when
 * nothing is unread — deliberately, so a quiet machine does not pay for the
 * feature on every message — which means the ABSENCE of the block is the
 * statement "nothing has happened since you last spoke". A model that read the
 * absence as "I was told nothing" would look, which is the same bug arriving by
 * the other door. So the sentence says it outright.
 *
 * NOT A CAP ON TOOL CALLS, deliberately. A ceiling produces confident answers
 * built on nothing the day a question genuinely needs a read; what changed is
 * which behaviour is the default, and the exception keeps its whole range.
 *
 * WHAT IT COST: TWO SENTENCES, AND NEITHER WAS A LIMIT.
 *
 *   1. `For 'how are things' call fleet_status ONCE; sessions_answer is one
 *      turn's words.` was REPLACED IN PLACE rather than retired — same slot,
 *      same subject, opposite instruction. It told the Agent to spend a call on
 *      exactly the question #601 says costs none, so it could not survive the
 *      rule that supersedes it. Its routing is not lost: `FLEET_STATUS`'s own
 *      description, bound beside this paragraph on every lap, already said "ONE
 *      call answers 'how is it going'; sessions_answer is for one turn's words"
 *      in those words. It now also stops OPENING with the check-in's own phrase
 *      and adds "NOT to confirm the digest" — the specific form of this rule, at
 *      the moment of choosing that call. #570's finding is intact; its default
 *      moved.
 *   2. `recall searches this conversation's own history, folded turns included,
 *      for the words rather than the gist.` was RETIRED, and it was the most
 *      expendable thing left in the paragraph by exactly #592's test: it is the
 *      only remaining sentence that DESCRIBES A TOOL instead of naming a limit.
 *      Every clause of it is already in `RECALL` and in `recall`'s own `q`
 *      parameter — "Search THIS conversation's own history", "including turns
 *      already folded out of your prompt", "Lexical, not semantic" — bound on
 *      every lap regardless. A duplicate costs nothing to retire; a limit would
 *      have cost the limit. Every rule that was in this paragraph is still in it.
 *
 * IT DOES NOT REPEAT THE `telar` SKILL, which already says what a session is,
 * that sessions are peers, that settling is shelving rather than acceptance,
 * and how assignment works. A second copy paid for on every turn would drift
 * from it on the first edit.
 */
export const AGENT_BRIEFING =
  "You are Telar's Agent: the conversation the person uses to keep track of Telar's work and to coordinate the sessions running it. " +
  "ANSWER IN THE LANGUAGE THE PERSON USED, turn by turn: English back to English, Spanish back to Spanish. Spanish is NEUTRAL Spanish with tú — never voseo (vos, querés, podés, tenés, decime, fijate, mirá) and never Southern-Cone lexicon (acá, allá, dale, che, laburo, bárbaro); write 'aquí', 'puedes', 'dime'. " +
  "YOU ARE NOT A SESSION. You have no project, no checkout and no working directory, and nothing in the rail is you — Telar sessions are resources you operate on through tools, never your own identity. " +
  "YOU HOLD THE SESSIONS WALL AND THE NOTES WALL and nothing else: no shell, no browser, no files, no runs. That is the shape of the role, not a restriction to work around: repository work belongs to the sessions you delegate to. " +
  "LOOK BEFORE YOU CREATE: sessions_find answers 'which conversation was this', sessions_outline scrolls one without reading it, sessions_answer gives what a turn concluded — those three before sessions_read. Read the rail before starting anything: the session usually already exists. " +
  "INDEPENDENT READS GO IN ONE MESSAGE, not one per lap — they run together, and your laps are few. " +
  "ANSWER BEFORE YOU LOOK: the digest and your notes are the news — no digest means nothing happened — so a greeting or 'how are things' costs NO call; read only for what they cannot carry. " +
  "DELEGATE ONLY WHAT WAS ASKED FOR, as a bounded task carrying everything the other session needs: it cannot see this conversation, and it is the one with the files. " +
  "SUBSCRIBE ONLY TO WORK YOU ASSIGNED, and prefer one-shot subscriptions; you are not a monitor and run no schedule. " +
  "REPORT WHAT CHANGED — a result, a blocker, a decision the person has to make — not that work is still in progress. " +
  "SOME CALLS WAIT FOR THE PERSON: assigning a task, raising a blocker, creating a session, stopping one, answering another session's request, deleting a note. That pause is the gate working, not a failure — never retry a declined call; say it was declined and ask what they want. " +
  "KEEP YOUR OWN NOTES WITH remember: four sections — what you are doing, who is on what, open questions, preferences — one at a time, always in this prompt, which is what you still have once older turns fold to one line each. " +
  "WHEN THEY ASKED FOR AN ACTION, reads are for finding the target — once it is found, act; if two candidates survive the first read, ask which rather than widening the search. " +
  "PRESERVE WORK AND RESPECT PERMISSIONS: never stop or settle a session to tidy the list, never answer another session's request unless you actually know the answer, and never hand a peer an action refused here — the same action renamed. " +
  "When something needs the person's decision, ask them.";

/**
 * ONE SENTENCE, FOR A TURN THAT WILL BE HEARD RATHER THAN READ (#567).
 *
 * PER TURN, NOT A SETTING. `brief` is a property of the REQUEST — telar-vr sends
 * it, the cockpit does not — and the same conversation is read on a screen
 * between two spoken turns. A stored preference would make the written UI
 * terse because somebody once used their voice.
 *
 * IT RIDES THE SYSTEM BLOCK, LAST, because that block is rebuilt per turn and
 * never checkpointed: an instruction about how to answer THIS question must not
 * still be in the prompt three turns later, and anything appended to the
 * message list would be. Last for the order the rest of the block already has —
 * most permanent first, and nothing here is less permanent than this.
 *
 * WHAT IT ASKS FOR IS A LENGTH AND A SHAPE, not a tone. A list read aloud is a
 * paragraph with the punctuation removed, and a code block is unspeakable; the
 * Agent's voice is its own.
 */
export const AGENT_BRIEF_ANSWER =
  "THIS ANSWER WILL BE SPOKEN ALOUD: reply in ONE sentence of plain prose, and offer more only if there is more. No lists, no headings, no code, no markdown.";
