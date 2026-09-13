/**
 * THE LINE ABOVE AN EMPTY COMPOSER — one line, and always the same one.
 *
 * Codex and t3 code both put a sentence over a fresh chat — "let's work on
 * <project>" — and it does more work than it looks like. An empty screen with a
 * box on it is a form; an empty screen that addresses you and names where you
 * are standing is a place. It also answers, before you type a word, the one
 * question a new conversation actually has to answer: WHICH PROJECT is this
 * about.
 *
 * THERE USED TO BE FOURTEEN OF THEM, ROTATING. "exoplanets is not going to fix
 * itself", "exoplanets has been suspiciously quiet", "Be gentle with exoplanets
 * today" — a joke chosen per visit, directly above the box you came here to type
 * into. A joke is funny once. Read at the top of every new conversation, several
 * times a day, it is a slot machine on the one screen that should be quiet, and
 * it makes the app's voice the loudest thing in a room the reader came to think
 * in. One neutral question costs nothing and wears out never.
 *
 * SPLIT AROUND THE PROJECT RATHER THAN INTERPOLATED, because the project name is
 * a CONTROL — you can press it and change it — and a template string cannot hold
 * a button. `before` and `after` are the two halves of the sentence, and `after`
 * is punctuation that must HUG the name: see `fresh-greeting.tsx`, where the
 * trigger's own padding is what used to push it away ("exoplanets , then?").
 */
export type Greeting = { before: string; after: string };

export const GREETING: Greeting = { before: "What's next for ", after: "?" };
