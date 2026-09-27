# Card Lab Cloudflare Worker v3.0.2

## What changed from v3.0.1
This is a stabilization release. It preserves the v3 market/identity-lock architecture and fixes three failure modes found by the Travis Hunter regression card.

- Card-number hypotheses now come from physical-card OCR first; generic Google/web URL slugs cannot seed a card number.
- Trusted-source recovery can still establish an exact card number when OCR misses it, but only from explicit card-number text in trusted source results/matching-page titles.
- Set and parallel are separated deterministically when a trusted source embeds a known parallel name in the set title; detected serial numbering is preserved with the variation.
- Condition inspection now requests structured JSON first, retries conservatively, accepts flexible JSON/KV output, and uses a text model only to normalize values already stated by the vision model.
- Condition failures are explicit rather than silently producing a 0%-confidence pseudo-result.
- eBay Sandbox/Production handling from v3.0.1 is unchanged.

## Prior v3 architecture preserved
 The Card Lab 3.0 identity, condition, market filtering, identity-lock, `/market`, and grading-support architecture is preserved.

- Added explicit eBay environment handling.
- Sandbox is the default and is explicitly set with `EBAY_ENV=sandbox` in `wrangler.jsonc`.
- Sandbox OAuth and Browse requests use `https://api.sandbox.ebay.com`.
- Production OAuth and Browse requests use `https://api.ebay.com` when `EBAY_ENV=production`.
- eBay OAuth token caching is keyed by environment + Client ID, preventing a token from one environment being reused for the other.
- `/health` now reports `ebayEnvironment` in addition to whether eBay credentials are configured.
- Market responses include the active eBay environment when the official Browse API is used.

### Identity
- Google Cloud Vision OCR/Web Detection extracts visual/text clues.
- Tavily searches trusted card sources/checklists.
- Deterministic verification gates decide whether identity is `verified`, `probable`, or `unverified`.
- Saved verified identity can be sent as `identityLock`, so normal re-analysis skips repeat identification.

### Condition / centering / grading
- Cloudflare Workers AI Moondream 3.1 inspects visible physical condition.
- The frontend measures centering locally and cross-checks it against vision evidence.
- Final PSA/BGS/CGC/SGC estimates are calculated in the frontend and withheld when evidence is insufficient.

### Market
- `POST /market` refreshes market data without re-running identity, condition, centering, or grading.
- Official eBay Browse API uses keyword + image matching when eBay credentials are configured.
- Results are filtered against the verified identity and separated into raw vs graded listings.
- Low / median / high asking-price summaries are calculated from accepted matches.
- Tavily remains a clearly labeled non-live fallback if official eBay data is unavailable.

## Cloudflare configuration
Binding / variables:
- Workers AI binding: `AI`
- `ALLOWED_ORIGIN=https://darknight909.github.io`
- `EBAY_ENV=sandbox` for the current Sandbox test phase

Secrets:
- `CARDLAB_API_KEY`
- `GOOGLE_VISION_API_KEY`
- `TAVILY_API_KEY`
- `EBAY_CLIENT_ID` = current eBay environment App ID / Client ID
- `EBAY_CLIENT_SECRET` = current eBay environment Cert ID / Client Secret

Do not store the eBay Client Secret in the frontend or commit it to GitHub.

## Endpoints
- `GET /health`
- `POST /analyze`
- `POST /market`

## Deploy
Replace these three files in the existing `card-lab-api` GitHub repository and commit:
- `worker.js`
- `wrangler.jsonc`
- `README.md`

Do not rename the Worker/repository configuration. The existing Cloudflare Git deployment should deploy to the already configured Card Lab Worker.

After deployment, Card Lab → Settings → Test connection should report:
- API `v3.0.1`
- eBay configured: true
- eBay environment: `sandbox`

When eBay Production Browse access is approved, change `EBAY_ENV` to `production` and replace the Cloudflare `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` secrets with the Production App ID / Cert ID. No Card Lab frontend rewrite should be required for that environment switch.
