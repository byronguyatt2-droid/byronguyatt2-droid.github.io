# Baseline scores

The prompt as it stood when the bench was added: `SYSTEM_PROMPT` in `js/app.js` at `e15f1f0` (2026-10-05, the same prompt that is live in `korva-v51`).

- Runner: Sonnet subagents given exactly the `eval-workflow.js` extract prompt (one agent per run, `out/baseline/`), standing in for the app's `claude-sonnet-5`. Treat it as a proxy, not the production number.
- 3 runs per case, scored with `score.mjs` against the keys in `gold/`.
- Mean = total weighted points over total possible across the runs. "Weight-3 fails" counts CRITICAL checks failed in each run.

| Case | Runs | Mean | Per run | Weight-3 fails per run |
|---|---|---|---|---|
| house-test-1 | 3 | 91.4% (384/420) | 94%, 90%, 91% | 2, 3, 3 |
| house-test-2 | 3 | 93.3% (417/447) | 94%, 91%, 95% | 1, 2, 1 |

The same prompt on the five written cases added on 2026-10-06 (tag `baseline-new`, run from a worktree of `origin/main` at `53d2aa7` with the new cases copied in):

| Case | Runs | Mean | Per run | Weight-3 fails per run |
|---|---|---|---|---|
| slab-barrier | 3 | 95.2% (277/291) | 94%, 96%, 96% | 0, 0, 0 |
| skirting-active | 3 | 98.1% (303/309) | 98%, 98%, 98% | 0, 0, 0 |
| subfloor-followup | 3 | 96.3% (312/324) | 96%, 96%, 96% | 1, 1, 1 |
| borers-rot | 3 | 96.9% (282/291) | 97%, 97%, 97% | 1, 1, 1 |
| rambling-nest | 3 | 88.9% (264/297) | 89%, 89%, 89% | 3, 3, 3 |

Checks the old prompt failed on them: `slab-barrier` existing-system-other-brand 0/3 (the key is new), no-obstructions 0/3, no-hindered-areas 2/3; `skirting-active` hindered-roof-only 0/3 (listed the exterior as a restricted area); `subfloor-followup` findings-count-zero 0/3 (a NONE card for one clean area), moisture-readings-empty 0/3; `borers-rot` no-hindered-areas 0/3 (every inspected area written into the restricted-areas row); `rambling-nest` finding-damage-nest-hedged 0/3 and finding-nest-not-located 0/3 (a "possible nest" became nestLocated YES), treatment-type-stump 0/3 and treatment-type-no-product 0/3 (the "Chemical Barrier Treatment" fallback replaced the stump colony).

House test 2 leaked into the prompt (its mishearings were added to the homophone list after the test), so it flatters the prompt. See `docs/handover/extraction.md` section 6.

## Checks that failed at least once

Most weight-3 failures are where the keys depart on purpose from the literal prompt (`docs/handover/extraction.md` section 6): what `hinderedAreas` holds, the "Chemical Barrier Treatment" fallback, and the "possible nest" hedge.

**house-test-1**

| Check | Weight | Passed | What the answers did |
|---|---|---|---|
| hindered-areas-not-every-area | 3 | 0/3 | Listed every inspected area, as the schema's "readily accessible areas inspected" asks; the PDF prints it as restricted areas |
| treatment-no-method-words | 3 | 0/3 | "Chemical Barrier Treatment" (the prompt's fallback) for a tree colony whose treatment was left to the client |
| subfloor-finding | 3 | 1/3 | Kept the filler "Wall" as a location ("activity at the wall, joists and bearers") |
| highrisk-rear-subfloor | 2 | 0/3 | Left the obstructed back of the subfloor out of high-risk areas |
| treatment-targets-tree | 2 | 0/3 | Treatment text didn't name the tree |
| moisture-row-back-room | 2 | 1/3 | Dropped the reading taken in the back room (no value was said) |
| risk-high | 2 | 2/3 | MEDIUM once |

**house-test-2**

| Check | Weight | Passed | What the answers did |
|---|---|---|---|
| finding-tree | 3 | 0/3 | Dropped the "possible nest" hedge (nestLocated YES with no "possible" in the text), so the PDF says a nest was found |
| finding-subfloor | 3 | 2/3 | Lost "no damage visible" once |
| restrictions-said | 2 | 0/3 | Put the backyard tree in `hinderedAreas` and missed the low clearance and furniture |
| restricted-access | 2 | 0/3 | Wrote "blocking access" / "side access door" in the subfloor phrase, which makes the app tick "No access to subfloor" |
| restricted-access-matcher-words | 1 | 0/3 | Didn't use the reason words the app's matcher ticks ("stored articles", "furniture") |
| treatment-type | 2 | 2/3 | Missed the tree or the system install once |
| no-zone-75 | 1 | 2/3 | Filled a verification field with no system present |

## After the rewrite (2026-10-06)

`SYSTEM_PROMPT` as rewritten on branch `claude/voice-extraction-rdusm7` (revision 2; revision 1 differed only in the riskLevel paragraph and rated `borers-rot` HIGH in one of three runs). Same runner, 3 runs per case, tag `rev2`.

| Case | Before: mean (weight-3 fails per run) | After: mean (weight-3 fails per run) |
|---|---|---|
| house-test-1 | 91.4% (2, 3, 3) | 100% (0, 0, 0) |
| house-test-2 (leaked into the prompt; reported, not tuned for) | 93.3% (1, 2, 1) | 100% (0, 0, 0) |
| slab-barrier | 95.2% (0, 0, 0) | 100% (0, 0, 0) |
| skirting-active | 98.1% (0, 0, 0) | 100% (0, 0, 0) |
| subfloor-followup | 96.3% (1, 1, 1) | 99.1% (0, 0, 0): only the weight-1 "moistureReadings empty preferred" check fails, the answer is NO for a reading called normal |
| borers-rot | 96.9% (1, 1, 1) | 100% (0, 0, 0) |
| rambling-nest | 88.9% (3, 3, 3) | 100% (0, 0, 0) |

Pass bar (every weight-3 check in 3 of 3 runs on house test 1 and the five written cases; no case's mean below its baseline): met. Every answer was valid JSON. No key was changed to make a run pass; the only key edits after drafting were made before any run (`risk-low-or-medium` on `slab-barrier` and `borers-rot` also accepts empty, because the inspector didn't state a risk; `no-hindered-areas` on `slab-barrier` lowered to weight 2; the "east" substring checks on `rambling-nest` narrowed to "eastern"/"east side" so "least" can't trip them).
