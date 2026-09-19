# Provider logo attribution

## Connection marks — models.dev

`openai.svg`, `anthropic.svg`, `opencode.svg`, `opencode-go.svg` and
`amazon-bedrock.svg` were fetched from **models.dev**
(`https://models.dev/logos/{provider}.svg`) — the provider database maintained
by SST and used by OpenCode to resolve model connections. `opencode.svg`,
`anthropic.svg`, `openai.svg` and `amazon-bedrock.svg` on 2026-09-10;
`opencode-go.svg` on 2026-09-19.

- Source repository: https://github.com/sst/models.dev (MIT license)
- Consumed by: https://github.com/anomalyco/opencode (MIT license)

**These are keyed by models.dev's CONNECTION id, and `opencode` there means
`OpenCode Zen`** — one account type under the OpenCode provider, whose model
ids read `opencode/<model>`. Its mark is a blocky **Z**, next to
`opencode-go`'s blocky **G**. It is not a mark for OpenCode the application,
and using it as one is the defect issue #655 records. `opencode-go.svg` is
vendored for the same reason: it used to be aliased to `opencode.svg`, which
drew Go's rows with Zen's letter.

## The provider mark — opencode's own brand assets

`opencode-app.svg` is the **OpenCode application's** mark, vendored from
opencode's published brand assets rather than models.dev, which has no entry
for the app itself.

- Source: https://github.com/anomalyco/opencode (MIT license),
  `packages/console/app/src/asset/lander/logo-dark.svg`, fetched 2026-09-19.
- Geometry verbatim. The two brand fills (`#4B4646` inner, `#F1ECEC` ring)
  become `currentColor`, with the inner block kept dimmer via `opacity`, so one
  file reads in both themes — the same treatment every mark here gets. The
  upstream `clipPath` clips to the mark's own bounds and is dropped as a no-op.

## Both

All marks are `fill="currentColor"`. The logos remain trademarks of their
respective owners (OpenAI, Anthropic, Anomaly / SST, Amazon); they are used
here to identify the corresponding service, not to imply endorsement.

`components/session/connection-icon.tsx` embeds these paths and is GENERATED —
regenerate it with `node generate-icons.mjs` from this directory after
re-vendoring, rather than hand-editing it.
