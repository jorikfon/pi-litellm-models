# pi-litellm-models

A [pi](https://github.com/earendil-works/pi) extension that fills in the models of a LiteLLM proxy
by itself. Every model the proxy serves shows up in pi as `litellm/<model>` — no `models.json`
entries, nothing to update when the proxy changes. Sibling of
[opencode-litellm-models](https://github.com/jorikfon/opencode-litellm-models).

Models are read at startup from LiteLLM's `GET /model_group/info` (limits, prices, reasoning
levels) and narrowed to the ones `GET /model/info` lists for your key, so a model the key may not
call does not show up only to answer 403; prompt-cache prices come from `/model/info` too. If
`/model/info` fails or is empty, every model group is shown. Both requests time out after 5 s; if
`/model_group/info` fails, pi starts without the provider and prints a `[litellm]` warning.

## Install

Point pi at the proxy:

```sh
export LITELLM_BASE_URL=https://litellm.example.com/v1
export LITELLM_API_KEY=sk-...
```

Then put a re-export where pi auto-discovers extensions —
`~/.pi/agent/extensions/litellm.ts` for every project, or `.pi/extensions/litellm.ts` for one:

```ts
export { default } from "/path/to/pi-litellm-models/index.ts"
```

Check it: `pi --list-models litellm`. A convenient home for the clone is
`~/.local/share/pi-litellm-models`; `git pull` there upgrades it.

Verified on pi 0.87.1 (`@earendil-works/pi-coding-agent`). The older `@mariozechner/*` builds
(≤ 0.73) read `apiKey` as a variable name and have no `max` level — not supported.

## Reasoning levels

LiteLLM publishes the levels a model really takes in `supported_reasoning_efforts`; sending
another one is a 400, a cooldown of the deployment and 429s for everyone on the proxy. The
extension turns that list into the model's `thinkingLevelMap`, so pi hides the levels the model
does not take and moves a request to the nearest one that it does:

| LiteLLM effort | pi level |
|---|---|
| `none` (or `off`) | `off` |
| `minimal` / `low` / `medium` / `high` | same name |
| `xhigh` | `xhigh` |
| `max` | `max` |

A model without `none` cannot be switched off — `off` is hidden (e.g. `glm-5.3`: low/high/max).
A model with reasoning switched off on the deployment itself (`reasoning_effort: "none"`, `enable_thinking: false` or `thinking.type: "disabled"` in `litellm_params` of every deployment, as `/model/info` shows them) is registered with `reasoning: false`, so pi offers only `off` —
that is how `*-no-reasoning` groups look, even though LiteLLM reports `supports_reasoning: true`
for them. Only those reasoning fields are read from `litellm_params`; the rest of it (provider
credentials) is neither kept nor logged. A reasoning model with no efforts listed and nothing
pinned gets no map, and pi sends its levels as is.

## Known limits

- When `/model/info` is unavailable the list is not narrowed, and a model outside the key's team
  answers 403 `key_model_access_denied`; cache prices are then 0.
