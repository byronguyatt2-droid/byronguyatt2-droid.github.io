# Extraction rewrite: what changed, what's left (2026-10-06)

Written by the model that reworked `SYSTEM_PROMPT` and the code that applies its answer. Read `extraction.md` first for how a note becomes a report; this file says what moved on 2026-10-06 and what the next session should do.

## 1. What changed

All in one PR to `main` (branch `claude/voice-extraction-rdusm7`), three commits: tests, then `js/app.js` + `service-worker.js`, then docs.

**`SYSTEM_PROMPT` (`js/app.js`, `grep -n "const SYSTEM_PROMPT"`)**, rewritten from scratch, still a plain template literal with no `${}`:
- One note at a time. The prompt says the inspector records several notes per job and the app merges them, so it returns only what THIS note states and null for everything else. That is what makes `subfloor-followup` come back with the subfloor status, one meter row and nothing else.
- Every dropdown's exact values are listed (structure, height, wall, floor, roof, facade, occupancy, weather, era, existing system type, inspection type), with "use the inspector's words when no value fits" so a tiled roof with no tile material is never turned into concrete or terracotta.
- The four access fields each have one meaning: `obstructions` = which areas were not fully inspected and where; `restrictedAccess` = "Area: reason" pairs using the app's reason labels (the full `OBS_ZONES` vocabulary is in the prompt); `hinderedAreas` = restricted-but-not-prevented areas only, never a list of inspected areas, null when no restriction; `hinderedAreasDetail` = the nature of those restrictions; `highRiskAreas` = places not inspected, never a finding.
- Findings: NONE only when the whole property is clear; a clear remark about one area never makes a NONE card; "possible nest" stays in `damageDescription` with `nestLocated` null; `structuralConcern` NO for "no damage" and for a tree/stump/fence; genus-only species becomes "Genus spp."; the not-identified string is scoped to the finding it was said about; no severity words, no activity grades, no structural opinion in any wording.
- Treatment: no "Chemical Barrier Treatment" fallback. Target first, method only if the inspector named one, never a method or product word they didn't say (each becomes a priced quote line). `inspectionFrequency` is "N months" first.
- Risk: the inspector's own statement wins; otherwise inferred only from a whole-house note, never from a one-area note; HIGH needs termites; no termites means never HIGH (revision 2, after one `borers-rot` run rated a leak plus rot as HIGH).
- Moisture: elevated reading with no leak found = moisture YES, leaks NO; a reading with no value keeps a row with reading null; normal readings are still rows.
- Existing system: the five type values (or "Chemical soil barrier"), plus a new `existingSystemOther` key for the brand/product read off the notice; `durableNoticePresent` and the landscaping fields stand on their own.
- Dictation: restatements (later wins), negations, hedges, filler, brand names in the wrong slot, and the mishearing list kept as a compact list. The house-test-2 phrases are still in it (they are real mishearings and also live in `correctKnownMishearings()`), so test 2 still flatters the prompt.

**`populateFields` and friends (`js/app.js`)**:
- `populateFields` returns a promise that resolves after its staggered writes; `processTranscript` and `processPendingNotes` await it before saving.
- Findings merge: incoming NONE cards are dropped when a real finding exists on either side, and a real finding replaces an earlier NONE card. Findings are otherwise appended as before (no de-duplication yet).
- `APPEND_TEXT_KEYS` (`hinderedAreas`, `hinderedAreasDetail`, `highRiskAreas`, `borerDetails`, `decayDetails`, `leakLocation`) are added to, not replaced, unless one already contains the other.
- Nil words ("None", "Nil", "N/A" …) in free-text keys are dropped before the write; a nil `hinderedAreas` answers the Restrictions question NO, a real one answers YES and shows the detail (`setRestrictedAccess`).
- Write order: `moistureReadings` → `waterLeaks` → `leakLocation` → `existingSystem` → `existingSystemOther`, then the rest. A leak forces moisture YES; a moisture NO from a note that doesn't mention leaks leaves a recorded leak alone.
- `applyFieldCascade(key, value, el, prev)`: the system type only clears `existingSystemOther` when the type actually changed, so a plate-scan brand survives a voice note.
- Duplicate meter rows (same location and reading) aren't added twice.
- `applyObstructionExtraction`: a status that comes back INSPECTED/NA deletes that area's `areaReasons`; reasons are matched by exact label, then `OBS_REASON_SYNONYMS` ("stored items" → Stored Articles, "batts" → Insulation …), then every significant word with `no`/`not` kept, so "No access to subfloor" needs the "no" and a subfloor the inspector entered is never ticked as not accessed; when a phrase matches an exact label the looser word match is skipped.
- `processTranscript`: when notes are waiting and the phone is online, the new note queues behind them and the queue runs, so notes land in dictation order and an older note can't overwrite a newer one.
- `processPendingNotes`: a note-specific problem (Worker 413, `max_tokens` cut-off, an answer that isn't JSON) is written on the note (`note.problem`, shown under it in red) and skipped, so the notes behind it still fill in; sign-in, plan and signal problems still stop the run as before. `requestExtraction` throws `.badAnswer` for an unparseable answer and `extractionProblem` has a 413 message.
- `service-worker.js`: `CACHE_VERSION` `korva-v52`.

**Bench (`tests/extraction/`)**: five written cases (transcripts + keys), `multi-note.playwright.js`, README updates, scores in `BASELINE.md`.

## 2. Scores

See `tests/extraction/BASELINE.md` for the full table (old prompt vs this one, 3 runs per case, Sonnet subagents as a proxy for `claude-sonnet-5`). Short version: the old prompt scored 89–98% on the five new cases with weight-3 failures on three of them; after the rewrite every case passes every weight-3 check in 3 of 3 runs, and house test 1 goes from 91% to 100%. House test 2 is reported but was not tuned for.

Pass bar from the brief: every weight-3 check passes in 3 of 3 runs on house test 1 and the five new cases, and no case's mean falls below baseline. Met after two prompt revisions (revision 2 changed only the riskLevel paragraph).

## 3. What's left, in order

1. **Go-live** of this PR after baz says "deploy PR #N" (regular model): `origin/live` + cherry-pick of the `js/app.js`/`service-worker.js` commit only (the tests and docs commits stay off live). Then the phone test in section 4.
2. **Wording review** (the next larger-model task) should settle: the PDF's `hinderedAreas.includes('N/A')` test (`grep -n "includes('N/A')" js/app.js`) versus the app's `'NIL — …'` text, so choosing NO stops printing Restrictions YES; `FIELD_LABELS.hinderedAreas` still reads "Readily Accessible Areas Inspected"; `INSPECTION_TYPE_STANDARD` and the prompt's AS 4349.3 / AS 3660.2 split; the `treatmentType` dropdown values versus the free text the prompt now returns (the quote builder's `classifyTreatment` keyword matching in `js/quote.js` still decides the quote line).
3. **Findings de-duplication**: two notes about the same spot still make two cards. Not started; needs a rule for "same place" that an inspector would agree with.
4. **`correctKnownMishearings()` and hands-free mode**: unchanged. The hands-free path still skips the mishearing fixes (state.md section 4).
5. **Code issues seen but left** (outside this task's ownership): `renderField` prints `NO` for any non-YES `nestLocated`/`structuralConcern` value; `SPECIES_DB` still has species-risk wording on screen; `OPTIONS.existingsystem` has no value for a hand-applied chemical soil barrier (the prompt returns "Chemical soil barrier" as free text, which the field shows but the dropdown can't re-select); `startEdit` selects show the first option when the stored value isn't in the list.

## 4. How to check it

- Syntax: `node --check js/app.js && node --check service-worker.js`.
- Bench (no key): Workflow tool, `tests/extraction/eval-workflow.js`, `args: { repo, runs: 3, tag, cases: [all seven ids] }`. With a key: `ANTHROPIC_API_KEY=… node tests/extraction/run-api.mjs <case> 3 <tag>` then `score.mjs`.
- Browser: `python3 -m http.server 8791` then `NODE_PATH=/opt/node-tools/node_modules node tests/extraction/multi-note.playwright.js <jspdf-dir> 8791` (header of the file explains `<jspdf-dir>`). All ten verdicts should print `true` and `pageErrors` `[]`.
- Phone test for baz once live (fully close SAYON and reopen first):
  1. New report. Dictate one note: "double brick house on a suspended timber floor tiled roof no termite management system". Tap Extract. Check Property shows Double brick and Timber suspended floor.
  2. Dictate a second note: "in the subfloor stored items block the back section partly inspected timber lying on the soil". Extract. Check Areas: Subfloor is Partly with Stored Articles ticked, and Property still shows Double brick.
  3. Turn on Aeroplane mode. Dictate "roof void inspected fully no termite activity". Extract: it should say the note is saved until there's signal. Turn Aeroplane mode off: the note should fill in and Roof Void should show Inspected.
  4. Dictate "the owner moved the stored items the back of the subfloor is now inspected". Extract. Check Subfloor is Inspected and Stored Articles is no longer ticked.
  5. Tap Generate report and check the PDF opens and the Restrictions page answers NO.

## 5. What waits on baz

- "deploy PR #N" for the go-live (merging is not deploying).
- The phone test above, and a real-house run of a whole-house note on the new prompt.
- No Worker, Supabase or Stripe change is needed. The Worker's model, effort passthrough and 16000 ceiling are unchanged; the request body is unchanged too, so `run-api.mjs` and `eval-workflow.js` needed no change.

## 6. What `hinderedAreas` now holds

`reportData.hinderedAreas` is the answer to the report's "Were there conditions that restricted but did not prevent inspection?":
- From voice: the areas where inspection was limited and how ("Roof void: outer edges and corners not reached. Bedrooms: walls behind furniture"), never a list of inspected areas. A second note's restrictions are appended with "; ". `hinderedAreasDetail` holds the nature of those limits.
- When the note says there were no restrictions, the model returns a nil word, `populateFields` turns that into the NO answer, and the field holds the app's own `'NIL — No restricted access areas at time of inspection.'`.
- When the note doesn't raise the subject, the model returns null and the field is left as it was.
- Obstructions that stop part of an area being seen go in `areaStatus` (PARTIAL/NOT) with reasons in `areaReasons`, not here. The PDF still decides "no restrictions" by `includes('N/A')`, so the `'NIL — …'` text prints as YES until the wording review fixes that line.
