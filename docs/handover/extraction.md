# SAYON voice extraction: how a note becomes a report

Read this before you touch voice capture, transcript cleanup, `SYSTEM_PROMPT` or how notes fill the report.

- Line numbers are from `origin/main` at `e15f1f0` (2026-10-05) and drift with every change. Find code by name (`grep -n "function populateFields" js/app.js`) and use the numbers only as a rough guide.
- Written by reading the code, not by running it, except where it says "confirmed". Check a claim in the code before you build on it.
- Section 5 is the list of known weak points. Nothing in it has been fixed yet.

## 1. Prompts

**`SYSTEM_PROMPT`** is at `js/app.js:1095–1205`. It is 21,814 characters and about 3,076 words, with no `${}` interpolation. Its sections:

| Lines | Section |
|---|---|
| 1095–1096 | Role, plus "Return ONLY a valid JSON object" |
| 1098 | "Known NSW termite species" (8 names) |
| 1100–1104 | Known products and systems: non-repellent, repellent, baiting, and "HomeGuard Blue (linear metres + collars)" |
| 1106–1114 | Construction era table (6 eras with asbestos likelihood) and the decade mapping |
| 1116–1117 | The schema, written as one 2,199-char JSON line: 44 top-level keys, `findings[]` with 6 sub-keys, `moistureMeterReadings[]` with 2, `areaStatus` with 9 area keys |
| 1119–1132 | Rules: inspectionType, findings array split, species and product formatting, "Chemical Barrier Treatment" default, conducive-condition language, constructionEra, existingSystem, leakLocation, moistureMeterReadings, the moisture/leak coupling, highRiskAreas |
| 1134–1137 | AREA STATUS |
| 1139–1143 | BORERS AND WOOD DECAY |
| 1145–1150 | EXISTING SYSTEM VERIFICATION |
| 1152–1158 | CRITICAL: termiteActivity has three states, plus the species-naming rule |
| 1160–1164 | CRITICAL: no severity words in damageDescription; structuralConcern means a referral |
| 1166–1172 | Handling real-world speech (self-corrections, implicit findings, hedging, mixed topics, filler, negations) |
| 1174–1197 | VOICE-DICTATION HOMOPHONE ERRORS (20 "→" patterns plus a brand-slot rule) |
| 1199–1204 | riskLevel inference (HIGH/MEDIUM/LOW; never based on species) |
| 1205 | Address and client name: only if spoken |

**Other prompts and helpers:**
- **`TRANSCRIPT_CLEANUP_PROMPT`**: `1770–1776`, 1,689 chars. It is used by `suggestTranscriptCleanup` (`1781`) with claude-sonnet-5, max_tokens 8000 and effort low (`1795–1798`). It only suggests changes; nothing is applied until the inspector taps Apply (`1840–1855`).
- **`correctKnownMishearings`**: `1702–1741`, 17 regex replacements. Its only call site is `2099`, on final Web Speech or native results. The hands-free path (`2394`, `2397`), the server transcript (`2040`) and typed edits (`2201`) skip it.
- **`TRANSCRIPTION_VOCAB`**: `1750–1756`. It is only used as the Whisper `initial_prompt` (`1977–1981`, worker `839–850`).
- **Narrow prompts**: `PLATE_SYSTEM_PROMPT` `1215–1231` (2,087 chars) and `INSECT_ID_SYSTEM_PROMPT` `1239–1270` (2,602 chars).

## 2. The request

- **Request body.** `requestExtraction(text)` (`2722–2780`) sends model `'claude-sonnet-5'`, `max_tokens: 16000`, `output_config: {effort:'medium'}`, `system: SYSTEM_PROMPT` and `messages:[{role:'user',content:text}]` (`2735–2743`).
  - Only the transcript is sent. The current report state is not, so each note is extracted with no memory of earlier ones.
  - It goes through `workerFetch` (`5455`), which retries once on a 401 after refreshing the session.
  - No `cache_control` exists anywhere in `js/app.js` or `worker/worker.js`.
- **Timeout.** `EXTRACTION_TIMEOUT_MS = 120000` (`2720`) with an AbortController. Being offline, a fetch rejection or an abort throws `.noSignal` (`2723–2724`, `2746–2750`).
- **Parsing.**
  - The raw body goes through `JSON.parse`. A non-JSON body (the Worker's plain-text refusals) throws with `.status` (`2755–2761`).
  - `!res.ok || data.error` throws "API error" (`2763–2765`).
  - `stop_reason === 'max_tokens'` throws `.tooLong` (`2770–2772`).
  - Otherwise the text blocks are joined, code fences are stripped, and the result goes through `JSON.parse` (`2774–2775`). A parse failure is a plain SyntaxError.
- **`extractionProblem`** (`2783–2792`) maps errors to messages: 401 expired sign-in, 402 plan ended, 429 usage used up, tooLong "split it", anything else "The AI couldn't read it (…)".
- **`processTranscript`** (`2794–2841`) runs `populateFields(...)` and then `processPendingNotes()` (`2800–2804`). On error:
  - tooLong: the text stays in the box and is not queued (`2810–2815`).
  - Anything else: `queuePendingNote` (`2818–2823`). It is queued on no signal and also on a refusal or a parse error.
- **WAITING NOTES** (`2843–2949`). Notes are stored in `reportData.pendingNotes`, capped at `MAX_PENDING_NOTES = 50` (`2851`).
  - `processPendingNotes` (`2907`) runs oldest first and stops at the first failure (`2920–2928`). It skips locked reports (`2908`) and stops if a different report is opened.
  - It is triggered by the `online` event (`6550`), at `6560`, at `6799`, at app init (`1372`), and after any successful extraction.
  - Hands-free mode `hfAutoExtract` (`2469`) calls the same `processTranscript` and ignores text under 8 characters.
- **Worker constraints** (`worker/worker.js`):
  - `ALLOWED_MODEL='claude-sonnet-5'` (`117`) is forced at `258`.
  - `MAX_TOKENS_CEILING=16000` (`121`), applied as `Math.min(body.max_tokens||ceiling, ceiling)` (`259`).
  - `ALLOWED_EFFORTS=['low','medium','high']` (`125`); any other effort is dropped (`263–264`).
  - `MAX_INPUT_CHARS=20000` (`130`), checked at `248`. It counts message text only (`collectText` `892–904`), not the system prompt. Over the cap, the Worker returns a plain-text 413.
  - Only `model`, `max_tokens`, `system`, `messages` and `output_config.effort` are forwarded (`257–264`).
  - Plan and usage gate at `229`; usage is recorded only when Anthropic returns OK (`279–281`).

## 3. Schema key → UI, PDF, and what a second extraction does

`populateFields` is at `3216–3335`. A generic loop (`3312–3329`) writes every non-null key that has an `f-<key>` element, in the model's JSON key order, 70 ms apart. Each write runs `applyFieldCascade` (`4133`) and then `renderField`. `autoReveal` runs after the loop (`3331–3334`). Nulls are skipped, so "overwrite" below means overwritten by any non-null value.

| Key | Where it goes (index.html / app.js) | PDF (app.js) | Second extraction |
|---|---|---|---|
| propertyStreetAddress / Suburb / State / Postcode, clientName | Job panel `#jobAddress` 631, `#jobSuburb` 636, `#jobState` 640, `#jobPostcode` 649, `#jobClient` 656 (map `3284–3301`) | Yes: 7956–7957, 8520–8521 | Fill only if empty |
| inspectionType | `#jobInspectionType` 684. Set only if the select is empty and the value exactly matches an option (`3303–3309`); this may set `standard` via `INSPECTION_TYPE_STANDARD` (`5285–5297`) | Yes: 8536 | Fill only if empty |
| structureType, height, wallConstruction, roofType, floorType, facadeDirection, constructionEra, occupancyStatus, weatherConditions | §1 Property, `f-*` 1064–1072 | Yes: 8543–8547; era also drives the asbestos note 8553–8556 | Overwrite |
| existingSystem | §1, `f-existingSystem` 1076. The cascade clears `existingSystemOther` (`4136–4142`) | Yes: 8550, 8830 | Overwrite, and wipes existingSystemOther |
| durableNoticePresent, hardLandscaping, zone25mmVisible, softLandscaping, zone75mmVisible, antCapSoldered | §1, `f-*` 1098–1103 inside `#systemVerify` 1091. Hidden unless `hasIdentifiedSystem` (`3654–3666`) | Only if a system is identified: 8833–8845 | Overwrite |
| areaStatus | §2, `#areaChecklist` 1135, via `applyObstructionExtraction` `490–546` (no `f-` element) | Yes, per area: 8626–8631; also feeds the undetected-risk rating 8580 and the summary | Overwrites the areas named; others kept; `areaReasons` never cleared |
| obstructions, restrictedAccess | Not stored. Used only to infer PARTIAL/NOT when the AI gave no areaStatus, and to tick fixed `OBS_ZONES` reasons (`279–366`, `504–538`). Then `syncObstructionData` (`446`) rebuilds both strings from the statuses | No (only the FIELD_LABELS for notes, 8268) | Reasons appended without duplicates; unmatched text is dropped with a toast (`543`) |
| highRiskAreas | §2, `f-highRiskAreas` 1141 | Yes: 8647 (only if some area is not fully inspected) and 8824 "Areas of Concern" | Overwrite |
| hinderedAreas, hinderedAreasDetail | §3, `f-*` 1191 and 1195 inside `#resDetailWrap`, which is hidden. The YES/NO toggle (`setRestrictedAccess` 549) is not called; `restoreResState` runs only at init (`1351`) | Yes: 8671–8672; gates 8576 and 8659 | Overwrite |
| findings[] (termiteActivity, species, damageDescription, activityLocation, nestLocated, structuralConcern) | §4, `#findingsList` 1251 through `renderFindingsUI` 3447; card fields 3426–3437 | Yes: every card, including NONE ones, 8688–8776 | Appended (`3241–3248`). Replaces only an untouched blank placeholder. Capped at `MAX_FINDINGS=6` (3341), overflow dropped with a toast. No de-duplication |
| (flat termiteActivity etc. fallback) | Overwrites `findings[0]` (`3251–3265`) | — | Overwrite |
| borerActivity, decayFound, borerDetails, decayDetails | §4, `f-*` 1299–1302 | Yes: 8782–8785, plus summary tiles 7419–7422 | Overwrite (details are not appended) |
| moistureReadings | §5, `f-moistureReadings` 1339. Any non-YES value forces waterLeaks to `'NO'` and clears leakLocation (`4145–4162`) | Yes: 8807 | Overwrite, with that cascade |
| waterLeaks | §5, `f-waterLeaks` 1342 inside `#waterLeakWrap`. NO clears leakLocation (`4166–4173`) | Yes: 8806 | Overwrite |
| leakLocation | §5, `f-leakLocation` 1343 | Yes: 8810–8811 | Overwrite |
| moistureMeterReadings[] | §5, `#moistureTableRows` 1359 via `addMoistureReading` 3720 | Yes: 8803/8808 (as `moistureTable`) | Appended, no de-duplication, capped at 30 |
| timberSoil, slabEdge, weepHoles | §5, `f-*` 1345–1347 | Yes: 8821–8823 | Overwrite |
| riskLevel | §6, `f-riskLevel` 1397 | Yes: cover badge 8411, row 8863, summary | Overwrite, based on one note only |
| treatmentRecommended | §6, `f-*` 1398. NO sets treatmentType to "No treatment required at this time" (`4176–4187`) | Yes: 8864 | Overwrite |
| treatmentType, inspectionFrequency | §6, `f-*` 1399–1400 | Yes: 8865–8866; quote seeding `quote.js:227–291` | Overwrite |

`autoReveal` (`3777–3789`) only looks at `SECTIONS` fields (`1083–1092`) and jumps to the first matching section. Keys that never trigger it: existingSystem and the verification keys, borerDetails, decayDetails, moistureMeterReadings, the address keys and inspectionType.

## 4. Report fields with no schema key (dictation can never fill them)

- **In the report UI:**
  - `f-existingSystemOther` 1080 (PDF 8551, 8831): only the plate scan fills it (`3032–3038`).
  - `f-standard` 1073 (PDF 8547, 7976): set only indirectly through inspectionType, and only for Pre-Purchase and Annual (`5285–5289`).
- **In the Job panel:**
  - `jobClientPhone` 660, `jobClientEmail` 665, `jobOrderId` 675, `jobInvoiceNo` 679, `jobInspectionDate` 699, `jobInspectionTime` 703 and `jobFee` 723 are printed in the PDF at 8523–8539.
  - `jobReferral` 709, `jobPaymentStatus` 728 and `jobNotes` 740 are not printed.
- **Sign-off:** `jobInspector` 1463 and `inspectorLicence` 1472 (both printed), the signatures, and the agreement.
- **Per-field notes:** the "Additional notes" textareas (`notes-text-<key>`, `enhanceFieldsWithNotes` 1404–1429). They are printed by `notesBlock` (8276–8294), but only for keys listed in SECTIONS. Their own Dictate button inserts raw speech with no AI.
- **Obstruction reasons:** only the fixed OBS_ZONES items can be ticked; free-text reasons are lost.
- **Conducive conditions beyond the five fields:** garden beds, bark chip, backfill, vegetation, ventilation, drainage. The prompt asks the model to recognise them (1126), but no keys exist for them. The summary only counts the five fields (7399–7403).
- **Not found anywhere:** persons present; a free-text recommendations or summary field (the summary is derived by `reportSummary` 7393–7448).

## 5. Mismatches and risks

1. **Multi-note overwrite (the biggest risk).**
   - Every scalar key is overwritten by the next note that mentions it, including YES→NO flips, borerDetails, leakLocation and highRiskAreas.
   - `riskLevel` is re-judged from one note alone, even though the prompt says "across the whole transcript" (1204).
   - A note saying "everything accessible" overwrites earlier NOT/PARTIAL statuses (1137), but `applyObstructionExtraction` never clears `areaReasons`. Compare `setAreaStatus` 402–406, which does. The PDF prints the reasons whatever the status (8629–8630), so an area can print as "Inspected — Stored Articles".
   - `processTranscript` applies the new note and then the older waiting notes (2800–2804), so stale values land last and win.
2. **Moisture cascade order.** The schema order puts waterLeaks and leakLocation before moistureReadings. A moistureReadings of "NO" (which the prompt allows when the inspector explicitly separates the two, 1131), or a later note saying "no moisture", wipes the leak (4152–4161).
3. **existingSystem.**
   - The prompt (1128, 1124) asks for a brand as free text, e.g. "HomeGuard Blue — 66 linear metres".
   - The UI field is a 5-value *type* dropdown (`OPTIONS.existingsystem` 4015–4021), with the brand kept separately in existingSystemOther (`SPECIFIC_SYSTEMS_BY_TYPE` 4034).
   - The plate prompt is explicitly kept in sync with that list (comment at 1213–1214); `SYSTEM_PROMPT` is not.
   - A voice existingSystem also wipes a brand the plate scan read (4138).
   - The six verification keys are "only relevant when existingSystem is identified" (1145), but a note that doesn't repeat the system has no way to know one was identified.
4. **inspectionType.** The prompt allows 4 values (1117) and gives rules for only 2 (1121). The dropdown has 8 options (686–693), including Combined Building & Pest, New Construction, Insurance/Legal and Other.
5. **Species.**
   - The prompt lists 8 species (1098), and only one genus "spp." form (Microcerotermes). `SPECIES_LIST` has 22 entries including genus "spp." forms and beetles (3816–3826).
   - The homophone rule "match to closest species… e.g. Coptotermes" (1182) pulls against "Never pick a species they didn't say" (1158). A plain "Coptotermes" is not a dropdown value.
   - `SPECIES_DB` includes Mastotermes and Porotermes (849, 932), which are in neither list.
   - The aliases map a genus to one species for the intel panel: `coptotermes` → acinaciformis (1031), `nasutitermes spp.` → exitiosus (1051).
6. **treatmentType.**
   - The prompt formats are "Termidor (Fipronil)" and the default "Chemical Barrier Treatment" (1124–1125). The dropdown uses forms like "Chemical barrier — Termidor (Fipronil)" (3906–3918).
   - Quote seeding uses keyword matching (`quote.js:204–210`). The dropdown values "Physical barrier — HomeGuard/Kordon" match the `system` rule (`quote.js:207`) and become a `system_topup` line (`quote.js:267`), not a new install.
   - `inspectionFrequency` has no format in the prompt. The UI list is at 3919–3926, and `treatment.js:78–83` regex-parses "N months" with a default of 12.
7. **Property dropdowns.** The prompt types these fields as plain `string` and doesn't give the option lists (3845–3905, 4022–4030), so the dictated wording need not match a dropdown value.
8. **hinderedAreas meaning.**
   - The prompt defines it as "readily accessible areas inspected" (1117).
   - The UI shows it as "Details & Recommendations" under a "restricted access?" YES question (1179–1191).
   - The PDF row calls it "Areas Where Inspection Was Restricted" (8671), while the PDF's own FIELD_LABELS calls it "Readily Accessible Areas Inspected" (8268).
   - The PDF decides "no restrictions" only when the text contains `'N/A'` (8576, 8659). So any extracted text, and the app's own `'NIL — No restricted access…'` (561), prints Restrictions: YES and raises the undetected-risk rating to MODERATE (8581–8583).
   - The prompt also defines restrictedAccess and hinderedAreasDetail almost identically, and obstructions/restrictedAccess are thrown away after reason-matching.
9. **Dead option lists.** `inspectionareas` 3929, `obstructiontype` 3965, `restrictiontype` 3985 and `leaklocation` 3996 are not used by any element (leakLocation is a text field, 1343).
10. **Notes that fail forever.** A queued note over 20,000 characters (Worker 413), one whose answer won't parse, or one that hits max_tokens fails on every retry. Because the queue stops at the first failure (2923–2927), it blocks every note behind it.
11. **Save timing (plausible, not tested).** `processPendingNotes` calls `saveDraft` and then `saveCurrentReport(true)` (2933, 2941–2943) while the last note's 70 ms staggered writes are still pending. The Saved Reports copy may miss them.
12. **Trade rules.**
    - The prompt itself complies: no severity words (1162–1163), structuralConcern means a builder or engineer referral (1164), riskLevel is never based on species (1203). The prompt header says "compliant with AS 3660.2-2017" (1095), while its area and borer rules cite AS 4349.3.
    - Species-based risk wording exists only in the on-screen `SPECIES_DB`: "most destructive" 878, "high-risk colony" 745, "less aggressive" 660/978/1014. `SPECIES_DB` is not referenced in the PDF code (7945–9178).
    - The UI verification flag says "shielding inadequate" (3676).

## 6. What the answer keys exposed (start the rewrite here)

Two reviewers built the answer keys in `tests/extraction/gold/` by reading the transcripts, the prompt and the code that applies each answer. Along the way they listed where the current prompt gives a wrong or unclear answer. The lists overlap (both found the `hinderedAreas` meaning, the treatment fallback and the obstruction matcher); they are kept as written.

Where a key departs on purpose from the literal prompt (the `hinderedAreas` meaning, the "Chemical Barrier Treatment" fallback, the NONE rule, the possible-nest hedge, the distance from the house, the reason words the matcher needs), a model that follows today's prompt word for word fails that check. That is intended.

**Test leakage (item P below):** the homophone list in `SYSTEM_PROMPT` already holds near-verbatim phrases from house test 2, added after that test. A pass on test 2 says little about new dictation. Score a rewrite on cases the prompt was not written from, and prefer general rules to transcript-specific examples.

### From house test 2

A. hinderedAreas is described as 'readily accessible areas inspected' (and FIELD_LABELS still labels it 'Readily Accessible Areas Inspected'), but the UI shows it as 'Details & Recommendations' under 'Were there any normally accessible areas that had restricted access?', and the PDF prints it as 'Areas Where Inspection Was Restricted'. A model that follows the prompt literally writes a list of inspected areas into the restricted-areas row. Redefine it as 'areas where inspection was restricted but not prevented', with hinderedAreasDetail as 'the nature of the restriction', and spell out the split to match the PDF's own DEFINITIONS: obstructions are items or conditions hiding part of an area (furniture, stored goods, insulation, vegetation); restrictions are physical, safety or design constraints (low clearance, hatch size, height, unsafe areas).
B. obstructions and restrictedAccess are only used to tick reason buttons and are then overwritten by syncObstructionData. Ticks need every significant word of the reason label inside a phrase that names the area. So 'stored items' never ticks subfloor 'Stored Articles', and 'outer sides and corners' never ticks 'Low clearance to the outside edges of roof void' (only 'Low clearance in roof void' matches). The matcher also gives false ticks: sigWords drops words under 4 letters, so 'No access to subfloor' reduces to {access, subfloor}, and any subfloor phrase containing 'access' ticks it, including the literal echo 'stored items at the back block access' and the entry point 'east side access door'. The PDF then prints 'Subfloor — PARTLY INSPECTED — No access to subfloor' for a subfloor the inspector entered. The key therefore uses the reason-list words ('stored articles', 'low clearance to the outside edges of roof void', 'furniture') and bans 'access' in the Subfloor phrase. Fix the matcher (keep no/not as required words for that label, or accept synonyms) and give the model the per-area reason vocabulary and the 'Area: reason' format. The 'access' ban can be dropped once the matcher is fixed.
C. 'If treatment mentioned without specific product, use "Chemical Barrier Treatment"' would collapse 'treat the tree + install a chemical barrier or baiting system' into 'Chemical Barrier Treatment', losing the tree treatment and the baiting option. Restrict the fallback to a bare 'treat it' and otherwise describe what was recommended, ideally TMS first and active-termite work as ', plus direct treatment of ...' so the quote doesn't duplicate it.
D. The existingSystem-null rule loses 'no TMS found', and durableNoticePresent is scoped 'only relevant when existingSystem is identified' while its own bullet says NO when not found. The two contradict each other, and the UI hides the field anyway.
E. nestLocated with 'possible nest': the UNCERTAINTY rule turns it into YES and the hedge is lost; the PDF then prints 'TERMITE NEST FOUND? YES' and the quote adds a nest treatment. Tell the model to carry 'possible nest' into damageDescription, or add a POSSIBLE value.
F. structuralConcern rule ('NO only if they say no referral needed') gives null for 'no damage visible' and for a garden tree, though an inspector would tick NO, and the script treats 'no damage visible' as the no-referral branch. Clarify whether 'no damage visible' or 'not a building element' counts.
G. The species rule doesn't say which finding a 'species couldn't be identified' remark belongs to. A model may copy it onto the subfloor finding (tolerated) or, worse, read 'can be identified' literally and name a species. The rule handles the negation, but scope it to the finding it was said about.
H. The damageDescription ban on 'any other severity/extent-grading adjective' is unclear for activity-level words ('high activity'). Say whether activity level may be recorded.
I. Era table text ('1965-1985: brick veneer dominant, concrete slab standard') can contaminate wallConstruction and floorType. Add 'the era table only sets constructionEra; never use it to fill or override stated construction'.
J. 'moistureReadings and waterLeaks normally move together' can push the model to waterLeaks YES from the elevated reading. Add: elevated moisture with no leak found means waterLeaks NO and moistureReadings YES.
K. No rule for distances or contact ('15 m from the house', 'not touching any building'). Say to put them in activityLocation.
L. slabEdge has no N/A. Say to leave it null when the floor is suspended with no slab.
M. antCapSoldered: 'ant caps on all of them' may tempt YES. Say that ant-cap presence is not soldering.
N. areaStatus: say that a mention in a recommendation (the garage) is not an inspection status, and whether an area described with observations but never called 'inspected' (site, fences) counts as INSPECTED.
O. The prompt doesn't list the UI dropdown vocabularies (structureType 'Detached house', floorType 'Timber suspended floor', occupancyStatus 'Occupied — residential', inspectionFrequency '3 months — active infestation follow-up' ...). Values come back free-form and don't match the selects; either list them or accept free text. For inspectionFrequency also say to write the next interval first as 'N months'.
P. TEST LEAKAGE: the homophone list already contains near-verbatim phrases from this transcript ('brick repairs with caps on all of them', 'no borrowers or decay', 'Tims around the base of the tree', 'some flow entered from the side door', 'rear barer', 'live termite scene', 'called roof', 'water strains', 'batting system', 'species can be identified'). A pass on this transcript says little about new dictations, so keep a held-out transcript (e.g. test 1 or a fresh run) for scoring the rewrite, and prefer general patterns over transcript-specific examples.
Q. IMPLICIT FINDINGS says 'if the technician says no termites, no activity, or nothing found, set termiteActivity to NONE'. With per-area negatives (outside walls, inside, roof void) it can push the model to add NONE cards; the NONE rule forces activityLocation null, so the PDF prints 'NO ACTIVITY FOUND' cards with no location. The key's mustNot (no NONE entries) departs from that rule on purpose. Scope NONE to 'nothing found anywhere on the property'.

SCORING NOTE: where the key deliberately departs from the literal prompt (hinderedAreas meaning, the 'Chemical Barrier Treatment' fallback, the NONE rule, the possible-nest hedge, the ~15 m distance, the matcher-friendly reason words), a model that follows the current prompt word for word will fail the key. That is intended and recorded in A, B, C, E, K and Q.

### From house test 1

1. hinderedAreas is described as 'readily accessible areas inspected', but the app uses it as 'Areas Where Inspection Was Restricted' (Restrictions section, PDF) and treats any non-empty value without 'N/A' as 'restrictions: YES'. Following the schema literally ('interior, exterior, subfloor, roof void...') makes the report call every area restricted. The PDF FIELD_LABELS map also still says 'Readily Accessible Areas Inspected'. The four access fields (hinderedAreas, obstructions, restrictedAccess, hinderedAreasDetail) need one clear definition each, and the prompt should say that obstructions which prevent inspection of part of an area go in areaStatus/obstructions, not Restrictions.
2. The highRiskAreas no-duplicate rule clashes when the obstructed area (rear subfloor) is also where inactive evidence was seen. A strict model drops the most important high-risk area. Rewrite: an inaccessible area stays a high-risk area even when evidence was seen at its edge; only areas fully inspected where activity was found are excluded.
3. treatmentType: 'If treatment mentioned without specific product, use Chemical Barrier Treatment' is wrong for a tree or nest colony treatment that depends on the client. It invents a barrier he never recommended. Rewrite: describe the target and leave the method 'to be confirmed'. Use 'Chemical Barrier Treatment' only when a barrier is actually said, and never add a method word ('chemical', 'soil treatment', 'physical', 'reticulation', 'top-up', 'bait') the inspector didn't say, because the quote builder turns those words into priced lines.
4. structuralConcern: 'NO only if they say no referral is needed' leaves an off-building finding (a tree away from the house) at null, which is why this key expects null today. Rewrite: a finding not in or on any building means NO (nothing to refer). Also state outright that the inspector's own 'not compromised / compromised' remarks are never copied into any text.
5. riskLevel: the rules overlap. 'ACTIVE with no builder referral' gives MEDIUM, while 'ACTIVE AND multiple conducive conditions' gives HIGH. The example 'timber-soil contact AND water leak AND high moisture' reads as if all three are needed. termiteActivity is per-finding, but the rules treat it as a single value. The main driver an inspector uses is missing: an active colony on the property plus no termite management system plus past activity in the building. Say HIGH is checked first.
6. The IMPLICIT FINDINGS rule ('no activity' sets NONE) invites a NONE finding or a flipped subfloor finding when 'no signs of activity' about one spot sits next to real evidence elsewhere. Say that area-level 'clear' remarks never create a NONE finding when other findings exist. Note too that a NONE finding must have a null location, so it carries no information.
7. moistureMeterReadings has no guidance for 'a reading was taken but the value wasn't said'. Models will either drop it or invent a number or placeholder. Say: keep the row with the location and a null reading. Moisture location also has nowhere to go when there's no leak.
8. constructionEra: the '(construction type...)' trigger invites guessing an era from 'double brick'. Require a stated age or an era-specific material.
9. The self-correction rule only covers explicit corrections ('no wait'). Add: when a field is restated later, the later statement wins. A self-contradictory phrase like 'double brick veneer' should be settled from the restatements, never combined.
10. Add to the homophone list: 'Wall' or 'Well' as a sentence-start filler; 'customers once' = customer's wants; 'Within sub saw' = within subfloor; 'out of corners' = outer corners.
11. The 'only relevant when existingSystem is identified' scope of the verification fields contradicts 'purely descriptive' for hard and soft landscaping. Say plainly whether to fill them when no system is found.
12. areaStatus: 'outbuildings' covers detached garages only. The prompt doesn't say what to do when attachment isn't stated, or whether a fence mentioned only as a conducive-condition spot counts as inspected.
13. The app matches obstruction reasons by word, so 'stored items' won't tick the subfloor's 'Stored Articles' reason, 'outer sides of the roof' without the word 'void' isn't matched to the roof void, and any phrase containing both 'access' and 'subfloor' ticks 'No access to subfloor' (so 'stored items restricting access to the back of the subfloor' reports a partly inspected subfloor as 'No access to subfloor'). The rewrite should have the model use the app's reason vocabulary ('stored articles', 'roof void') in obstructions and restrictedAccess and avoid 'access' in subfloor phrases unless there was no access at all; the matcher could also be tightened.
14. damageDescription's banned-word list says 'any other severity/extent-grading adjective' without saying whether an activity level ('high activity') counts. Clarify.
15. nestLocated: say to leave it null unless the inspector says a nest was or wasn't found. The PDF prints 'TERMITE NEST FOUND? NO' in green for any non-YES value, so an invented NO reads as a checked negative.

### App issues seen while checking (outside the prompt)

- The Restrictions NO button writes 'NIL — No restricted access…', but the PDF (js/app.js:8576, 8659) only treats a value containing 'N/A' as no restriction, so choosing NO prints Restrictions YES with 'NIL — …' as the restricted areas.
- populateFields writes f-hinderedAreas but never calls restoreResState (only the load path at js/app.js:1351 does), so after extraction the toggle stays on NO and #resDetailWrap stays hidden while the PDF prints YES.
- The quote builder adds a 'direct' line for every ACTIVE finding and a second line from treatmentType (js/quote.js:229-270). When treatmentType describes only the tree colony, the tree is quoted twice whatever the wording.
- With a blank reading, the PDF prints the location alone in the 'Moisture Meter Reading' row (js/app.js:8806).
- populateFields fills hinderedAreas without calling setRestrictedAccess(true), so the detail stays hidden until reload.
- The PDF's hasRestriction tests includes('N/A') while restoreResState tests startsWith('NIL'), so the default 'NIL — No restricted access...' text counts as a restriction in the undetected-risk rating.
- With waterLeaks processed before leakLocation in key order, a returned leakLocation is cleared and then re-rendered while hidden.
- With constructionEra 1965-1985 the PDF prints a 'HIGH likelihood of asbestos' disclaimer (app.js ~8555), so the report mentions asbestos even though no field does.
- classifyTreatment picks the baiting system (12 stations plus monitoring) for 'chemical barrier or baiting system'.
- The finding card's label 'Workings / Nest Located' doesn't match the PDF's 'TERMITE NEST FOUND?', which could push inspectors toward YES on the subfloor finding.
