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
 * THE PHRASE IS CHOSEN ON THE SERVER, which is why there is no "safe first
 * one" any more. The canvas used to render phrase 0 and then rewrite itself
 * once the client had read a counter — one of three visible steps that screen
 * took before it settled. The page picks a number, the number arrives as a
 * prop, and the first paint is the final paint.
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
 * Clamp a chosen index into range.
 *
 * ONE PHRASE PER PAGE LOAD, never on a timer: a sentence that rewrites itself
 * while you are reading it is a distraction with no upside, and this one sits
 * directly above the thing you came to type into.
 *
 * The index arrives from the server, so this is a boundary check rather than a
 * choice — but it is a real one. A number out of range, or one that stopped
 * being a number somewhere in transit, would index past the end and render
 * nothing at all.
 */
export function greetingForVisit(seed: number): number {
  if (!Number.isFinite(seed)) return 0;
  return Math.abs(Math.trunc(seed)) % GREETINGS.length;
}
