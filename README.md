# Card Lab API v1.2.1 — Cloudflare Worker

This Worker receives the front/back card photos, uses Cloudflare Workers AI transiently, reconciles the identity and visible condition, and optionally searches current eBay listings if eBay Developer credentials are configured.

## Required Cloudflare settings

- Workers AI binding named: `AI`
- Secret: `CARDLAB_API_KEY` — create your own long random value. Do not put it in worker.js or GitHub.
- Variable: `ALLOWED_ORIGIN` = `https://darknight909.github.io`

## Optional eBay current listings

Create two Worker secrets if/when you join the free eBay Developers Program:
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`

Without these, identification/grading still works and the app opens a normal current eBay search page.

## Dashboard deployment (no computer required)

Create a Worker named `card-lab-api`, replace the starter code with worker.js, add the Workers AI binding and secrets/variable above, deploy, then copy the `https://...workers.dev` URL into Card Lab > Settings.

Do not store photos in KV/R2/D1 unless you intentionally add cloud storage later. This Worker itself does not persist photos.


## v1.2.1 fix
Uses a JSON-Mode-supported reconciliation model and accepts Cloudflare structured `response` objects. If reconciliation still fails, it falls back to a conservative merge instead of failing the whole analysis.
