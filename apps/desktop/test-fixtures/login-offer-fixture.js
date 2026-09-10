// A review fixture for the ACTUAL login-offer.html: serves the real file
// (read from disk on every request — never a copy) with one injected script
// that stands in for login-offer-preload.js, implementing the same
// window.telarLoginOffer contract with scripted vault METADATA per scenario.
// Nothing here touches Electron, the engine, a vault, or any installed state;
// confirm/dismiss are recorded on window.__offerCalls and echoed into the
// document title so a browser reviewer can see the outcome.
//
//   bun apps/desktop/test-fixtures/login-offer-fixture.js [port]
//   → http://127.0.0.1:43195/          (scenario index)
//   → http://127.0.0.1:43195/offer?scenario=two-accounts
//
// Scenarios: two-accounts (confirm succeeds), vault-locked, no-items,
// replaced-on-confirm (refusal after selection), expired, live-refresh
// (the offer is replaced while open; the page's onRefresh re-renders).
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.argv[2] || 43195);
const OFFER_HTML = path.join(__dirname, "..", "login-offer.html");

const SCENARIOS = ["two-accounts", "vault-locked", "no-items", "replaced-on-confirm", "expired", "live-refresh"];

const bridgeScript = (scenario) => `
"use strict";
// Stands in for login-offer-preload.js — same surface, scripted answers.
(() => {
  const calls = (window.__offerCalls = []);
  const listeners = [];
  const twoAccounts = {
    origin: "https://accounts.example.com",
    profileLabel: "Personal",
    candidates: [
      { id: "item_work", title: "Example — work", domain: "example.com", vault: "Private" },
      { id: "item_home", title: "Example — home", domain: "example.com", vault: "Private" },
    ],
  };
  let state = {
    "two-accounts": twoAccounts,
    "replaced-on-confirm": twoAccounts,
    "live-refresh": twoAccounts,
    "vault-locked": { origin: "https://accounts.example.com", profileLabel: "Personal", candidates: [], error: "1Password is locked or the CLI integration is disabled. Unlock the 1Password app (or set OP_SERVICE_ACCOUNT_TOKEN for detached use) and try again." },
    "no-items": { origin: "https://accounts.example.com", profileLabel: "Personal", candidates: [] },
    "expired": { error: "Nothing to offer — the moment has passed." },
  }[${JSON.stringify(scenario)}];
  window.telarLoginOffer = {
    state: async () => state,
    confirm: async (input) => {
      calls.push({ method: "confirm", input });
      if (${JSON.stringify(scenario)} === "replaced-on-confirm") {
        return { ok: false, error: "The page or sign-in this offer was about has changed, so nothing was remembered." };
      }
      document.title = "confirmed: " + input.itemId + (input.otp ? " +otp" : "");
      return { ok: true, itemTitle: input.itemId, origin: state.origin };
    },
    dismiss: async () => {
      calls.push({ method: "dismiss" });
      document.title = "dismissed";
      return { ok: true };
    },
    onRefresh: (listener) => {
      listeners.push(listener);
      return () => {};
    },
  };
  if (${JSON.stringify(scenario)} === "live-refresh") {
    // The world moves while the window is open: another site's entry
    // finishes, main replaces the offer and tells the window to refresh.
    setTimeout(() => {
      state = {
        origin: "https://other.example.net",
        profileLabel: "Work",
        candidates: [{ id: "item_other", title: "Other — personal", domain: "other.example.net", vault: "Private" }],
      };
      for (const listener of listeners) listener();
    }, 1500);
  }
})();
`;

const index = `<!doctype html><meta charset="utf-8"><title>login-offer fixture</title>
<h1>login-offer.html review fixture</h1>
<p>The real apps/desktop/login-offer.html, served from disk with a scripted
preload bridge (fake vault metadata, no Electron, no vault, no grants).</p>
<ul>${SCENARIOS.map((scenario) => `<li><a href="/offer?scenario=${scenario}">${scenario}</a></li>`).join("")}</ul>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const scenario = SCENARIOS.includes(url.searchParams.get("scenario")) ? url.searchParams.get("scenario") : "two-accounts";
  if (url.pathname === "/offer") {
    // The actual bytes, at request time; the bridge rides in ahead of the
    // page's own script (which runs at the end of body).
    const html = fs.readFileSync(OFFER_HTML, "utf8").replace('<meta charset="utf-8" />', `<meta charset="utf-8" /><script src="/bridge.js?scenario=${scenario}"></script>`);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (url.pathname === "/bridge.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(bridgeScript(scenario));
    return;
  }
  response.writeHead(url.pathname === "/" ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  response.end(url.pathname === "/" ? index : "not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`login-offer fixture: http://127.0.0.1:${PORT}/`);
});
