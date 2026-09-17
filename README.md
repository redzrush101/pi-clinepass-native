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
Cline does. The provider uses pi's native OAuth API, so pi owns credential
persistence and locked token refresh (`~/.pi/agent/auth.json`). ClinePass is a
personal-account subscription, so the extension also performs Cline's
best-effort switch to Personal after authentication.

**Model catalog.** Membership and order come from Cline's
`recommended-models` feed (`clinePass` then `free`). Per-model metadata
(context/output limits, image support, and reasoning controls) comes from the
models.dev `openrouter` section, matching current Cline's catalog builder. Full
id lookup falls back to the model slug and includes the `zai/`↔`z-ai/` alias.
Both subscription and free models report $0 token cost because ClinePass is
subscription-backed; the feed bucket decides which entries receive the
`(free)` label. Pi persists the last successful model list. Each network model
refresh checks the live Cline feed again, while a temporary models.dev failure
keeps persisted metadata for models that were already known. New unmatched
models fall back to 128k context / 8k output.

**Inference.** A complete native pi provider uses pi's built-in OpenAI Chat
Completions transport against `https://api.cline.bot/api/v1`. Cline's
reasoning metadata is projected into pi thinking levels, including binary
toggle-only models, without forcing prompt-cache markers globally across the
different upstream model families.

## Contributing

Issues and PRs welcome. Keep it to the single dependency-free `index.ts`.

## License

MIT
