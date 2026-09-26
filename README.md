Card Lab Cloudflare Worker v1.4.3

Fixes the repeated "front vision returned an unreadable response" failure.

Changes:
- Gemma 4 vision output no longer has to be valid JSON.
- Vision uses a simple KEY=VALUE format with a deterministic parser.
- If structured vision output is weak, a plain-text OCR fallback still feeds card clues to Tavily.
- Web identity reconciliation uses a Workers AI model that supports JSON mode.
- Condition/grade fields remain unavailable instead of being invented when the vision pass cannot support them.

Files:
- worker.js
- wrangler.jsonc
- README.md


### v1.4.3
- Switched image OCR/inspection to Cloudflare Moondream 3.1, an image-to-text model optimized for OCR and structured visual queries.
- Added condition sanity checks so malformed all-1 scores do not produce fake low grades.
