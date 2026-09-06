/** Provider-neutral guidance, injected only when the session has a browser. */
export const BROWSER_BRIEFING =
  "Telar supplies this session's integrated browser through the telar-browser MCP server. " +
  "For browser work, use that server's tools so the human and agent share this session's tabs. " +
  "The tools may be deferred: use available tool discovery/search for telar-browser and browser_list_tabs, " +
  "browser_navigate, browser_snapshot, or browser_resize before concluding they are unavailable. " +
  "List existing tabs before acting on a page the human refers to. Do not substitute another browser or profile. " +
  "When calling screenshot tools through a code runner, forward returned image content blocks to its image display helper " +
  "and print only text blocks; do not serialize base64 image data as text. Inspect the displayed image before claiming visual verification.";
