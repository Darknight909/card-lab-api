# Card Lab Worker v1.2.4

Backend-only reliability update.

- Keeps the existing `AI` binding, `ALLOWED_ORIGIN`, and `CARDLAB_API_KEY` secret.
- Uses two parallel image AI calls (front + back) instead of adding a third serial identity read.
- Back-side prompt explicitly prioritizes card number, manufacturer, copyright line, and distinguishes stats years from release/copyright years.
- Preserves deterministic safeguards for known card-code/design clues such as `91TF-` + 35th Anniversary.

Upload these files to the existing `card-lab-api` GitHub repository. Cloudflare should redeploy automatically. No iPhone app reinstall is required.
