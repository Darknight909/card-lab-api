# Card Lab Cloudflare Worker v2.0.0

## Architecture
- Google Cloud Vision Web Detection is the primary visual identity source.
- Google Cloud Vision Text Detection reads front/back text and exact card-code clues.
- If the front produces weak visual-web evidence, the Worker performs one fallback Web Detection pass on the back.
- Tavily independently verifies identity clues/checklist evidence using text searches only.
- Cloudflare Workers AI Moondream 3.1 inspects visible physical condition; it is no longer responsible for card identity or centering.
- A Cloudflare text model reconciles identity evidence conservatively.
- eBay Browse API is optional if `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET` are later configured; otherwise Tavily-backed current eBay web results are used.
- The Worker does not persist images or collection records.

## Required configuration
Bindings / variables:
- Workers AI binding: `AI`
- `ALLOWED_ORIGIN=https://darknight909.github.io`

Secrets:
- `CARDLAB_API_KEY`
- `GOOGLE_VISION_API_KEY`
- `TAVILY_API_KEY` (recommended for independent verification/current-listing fallback)

Optional secrets:
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`

## Files
- `worker.js`
- `wrangler.jsonc`
- `README.md`

## Deploy
Replace these three files in the existing `card-lab-api` GitHub repository and commit. The existing Cloudflare Git deployment should deploy automatically.

After deployment, Card Lab → Settings → Test connection should report API v2.0.0 and Google Vision ready.
