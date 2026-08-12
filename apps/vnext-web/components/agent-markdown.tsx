"use client";

import { Streamdown } from "streamdown";

/**
 * Agent prose, rendered as markdown.
 *
 * WHY A LIBRARY AND WHY THIS ONE. Assistant text was rendered as a single
 * `<p>{text}</p>`, so every code block, list and heading the model wrote arrived
 * as one run-on paragraph with literal backticks in it. `streamdown` is what the
 * frozen cockpit uses, and it is built for exactly this input: text that arrives
 * as deltas and is therefore SYNTACTICALLY INCOMPLETE most of the time it is on
 * screen. A general markdown renderer given a half-written fence renders the
 * rest of the message as code until the closing fence lands, so the page flashes
 * between two layouts on every token.
 *
 * `mode` IS DERIVED FROM WHETHER THE TURN IS LIVE, not from whether this
 * particular row is still open. A completed row inside a running turn is done
 * and can be parsed strictly; the distinction only matters for the row currently
 * receiving deltas, and `parseIncompleteMarkdown` is what handles it.
 */
export function AgentMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  if (!text) return null;
  return (
    <Streamdown
      className="vnext-markdown"
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming === true}
      // Links open away from the cockpit. An agent-authored link that replaced
      // the session view would lose a running turn's scroll position and, in the
      // desktop shell, the window itself.
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </Streamdown>
  );
}
