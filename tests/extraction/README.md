# Extraction test bench

Checks how well `SYSTEM_PROMPT` (js/app.js) turns an inspector's dictation into report fields. Each case is a transcript plus an answer key; `score.mjs` marks an answer against the key.

## What's here

| Path | What it is |
|---|---|
| `transcripts/house-test-1.txt` | First real run on a house (2026-10-05): iOS dictation, one long note, no script. The tester wasn't an inspector, so the order is loose. |
| `transcripts/house-test-2.txt` | Second run, read spot by spot from a say-this script and dictated in several recordings into one box. The address and client name are made up; everything else is exactly what the phone produced, mishearings included. |
| `transcripts/house-test-2-whisper-wrapup.txt` | The experimental Whisper transcription of test 2's last recording only (the wrap-up). No answer key yet. |
| `gold/<case>.json` | Answer key: a list of checks (format below). Built from what the inspector said and meant, then checked by two independent reviewers. |
| `score.mjs` | `node tests/extraction/score.mjs gold/<case>.json <answer.json> [more answers]`. Prints failures, a weighted score, and the pass rate of each check across runs. |
| `eval-workflow.js` | Claude Code workflow: Sonnet subagents stand in for the app's model, answer each case N times, then `score.mjs` marks them. |
| `run-api.mjs` | Sends a case to the real Anthropic API exactly as the app does (model, effort, max_tokens). Only where `ANTHROPIC_API_KEY` is set. |
| `BASELINE.md` | Scores of the prompt as it stood when the bench was added, per case and per check. |
| `out/` | Answers written by the runners. Not committed (`.gitignore`). |

## Running it

With an API key (most faithful, a few cents a run):

```
ANTHROPIC_API_KEY=... node tests/extraction/run-api.mjs house-test-2 3 baseline
node tests/extraction/score.mjs tests/extraction/gold/house-test-2.json tests/extraction/out/baseline/house-test-2-run*.json
```

Without a key, from a Claude Code session:

```
Workflow({ scriptPath: "<repo>/tests/extraction/eval-workflow.js",
           args: { repo: "<absolute repo path>", runs: 3, tag: "baseline" } })
```

The workflow's subagents run on the session's `sonnet` model inside an agent harness, while the app calls `claude-sonnet-5` through the Worker. Treat workflow scores as a good proxy, not the production number: compare prompts with each other, and confirm the winner on the phone.

Never let the answering model see `gold/` or this README; the workflow's prompt forbids it.

Notes on the runners:
- `eval-workflow.js` scores only the two house tests unless you pass `cases: [...]` with every case id you want.
- Both runners read `SYSTEM_PROMPT` as plain text from `js/app.js`. Keep it a template literal with no `${}`; `run-api.mjs` refuses one that has it, and the workflow's agents would read the raw `${…}`.
- An answer that isn't valid JSON counts as failing every check for that run, because the app can't use it either.
- `BASELINE.md` holds the scores of the prompt as it was when the bench was added. Add a row there for every prompt change you measure.

## Answer key format

```json
{
  "id": "house-test-2",
  "transcript": "transcripts/house-test-2.txt",
  "checks": [
    { "id": "floor-not-slab", "kind": "mentions", "path": "floorType", "all": [["suspended", "timber floor"]], "none": ["slab on ground", "concrete slab"], "weight": 3, "why": "said 'not a slab'" },
    { "id": "risk", "kind": "equals", "path": "riskLevel", "values": ["HIGH"] },
    { "id": "no-brand-misfires", "kind": "forbidAnywhere", "terms": ["termimesh", "exterra"], "weight": 3 },
    { "id": "tree-finding", "kind": "findingMatch", "checks": [
        { "kind": "equals", "path": "termiteActivity", "values": ["ACTIVE"] },
        { "kind": "mentions", "path": "activityLocation", "all": [["tree"]] } ] },
    { "id": "two-findings", "kind": "count", "path": "findings", "min": 2, "max": 2 },
    { "id": "no-structural-verdict", "kind": "manual", "description": "Nothing says the structure is or isn't compromised" }
  ]
}
```

- `equals`: the value must equal one of `values` (case and spacing ignored; `null` means empty or missing).
- `mentions`: the text must contain at least one alternative from every group in `all`, and nothing in `none`. `nullOk: true` lets an empty value pass.
- `absent`: the value must be empty or missing.
- `count`: array length between `min` and `max`.
- `forbidAnywhere`: none of `terms` may appear in any string in the answer.
- `findingMatch`: some finding must pass all its sub-checks; each finding can satisfy only one `findingMatch`.
- `every`: every element of the array at `path` (e.g. `findings`) must pass all its sub-checks; a sub-check with no `path` looks at the whole element. An empty array passes, so pair it with `count`.
- `manual`: not scored; printed for a person or model to judge.
- `weight`: default 1. Use 3 for anything that would put wrong facts in a client's report (a lost negation, an invented species or brand, a wrong activity status). The scorer lists these as CRITICAL.

## Adding a case

Write the transcript the way iOS dictation produces it: no punctuation, run-on, with the mishearings real dictation makes. Write the answer key from what the inspector meant, not from what any model answered. Keep keys honest about ambiguity: if two values are defensible, accept both.
