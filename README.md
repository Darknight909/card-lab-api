# Card Lab Cloudflare Worker v4.0.0

## Major changes
Card Lab 4.0 is an optimization release rather than a narrow patch.

### Identity / parallel verification
- Physical-card OCR remains the first source for card-number candidates.
- Trusted sources establish exact year, set, subject, and card number.
- Parallel/variation is now a separate evidence gate.
- Numbered parallels are accepted only when detected serial-number evidence maps uniquely to a documented parallel denominator.
- Conflicting parallels fail closed instead of being guessed.
- Per-field confidence and an evidence graph are returned with each analysis.
- Matching reference-image URLs are retained for future card-template comparison.

### Condition
- Google Gemma 4 vision is now the primary visible-condition model.
- Moondream 3.1 is used only as a targeted fallback/consensus pass when the primary result is incomplete, low-confidence, or defect-sensitive.
- When both models run, Card Lab keeps the more conservative supported score and withholds categories with major disagreement.
- Photo-quality information from the phone participates in deterministic condition-confidence calibration.
- Condition model path and stage timing are exposed in diagnostics.

### Market
- Official eBay Browse API remains isolated behind `POST /market`.
- Asking-price statistics now use listing price + stated shipping where available.
- A trimmed raw-card value and credible low/high range reduce outlier distortion.
- Market support quality and sample size are returned with the value.

### Regression protection
- New authenticated `GET /selftest` runs deterministic regression checks for:
  - valid card-code acceptance
  - product/URL-slug rejection
  - serial-to-parallel resolution
  - fail-closed parallel conflicts
  - outlier-resistant market value
  - conservative condition consensus

## Cloudflare configuration
Binding / variables:
- Workers AI binding: `AI`
- `ALLOWED_ORIGIN=https://darknight909.github.io`
- `EBAY_ENV=sandbox` during the current eBay Sandbox phase

Secrets:
- `CARDLAB_API_KEY`
- `GOOGLE_VISION_API_KEY`
- `TAVILY_API_KEY`
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`

## Endpoints
- `GET /health`
- `GET /selftest` (requires Card Lab bearer key)
- `POST /analyze`
- `POST /market`

## Deploy
Replace these three files in the existing `card-lab-api` GitHub repository and commit:
- `worker.js`
- `wrangler.jsonc`
- `README.md`

After deployment, Card Lab → Settings → Test connection should report API `v4.0.0`.
Then use Settings → Diagnostic mode → Run regression self-test. All tests should pass before analyzing cards.

When eBay Production Browse access is approved, change `EBAY_ENV` to `production` and replace the eBay Sandbox secrets with the Production App ID / Cert ID.
