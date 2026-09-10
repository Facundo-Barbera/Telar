# Provider logo attribution

The SVG logos in this directory were fetched on 2026-09-10 from
**models.dev** (`https://models.dev/logos/{provider}.svg`) — the provider
database maintained by SST and used by OpenCode to resolve model connections.

- Source repository: https://github.com/sst/models.dev (MIT license)
- Consumed by: https://github.com/sst/opencode (MIT license)
- Files: `openai.svg`, `anthropic.svg`, `opencode.svg`, `amazon-bedrock.svg`

All marks are `fill="currentColor"` as published upstream. The logos remain
trademarks of their respective owners (OpenAI, Anthropic, Anomaly / SST,
Amazon); they are used here to identify the corresponding service connection,
not to imply endorsement.

`components/session/connection-icon.tsx` embeds these paths; regenerate it
with `node generate-icons.mjs` from this directory after re-vendoring.
