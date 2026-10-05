# SAYON: wording the client sees

A map of every fixed sentence the client reads in the report, agreement, quote and certificate PDFs, for a review against AS 4349.3-2010, AS 3660.2-2017 and the Australian Consumer Law.

- Line numbers are from `origin/main` at `e15f1f0` (2026-10-05); `js/app.js` was 9,178 lines. They drift, so find code by the quoted text or function name.
- Written by reading the code. The figures it flags as "need checking" have not been checked against the standards, and nobody on this project has a copy of them; say so rather than guess clause numbers.
- A sample report made with this code (made-up business and address) is `docs/handover/samples/report-sample.pdf`. `docs/handover/samples/make-report-sample.js` makes a fresh one.

## 1. Inspection report PDF

**Entry points:** `generateReport()` js/app.js:7829 calls `_buildAndDownloadPDF()` js/app.js:7945–9178. Shared pieces are at 7851+: `drawPdfCompanyMark` 7880 and `deliverPdfBlob` 7906. Local helpers: `sectionTitle` 8025 (numbered with a badge), `row` 8048, `subhead` 8119, `disclaimer` 8140, `callout` 8153.

A `row()` with an empty value is skipped (8050–8052), so a field nobody filled in prints nothing.

Three helpers are defined but never called, so their wording never prints: `riskBanner` 8093, `referralBox` 8171 and `photoPlaceholder` 8225.

**Standard label:** `STANDARD_NAMES` 7971–7978. `standard = reportData.standard || 'AS 3660.2-2017'` 7979.

### Print order

| # | Part (heading) | Lines | Fixed wording |
|---|---|---|---|
| Cover | Company band, or "SAYON" / "Intelligent Inspection Platform" when no company name | 8296–8338 | 8333 |
| | Kicker "PRE-PURCHASE TIMBER PEST" if the standard starts with `AS 4349`, otherwise "TIMBER PEST", then "INSPECTION REPORT" | 8342–8350 | Any AS 4349.x gets the pre-purchase label, including 4349.0 and 4349.1 |
| | "Prepared in accordance with" + `standardLabel` | 8355–8358 | |
| | Property card (address, client, inspector, licence, date, time, type, IDs) | 8360–8408 | |
| | Badge "RISK OF TERMITE ATTACK": LOW/MEDIUM/HIGH, or "PENDING ASSESSMENT", plus "BASED ON …" | 8410–8435 | The basis is built in `reportSummary()` 7408–7416 and is never based on species |
| | Footer: "Prepared by {company}" or "Generated via SAYON", "This report does not conclusively determine that the property is free of termites." | 8437–8446 | 8441, 8443 |
| — | SUMMARY OF FINDINGS (unnumbered) | 8454–8508 | Tiles from `reportSummary()` 7393–7447: Live termites, Termite damage or old activity, Borers, Wood decay (rot), Builder referral ("BUILDER TO ASSESS"), Conducive conditions, Risk of termite attack, Treatment recommended (7417–7430) |
| | "AREAS NOT FULLY INSPECTED" list | 7432–7435 | |
| | "WHAT TO DO NEXT" list | 7437–7445 | Builder/engineer line 7440: "Have a licensed builder or structural engineer assess the termite damage before any repairs." Decay 7442. Last item always prints: "Next timber pest inspection: {inspectionFrequency \|\| 'within 12 months'}" 7445 |
| | Disclaimer: "This summary highlights the main results only. Read the full report…" | 8507 | |
| 1 | CLIENT & JOB DETAILS | 8510–8538 | Includes "Fee (inc. GST)" |
| 2 | PROPERTY DETAILS | 8540–8564 | Row "Applicable Standard" 8547. Era-based asbestos disclaimers: "HIGH likelihood of asbestos-containing materials… Recommend licensed asbestos assessor…" 8555, "MODERATE likelihood…" 8558 |
| 3 | UNDETECTED TIMBER PEST RISK ASSESSMENT | 8567–8619 | Comment "Per AS 4349.3" 8570. Ratings HIGH, MODERATE-HIGH, MODERATE, LOW-MODERATE or NOT ASSESSED (logic 8580–8585). Explanations 8594–8602, e.g. "Further invasive inspection strongly recommended." and "Regular inspection programme should continue." Disclaimer 8618: "…It is not an assessment of pest pressure or building susceptibility." |
| 4 | AREAS INSPECTED & OBSTRUCTIONS | 8622–8653 | Area labels `OBS_ZONES` 281–358. Status text 8626 ("Inspected / PARTLY INSPECTED / NOT INSPECTED / Not present"). Question 8639: "WERE THERE OBSTRUCTIONS THAT MAY CONCEAL POSSIBLE TIMBER PEST ACTIVITY?" Disclaimer 8649: "…It must be assumed that timber pest activity may exist in these areas." |
| 5 | RESTRICTIONS | 8656–8678 | Question 8664: "WERE THERE CONDITIONS THAT RESTRICTED BUT DID NOT PREVENT INSPECTION?" Rows 8671–8672. Disclaimer 8674 |
| 6 | TIMBER PEST FINDINGS | 8681–8793 | One card per finding (`findingCard` 8689). Labels 8695: "LIVE TERMITES PRESENT" / "EVIDENCE ONLY — NO LIVE TERMITES" / "NO ACTIVITY FOUND". Also "SPECIES / GENUS" 8723 and "TERMITE NEST FOUND?" 8732. Referral callout 8764: "The inspector recommends a licensed builder or structural engineer assess this damage, and any effect on the structure, before work proceeds." Subhead "BORERS & WOOD DECAY" 8781–8786. Disclaimer 8789: "…does not assess structural damage severity — a licensed builder or structural engineer must be engaged… Where live termites are found, concealed activity must be assumed in all areas not inspected." |
| 7 | CONDUCIVE CONDITIONS | 8797–8857 | "MOISTURE & DRAINAGE" 8805: Water Leaks, "Moisture Detected", "Moisture Meter Reading" as `reading — location` (8806–8808). "Above-ground leak" callout 8813 (secondary moisture-dependent colony). Barriers 8818–8825. Existing system 8827–8853, with callout 8849: "These checks confirm the system can still be inspected, not that it works. Rectification and re-inspection are recommended." No fixed wording on meter type, units or thresholds was found |
| 8 | RECOMMENDATIONS | 8859–8871 | Rows: Risk of Termite Attack, Treatment Recommended, Treatment Type, "Re-inspection Interval" (8863–8866). Insurance disclaimer 8870: "…typically do not cover damage caused by termites…" |
| (9) | PHOTOGRAPHIC EVIDENCE (only if there are general photos) | `photoGallery` 8230–8262 | Section photos print inline under "PHOTOGRAPHIC EVIDENCE — {LABEL}" 8185 |
| — | WHAT IS A TIMBER PEST INSPECTION? (unnumbered) | 8878–8911 | Intro 8896 ("visual, non-invasive… in accordance with the applicable Australian Standard"). Q&As at 8898/8899 (pests covered, "as defined in AS 4349.3-2010"), 8901/8902 (non-invasive; splinter testing "with the property owner's consent"), 8904/8905 ("Reasonable access is defined in AS 4349.3-2010 as…" 3.6 m ladder, 400 mm under lowest bearer, roof hatch 450 mm x 400 mm; **these figures need checking against the standard**), 8907/8908 (readily accessible), 8910/8911 ("No…" no guarantee) |
| — | DEFINITIONS | 8913–8939 | `defs` 8918–8928: Timber Pests, Visual Inspection, Reasonable Access (repeats the 3.6 m / 400 mm / 450x400 figures, 8921), Readily Accessible Area, Obstructions 8923, Restrictions 8924 ("…prevent the inspector from entering an area…"; **conflicts with the section 5 question at 8664, "restricted but did not prevent"**), Conducive Conditions, Active Termites 8926, Inactive / Evidence Only 8927 ("…equally significant as active termites and warrants immediate professional attention.") |
| — | IMPORTANT NOTICE box | 8941–8950 | 8948: the fee covers inspection and report only; "Standard home and contents insurance policies do not cover termite damage." |
| n | TERMS & CONDITIONS OF INSPECTION | 8952–9011 | See the clause list below |
| n+1 | INSPECTION AGREEMENT & ACKNOWLEDGEMENT | 9014–9134 | Disclaimers 9018 (not a warranty, guarantee or certificate) and 9024 ("The client acknowledges… does not conclusively determine that the property is free of termites."). 9021 prints only when the standard is not AS 4349: "…not suitable for use where the property is being bought or sold — a Prior-to-Purchase inspection complying with AS 4349.3 should be obtained…" Inspector block 9027–9054. Client block 9056–9096 ("Agreed by", "Signed: … before the inspection", or "No pre-inspection agreement was recorded for this inspection." 9082). Version history 9098–9128. Footer badge 9131–9134: "Generated by SAYON", "Report ID: … · **{standard} Compliant**", "Content fingerprint…" |
| n+2 | PRE-INSPECTION AGREEMENT (full signed text) | 9136–9141 | `drawAgreementBody` 4666–4696 |

**Page footers** (9143–9151): "Report {no} · Version {v}" and "Page x of y". The cover is not counted.

**Share-sheet title** (9174): `'SAYONion Report'`, a rename leftover (see the bug list below). The share text is "Timber Pest Inspection Report — {address}" (9175). The email subject and body come from `openSendReview` 7789–7795 and `clientMessage` 7632–7645 ("Please find attached your {docs} for {address}…").

### T&C clauses (heading line, then paragraph on the next line)

1. Purpose and Nature, 8973. Uses `${standard}`. "not a structural inspection… not a certificate of any kind… not… a warranty or guarantee".
2. Scope of Inspection, 8976. "Readily accessible areas are defined in AS 4349.3-2010 as…"
3. Areas Not Inspected — Obstructions and Restrictions, 8979.
4. Limitations of a Visual Non-Invasive Inspection, 8982. Cites AS 4349.3-2010.
5. Damage Assessment — No Structural Opinion, 8985. "The inspector is not qualified to assess the structural significance…", followed by the builder/engineer referral.
6. Conditions May Change After Inspection, 8988.
7. Insurance, 8991. "do not generally cover…"
8. Reliance — Client Use Only, 8994. Prints on **every** report, including AS 4349.3 pre-purchase ones: "Where this report has been sought in connection with a proposed property purchase, a formal Prior-to-Purchase… AS 4349.3-2010… is strongly advised."
9. Recommended Re-inspection Frequency, 8997. "Annual… minimum recommended frequency under AS 3660.2-2017…; six-monthly where elevated risk…"
10. Applicable Standards and Legislation, 9000. `${standard}`, the "AEPMA… Code of Practice for Timber Pest Inspections", NCC and AS 3660.1-2014.

Closing line 9010: "This report must be read in its entirety…"

### Repeated themes

- **Insurance:** 8870 ("typically"), 8948 ("do not"), 8992 ("do not generally").
- **Builder/engineer referral:** 7440, 7423 (tile), 8764, 8789, 8986, and quote.js:298.
- **Next inspection:** 7445, 8602, 8866, 8998.

### What the AI fills in (not fixed wording, but printed)

- `SYSTEM_PROMPT` runs from js/app.js:1095 to 1205. The JSON schema is at 1117.
- No severity words in `damageDescription`, borer details or decay details (1160–1163; borers 1141, decay 1143).
- `structuralConcern` means "refer", not a structural verdict (1164).
- `riskLevel` is inferred as HIGH/MEDIUM/HIGH-LOW rules at 1199–1203, with "Never base riskLevel on the termite species" at 1203. The prompt calls this "a legitimate, subjective, comparative rating under AS 4349.3/AEPMA guidance" (1199).

### Bugs in client-facing output (found by reading the code, not yet fixed)

- **A "No restrictions" answer prints as YES** (re-checked in the code 2026-10-05). Tapping No sets `hinderedAreas = 'NIL — No restricted access areas at time of inspection.'` (js/app.js:561). The PDF only treats the answer as No if the field is empty or contains `'N/A'` (8659, and `hasRestriction` 8576). So the PDF answers YES, prints the NIL text under "Areas Where Inspection Was Restricted" (8671), and can raise the undetected-risk rating to MODERATE.
- **The same field means three different things.** `hinderedAreas` is "(readily accessible areas inspected)" in the AI schema (1117), "Readily Accessible Areas Inspected" in `FIELD_LABELS` (8268), and "Details & Recommendations" in the app (index.html:1190). The PDF prints it as the restricted areas.
- **The share sheet title reads "SAYONion Report"** (`deliverPdfBlob` call at the end of `_buildAndDownloadPDF`, about line 9174): a leftover from the KORVUS → SAYON rename. It should read like the share text, e.g. "Timber Pest Inspection Report".
- **A blank borer or decay answer prints nothing.** The comment at 8778–8780 says those rows are "always printed", but `row()` drops empty values. Only the summary tile then shows "NOT RECORDED".

## 2. The "Applicable standard" field

- **Options** (js/app.js:3844): AS 3660.1-2014, AS 3660.2-2017, AS 3660.3-2014, AS 4349.0-2007, AS 4349.1-2007, AS 4349.3-2010. The inspector edits it on the report screen (index.html:1073, `setStandard` js/app.js:5205–5217).
- **Default is AS 3660.2-2017.** It is forced at 1363, 6777–6778 and 7112, with fallbacks at 4516 and 7979. Progress only counts the field once it differs from that default (6681–6689).
- **Inspection type sets it** (`INSPECTION_TYPE_STANDARD` 5285–5289): both Pre-Purchase types give AS 4349.3-2010, "Annual — Existing Building" gives AS 3660.2-2017. New Construction, Treatment Follow-Up, Re-inspection and Insurance / Legal leave it unchanged (options at index.html:686–692). The AI can set the inspection type, which then triggers the same switch (3303–3308). The AI never sets `standard` directly.
- **Where it prints:**
  - Cover "Prepared in accordance with {std — name}" (8356–8358).
  - Report-type kicker (8342).
  - Property Details row (8547).
  - T&C 1 and T&C 10 (8974, 9001).
  - The 9021 disclaimer is switched by it.
  - Footer "{standard} Compliant" (9133).
  - Agreement clause 1 `{standard}` (4450, 4516).
- **First line of `SYSTEM_PROMPT`** (1095): "You are a data extraction AI for SAYON, an Australian termite inspection app compliant with AS 3660.2-2017."
- **AS 4349.3 does appear.** It is hard-coded into client text whatever standard is selected: 8899, 8905, 8919, 8977, 8983, 8995, and 9021 when not 4349. It also appears in prompt comments 1134 and 1139, and on inspector screens at index.html:1297 and 1477. AS 3660.2 is hard-coded in T&C 9 (8998), quote.js:41 and treatment.js:625 and 665.

## 3. Pre-inspection agreement

**Where it lives:** the section starts at js/app.js:4436. Default text is `DEFAULT_AGREEMENT_TEXT` 4449–4476, with placeholders listed at 4447.

- A business's own template would come from `getCompanyDetails().agreementText` (4479). **No editor for it was found** in index.html or js.
- Filling: `fillAgreementText` 4489. Unknown values print as "____________". Fee defaults to "As quoted.", notes to "None." (4519–4531).
- Type wording: `agreementInspectionType` 4483 gives "pre-purchase timber pest" if the standard contains 4349, otherwise "timber pest".
- The exact signed text is stored on the report (4442–4443). Signing is at 4605. A standalone agreement PDF is made by `shareAgreementPdf` 4642. The sign sheet is index.html:1628–1670 ("I have read and agree to this agreement", 1659).

**Clauses:**

1. The inspection (4449): {company} inspects {address} for {client} on {date}, "in line with {standard}".
2. What is inspected (4452): a visual inspection of readily accessible areas for termites, borers and wood decay fungi plus conducive conditions; interior, roof space, subfloor, exterior, outbuildings and "site within 50 m".
3. Limits (4455): visual and non-invasive, nothing moved or cut; hidden areas noted; no guarantee; not a building, structural, asbestos, mould or electrical inspection.
4. Invasive inspection (4458): not included; needs a separate written agreement and fee.
5. Access (4461): client arranges safe access; a return visit may cost extra.
6. The report (4464): for the client's use only; no third-party reliance without written consent.
7. Fee (4467): {fee}.
8. Special requests (4470): {notes}.
9. Your rights (4473): nothing limits Australian Consumer Law rights.
- Closing (4476): "By signing, you confirm… before the inspection starts. You also agree to sign it electronically and to receive the report by email." The second sentence is main-only; see section 6.

## 4. Quote PDF and treatment certificate

**Quote — `buildQuotePDF`, js/quote.js:1006–1122**

- Cover "TIMBER PEST / TREATMENT QUOTE" (1022), "VALID UNTIL", 30 days by default (1012–1013, 1029, 337).
- 1 SCOPE OF WORKS (1035): priced lines, descriptions at 20–37.
- "PAYMENT TERMS" box (1047): default "Payment is due on completion of the work." (44).
- EXCLUSIONS & WORK BY OTHERS (1057). Built automatically by `buildQuoteExclusions` 294–316: builder/engineer assessment and repair (298), borer or decay repair, moisture source by a plumber or builder, areas not accessible.
- TERMS & NOTES (1072). Default `QUOTE_DEFAULT_NOTES` 40–42: "…licensed pest technician in accordance with AS 3660.2-2017 and the product label directions. Treatment does not repair existing timber damage."
- ACCEPTANCE (1088–1092): "I accept this quote of {total} (inc GST) and authorise the work described above." The in-app version is at quote.js:654–655.

**Treatment certificate — `buildTreatmentCertificatePDF`, js/treatment.js:426–671**

- Cover "TERMITE MANAGEMENT / TREATMENT CERTIFICATE" (470–481).
- TREATMENT CARRIED OUT (484), PRODUCTS APPLIED (536).
- DURABLE NOTICE (AND SITE PLAN) (580). Notice cells 587–594: System, Date installed, Chemical life (label), "Future inspections… at least every 12 months", Installed by, Notice. Notice options at 47–51.
- KEEPING THE PROPERTY PROTECTED (633). Steps 624–628, including "AS 3660.2 recommends one at least every 12 months" and "Do not disturb the treated soil…". Default cautions 136–137. Optional warranty text at 643.
- Closing line 665: "…carried out… in line with the product label directions and AS 3660.2. It does not repair existing damage, and no treatment can guarantee termites will never return…"
- On Queensland jobs the inspector sees a reminder to also leave a printed copy (161).

## 5. Earlier reviews (do not redo)

**/mnt/project-files/product-review/report-contents-and-trim.md** (checked against live, 2026-10-05)
- Concluded: the 12 parts of a report map onto SAYON in a sensible order, and "the report itself is not bloated". Company details are set once.
- Still open (candidates, none built): merge Areas and Restrictions into one step; hide Voice & AI; fold Accessibility into Settings; rethink Export/Import; ask an inspector whether the PDF needs **both** risk ratings.
- It says to get an inspector or industry body to confirm the details for each state.

**/mnt/project-files/product-review/rating-2026-10-04.md** (written as "KORVUS", 8.6k lines, PDF not tested)
- Scores: 7/10 as a prototype, 4/10 as a paid product.
- Gaps it raised and what the code shows now:
  - Borer and decay fields: now present (js/app.js:8781, index.html:1291).
  - 12-photo cap: now 100 (4708), with photos in IndexedDB and Supabase Storage (4749).
  - Area-by-area record and moisture table: now present (OBS_ZONES 281+, 3709+).
  - Agreement before the job: now present.
  - Offline guessing: now a waiting queue (2843+).
  - Emailing the client: now via `/send-email` or the share sheet (7621+).
- Still open per that review, not checked further here:
  - Proof on real dictation.
  - Subfloor ventilation and thermal readings (no field found).
  - Invoices and integrations.
  - Terms and privacy still drafts.
  - Automated tests: none found.
  - Australian data residency: not checked.

**/mnt/project-files/test-kit/treatment/standards-check.md** (4 Oct; the standards themselves were not read)
- Maps the certificate against AS 3660.2, AS 3660.1 / NCC 3.1.4.4 (durable notice), NSW Pesticides Regulation 2017 cl 36, QLD advice and records, VIC licence conditions, WA records and the AEPMA CoP. Everything is recorded except the QLD "premises type", which is in the report.
- Closed: site plan, supervisor fields, durable-notice wording box.
- Not reviewed there: AS 4349.3 against the inspection report ("Already covered by the report").

**Also present but not read:** /mnt/project-files/product-review/job-flow-gaps-2026-10-04.md.

**Sample PDFs (not read):**
- /mnt/project-files/report-pdf/sample-report-new-layout.pdf
- /mnt/project-files/report-pdf/sample-report-old-layout.pdf
- /mnt/project-files/test-kit/treatment/treatment-certificate-sample.pdf
- /mnt/project-files/test-kit/treatment/certificate-with-plan.pdf

## 6. Main vs live (what clients see now)

After go-live #73 (`korva-v51`), `git diff --stat origin/live origin/main` shows only these, so the PDF, quote and certificate wording above is what clients get on live:

- **E-signing sentence** at the end of the agreement's closing (`DEFAULT_AGREEMENT_TEXT`, main only): "You also agree to sign it electronically and to receive the report by email." Live ends at "…before the inspection starts."
- **`.voice-privacy-hint`** in `index.html` and `css/app.css` (inspector-facing, main only): "Dictate your own notes. Don't record conversations with the client or others without their consent."
- **`terms.html` / `privacy.html` rewrite** (PR #32) with placeholders such as `[BUSINESS NAME]`, `[ABN]`, `[ADDRESS]`, `[STATE]` and a refund policy. Both versions say "Draft — not yet legally reviewed". These pages are for SAYON's subscribers, not homeowners; privacy.html also covers client data. They stay off live until the owner supplies the details. Don't fill the placeholders yourself.
- `CLAUDE.md`, `docs/`, `tests/`, and `supabase/delete-account.sql` (applied by hand already).

`worker/worker.js` is the same on both branches (v9); the live Cloudflare Worker is v8.1.
