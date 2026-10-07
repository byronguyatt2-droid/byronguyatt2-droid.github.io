# Inspector walk-through: the ten changes that would matter most (2026-10-06)

One whole job was walked in Chromium at phone size (390×844), on `main` at commit `b0f6323` (= live `korva-v53`): agreement, dictation, every report section, the check screen, the report PDF, the quote, the client's answer, the treatment record and the certificate. The AI's answer was canned from the house-test-2 sample (`docs/handover/samples/make-report-sample.js`); everything else was tapped and typed as an inspector would. Chromium cannot show speech, the share sheet, the mail app or the camera, so those were noted rather than faked.

The 70 screenshots, six PDFs and the walk notes (`WALK-NOTES.md`, with a row per screenshot and the tap counts) are in the project's files under `fable/walkthrough/`. Screenshot names below refer to that folder.

The review is written as a licensed timber pest inspector at the third job of a hot day would see it: what slows them down, what they would not trust, what a homeowner would misread, and what is missing between inspection, quote and delivery. Items the README lists as cut or later, and business setup, are left out. Wording already fixed by the client wording review (PR #76) is not repeated.

Counts from the walk: 27 taps on the shortest path from "new inspection" to "report sent" (36 as walked, with the detours below), plus 11 typed fields and the note, across about 16 screens and sheets. Quote to certificate: 9 taps minimum, 13 as walked, plus 9 typed fields in the treatment record.

## The top ten

### 1. An unanswered "Refer to a builder or engineer?" prints as "BUILDER REFERRAL: NONE FLAGGED"

- **Seen:** `22-section-findings.png` (the referral field under Finding 1 is blank; Finding 2, workings on the rear bearer and joist, is blank too), `pdf-pages/report-page-02.png` (summary tile "BUILDER REFERRAL — NONE FLAGGED"), `34-check-before-sending.png` (same tile on the check screen, in green).
- **Why it matters:** the AI never answers this question and the inspector did not notice it on either finding. The report then tells the buyer, in the one place they read, that no builder referral was made. For termite workings on a bearer and joist that is the inspector's decision to make, and the report has made it for them. It is the one tile on the summary page that can turn a blank into advice.
- **Smallest fix:** treat a blank referral on any finding as unanswered: the summary tile and the check-screen tile read "NOT ANSWERED" in amber, and the check screen lists "Finding 2: builder referral not answered" under "Worth checking first". Only an explicit No prints "NONE FLAGGED".

### 2. Restrictions says NO while three areas were only partly inspected

- **Seen:** `21-section-restrictions.png` (section 3 shows "Not started", the YES button is pink, the NO button grey, and nothing explains the state), `20-section-obstructions.png` (section 2: Interior, Subfloor and Roof Void marked Partly, with reasons), `pdf-pages/report-page-04.png` ("WERE THERE CONDITIONS THAT RESTRICTED BUT DID NOT PREVENT INSPECTION? NO") against `report-page-03.png` (three areas PARTLY INSPECTED, stored articles, low clearance).
- **Why it matters:** the AI put the restricted areas into the data (`restrictedAccess` holds "The Interior. Subfloor: Stored Articles. Roof Void: Low clearance in roof void"), but the buttons did not pick it up, so the section reads as untouched and the PDF says NO. A homeowner reads page 3 and page 4 and sees the report contradict itself; a solicitor sees a NO the inspector cannot defend. Sections 2 and 3 also ask the same question twice (which area, why), and an inspector on a hot day answers it once.
- **Smallest fix:** make section 3 follow section 2: when any area is Partly or Not inspected with a reason, Restrictions is YES and lists those areas and reasons; the YES/NO buttons only override that. The trim list in `state.md` (merge sections 2 and 3 into one "Areas inspected" step) is the fuller version of the same fix.

### 3. The agreement is signed under AS 3660.2 and the report is issued under AS 4349.3

- **Seen:** `09-agreement-form.png` (the agreement text is fixed at signing; the Applicable Standard was still the default "AS 3660.2-2017", `03-app-empty.png`), `07-job-details-scrolled.png` (Inspection type blank in Job details), `17-after-extract.png` (extraction later set "AS 4349.3-2010"), `pdf-pages/report-page-11.png` ("in line with AS 3660.2-2017") against `report-page-01.png` ("Prepared with reference to AS 4349.3-2010 — Pre-Purchase Timber Pest").
- **Why it matters:** the agreement is the contract. On a pre-purchase job the client signs it before the inspector has said a word, and it names the wrong standard and does not call the job pre-purchase. Both documents go to the client in one PDF. Nothing in the flow asks "what kind of inspection is this?" before the signature.
- **Smallest fix:** the agreement sheet asks for the inspection type first (pre-purchase, annual, re-inspection, insurance/legal), sets the standard from it (`INSPECTION_TYPE_STANDARD`), and shows the resulting clause 1 before the pad. Job details inherits it.

### 4. Getting from a finished report to a sent report takes two PDF builds and a detour

- **Seen:** `32-drawer-ready-to-generate.png` (Generate PDF enabled, Send hidden), `33-drawer-after-generate.png` ("PDF downloaded", Send appears), `34-check-before-sending.png` ("3 areas have no inspection status", no way to fix it from the sheet), `36-check-before-sending-bottom.png` ("Send anyway"), `37-areas-before-mark-all.png` and `38-areas-after-mark-all.png` (back to the Areas tab, Mark all), `39-check-before-sending-clean.png` (Generate PDF again, Send again; the sheet reopened scrolled down with the warning box out of view; "No quote is attached").
- **Why it matters:** the check screen is good at finding gaps and then makes the inspector leave to fix them, rebuild the PDF and come back. The three unmarked areas (outbuildings, retaining walls, landscaping timbers) are the ones the inspector never mentioned because there was nothing to say. The first PDF is also already on the phone, so there are two report files to confuse. And "No quote is attached" has no "build the quote" button, so the walk sent the report alone and the quote later: two emails to the client, when the one goal is report plus quote before leaving the driveway.
- **Smallest fix:** one Send button that runs the check first and builds the PDF only after the inspector confirms. Each gap on the check sheet gets its own fix: "Mark the rest as inspected" / "Not applicable" next to the unmarked-areas warning, and "Build quote now" next to "No quote is attached". The sheet opens at the top.

### 5. The quote is sent with prices the inspector never set and report prose as line text

- **Seen:** `42-quote-builder.png` (header "Saved"; the first line already priced at $380 before anything was typed), `43-quote-builder-scroll1.png` (line "Termite baiting system: supply and install stations", detail "Treat the active termites in the backyard tree; install a termite management system (chemical barrier or baiting system)", qty "12 station"), `pdf-pages/quote-page-1.png` (the same text on the client's quote; line 1 detail ends "Species not identified — further investigation required · nest located — includes nest treatment").
- **Why it matters:** the lines come from the right places (findings, recommendation, conducive conditions) and say so, which is the strength of the quote. But a first-time business gets catalogue prices it has never seen, marked Saved, and nothing says "these are starting prices". The detail text is the report's wording, so the client's baiting quote tells them a chemical barrier is also an option and that further investigation is required, and reads "12 station". The recommendation named two systems; the quote silently picked one.
- **Smallest fix:** a line whose price has never been edited by this business shows a "starting price" tag until it is; the detail field defaults to the location only ("Gum tree in the backyard, about 15 m from the house"), never the recommendation sentence or the species line; plural units; and when the recommendation names more than one system, the builder asks which to quote.

### 6. The treatment record asks for nine typed fields and the certificate still prints a row of dashes

- **Seen:** `55-treatment-record-empty.png` (date, next inspection, technician, licence, pest, methods and station count prefilled from the quote, which works well), `57-treatment-record-products.png` (start, finish, equipment, weather, product, amount typed by hand), `58-treatment-record-areas-notice.png` (areas treated, areas not treated, notice location typed), `pdf-pages/certificate-page-1.png` (PRODUCTS APPLIED: rate —, batch —, life —, where —; "Chemical life: Termidor (fipronil): see label" on a baiting job; "Pest treated: Subterranean termites (Species not identified — further investigation required)"), `certificate-page-2.png` (a second page holding only the signature block).
- **Why it matters:** the certificate is what the client keeps and the next inspector reads. A products table of dashes looks unfinished, and the batch number is the one thing a technician must record for a chemical treatment. "Further investigation required" on a certificate for work already done undermines it. The "one-page certificate" is two pages because the signature did not fit.
- **Smallest fix:** print only the product columns that have values and ask for the batch number in its own field (with the drum label photo as the easy way to capture it); drop the species qualifier from "Pest treated" on the certificate; show "Chemical life" only when a chemical was applied; fit the signature on page 1 by trimming the "Keeping the property protected" list to three lines.

### 7. "Report sent" and "Quote sent" are recorded when the button is tapped, not when anything was sent

- **Seen:** `40-after-send.png` (toast "PDF downloaded — attach it to the email that just opened"; nothing opened in Chromium, yet the report is now sent), `41-report-after-send.png` ("Report sent 6 Oct 2026"), `50-quote-after-email.png` (the quote's `sentAt` is set, but the card still says "Not sent yet"), `64-quote-after-certificate-email.png` (no sent state for the certificate at all).
- **Why it matters:** on the phone the share sheet does carry the PDF (that part Chromium cannot show), but an inspector who taps Send, is interrupted and swipes the share sheet away has a job marked sent that the client never received. Complete job then locks it. The quote card contradicting its own state, and the certificate having no sent state, means the inspector cannot tell at a glance what the client has.
- **Smallest fix:** set sent only when the share call resolves (iOS reports success), otherwise ask "Did that send?" with Yes / Not yet; one "Sent" line per document (report, quote, certificate) on the report banner and the quote cards, driven by the same data.

### 8. A complete, locked job still reads 84%

- **Seen:** `66-job-complete-locked.png` (ring 84% beside "Job complete · version 1"), `68-saved-reports-list.png` (the saved row shows "84%" and "Complete v1"), `69-dashboard.png` ("84% avg completion"; "Recorded fees —" although the agreement fee was $350).
- **Why it matters:** the ring counts optional fields (height, termite management system, photos), so no real job reaches 100%. The inspector learns to ignore the one progress signal the app has, and the saved list looks like a pile of unfinished work. The dashboard not seeing the agreement fee is the same kind of thing: two fee fields (Job details and the agreement) and the one the inspector used is not the one counted.
- **Smallest fix:** the ring counts only required fields and reads "Complete" once the job is locked; the saved list shows status, not a percentage; one fee field, shared by Job details and the agreement.

### 9. After extraction the inspector cannot see what the AI did and did not fill

- **Seen:** `16-dictation-typed.png` (the whole-house note in a box that shows about five lines), `17-after-extract.png` (toast "Fields populated", ring 74%, and the Property section; Height, Termite management system and the referral questions are blank, but finding that out means scrolling seven sections).
- **Why it matters:** the AI is the reason the app exists, and the moment it answers is the moment the inspector is least sure of it. Today the answer is a toast and a percentage. The inspector on a hot day either trusts it blind or reads every section; both are slow, and the first is how item 1 reaches a client. The note box is also too small to re-read what was heard.
- **Smallest fix:** after Extract, one sheet: "Filled 24 fields from your note. Left blank: height, termite management system, builder referral (2 findings), slab edge. Not used from your note: (sentences the AI did not place)." Each blank is a tap to that field. Let the transcript box grow to the note (or open full screen).

### 10. The mic button and toasts sit on top of things the inspector needs to read or tap

- **Seen:** `03-app-empty.png` (mic over the "Read from compliance plate" label), `23-section-findings-scrolled.png` (mic over the amber note under Finding 2), `68-saved-reports-list.png` (mic over the Generate PDF and Quote buttons of the last row), `12-agreement-signed.png`, `33-drawer-after-generate.png` and `39-check-before-sending-clean.png` (a "PDF downloaded" toast over the Quote button and over the Send button; a stale toast still showing on the next screen), `70-profile-menu.png` (the account dropdown over the banner), `15-dictation-empty.png` (the Hands-Free description in low-contrast grey on a dark gradient).
- **Why it matters:** in sun, with gloves off and dust on the screen, the inspector taps where the button is, and gets the mic or a toast instead. Each one is small; together they are the "this app fights me" feeling.
- **Smallest fix:** bottom padding on every scroll area equal to the mic button, hide the mic on list and quote screens, toasts above the mic and dismissed on screen change, and a solid background behind the Hands-Free text.

## Things that work and should not change

- **The summary page** (`pdf-pages/report-page-02.png`): eight tiles, areas not fully inspected, what to do next, and the "read the full report" line. It is the best page in the app; the fix in item 1 only changes what a blank prints as.
- **The check screen's "What the client reads first"** (`34-check-before-sending.png`): the inspector sees exactly what the summary page will say before it goes.
- **The agreement banner flow** (`03`, `12`, `13`): sign on the pad, the banner turns green with name and time, View shows the signed copy. Nothing locks on signing.
- **Findings as cards with the no-severity damage field** (`22-section-findings.png`): "Damage description (location, extent, what's visible — no severity opinion)" trains the inspector into the right wording. The PDF's builder-or-engineer paragraph and the risk badge's "based on" factors are right and match the trade rules.
- **The moisture meter card and the Areas zone cards with reason chips** (`24`, `20`): fast to correct by tapping.
- **The quote's "From report · Finding 1" provenance and "Rebuild from report"** (`42`, `43`): the client can see why each line exists and the inspector can start again after amending.
- **The client's answer card** (`52`–`54`): accepted or declined, how, when, signature, and it goes stale if the quote changes.
- **The treatment record's prefill from the quote** (`55`): methods, station count, technician, licence and next inspection date arrive filled.
- **Complete job / Amend with a reason / version N+1** (`66`, `67`): the lock explains itself when tapped, and the PDF carries the version history.
- **The asbestos note and the AS 4349.3 "with reference to" wording** from the client wording review: keep as fixed.
- **Waiting notes with the reason shown and no guessing fallback**: not exercised here (the canned AI answered), and must stay.

## Not reviewed here

Speech recognition, the Whisper alternate, hands-free mode, photos, the share sheet and the mail app can only be judged on a phone. Dates and times in the walk render in US format because headless Chromium runs in an en-US locale; on an Australian iPhone they follow the phone.

## Handoff

- This PR adds only this file. No app code changed; nothing needs a go-live.
- The screenshots and PDFs are in the project's files under `fable/walkthrough/`, not in the repo.
- Items 1, 2 and 3 are wrong facts in a client's documents and should go before the others. Items 4 and 9 are the time savers. Items 5 to 8 and 10 are polish that a paying business would notice in its first week.
- For each fix, the regular model can reproduce the screen with the walk scripts' approach (`docs/handover/README.md` section 5) and check the PDF text with `pdftotext`.
