# Card Lab Worker v1.3.0

Hybrid card identification update.

## What changed
- Uses the existing front/back photo analysis to extract text clues and condition data.
- Sends only text clues/search terms (not card photos) to Tavily Search.
- Uses live web results/checklists to verify year, brand, set/insert, subject, and card number.
- Keeps card condition and pre-grading based on the photos only.
- Uses one basic Tavily search per card to conserve free credits.
- Falls back to the existing photo-only logic if Tavily is unavailable.

## Existing settings kept
- AI binding: `AI`
- Variable: `ALLOWED_ORIGIN`
- Secret: `CARDLAB_API_KEY`

## New required secret
- `TAVILY_API_KEY` (already configured in Cloudflare before deploying this version)

Upload these 3 files to the existing `card-lab-api` GitHub repository. Cloudflare should redeploy automatically. No iPhone frontend reinstall is required; Card Lab v1.4 can stay installed.
