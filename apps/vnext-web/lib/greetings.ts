/**
 * THE LINE ABOVE AN EMPTY COMPOSER.
 *
 * Codex and t3 code both put a sentence over a fresh chat — "let's work on
 * <project>" — and it does more work than it looks like. An empty screen with a
 * box on it is a form; an empty screen that addresses you and names where you
 * are standing is a place. It also answers, before you type a word, the one
 * question a new conversation actually has to answer: WHICH PROJECT is this
 * about.
 *
 * SPLIT AROUND THE PROJECT RATHER THAN INTERPOLATED, because the project name is
 * a CONTROL — you can press it and change it — and a template string cannot hold
 * a button. `before` and `after` are the two halves of the sentence.
 *
 * THE FIRST ONE IS NOT RANDOM AND THAT IS DELIBERATE. It is what renders on the
 * server, before the client has picked; every other phrase swaps in after mount.
 * Making the plainest line the one that can flicker into something else keeps
 * the transition reading as intentional rather than as a glitch.
 */
export type Greeting = { before: string; after: string };

export const GREETINGS: readonly Greeting[] = [
  // The canonical one. Server-rendered, and the fallback for everything else.
  { before: "Let's work on ", after: "" },
  { before: "What are we doing to ", after: " today?" },
  { before: "", after: " awaits." },
  { before: "What's broken in ", after: "?" },
  { before: "", after: " is not going to fix itself." },
  { before: "Point me at ", after: "." },
  { before: "Another day, another ", after: "." },
  { before: "Ship something to ", after: "." },
  { before: "", after: ", then?" },
  { before: "Be gentle with ", after: " today." },
  { before: "", after: " has been suspiciously quiet." },
  { before: "Let's go and improve ", after: "." },
  { before: "So. ", after: ".", },
  { before: "Make ", after: " better than you found it." },
];

/** Step to the next phrase, wrapping. Used both by the reroll and by the
 *  per-visit rotation, so the two cannot disagree about the order. */
export function nextGreeting(index: number): number {
  return (index + 1) % GREETINGS.length;
}

/**
 * Where to start on this visit.
 *
 * ROTATES ACROSS VISITS RATHER THAN ON A TIMER. A sentence that rewrites itself
 * while you are reading it is a distraction with no upside, and this one sits
 * directly above the thing you came to type into. One phrase per new
 * conversation is the cadence that makes it feel alive without ever moving under
 * the cursor.
 */
export function greetingForVisit(seed: number): number {
  // NOT FINITE MEANS START OVER. The seed comes from `localStorage`, so it is
  // whatever was last written there — including something another build wrote,
  // or a value that stopped being a number on the way through `Number()`.
  // Without this the modulo yields NaN and the lookup silently misses.
  if (!Number.isFinite(seed)) return 0;
  // Modulo rather than random so the sequence is a rotation — every phrase gets
  // its turn, instead of the same three coming up all week.
  return Math.abs(Math.trunc(seed)) % GREETINGS.length;
}
