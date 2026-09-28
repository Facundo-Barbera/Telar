/**
 * Split around the project name because the name is rendered as a button.
 * `after` is punctuation that must sit flush against the name.
 */
export type Greeting = { before: string; after: string };

export const GREETING: Greeting = { before: "What's next for ", after: "?" };
