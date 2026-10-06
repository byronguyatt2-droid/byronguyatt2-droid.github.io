# SAYON — guide for working on this repo

A voice-to-report PWA for Australian timber pest inspectors. The chain is: pre-inspection agreement → voice inspection report → quote → client's answer and signature → treatment record and certificate, each sent to the client. It is a static site on GitHub Pages: no build step and no framework. Plain HTML, CSS and JS that load in the browser.

**New to this repo, or starting a larger task? Read `docs/handover/README.md` first.** It covers the owner, what's live, the go-live recipe and the traps, and points to the rest.

Read only the files your task needs. `js/app.js` is about 9,200 lines, so jump to a section with `grep -n "SECTION NAME" js/app.js` instead of reading it whole.

## File map

| File | What's in it |
|---|---|
| `index.html` | Every screen and overlay: splash, sign-in, platform menu, report (sections 1–7 + sign-off), drawer menu pages, quote screen and sheets |
| `js/app.js` | The report app and everything shared (see sections below) |
| `js/quote.js` | Quote builder, the client's answer and the quote PDF |
| `js/treatment.js` | Treatment record and the one-page certificate PDF |
| `js/business-sync.js` | Syncs company details and quote prices to Supabase `businesses.settings` |
| `css/app.css`, `css/quote.css` | Styles |
| `service-worker.js` | Offline cache. **Bump `CACHE_VERSION` (korva-vNN) whenever cached files change** |
| `worker/worker.js` | Cloudflare Worker `korva`: AI proxy, `/transcribe`, Stripe, `/send-email`. Pasted into Cloudflare by hand |
| `netlify.toml` | Netlify preview links only (`deploy-preview-N--sayon-preview.netlify.app`). Never the live site |
| `supabase/*.sql` | SQL baz applies in the Supabase SQL editor |
| `terms.html`, `privacy.html` | Legal pages |
| `docs/handover/` | Handover docs: start-here guide, current state, extraction and report-wording maps, a sample report PDF |
| `tests/extraction/` | Extraction test bench: real transcripts (made-up address), answer keys, scorer and runners |

## `js/app.js` sections (grep the banner text)

- **Voice:** VOICE, NATIVE SPEECH RECOGNITION ADAPTER, AI TRANSCRIPT CLEANUP, HANDS-FREE MODE, EXPERIMENTAL AUDIO CAPTURE
- **Extraction:** AI EXTRACTION (`SYSTEM_PROMPT`), WAITING NOTES
- **Report:** FIELD RENDERING, MULTI-FINDING ENGINE, MOISTURE METER READINGS, OBSTRUCTION ZONE SELECTOR, SPECIES INTELLIGENCE DATABASE
- **Jobs:** PRE-INSPECTION AGREEMENT, PHOTO ATTACHMENTS, SIGNATURE PADS, COMPLETED JOBS
- **Account:** AUTH STATE, SIGN IN, BILLING / STRIPE, BUSINESS LOAD, DELETE MY ACCOUNT
- **Data:** PERSISTENCE — SAVED REPORTS, SUPABASE REPORT SYNC, DATA EXPORT / IMPORT
- **Screens:** DASHBOARD, MENU, ACCESSIBILITY SETTINGS
- **Output:** PDF GENERATION, SEND TO CLIENT

## Rules that aren't obvious from the code

- **Merging is not deploying.** GitHub Pages publishes the `live` branch. Work goes into `main` by PR. Going live is a separate PR into `live`, built from `origin/live` plus cherry-picked commits, and only after the owner says "deploy". Never push to `live`.
- **Worker, Supabase and Stripe changes** are applied by hand, and only after the owner has seen the exact change.
- **Don't rename stored keys.** That covers `korva_*` localStorage keys, the `korvus-photos` IndexedDB and the Worker URL; renaming them loses users' data. The brand was renamed KORVUS → SAYON in display text only.
- **Replace, don't duplicate.** Reuse the shared helpers (`PDF_COLORS`, `drawPdfCompanyMark`, `deliverPdfBlob`, `formatAddress`) instead of adding copies.
- **Trade wording:** never give a structural verdict (refer to a builder or engineer), and never rate risk by termite species.
- **No App Store yet.**

## Testing

Serve the repo with `python3 -m http.server 8765` and drive it with Playwright (Chromium is at `/opt/pw-browsers`). Block the service worker in tests. Run `node --check` on every changed JS file.
