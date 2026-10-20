# Mumbai Event Radar

Free, in-person tech events in Mumbai (AI, crypto, startups), pulled from Luma's public Discover feed every morning at 06:30 IST.

- **Page:** filter by this week, talks, food or multi-day; each event links to Luma and Google Calendar.
- **WhatsApp:** the green button opens WhatsApp with this week's digest written out. Pick your group and tap send.
- **Registering:** always on Luma, by you. Luma remembers your answers (company, LinkedIn, GitHub, X), so most forms are already filled after your first one.

## Staying on

GitHub turns off scheduled workflows after 60 days without repo activity. The `keepalive` job re-enables the daily workflow on every run, and if the repo has had no commits for 45 days it also commits a timestamp to `.keepalive`.

## Run locally

```bash
node build.mjs
```

Outputs `docs/index.html`, `docs/events.json` and `docs/digest.txt`. Set `SITE_URL` to change the link in the digest.

## Tuning

Edit the constants at the top of `build.mjs`: radius (`RADIUS_KM`), how far ahead (`DAYS_AHEAD`), digest window (`DIGEST_DAYS`), categories, and the keyword lists for talks and food.
