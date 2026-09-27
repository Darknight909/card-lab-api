# Card Lab Cloudflare Worker v7.0.0

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

## v6.0.0 optimization pass
- Condition models now classify severity categories; Card Lab converts those categories to grading scores deterministically.
- A second vision model is used only when the first result is uncertain, damaged, incomplete, or disputed.
- Core identity verification is separated from parallel/variant verification. An unresolved parallel can block market value without unnecessarily blocking pre-grading of a verified core card.
- Exact-card source lookup explicitly probes independent checklist/reference domains when a broad search returns only an aggregator.
- Local centering remains first choice. A dedicated independent geometry pass can rescue centering only when local geometry fails and confidence is high.
- Market valuation remains fail-closed when the variant is unresolved.

## v7.0.0 verified-source-first release
- Final identity fields come from trusted online sources; OCR and visual-web evidence are lookup clues only.
- Short card-number prefixes can no longer verify longer unrelated card numbers.
- Trusted-source results must match the full card number and subject; conflicting results are negative evidence.
- A longer physical/source-proven card number cannot be silently shortened later.
- Field provenance and source contradictions are retained in the evidence graph.
- Reference images are accepted only from exact-card, full-match, established-source paths.
- Centering cannot be rescued by a single vision guess without a verified exact-card reference template.
- Condition uses Moondream categorical inspection first, targeted retries only for missing fields, and Gemma arbitration only when needed.
