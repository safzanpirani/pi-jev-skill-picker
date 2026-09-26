# pi-jev-skill-picker

A Pi extension that keeps the Agent Skills catalog out of model requests and replaces it with one ranking tool backed by [TypeSafe's Jev](https://docs.typesafe.ai) System One model.

Skills stay loaded, so `/skill:name` keeps working. Before each agent turn the extension removes Pi's generated `<skills>` catalog from the effective system prompt and gives the model two tools to pull skills in on demand.

`skill_search` takes a plain-language description of the task, rates every enabled skill against it, and returns the complete `SKILL.md` instructions of the skills that apply.

## What it saves

On a 137-skill catalog the generated `<skills>` block runs about 19,000 tokens, which is 87% of Pi's system prompt. Pi resends it on every request.

Both rows below use the same captured prompt and one trivial turn:

| Model | Catalog present | Catalog stripped | Saving |
|---|---|---|---|
| `gpt-6-astra` | 21,074 tokens, $0.2107 | 2,541 tokens, $0.0254 | 87.9% |
| `deepseek-v4.1-flash` | 22,377 tokens, $0.0034 | 3,434 tokens, $0.0005 | 84.6% |

One `skill_search` call costs about 38,600 Jev input tokens, or $0.0016 at $42 per billion. Jev bills input only. Against `gpt-6-astra` that is under 1% of what a single un-stripped request wastes.

## How the ranking works

Each skill becomes its own Score question. The task goes in the shared `state`, and the skill's name and description go in that skill's own `instructions`. Jev judges each skill without seeing the others, so no keyword prefilter can drop one first.

Every skill is rated on the same three ordered levels:

| Level | Meaning |
|---|---|
| 0 | Unrelated. A different domain, tool or workflow. |
| 1 | Adjacent. Same general area, not the specific thing the task needs. |
| 2 | Directly applicable. Covers the exact tool or workflow, and changes how the task is done. |

Jev returns a probability-weighted position on those levels. Code applies the floor, sorts, and loads the winners. A skill has to lean toward "directly applicable" to be loaded, and ties break on confidence.

## Fallback

If no API key is configured or every request fails, `skill_search` falls back to deterministic lexical matching and says so in its result. The fallback returns skill metadata and paths rather than loaded instructions, so the agent decides what to read.

## Configuration

Precedence is environment variable, then `skill-jev.json` under `PI_CODING_AGENT_DIR` (normally `~/.pi/agent`), then the package default.

| Setting | Environment variable | JSON field | Default |
|---|---|---|---|
| API key | `TYPESAFE_API_KEY` | `apiKey` | none |
| Model | `PI_SKILL_JEV_MODEL` | `model` | `jev-latest` |
| Max questions per request | `PI_SKILL_JEV_SHARD_SIZE` | `shardSize` | `50` |
| Score floor, 0 to 2 | `PI_SKILL_JEV_MIN_SCORE` | `minScore` | `1.6` |
| Skills loaded per call | `PI_SKILL_JEV_MAX_SKILLS` | `maxSkills` | `3` |
| Request timeout, ms | `PI_SKILL_JEV_TIMEOUT_MS` | `timeoutMs` | `20000` |
| Description truncation | none | `descriptionLimit` | `1200` |
| Endpoint | `PI_SKILL_JEV_ENDPOINT` | `endpoint` | `https://api.typesafe.ai/v1/systemone` |

Keep the key in the config file with `0600` permissions, or in the environment. It is never passed on a command line.

```json
{
  "apiKey": "apikey_…",
  "minScore": 1.6,
  "maxSkills": 3
}
```

Raise `minScore` if too many adjacent skills load, and lower it if a relevant skill is missed.

## Install

```sh
pi install git:github.com/safzanpirani/pi-jev-skill-picker
```

Reload an existing Pi session with `/reload`, or start a new session.

This extension replaces `pi-skill-search`. Uninstall that one, along with its `pi-subagents` dependency if nothing else uses it. The old subagent picker forked the whole conversation into a child agent and needed a persisted session to do it. This one sends a single task string, so it needs neither.

## Tools

`skill_search` ranks and loads. It accepts:

- `task`: required plain-language description of what the agent is about to do, naming the concrete tools, services or files involved
- `maxSkills`: optional limit from 1 to 5; defaults to the configured `maxSkills`

It loads the top `maxSkills` skills in full, then lists every other skill that cleared the floor with its score and path. Nothing above the floor is hidden. A task like "review this diff and hand it to codex" puts 12 skills over 1.4, so the 9 that missed the cut are named rather than dropped.

`skill_load` loads by name and never calls Jev. It accepts:

- `names`: one to five exact skill names, as `skill_search` reported them

Use it for a skill that `skill_search` listed but did not load, or when the name is already known. Files are read straight off disk, so it costs no tokens and adds no latency.

A name that does not match returns close alternatives instead of failing:

```
No skill named 'fleece'. Did you mean 'fleet'?
```

Matching ignores case and separators, so `Fleet` and `review codex auto` resolve to `fleet` and `review-codex-auto` and load without a second call. Anything further off is reported as a suggestion for the agent to confirm. One bad name among good ones does not fail the call. The rest load, and the miss is noted at the end.

Both tools return skill content as tool results. Neither writes to the system prompt, which is what keeps the cached prefix stable across turns.

Disabled skills stay undiscoverable, because both tools work from Pi's resolved enabled-skill list.

## Development

```sh
bun install
bun run check   # typecheck and unit tests
```

Tests stub `fetch`, so they make no network calls.
