"use client";

// THE FOUR HEAVY STREAMDOWN RENDERERS, FETCHED ONLY BY TEXT THAT ASKS FOR THEM.
//
// `MessageResponse` is reached from the dock, and the dock is mounted globally
// in app/layout.tsx — so anything this module's callers import statically is
// paid for by EVERY route before it can hydrate. Measured on an empty composer
// (`/projects/telar/sessions/new`, no messages at all): katex 819KB, mermaid
// 1.4MB across four chunks, plus shiki, were all downloaded to render nothing.
//
// So the plugin objects move behind `import()` and are requested per message
// from an effect, after the text has already painted through Streamdown's core.
//
// WHY DETECTION IS SAFE HERE RATHER THAN A GUESS. Each of these plugins is a
// no-op on text that does not contain its syntax: remark-math only fires on
// `$$`/`\(`/`\[`, the mermaid renderer only on a fence whose language is
// literally `mermaid`, remark-cjk-friendly only on CJK codepoints, and shiki
// only on a fenced block. The triggers below are therefore not heuristics about
// what a message "probably" needs — they are the same conditions the plugins
// themselves test, hoisted one level up. Over-matching (a shell transcript that
// happens to print `$$`) costs one wasted fetch; it cannot change output.
//
// WHAT A READER SEES WHILE A PLUGIN IS IN FLIGHT. For three of the four,
// Streamdown degrades on its own: a fenced block renders with its full chrome
// and uncoloured tokens until the highlighter resolves, and math renders as
// literal text. Prose never waits, because Streamdown's core (markdown, lists,
// tables, the bare-fence box in code-block.tsx) stays statically imported.
//
// MERMAID IS THE EXCEPTION AND IT NEEDED HANDLING. Its renderer does not fall
// back to a code block — it reads the plugin off context and, finding none,
// sets an error:
//     if (!g) { l("Mermaid plugin not available. …"); return; }
// (streamdown 2.5.0 dist/chunk-BO2N2NFS.js, the diagram component's effect).
// That effect lists the plugin in its deps, so it self-heals the moment the
// import lands — but mermaid is the largest of the four, so a reader would
// otherwise watch a red error box for the whole fetch. `useMermaidReady` below
// exists so the caller can tell "still loading" from "genuinely broken" and
// render each honestly; see MessageResponse's errorComponent.
//
// THE PLUGINS ARE RE-READ AFTER MOUNT, which is what makes any of this work.
// Streamdown's own memo comparator includes `e.plugins===t.plugins`, and both
// pipelines are useMemo'd on the sub-objects (`[l, g?.math, g?.cjk]` for remark,
// `[a, g?.math, …]` for rehype), so handing back a fresh object identity when a
// plugin resolves is exactly the signal it re-renders on. That is why
// `snapshot` below is copied rather than mutated in place.

import { useEffect, useSyncExternalStore } from "react";
import type { PluginConfig } from "streamdown";

type PluginName = "cjk" | "code" | "math" | "mermaid";

// Accumulates across the whole page: plugins are stateless config objects, so a
// transcript that already pulled mermaid hands it to the next message for free.
const loaded: PluginConfig = {};

// Written per-plugin rather than through one generic helper because each entry
// resolves a differently-shaped plugin type, and `loaded[name] = plugin` on a
// union key is exactly the assignment TypeScript cannot narrow.
const LOAD: Record<PluginName, () => Promise<void>> = {
  cjk: async () => {
    loaded.cjk = (await import("@streamdown/cjk")).cjk;
  },
  code: async () => {
    loaded.code = (await import("@streamdown/code")).code;
  },
  math: async () => {
    loaded.math = (await import("@streamdown/math")).math;
  },
  mermaid: async () => {
    loaded.mermaid = (await import("@streamdown/mermaid")).mermaid;
  },
};

// No `g` flag anywhere: these are re-tested against a growing string on every
// streamed token, and a stateful `lastIndex` would silently skip matches.
const TRIGGERS: Record<PluginName, RegExp> = {
  // Han, Hiragana, Katakana, Hangul, and the CJK punctuation/fullwidth blocks
  // remark-cjk-friendly adjusts emphasis around.
  cjk: /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\uAC00-\uD7AF]/,
  // Any fence. A fence WITHOUT a language never reaches shiki (MarkdownPre
  // renders those itself), but the language is the last thing to arrive on a
  // streamed fence line, and asking one beat early is cheaper than re-scanning.
  code: /^[ \t]*(?:`{3,}|~{3,})/m,
  // `$$` display math, LaTeX `\(`/`\[` delimiters, and a ```math fence.
  // Single `$` is deliberately absent: Streamdown defaults
  // `singleDollarTextMath` to false, so a lone `$` is not math here — and shell
  // output is full of them.
  math: /\$\$|\\\(|\\\[|^[ \t]*(?:`{3,}|~{3,})[ \t]*math\b/m,
  mermaid: /^[ \t]*(?:`{3,}|~{3,})[ \t]*mermaid\b/im,
};

const PLUGIN_NAMES = Object.keys(TRIGGERS) as PluginName[];

const EMPTY_PLUGINS: PluginConfig = {};

// `useSyncExternalStore` needs a snapshot whose identity is stable between
// loads, so `loaded` is copied into `snapshot` once per resolution instead of
// being handed out directly.
let snapshot: PluginConfig = EMPTY_PLUGINS;
const subscribers = new Set<() => void>();

// Requested, not "pending": an entry is never removed. A plugin that failed to
// load must not be retried on every subsequent render of a streaming message.
const requested = new Set<PluginName>();

const requestPlugin = (name: PluginName) => {
  if (requested.has(name)) return;
  requested.add(name);
  LOAD[name]().then(
    () => {
      snapshot = { ...loaded };
      for (const notify of subscribers) notify();
    },
    (error: unknown) => {
      console.error(`[MessageResponse] failed to load the ${name} plugin`, error);
    }
  );
};

const subscribe = (onStoreChange: () => void) => {
  subscribers.add(onStoreChange);
  return () => {
    subscribers.delete(onStoreChange);
  };
};

const getSnapshot = () => snapshot;

// The server has no plugins either, which is the point: SSR and the first
// client render agree on the empty set, so there is no hydration mismatch to
// paper over. Plugins only ever arrive in an effect, after hydration.
const getServerSnapshot = () => EMPTY_PLUGINS;

/**
 * Streamdown plugins available to render `markdown`, widening over time.
 *
 * Returns `{}` on the first render and again whenever nothing has loaded yet;
 * `Streamdown` treats every plugin as optional, so that is a valid config.
 */
// Whether the mermaid renderer can actually draw yet. Separate from the plugin
// object so a caller can subscribe to just this without re-rendering on every
// other plugin's arrival — and a boolean snapshot is referentially stable,
// which `useSyncExternalStore` requires.
const getMermaidReady = () => snapshot.mermaid !== undefined;
const getMermaidReadyServer = () => false;

export function useMermaidReady(): boolean {
  return useSyncExternalStore(subscribe, getMermaidReady, getMermaidReadyServer);
}

export function useStreamdownPlugins(markdown: string | undefined): PluginConfig {
  useEffect(() => {
    if (!markdown) return;
    for (const name of PLUGIN_NAMES) {
      // Cheap short-circuit first — once a plugin is on its way the regex
      // never has to run again, which matters when this re-runs per token.
      if (requested.has(name)) continue;
      if (TRIGGERS[name].test(markdown)) requestPlugin(name);
    }
  }, [markdown]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
