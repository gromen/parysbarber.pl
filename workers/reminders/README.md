# parysbarber-reminders

Standalone Cloudflare Worker (cron-only, no `fetch` traffic) that sends push
reminders before appointments:

- **Client, 30 min before**: service, time, cancel link (`kind = 'client_30'`).
- **Barber, 15 min before**: client name, phone, time, service, to every barber
  subscription (`kind = 'barber_15'`).

It runs every minute (`* * * * *`) and shares the same D1 database as the main
Astro app (`parysbarber-bookings`) via its own `[[d1_databases]]` binding in
`wrangler.toml` — **its `database_id` must stay in sync with the root
`wrangler.toml`**. See `zakres-prac.md` (root) sections 3 and 6 for the
background on why this lives in a separate Worker.

## Secrets

Set these once per environment (never commit real values):

```
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT
```

## Local testing

```
npm install
npm run dev   # wrangler dev --test-scheduled
```

Then, in another terminal, trigger the cron manually:

```
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

(This is the current `wrangler dev --test-scheduled` mechanism — check
`wrangler dev --help` / Cloudflare's Workers docs if this stops working after
a wrangler upgrade.)

## Deploy

```
npm run deploy
```
