# Client wording review (2026-10-06)

A review of the wording the client reads in the inspection report PDF, the pre-inspection agreement, the quote PDF and the treatment certificate, against AS 4349.3-2010 (Inspection of buildings, Part 3: Timber pest inspections), AS 3660.2-2017 (Termite management, Part 2: In and around existing buildings and structures) and the Australian Consumer Law (ACL, Schedule 2 of the Competition and Consumer Act 2010).

- Written from the code on `main` after PR #75 (`0a878bb`), and from `docs/handover/samples/report-sample.pdf`. Line numbers are from that commit and drift; find text by the quoted words or the function name.
- Nobody on this project has the text of the standards. Where the existing wording gives a figure or clause that could not be confirmed, it was kept and marked **check against the standard**. No new figures or clause numbers were written.
- Rating: **must** = false or misleading to a homeowner, a standard claim the document doesn't meet, an ACL problem, a trade-rule break (structural verdict, risk by species, severity words) or a bug. **should** = worth fixing soon. **could** = polish.
- Every **must** is fixed in this PR (section 4). Nothing in the quote or certificate reached **must**, so those PDFs are unchanged.
- Out of scope, as briefed: `terms.html`, `privacy.html`, `SYSTEM_PROMPT` (see section 5 for the one line that touches it), and the e-sign sentence at the end of `DEFAULT_AGREEMENT_TEXT`.

## 1. Which standard each document claims

What the code did before this PR: the report's `standard` field (default `AS 3660.2-2017`, switched to `AS 4349.3-2010` by the two Pre-Purchase inspection types) printed on the cover as "Prepared in accordance with …", in T&C clauses 1 and 10, and in the footer badge as "{standard} Compliant". The cover label "PRE-PURCHASE TIMBER PEST", the agreement's "pre-purchase timber pest inspection" and the "not suitable where the property is being bought or sold" notice were switched by whether the standard started with `AS 4349`, so any AS 4349.x choice (including 4349.0 and 4349.1) printed a pre-purchase report. The body text cited AS 4349.3-2010 for definitions on every report, whatever the standard said.

Settled here:

| Document | Claims now | Why |
|---|---|---|
| Inspection report | "Prepared **with reference to** {standard}" on the cover, in T&C 1 and 10, and in the footer. The "Compliant" badge is gone. T&C 10 adds that termite management recommendations refer to AS 3660.2-2017. | Nobody has checked the template clause by clause against either standard, so the report must not say it complies. "With reference to" is true: the definitions, scope and limitations come from AS 4349.3, and the re-inspection and treatment advice from AS 3660.2. |
| | The pre-purchase label, the agreement's inspection type and the "not for buying or selling" notice follow the **inspection type** (`isPrePurchaseJob()`), falling back to the standard only when no type is set. | An "Insurance / Legal" or "Re-inspection" job that cites AS 4349.3 is not a pre-purchase inspection and must not be labelled one. |
| Pre-inspection agreement | "in line with {standard}" (unchanged). | The agreement is a promise about how the inspection will be done; "in line with" is a fair description of a visual inspection following the standard's method. |
| Quote | `QUOTE_DEFAULT_NOTES`: "in accordance with AS 3660.2-2017 and the product label directions" (unchanged, editable by the business). | A treatment of an existing building is the thing AS 3660.2 governs, and the technician who signs off is the one making the claim. Should: the business confirms it before relying on it (section 3). |
| Treatment certificate | "in line with the product label directions and AS 3660.2" (unchanged). | Same as the quote. |

**For baz to decide** (nothing in the code needs this to work; the default is the conservative one):

1. **Default standard for an annual inspection.** The report is a timber pest inspection (termites, borers and decay), which is AS 4349.3's subject, and every definition in it comes from AS 4349.3. Today an "Annual — Existing Building" job prints "with reference to AS 3660.2-2017 — Existing Buildings", a termite management standard. Industry practice does describe annual termite inspections as "to AS 3660.2", so this is not false, and it was left as is. Recommendation: ask the inspector friend which the trade expects on an annual report; if AS 4349.3, change `INSPECTION_TYPE_STANDARD` and the `'AS 3660.2-2017'` default (six places: `grep -n "'AS 3660.2-2017'" js/app.js`).
2. **The standard dropdown** (`OPTIONS.standard`, `grep -n "standard:    \['AS 3660.1-2014'" js/app.js`) offers AS 3660.1, 3660.3, 4349.0 and 4349.1, none of which a pest inspector's report should cite as its own standard (new-building termite management, assessment criteria, general building inspection, building inspection). Recommendation: trim it to AS 4349.3-2010 and AS 3660.2-2017. Stored reports keep whatever they hold.
3. **"With reference to" versus "in accordance with".** Once a qualified inspector has read the template against AS 4349.3 and says it meets it, the cover and T&C 1 can go back to "in accordance with". Until then, claim less.

## 2. Review table

File and function, the text the client read, the problem, the fix, and the rating. "Fixed" rows are in this PR.

### Inspection report PDF (`js/app.js`, `_buildAndDownloadPDF` unless noted)

| Where | Current text | Problem | Fix | Rating |
|---|---|---|---|---|
| Restrictions section (`noRestrictions`) and undetected-risk rating (`hasRestriction`) | Answer "YES" and the row "Areas Where Inspection Was Restricted: NIL — No restricted access areas at time of inspection." | Tapping No on the report screen stores `'NIL — …'` (`setRestrictedAccess`), but the PDF only read `'N/A'` as No. A clean report answered YES, printed the NIL text as a restricted area, and the undetected-risk rating rose to MODERATE. False to the homeowner; a bug. | `hasRestrictedAreas()` (next to `setRestrictedAccess`) reads `NIL`, `N/A` and empty as No; both PDF tests use it, as does `restoreResState`. **Fixed.** | must |
| `FIELD_LABELS` (`hinderedAreas`, `hinderedAreasDetail`); `index.html` Restrictions section | "Readily Accessible Areas Inspected" / "Restrictions"; on screen "Details & Recommendations" / "Additional Comments" | The field holds the areas where inspection was restricted (`extraction-notes.md` section 6), and the PDF prints it under that heading. Notes printed under "Readily Accessible Areas Inspected" would say the opposite of what they are. | Labels now "Areas Where Inspection Was Restricted" and "Nature of Restriction" (PDF), "Areas where inspection was restricted" and "Nature of the restriction" (screen). **Fixed.** | must |
| `deliverPdfBlob` call at the end | Share-sheet title "SAYONion Report" | Rename leftover; the client sees it when the report is shared. | "Timber Pest Inspection Report". **Fixed.** | must |
| Findings, "BORERS & WOOD DECAY" rows | (nothing, when the field is blank) | The comment says the rows always print, but `row()` drops empty values, so a report that never recorded borers or decay says nothing about them, which reads as "none". AS 4349.3 covers borers and decay, so silence misleads. | Blank prints "Not recorded". **Fixed.** | must |
| Cover `reportTypeLabel`; `agreementInspectionType`; the "not suitable for buying or selling" notice | "PRE-PURCHASE TIMBER PEST" for any standard starting `AS 4349` | AS 4349.0 and 4349.1 aren't pre-purchase timber pest standards, and an Insurance / Legal or Re-inspection job citing AS 4349.3 isn't a pre-purchase inspection. The pre-purchase label and agreement wording were wrong for those jobs, and the "not for buying or selling" notice was missing from a legal job and present on nothing else. | `isPrePurchaseJob()`: the inspection type decides; the standard only when no type is set. All three use it. **Fixed.** | must |
| Cover "Prepared in accordance with"; T&C 1; T&C 10; footer badge "{standard} Compliant" | as quoted | A compliance claim nobody has verified (section 1). The footer's "Compliant" is the strongest form and prints beside the report ID. | "Prepared with reference to {standard}" in all four places; T&C 10 also names AS 3660.2-2017 for the treatment advice. **Fixed.** | must |
| T&C 8 "Reliance on This Report" | "Where this report has been sought in connection with a proposed property purchase, a formal Prior-to-Purchase Timber Pest Inspection … is strongly advised." | Printed on pre-purchase reports too, telling the buyer that the pre-purchase report they are holding isn't one. | The sentence prints only on non-pre-purchase reports. **Fixed.** | must |
| Definitions, "Restrictions" | "Physical, safety, or design constraints that prevent the inspector from entering an area …" | Contradicts the section it defines, "conditions that restricted but did not prevent inspection". A homeowner reading both can't tell what the YES means. | Rewritten: conditions that limited the inspection of an area without preventing it (low clearance, stored items, insulation, poor lighting, parts beyond safe reach); the unseen parts are treated like obstructed areas. **Fixed.** | must |
| Definitions, "Inactive / Evidence Only" | "This finding is equally significant as active termites and warrants immediate professional attention." | A severity judgement and an alarm the inspector didn't make: old workings in a treated house are not "equally significant" as live termites. Breaks the no-severity-words rule. | Rewritten: evidence doesn't show when the activity happened or whether termites remain in concealed areas, so it should be investigated further and the report's recommendations followed. **Fixed.** | must |
| Property Details, construction-era note | "Construction era indicates a HIGH likelihood of asbestos-containing materials (fibro/ACM sheeting) … Recommend licensed asbestos assessor if suspected ACM identified." / "MODERATE likelihood …" | The agreement says this is not an asbestos inspection, then the report rates asbestos likelihood (HIGH for any 1945–1985 house, double brick included). A rating outside the inspector's licence and scope, and a severity word. | One neutral note for the 1920s–2003 eras: buildings of this period may contain asbestos materials; nothing was tested or disturbed; no opinion is given; have a licensed asbestos assessor check before work that disturbs materials. **Fixed.** | must |
| IMPORTANT NOTICE box | "Standard home and contents insurance policies do not cover termite damage." | Absolute. Some policies do cover some termite damage, and the other two insurance lines in the same report say "typically" and "do not generally". An absolute statement a client relies on is an ACL risk. | "generally do not cover". **Fixed.** | must |
| Client & Job Details | "Fee (inc. GST)" | The fee is typed by the inspector; nothing says whether the business is registered for GST (the quote has a per-quote GST switch, the report has none). A sole trader under the GST threshold would be stating a tax component that doesn't exist. | Label "Inspection Fee". The quote PDF carries the GST breakdown. **Fixed.** | must |
| "What is Reasonable Access?" and Definitions "Reasonable Access" | "… reached using a 3.6m ladder or less … Subfloor areas require a minimum clearance of 400mm under the lowest bearer, and roof voids require an access opening of at least 450mm x 400mm." | AS 4349.3 (and 4349.1) do set reasonable-access dimensions for ladder height, roof access openings and crawl space, and subfloor clearance. The exact figures, and especially the roof opening size, could not be confirmed here. | Keep. **Check against the standard** (Table of reasonable access in AS 4349.3 / AS 4349.1), then correct the two places together. | should |
| T&C 2 "Scope of Inspection" | "Readily accessible areas are defined in AS 4349.3-2010 as those that can be inspected without moving furniture …" | Paraphrase of the definition; wording not confirmed. | Keep. **Check against the standard.** | should |
| T&C 9 "Recommended Re-inspection Frequency" | "Annual timber pest inspections are the minimum recommended frequency under AS 3660.2-2017 … a six-monthly re-inspection interval is recommended" where risk factors are present | AS 3660.2 does recommend inspections at least every 12 months and more often where risk is higher; whether it names six months could not be confirmed. | Keep. **Check against the standard.** Consider "more frequent (for example six-monthly)" if the standard doesn't name an interval. | should |
| T&C 10 | "the AEPMA (Australian Environmental Pest Managers Association) Code of Practice for Timber Pest Inspections" | AEPMA publishes codes of practice; the exact title of the current timber pest inspection code could not be confirmed. | Keep. **Check the title** on aepma.com.au. | should |
| "What timber pests are covered?" and Definitions "Timber Pests" | "subterranean termites, drywood termites, borers of seasoned timber, and wood decay fungi (rot) as defined in AS 4349.3-2010" | Matches AS 4349.3's scope as far as is known here. | Keep. | — |
| Conducive Conditions, existing system rows | "25mm Inspection Zone Visible", "75mm Inspection Zone Visible" | Inspection-zone widths come from AS 3660.1 / the NCC (exposed slab edge and inspection zones). Figures not confirmed here. | Keep. **Check against AS 3660.1.** | should |
| Undetected risk box | Ratings HIGH / MODERATE-HIGH / MODERATE / LOW-MODERATE with one-line reasons | AS 4349.3 asks the report to state the risk of undetected timber pest attack (reasonable confidence) and this is a sensible way to do it. The MODERATE line says "Regular monitoring and follow-up inspection recommended" without saying of what. | Should: name the restricted areas in that line, or drop the sentence. The 2026-10-05 review already asks an inspector whether the PDF needs both this and the cover risk badge. | should |
| Summary "WHAT TO DO NEXT" | "Next timber pest inspection: within 12 months." always prints; "Treat the active borers and replace badly affected timbers." | "badly" is a severity word; replacing timbers is a builder's call. | Should: "Treat the active borers; have a builder assess any damaged timbers." | should |
| Findings card, species row | "Species not identified — further investigation required" | Fine. "Further investigation" is the inspector's recommendation. | Keep. | — |
| Recommendations insurance line; T&C 7 | "typically do not cover" / "do not generally cover" | Fine; consistent with the fixed notice. | Keep. | — |
| Cover footer and acknowledgement | "This report does not conclusively determine that the property is free of termites." | Fine. | Keep. | — |
| Version history / fingerprint | "changes to the report change this code" | Fine. | Keep. | — |
| Moisture rows | "28% — Back room" | No meter type or units; a reader can't judge what 28% means. | Could: let the inspector name the meter and print "elevated" / "normal" only when they said so. | could |
| Summary tiles | "BUILDER TO ASSESS", "NONE FLAGGED" | Fine; "builder referral" rather than a structural verdict. | Keep. | — |

### Pre-inspection agreement (`js/app.js`, `DEFAULT_AGREEMENT_TEXT`, `drawAgreementBody`)

| Where | Current text | Problem | Fix | Rating |
|---|---|---|---|---|
| Clause 1 | "{company} will carry out a {inspectionType} inspection … in line with {standard}." | `inspectionType` was switched by the standard. | Now follows the inspection type (`isPrePurchaseJob`). **Fixed** (counted above). | must |
| Clause 2 | "the site within 50 m of the building" | AS 4349.3 does include the site around the building; whether the distance is 50 m and bounded by the property boundary could not be confirmed. | Keep. **Check against the standard**; if confirmed, add "within the property boundary". | should |
| Clause 3 | "It is not a building, structural, asbestos, mould or electrical inspection." | Good. The report's asbestos note now matches it. | Keep. | — |
| Clause 6 | "It is for your use only and must not be relied on by anyone else without our written consent." | Fine. A buyer may pass it to their lender or solicitor; "without our written consent" is standard. | Keep. | — |
| Clause 7, 8 | "As quoted." / "None." defaults | Fine. | Keep. | — |
| Clause 9 | "Nothing in this agreement limits your rights under the Australian Consumer Law." | Good; required in spirit by the ACL's consumer guarantees. | Keep. | — |
| Closing | "By signing, you confirm you have read and agree to this agreement before the inspection starts. You also agree to sign it electronically and to receive the report by email." | Second sentence is main-only; out of scope as briefed. | Leave as is. | — |
| Whole agreement | — | ACL: the agreement should say what the inspection is not and that areas not reached are reported, which it does. No cooling-off text is needed: the client asked for the inspection, so it isn't an unsolicited consumer agreement. | Keep. | — |

### Quote PDF (`js/quote.js`, `buildQuotePDF`)

| Where | Current text | Problem | Fix | Rating |
|---|---|---|---|---|
| `QUOTE_DEFAULT_NOTES` | "All treatments are carried out by a licensed pest technician in accordance with AS 3660.2-2017 and the product label directions." | A claim the business makes about its own work. True for a licensed technician treating an existing building, but the business should confirm it before quoting, and the line is editable. | Should: show it to the inspector friend; keep. | should |
| `QUOTE_DEFAULT_NOTES` | "Treatment does not repair existing timber damage." | Good. | Keep. | — |
| Acceptance | "I accept this quote of {total} (inc GST) and authorise the work described above." | Fine. "(inc GST)" prints only when the quote's GST switch is on. | Keep. | — |
| Cover | "VALID UNTIL" 30 days | Fine. | Keep. | — |
| Exclusions (`buildQuoteExclusions`) | "Assessment of termite damage by a licensed builder or structural engineer, and repair of damaged timbers." | Good: a referral, not a verdict. | Keep. | — |
| Payment terms | "Payment is due on completion of the work." | Fine. | Keep. | — |
| Whole quote | — | ACL: no warranty or guarantee of result is implied ("Treatment does not repair …"); nothing says the quote can't be withdrawn or revised. | Could: a one-line "Prices may change if the scope changes on site; we will tell you first." | could |

### Treatment certificate (`js/treatment.js`, `buildTreatmentCertificatePDF`)

| Where | Current text | Problem | Fix | Rating |
|---|---|---|---|---|
| Next steps | "AS 3660.2 recommends one at least every 12 months." | Consistent with the report's T&C 9; figure not confirmed here. | Keep. **Check against the standard** (one check covers both). | should |
| Durable notice cells | "Future inspections: … then at least every 12 months" | Same figure. | Keep, same check. | should |
| Closing line | "… in line with the product label directions and AS 3660.2. It does not repair existing damage, and no treatment can guarantee termites will never return. Regular inspections are the best protection." | Good: no guarantee, no repair. | Keep. | — |
| Cover | "TERMITE MANAGEMENT / TREATMENT CERTIFICATE" | "Certificate" is the trade's word for the treatment record; the body makes no compliance claim. | Keep. | — |
| Warranty field | Free text typed by the technician | Whatever the business writes here is its own warranty under the ACL (a "warranty against defects" has required wording if it's called one). | Should: when the business starts using it, the text needs the ACL's mandatory warranty-against-defects statement; flag it to baz when that happens. | should |
| Cautions default | "Keep people and pets away from treated areas until the treatment has dried. Do not disturb treated soil, and do not wash treated surfaces." | Fine; the label directions govern. | Keep. | — |

### Emails and share text (`js/app.js`, `clientMessage`, `deliverPdfBlob` calls)

| Where | Current text | Problem | Fix | Rating |
|---|---|---|---|---|
| `clientMessage` | "Please find attached your {docs} for {address} …" | Fine. | Keep. | — |
| Quote share title (`js/quote.js`) | "SAYON Quote" | Fine. | Keep. | — |

## 3. Choices for baz or a qualified inspector

Only a person can settle these; the PR takes the conservative side of each.

1. Which standard an annual inspection cites by default (section 1, item 1).
2. Trimming the standard dropdown to AS 4349.3-2010 and AS 3660.2-2017 (section 1, item 2).
3. When to switch "with reference to" back to "in accordance with" (section 1, item 3).
4. The figures marked **check against the standard**: the 3.6 m ladder, 400 mm subfloor clearance and roof opening size (two places in the report); the 50 m site distance (agreement); the 12-month and six-monthly intervals (report T&C 9, certificate); the 25 mm / 75 mm inspection zones (report); the AEPMA code's title (report T&C 10).
5. Whether the PDF should keep both the cover "Risk of termite attack" badge and the "Risk of undetected timber pest activity" box (carried over from the 2026-10-05 review).
6. The quote's default note claiming treatment "in accordance with AS 3660.2-2017", and the certificate's "in line with … AS 3660.2": the business signs these, so the business confirms them.

## 4. What this PR changed

Branch `claude/client-wording-czr7hr`, two commits: app files first, then docs.

App commit (`js/app.js`, `index.html`, `service-worker.js` → `korva-v53`):
- `hasRestrictedAreas()` next to `setRestrictedAccess()`; used by `restoreResState()`, the undetected-risk rating and the Restrictions section.
- `isPrePurchaseJob()` next to `INSPECTION_TYPE_STANDARD`; `agreementInspectionType()` takes no argument now; used by the cover label, T&C 8 and the "not for buying or selling" notice.
- `FIELD_LABELS.hinderedAreas` / `.hinderedAreasDetail`, and the two labels in the Restrictions section of `index.html`.
- Fixed wording: cover "Prepared with reference to", T&C 1, T&C 8 (conditional sentence), T&C 10, footer badge, Restrictions and Inactive definitions, asbestos note, IMPORTANT NOTICE insurance line, "Inspection Fee" row, borer and decay "Not recorded", share title.

Docs commit: this file, and `docs/handover/samples/report-sample.pdf` regenerated with `make-report-sample.js`.

Not changed: `js/quote.js`, `js/treatment.js`, `SYSTEM_PROMPT`, `terms.html`, `privacy.html`, `worker/`.

## 5. Handoff for the next session

**What's left, in order**

1. **Go-live** of the app commit only, after baz says "deploy PR #N": `origin/live` + `git cherry-pick -x` of the app commit (not the docs commit). PR #75's app commits (`e326768`, `c327035`) are also still waiting to go live; take `CACHE_VERSION` as the higher number (`korva-v53` here). The README section 3 recipe applies.
2. **Decisions in section 3**, when baz or the inspector friend answers. The default-standard change is six string sites plus `INSPECTION_TYPE_STANDARD`; the dropdown trim is one line in `OPTIONS`.
3. **"Should" rows** in section 2 that need no decision: "badly affected timbers" in `reportSummary()`; the MODERATE undetected-risk line.
4. **`SYSTEM_PROMPT`**: its first line says the note comes from "a timber pest inspection (AS 4349.3 / AS 3660.2)", which is right; no change needed. If the default standard changes, the prompt doesn't need to follow, because the AI never sets `standard`.
5. **Not reviewed here**: the report screen's own labels beyond the Restrictions section (inspector-facing), and `SPECIES_DB` text shown on screen (noted in `extraction-notes.md` section 3).

**How to check it**

- `node --check js/app.js && node --check service-worker.js`
- Sample PDF: serve the repo (`python3 -m http.server 8790`), then `NODE_PATH=/opt/node-tools/node_modules node docs/handover/samples/make-report-sample.js <jspdf-dir> docs/handover/samples/report-sample.pdf 8790` (usage at the top of the script). `pdftotext -layout docs/handover/samples/report-sample.pdf - | grep -n "reference to\|Not recorded\|RESTRICTED"` should show "Prepared with reference to AS 4349.3-2010" on the cover and in the footer, and the Restrictions question answered NO.
- Phone checklist for baz once live (fully close SAYON and reopen first):
  1. Open a report, go to Restrictions, tap NO. Generate the PDF: the Restrictions page should answer NO with no "NIL" row under it.
  2. Tap YES, enter "Roof void: corners not reached", generate again: YES, with "Areas where inspection was restricted" and the text.
  3. Set Inspection type to "Insurance / Legal", generate: the cover should say "TIMBER PEST INSPECTION REPORT" (no "PRE-PURCHASE"), and the last page before the agreement should carry the "not suitable for use where the property is being bought or sold" note.
  4. Set it to "Pre-Purchase — Timber Pest": the cover says "PRE-PURCHASE", that note is gone, and T&C 8 no longer advises getting a pre-purchase inspection.
  5. Tap the Share button: the share sheet title reads "Timber Pest Inspection Report".

**What waits on baz's word**

- "deploy PR #N" for the go-live. Merging is not deploying.
- No Worker, Supabase or Stripe change is needed.
