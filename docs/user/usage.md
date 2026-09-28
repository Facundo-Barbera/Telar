# Usage and limits

Telar shows what your agents have spent and warns you before a provider's limit stops your work.

## The Usage page

Open Usage from the bottom of the rail, or from the command palette. It shows spend over the last 24 hours, 7, 30 or 90 days, as cost or as tokens:

- a chart per hour or per day, split by provider;
- totals for processed tokens, uncached and cached input, output, and requests;
- a breakdown by model or by day.

Some things to know:

- Usage counts everything this Mac ran with Claude Code and Codex, including work done outside Telar. It reads the CLIs' own records, so nothing is counted twice.
- Cost comes from the provider when it reports one, and otherwise from published rates. A model with no known rate shows a dash, not $0, and the page says its cost isn't counted.
- On a subscription plan, cost is an estimate of what the tokens would have cost. It isn't a bill.
- Each Mac counts only its own work. The iPhone app shows the same figures for one Mac at a time.

## Limits from a shared hub

If your subscription accounts are pooled behind a hub (a CLIProxyAPI server), Telar can show how much of each account's limit is left. Add the hub under Settings → Providers → Usage providers, with its address and management key. A **Limits** section then appears at the top of the Usage page, with one bar per provider and one segment per account.

Without a hub, this section is hidden and the page reports spend only.

## Warnings in a conversation

- **Approaching the rate limit** means the provider has warned that a limit is near. The session is still working.
- **Rate limit reached** (shown in red) means the provider refused the request. The row names the limit (five-hour or weekly, for example) and when it resets.
- **The model has not answered after…** means a request is taking unusually long. It can still answer.
- **Waiting for the limit to reset at…** means a turn was stopped by a usage limit. **Resume now** runs it again straight away, which helps if you know another account has freed up.
- **The context is getting heavy** means the conversation has used 70% of the model's context window. Choose Compact to shrink it, or dismiss the banner. You can change the threshold per login in Settings → Providers (**Heavy context notice**).

## Continuing after a limit

For Claude, a turn stopped by the five-hour or weekly limit runs again on its own once the limit lifts, and picks up where it left off.

- To change the default for new conversations, go to Settings → General → **Continue after a reset**.
- To change it for one conversation, use the composer's Access menu → Usage limits: **Continue after a reset** or **Stay stopped**.

This only applies to Claude, which is the only provider that reports when its limits reset.
