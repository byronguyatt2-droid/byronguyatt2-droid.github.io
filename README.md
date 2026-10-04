# KORVUS Inspect

A voice-to-report progressive web app / iOS app for licensed Australian timber pest and termite inspectors. Technicians speak their inspection findings, and Korvus turns the dictated transcript into a structured, standards-referenced inspection report (AS 3660.2 / AS 4349.3) ready for review and PDF export.

This repository hosts the web build (served via GitHub Pages) that also forms the basis of the native iOS app, built with Capacitor.

- `index.html` — the app's markup
- `css/app.css` — the app's styles
- `js/app.js` — the app's logic (a plain script, no build step)
- `css/quote.css`, `js/quote.js` — the Quote screen (treatment quotes built from an inspection report); loaded after `app.css` / `app.js`
- `privacy.html` — Privacy Policy (draft, not yet legally reviewed)
- `terms.html` — Terms of Service (draft, not yet legally reviewed)
- `manifest.json`, `service-worker.js`, `icon-*.png` — PWA support files

This project was previously named TermAI / TermiteAI.

## Merging vs deploying

Merging and deploying are separate steps.

- `main` is where finished code is merged. Merging to `main` does not change the live site.
- `live` is the branch GitHub Pages publishes to https://byronguyatt2-droid.github.io.

To deploy, only after the owner has reviewed the diff and said "deploy":

1. Open a pull request from `main` into `live`. Its "Files changed" tab shows exactly what will go live.
2. The owner merges it. The site updates a minute or two later.

`live` should only ever move forward to a commit already on `main`; never commit to `live` directly.

The Cloudflare Worker (`worker/`) and Stripe/Supabase settings are never deployed by merging. Each is changed by hand, only after an explicit "deploy".
