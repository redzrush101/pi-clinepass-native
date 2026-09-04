# pi-clinepass-native

ClinePass provider for [pi](https://github.com/earendil-works/pi). One
TypeScript file, no Cline CLI or `@cline/*` dependencies. Auth, model
catalog, and usage-limits all go through pi's built-in OAuth and OpenAI
transport.

## Install

```bash
pi install git:github.com/redzrush101/pi-clinepass-native
```

Restart pi, `/login`, pick **ClinePass**, finish device login in the browser,
then `/model`.

```bash
pi update pi-clinepass-native    # update later
```

## Commands

### `/clinepass-usage`

```
ClinePass usage
5-hour  ████▊░░░░░  48% · resets 11:48 PM (in 3h 10m)
Weekly  ██▍░░░░░░░  24% · resets Mon 06:19 PM (in 2d 21h)
Monthly █▎░░░░░░░░  12% · resets Sep 30 (in 25d 21h)
```

Reads `GET /api/v1/users/me/plan/usage-limits` with the stored OAuth token
(pi refreshes it automatically). Warns when any limit passes 90%.

## How it works

**Auth.** Mirrors Cline's WorkOS device flow and token exchange, verified
against the Cline source. The access token is sent `workos:`-prefixed, as
Cline does. Pi persists and refreshes the tokens
(`~/.pi/agent/auth.json`). After login the extension switches to the personal
account best-effort so usage-limit reads land there — Cline itself does not do
this on login, so a failure here is ignored.

**Model catalog.** Membership and order come from Cline's
`recommended-models` feed (`clinePass` then `free`). Per-model metadata
(context, cost, image support, reasoning efforts) comes from models.dev,
matched the way Cline does it: subscription ids against the `cline-pass` then
`openrouter` sections, free ids against `cline` then `openrouter`, full id
first then slug, including the `zai/`↔`z-ai/` alias. Free models are forced to
$0. The catalog is cached for 10 minutes like Cline's, revalidated with
ETag/Last-Modified when the feed sends them, and kept from cache when
models.dev is down. Unmatched models fall back to 128k context / 8k output.

**Inference.** Pi's OpenAI Chat Completions transport against
`https://api.cline.bot/api/v1`. Prompt-cache markers are not forced globally
because ClinePass routes several upstream model families.

## Contributing

Issues and PRs welcome. Keep it to the single dependency-free `index.ts`.

## License

MIT
