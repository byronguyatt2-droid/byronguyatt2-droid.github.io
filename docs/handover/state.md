# SAYON: current state and decisions

As of 2026-10-05, about 10:50 UTC. Written for a model starting with no context.

## 0. Start here

- Claude Code auto-loads `CLAUDE.md` (file map, deploy rules, stored keys, testing), not this file. `CLAUDE.md` points to `docs/handover/README.md`, which sends you here second.
- Check this file against reality before you rely on it:
  - `git fetch origin && git diff --stat origin/live origin/main`. On 2026-10-05 it listed only `CLAUDE.md`, `terms.html`, `privacy.html`, `supabase/delete-account.sql`, 2 lines each in `index.html` and `css/app.css` and 1 in `js/app.js` (all from `8b4a13b`), plus `docs/` and `tests/` once merged. Anything else is unreleased work.
  - `git show origin/live:service-worker.js | grep CACHE_VERSION` should print `korva-v51`.
  - Open PRs: `gh api repos/byronguyatt2-droid/byronguyatt2-droid.github.io/pulls`. (`gh pr list/view` use GraphQL, which is blocked in Claude Code sessions.)
  - Live Worker code: Cloudflare connector `workers_get_worker_code`, script `korva`. No Cloudflare connector? Ask baz to paste the live code. Never assume it matches `worker/worker.js`.
- **This repo is public.** Never commit or post secrets or API keys (they live only as Cloudflare secrets), Stripe ids, the owner's personal or business details, or real client or house details. The Worker URL, Supabase URL and Supabase anon key are in `js/app.js` on purpose; the service-role key must never appear outside Cloudflare.
- **Connectors (Supabase, Stripe, Cloudflare, GitHub) can write.** Only read with them unless baz has okayed that exact change by name. A bare "deploy" is not enough.
- Material outside the repo lives in the project's files under `/mnt/project-files/` (test scripts, raw transcripts, review notes, pasteable Worker files). The path may not exist where you run; ask baz for a file you need. Check anything from there for personal details before it goes into the repo.
- If you are the larger model (Fable) on limited time, spend it on (a) rewriting and scoring `SYSTEM_PROMPT` with the bench (section 4, item 1), (b) a wording review of what the client reads against AS 4349.3, AS 3660.2 and the Australian Consumer Law, then (c), optional, an inspector's walk-through of a whole job ranking the top ten changes. Leave deploys, small fixes and the cleanup pass to the regular model.

## 1. Live right now

| Part | State |
|---|---|
| App (GitHub Pages, `live` branch) | `korva-v51`, go-live PR #73. https://byronguyatt2-droid.github.io |
| Worker `korva` (Cloudflare) | v8.1 = v8 Stripe billing + `MAX_TOKENS_CEILING` 16000 + passes `output_config.effort` (`low`/`medium`/`high`) through. Confirmed live 2026-10-05 |
| `worker/worker.js` (main and live) | v9 = v8.1 + `POST /send-email` through Resend. Same file as `/mnt/project-files/worker/korva-worker-v9.js`. Pages only serves it as a file; nothing runs it. Not on Cloudflare yet (section 4, item 4) |
| AI model | `claude-sonnet-5` only; the Worker's `ALLOWED_MODEL` forces it. `model` plus `output_config: { effort }` is the working request shape, confirmed live 2026-10-05. Don't "correct" the model id or the parameter shape from memory: check the API docs and test through the Worker first |
| Supabase | `report-photos.sql`, `business-settings.sql`, `delete-account.sql` applied. The base tables (`businesses`, `reports`, `subscriptions`, `team_members`, plus `invites` and `jobs` left from cut features) were made in the dashboard and have no SQL in the repo: read them with `list_tables` before touching sync, billing or delete. `delete_my_account` still writes to `invites` and `jobs`, so don't drop them |
| Stripe | Test mode (sandbox) only |

**The job chain today**

| Step | What it does now | Where |
|---|---|---|
| Sign-up | Onboarding step 0 asks for business details, email and logo (no Skip). Edited in account menu (initials) › Your business. Details, last-quoted rates and payment terms (`prices` key) sync to `businesses.settings`. No invites; existing technician accounts still load their business | `js/business-sync.js` |
| Agreement | Client signs on the phone on site, or the inspector records it as signed on paper or by email, with a note. No remote signing | `reportData.agreement` |
| Dictation | Browser speech recognition (Web Speech API, `en-AU`; Apple's in Safari, which may send audio to Apple). Editable transcript box | VOICE |
| Extract | Sends the transcript through the Worker; the AI fills job details (client, address, inspection type) and sections 1–6. Photos (section 7) and sign-off (licence, signature, agreement) are the inspector's | `SYSTEM_PROMPT`, `requestExtraction()` |
| Voice extras | AI transcript cleanup (shows the whole cleaned transcript; nothing changes until the inspector taps Apply). Opt-in experimental Whisper alternate (`/transcribe`). Hands-free mode ("Hey Sayon") | VOICE, AI TRANSCRIPT CLEANUP, HANDS-FREE MODE, EXPERIMENTAL AUDIO CAPTURE |
| Photos | IndexedDB `korvus-photos` + private Supabase bucket `report-photos`. 100 per report, 30 per section | PHOTO ATTACHMENTS |
| Waiting notes | Notes the AI can't read (no signal, refused call) wait with the reason shown; they fill in on reconnect, on reopening the app, or on **Fill in now** | `reportData.pendingNotes` |
| Send | Check screen, then PDFs through the phone's share sheet or mail app. The live Worker has no `/send-email`, so `checkDirectEmail()` sets `directEmail = false` and the app falls back to the phone | `sendPdfsToClient()` |
| Quote | Built from findings. Active borers add a `borer` treatment line; old borer damage and rot go in the exclusions as builder repairs. Each line starts at the business's last quoted rate; a first quote starts from `QUOTE_CATALOGUE`. One-page PDF, **Email to client** | `js/quote.js` |
| Client's answer | Accepted or declined, how (signed on the phone, email, call, paper) and when. Flagged stale if the quote changes afterwards | `q.answer` |
| Treatment | Record on the accepted quote + one-page certificate PDF | `q.treatment`, `js/treatment.js` |
| Complete / Amend | **Complete job** locks report and quote together; needs the report sent and the quote sent or marked "No quote needed". **Amend** asks for a reason and reopens; finishing again makes version N+1, and the PDF lists every version | |
| Sign-out | Backs up every report, then removes reports, quotes, the draft and photos from the phone; asks first if the backup fails | |

**Billing** (Stripe test mode)
- Starter, Pro, Business plans: Checkout, Billing Portal, and a webhook to the Worker's `/stripe/webhook` that updates `subscriptions`. 14-day trial.
- Monthly AI-call limits in the Worker's `PLAN_LIMITS`: trial 50, starter 150, pro 400, business 2000. Ended trial or cancelled plan → 402; limit reached → 429. `/transcribe` counts as one call; `/send-email` (v9) counts as none.
- Live mode is parked until the app passes real jobs. Don't create live-mode products, prices, webhooks or keys, or switch anything to live, without baz's ok on the exact change. Never write Stripe ids or keys into the repo; the Worker reads them from secrets.

**On main but not live, and why**
- **Terms and Privacy rewrite** (`8b4a13b`, PR #32), plus an e-sign consent sentence in the default agreement wording and a voice-privacy hint under the transcript box. It has placeholders for the business's legal details (search `terms.html` and `privacy.html` for `[`). It stays off live until baz fills them, which is parked with the rest of the business admin. Fill them only with what baz types for that purpose; never take them from transcripts, memory or other files, and never put his details in this doc, commits or PR text. Live terms and privacy are the old drafts with only the name changed.
- `supabase/delete-account.sql` (delete the user's reports first): the file only; the function in Supabase already has the fix.
- Docs and tooling: `CLAUDE.md`, `docs/`, `tests/`. They never go live (see README section 3).
- Because main carries the placeholder Terms, build every go-live from `origin/live` plus cherry-picks (section 6). Never open a plain main→live PR.

## 2. Decision log

- **CLAUDE.md's rules stand.** Reasons, so you can apply them to new cases:
  - Merging is not deploying (2026-10-03): baz reviews exactly what ships.
  - Replace, don't duplicate (2026-10-03): the prototype was built across many sessions and copies drift.
  - No structural verdict (2026-10-04, PR #38): `structuralConcern` means "refer to a builder or engineer?"; AS 4349.3 is not a structural assessment and a verdict is outside the inspector's qualification.
  - No risk by species (2026-10-04, PR #39): `SPECIES_DB` has no risk, treatment or frequency ratings and the risk badge shows property-based reasons; any species can do severe damage.
  - KORVUS → SAYON in display text only (2026-10-05, PR #61, live #62): renaming `korva_*`, `korvus-photos` or the Worker URL loses users' data.
  - No App Store yet: `README.md`'s iOS/Capacitor mentions are intent only.
- 2026-10-03, **baz merges into `live`, never you.** Open a go-live PR when baz says "deploy <thing>"; never push to `live`, merge a PR into it or enable auto-merge on one. The branch rules require no approval, so nothing technical stops you.
- 2026-10-04, **show the exact change and get an ok that names it** for Worker, Supabase and Stripe changes. If a bare "deploy" arrives right after you post, ask "ok to apply X?". Reason: a storage bucket was applied on a bare "deploy" before baz had read it.
- 2026-10-04, **done = walked end to end and tried by baz**, not merely live. Reason: the promise is a closed loop from technician to delivery.
- 2026-10-04, **nothing locks on signing**; only Complete job locks, and Amend with a reason reopens. Reason: not recorded.
- 2026-10-04, **sign-out backs up, then clears client data from the phone**. Reason: not recorded.
- 2026-10-04, **no quote price list** (PR #56): each line starts at the last quoted rate. Reason: not recorded; the 2026-10-05 review also listed price lists as not needed.
- 2026-10-05, **the cut** (PR #64, live #65): removed invoices, dashboard follow-ups, job assigning and scheduling, treatment booking, the label calculator. Reason: ServiceM8, Tradify, Xero and similar do these better; SAYON's value is voice → an AS 4349.3 report plus a matching quote, finished on site.
- 2026-10-05, **work alongside field-service apps, don't replace them**: later, one generic "job in (ID and details) → report, quote and certificate out" interface, no per-vendor integrations. Build it after the test run, starting with the first real customer's system.
- 2026-10-05, **business details captured at sign-up, edited in Your business** (PR #68, live #69): Company details page, Team, invites and the agreement wording editor removed (saved custom wording still prints). Reason: account setup is where other trade apps put it.
- 2026-10-05, **the app emails PDFs itself through `/send-email`** once Resend is set up; share sheet until then (PR #59). Reason: mail goes out in the business's name with replies and a copy to the business's own email; it needs the business's own verified domain or it lands in spam.
- 2026-10-05, **no client-side fuzzy brand matching** (PR #70). Reason: it rewrote ordinary words into brand names.
- 2026-10-05, **no offline word-matching; failed notes wait** (PR #70). Reason: a guessed answer in a report is worse than a blank.
- 2026-10-05, **every Worker call goes through `workerFetch()`** (PR #70). Reason: sign-ins expire while the phone sleeps.
- 2026-10-05, **extraction: effort `medium`, `max_tokens` 16000, 120 s timeout** (PR #72), Worker ceiling raised to match (v8.1). Reason: thinking counts toward `max_tokens`.
- 2026-10-05, **species only when the inspector names one** (PR #72). Reason: dictation dropped a negation.
- 2026-10-05, **no new features until the test round is done, unless something is broken.** Steps are a sequence, not a schedule: repeat each until it's right, and never present steps as quick or time-boxed. Reason: sessions were going round in circles.
- 2026-10-05, **business admin is parked** unless it blocks the app. The only blocker is the business's own email domain.
- 2026-10-02 (earliest code), **Whisper alternate is opt-in, off by default, and only ever suggested**; the phone's Web Speech transcript stays the authority. Reason: two microphone users at once is not confirmed safe on real iOS Safari.

## 3. Field testing so far

Both tests were run by baz on a real house (not a client job) on 2026-10-05, dictating on iOS. The tester isn't a trained inspector, so scripts must spell out what to check at each spot. Script: `/mnt/project-files/test-kit/house-script.md`. Raw transcripts: `/mnt/project-files/test-kit/transcripts/`. These are unredacted: never copy them into the repo, a PR, a commit message or an artifact; use the redacted copies in `tests/extraction/transcripts/` and re-check them yourself. Guards are in section 5.

**Test 1** (one long note, no script). Fixes live in #71 (`korva-v50`).
- "termites" → Termimesh, "external" → Exterra: fuzzy brand matcher removed.
- AI call failed (most likely the `max_tokens` cut-off found in test 2); the offline word-matcher then guessed ("not slab" → concrete slab, whole note in Location): matcher removed, notes wait.
- Possible expired sign-in: `workerFetch()` checks the sign-in before each call (refreshing within 10 minutes of expiry, `AUTH_REFRESH_LEAD_SECONDS`) and retries once on a 401.

**Test 2** (followed the script, several recordings, then Extract). Fixes live in #73 (`korva-v51`).
- "Too long": thinking used up the 4096-token Worker ceiling → effort `medium`, 16000 tokens, 120 s, Worker v8.1.
- The Whisper alternate replaced the whole box but had heard only the last recording → it now replaces only its own recording.
- Mishearings (weep holes, subfloor vents, skirting boards, borers, baiting system, water stains, tiled roof) → `correctKnownMishearings()` and `SYSTEM_PROMPT`.
- "Species couldn't be identified" heard as "can be identified" → species only when named.
- A TEMP DEBUG confidence line was left in → removed. iOS reported 0.94–0.97 confidence even on misheard words: don't rely on confidence.

**Not yet field-tested:** a re-run of the whole-house note on `korva-v51` (unknown); dictation in a real subfloor with no signal (waiting notes on a real job); the Whisper alternate on a real job; hands-free mode on a job; a qualified inspector using the app (none lined up).

## 4. Open work, in baz's agreed order

Order: test run → fixes + trims → cleanup pass → larger model. Email sending isn't queued behind these; do it once the domain is verified.

1. **Test rounds and fixes until each part is right.** *Phone runs are blocked on baz.*
   - Bench: `tests/extraction/README.md`. With a key: `ANTHROPIC_API_KEY=... node tests/extraction/run-api.mjs house-test-2 3 baseline`, then `node tests/extraction/score.mjs tests/extraction/gold/house-test-2.json tests/extraction/out/baseline/house-test-2-run*.json`. `run-api.mjs` reads `SYSTEM_PROMPT` from `js/app.js` and sends the app's exact request (`claude-sonnet-5`, effort `medium`, `max_tokens` 16000); keep it in step with `requestExtraction()`.
   - Without a key: run `tests/extraction/eval-workflow.js` with the Workflow tool (`args: { repo, runs, tag }`). It is a proxy: compare prompts with each other, then confirm the winner on baz's phone.
   - Answer keys for both house tests are in `tests/extraction/gold/`; today's prompt scores 91–93% with 1–3 CRITICAL failures per run (`tests/extraction/BASELINE.md`). No pass bar is agreed with baz; treat any CRITICAL (weight 3) failure as wrong facts in a client's report.
   - Larger-model tasks: ~~rewrite `SYSTEM_PROMPT` against the real transcripts~~ **done 2026-10-06** (`docs/handover/extraction-notes.md`: new prompt, note merging in dictation order, five more bench cases, scores in `tests/extraction/BASELINE.md`; waits on baz's "deploy" and a phone test); AS 4349.3 wording review of the report PDF, including which standard governs which output (section 5).
2. **Trims** from `/mnt/project-files/product-review/report-contents-and-trim.md`: merge sections 2 and 3 into one "Areas inspected" step; hide the Voice & AI page from the menu and move only the experimental audio switch into Settings; fold Accessibility into Settings; turn Export/Import into a "Download a copy" option; decide whether the PDF needs both risk ratings. *Blocked on baz choosing after the tests.*
3. **Cleanup pass** (regular model): remove dead code and TEMP DEBUG leftovers (none on main on 2026-10-05; grep again), and split `js/app.js` (9,178 lines). Keep the `booking` and `invoice` keys that `quoteContentHash()` strips: older stored quotes still carry them.
4. **Email sending.** *Blocked on baz: the business's own domain must be set up and verified in Resend.* Then:
   1. baz adds `RESEND_API_KEY` and `MAIL_FROM` himself as Secrets in Cloudflare › Workers › korva › Settings › Variables and Secrets. Never ask for the key in chat, a file or a commit; don't write the real sending address into the repo. Claude can't set Worker secrets.
   2. Re-read the live code, show baz the diff of `worker/worker.js` against it, and get an ok that names v9. (`/mnt/project-files/worker/korva-v9-email.diff` exists; regenerate it against the live code.)
   3. baz pastes the whole of `worker/worker.js`. v9 answers 501 until both secrets are set, so pasting before the secrets is safe.

   More in `worker/README.md`. In a send test on 2026-10-05 baz didn't receive the emails. On v8.1 that send went through the phone's share sheet or mail app, not the Worker, so look there first (what he tapped, which address). Not yet investigated.
5. **Known gaps** (not started; each needs baz's ok):
   - No job import from booking or field-service apps.
   - The agreement can only be signed on site; a remote link needs a new Supabase table and a public signing page.
   - The Whisper alternate is opt-in and experimental.
   - Hands-free mode (`hfStartListening`) has neither the Safari duplicate guard nor `correctKnownMishearings()`. Found by reading the code; untested.
   - ~~The Worker refuses input over 20,000 characters (`MAX_INPUT_CHARS`) with a plain-text 413 and the note was refused again on every retry.~~ Fixed 2026-10-06: a 413 is treated like a too-long note, and the queue skips a note with a problem of its own instead of stopping. Test transcripts are about 2,500 characters.
   - The Stripe customer isn't deleted when an account is deleted.
   - Two bugs in the report PDF, found by reading the code: tapping No on "restricted access" prints Restrictions: YES and can raise the undetected-risk rating, and the share sheet title reads "SAYONion Report". Details in `report-wording.md`; the wording-review PR fixes them.
   - Extraction weak points are listed in `extraction.md` section 5; the ones marked FIXED (2026-10-06) were handled by the rewrite (notes now land in dictation order, list fields append, moisture order, system brand, note-specific failures). Still open there: findings are never de-duplicated, and the PDF's `hinderedAreas` `'N/A'` test (wording review).
   - No check against the Australian Privacy Act before anyone is charged.

## 5. Traps (what broke, and the guard now in place)

- **Service worker paired a new `index.html` with an old script** (blank page after go-live #65): precaching went through Pages' 10-minute HTTP cache, and `isAppShell`'s `'./'` matched every request, Supabase included. Fixed in `korva-v48` (go-live #66; main via #67): install precaches with `cache: 'reload'`, the app shell revalidates with `no-cache`, `isAppShell` matches whole paths only. Still bump `CACHE_VERSION` on every change to a cached file.
- **The Worker clamps `max_tokens`**: an old ceiling silently cut off the app's request. The app now treats `stop_reason === 'max_tokens'` as "too long" and keeps the note. Check the live ceiling before raising the app's `max_tokens`.
- **Adaptive thinking eats `max_tokens`**: `claude-sonnet-5` defaults to high effort. The app sends `output_config.effort` (`medium` for extraction and species photo ID, `low` for cleanup and plate scan); the Worker passes only `low`/`medium`/`high`, from v8.1.
- **"termites" became brand names** because of the client-side fuzzy matcher, not dictation. Brand names in the wrong slot are left to `SYSTEM_PROMPT`, and the Whisper vocabulary hint lists everyday words beside the brands. Don't bring fuzzy matching back.
- **Fixed-phrase corrections can misfire.** Add a pattern to `correctKnownMishearings()` only after it has repeated, or when the misheard phrase has no sensible literal meaning in an inspection (the test-2 patterns). Scope it by context (e.g. "barrel" only after a direction word).
- **Safari re-delivers speech results** (doubled phrases): `startRecording()` commits each result index once and drops an exact repeat within 3 s.
- **Real transcripts contain the owner's name and address**, usually in the first sentence ("inspection at … clients name is …"); the transcripts' `README.md` also has his full name. Before anything from them reaches the repo, change the name, house number, street and suburb to made-up ones. That covers files, commit messages, PR text, score output, artifacts, test fixtures and any example in `SYSTEM_PROMPT` (it ships publicly in `js/app.js`). If a real detail is ever pushed, stop and tell baz: a later commit doesn't remove it from git history.
- **Which standard applies is unreviewed.** `INSPECTION_TYPE_STANDARD` in `js/app.js` maps pre-purchase → AS 4349.3-2010 and annual existing building → AS 3660.2-2017 (the default). `SYSTEM_PROMPT` opens "compliant with AS 3660.2-2017"; the quote and certificate cite AS 3660.2. Settle it in the wording review; don't change it piecemeal.
- **Stale docs and comments; trust the code.**
  - `worker/README.md` opens with "the live v6 Worker". Trust the header in `worker/worker.js` and the live code.
  - `README.md` "Merging vs deploying" says to open a PR from `main` into `live`; that would ship the placeholder Terms. Its file list also misses `js/treatment.js`, `js/business-sync.js`, `worker/` and two SQL files.
  - Comments naming removed features: the v9 header in `worker/worker.js` ("or invoice PDF"), `business-settings.sql` ("price list and the invoice counter"), `delete-account.sql` ("scheduled jobs and pending invites"), the BILLING / STRIPE banner in `js/app.js` ("NOT live until…").
- **Supabase SQL:** none runs until baz has seen it and okayed it by name. The connector times out on destructive SQL: give that SQL to baz to paste into the SQL Editor; don't retry it or split it to get round the timeout. Run a multi-statement file one statement at a time (`business-settings.sql` needed two).
- **One push branch feeds go-live PRs too.** While a go-live PR from your branch is open, keep new commits local and don't force-push it (check open PRs first). After a go-live merges, start the next main PR from `origin/main`.
- **Dates were a day early in Australia.** Use `isoDate()` and `todayIsoDate()` (the phone's calendar), never `toISOString()`, for dates.
- **A blank account copy could wipe phone-only details.** `takeCloudCopy()` in `js/business-sync.js`: for phone details with no timestamp (entered before syncing existed), any field blank in the account copy keeps the phone's value; otherwise the newer copy wins. Keep that rule.
- **Keep the repo name `byronguyatt2-droid.github.io`**: renaming it moves the site off the root URL.

## 6. How to work here

`docs/handover/README.md` covers it: working with baz (section 2), the go-live recipe and the rules (section 3), and testing (section 5).
