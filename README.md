# Card Lab Cloudflare Worker v5.0.0

Card Lab API 5.0 is a stage-isolated optimization release. It preserves the v4 evidence-gated identity and market architecture while adding reference-assisted analysis, targeted retries, and stronger fail-closed validation.

## Major changes

### Identity / parallel / serial
- Google OCR/Web Detection can receive normalized identity copies while condition models receive the original analysis crops.
- A local verified-card fingerprint may be supplied as a search hint, but it never bypasses trusted online source verification.
- Source hierarchy and per-field evidence graph remain authoritative.
- If trusted exact-card sources document numbered parallels but OCR misses the serial number, a targeted back-photo serial verifier runs.
- A serial denominator must map uniquely to a documented parallel before a numbered parallel is accepted.
- High-confidence visual parallel arbitration is allowed only for documented unnumbered variants; numbered parallels still require serial evidence.

### Condition
- Internally impossible model results such as 1/1/1/1 with no visible defect evidence are rejected.
- Sub-7 scores require explicit visible supporting evidence.
- Gemma remains primary; Moondream is a targeted consensus pass.
- A third arbitration pass runs only for disputed/missing fields.
- `POST /condition` retries condition alone without rerunning identity or market.
- A verified online reference image may be converted into a design template to prevent intentional artwork from being mistaken for damage.

### Centering
- Local device geometry remains primary.
- When local centering is unreliable/extreme and a verified reference template shows a measurable frame, the Worker can perform a targeted reference-assisted centering check.
- Borderless/unmeasurable designs fail closed.

### Efficiency
- `/analyze` accepts a validated condition-stage lock so Re-identify can reuse reliable condition results.
- Diagnostics report which stages were reused, whether local trusted hints were used, reference-template use, and per-stage timing.
- Reference/template work only runs when the condition or centering evidence actually needs it.

### Market
- Official eBay Browse API remains isolated behind `POST /market`.
- Keyword search now automatically widens from exact to safe broader queries only when needed.
- Strict post-filtering still requires identity agreement.
- Raw value remains outlier-resistant and now exposes support/spread metadata.

### Regression self-test
`GET /selftest` now covers:
- card-code acceptance/rejection
- numbered-parallel serial mapping
- fail-closed parallel conflicts
- outlier-resistant valuation
- conservative condition consensus
- rejection of catastrophic placeholder condition output
- local fingerprint hints as hints rather than verdicts
- adaptive market-query generation

## Cloudflare configuration
Bindings / variables:
- Workers AI binding: `AI`
- `ALLOWED_ORIGIN=https://darknight909.github.io`
- `EBAY_ENV=sandbox` until eBay Production Browse access is approved

Secrets:
- `CARDLAB_API_KEY`
- `GOOGLE_VISION_API_KEY`
- `TAVILY_API_KEY`
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`

## Endpoints
- `GET /health`
- `GET /selftest`
- `POST /analyze`
- `POST /condition`
- `POST /market`

## Deploy
Replace these three files in the existing `card-lab-api` GitHub repository and commit:
- `worker.js`
- `wrangler.jsonc`
- `README.md`

After deployment, Card Lab → Settings → Test connection should report API `v5.0.0`.
