export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main className="vnext-settings-page">
      <nav className="vnext-settings-nav" aria-label="Settings sections"><div><p className="vnext-eyebrow">Telar vNext</p><h1>Settings</h1></div><a href="#runtime" className="is-active">Runtime</a><a href="#availability">Availability</a></nav>
      <div className="vnext-settings-content">
        <header><p className="vnext-eyebrow">Read-only guide</p><h2>Local runtime</h2><p>This cockpit uses the local Claude Code setup already available on this machine. It does not manage accounts, credentials, or provider configuration.</p></header>
        <section id="runtime" className="vnext-settings-group" aria-labelledby="runtime-title"><div><h3 id="runtime-title">Dedicated engine state</h3><p>Run vNext with its dedicated state root.</p></div><div className="vnext-settings-row"><span><strong>Launch command</strong><small>Starts the local engine, worker, and standalone app.</small></span><code>bun run dev:vnext</code></div><div className="vnext-settings-row"><span><strong>State isolation</strong><small>The vNext engine never reads or writes the normal Telar state root.</small></span><span className="vnext-readonly">Protected</span></div></section>
        <section id="availability" className="vnext-settings-group" aria-labelledby="claude-title"><div><h3 id="claude-title">Claude Code availability</h3><p>Worker availability is displayed on Projects; changes stay outside this cockpit.</p></div><div className="vnext-settings-row"><span><strong>Provider configuration</strong><small>Sign in with Claude Code on this machine before starting a worker.</small></span><span className="vnext-readonly">External</span></div></section>
      </div>
    </main>
  );
}
