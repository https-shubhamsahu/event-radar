# Mumbai Event Radar

Free, in-person tech events in Mumbai (AI, crypto, startups), pulled from Luma's public Discover feed every morning at 06:30 IST.

- **Page:** filter by this week, talks, food or multi-day; each event links to Luma and Google Calendar.
- **WhatsApp:** the green button opens WhatsApp with this week's digest written out. Pick your group and tap send.
- **Calendar:** `events.ics` is a calendar anyone can subscribe to (Google, Apple, Outlook). It refreshes on its own, so new events appear in subscribers' calendars. `feed.xml` is the same list as RSS.
- **Search:** every event carries schema.org `Event` markup so Google can show it in event results.
- **Sponsored spot:** add `{ "id": "evt-…", "until": "YYYY-MM-DD" }` to `pinned.json` to pin a paid event to the top with a "Sponsored" label until that date. Organisers ask by email (link at the bottom of the page).
- **WhatsApp Channel:** set the `WA_CHANNEL_URL` repo variable (or env) once the channel exists, and a Follow button appears.
- **Registering:** always on Luma, by you. Luma remembers your answers (company, LinkedIn, GitHub, X), so most forms are already filled after your first one.

## Staying on

GitHub turns off scheduled workflows after 60 days without repo activity. The `keepalive` job re-enables the daily workflow on every run, and if the repo has had no commits for 45 days it also commits a timestamp to `.keepalive`.

## Run locally

```bash
node build.mjs
```

Outputs `docs/index.html`, `docs/events.json`, `docs/digest.txt`, `docs/events.ics` and `docs/feed.xml`. Set `SITE_URL` to change the link in the digest.

## Tuning

Edit the constants at the top of `build.mjs`: radius (`RADIUS_KM`), how far ahead (`DAYS_AHEAD`), digest window (`DIGEST_DAYS`), categories, and the keyword lists for talks and food.
