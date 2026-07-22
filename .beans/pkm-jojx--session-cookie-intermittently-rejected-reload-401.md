---
# pkm-jojx
title: 'Session cookie intermittently rejected: reload -> 401 -> /login bounce on all clients'
status: scrapped
type: bug
priority: normal
created_at: 2026-07-22T15:09:15Z
updated_at: 2026-07-22T15:12:42Z
---

Pre-existing (Arthur confirms it predates the 2026-07-22 deploys). Server log evidence 2026-07-22 (~/.config/pkm/logs/server.out.log, no timestamps): all three clients (100.127.205.66, 100.104.173.117, 100.113.95.109) repeatedly show the cycle POST /api/login 200 -> API calls 200 -> later GET / (reload) -> GET /api/sidebar + /api/journal 401 -> redirect to /login; 8x GET /login and 4x POST /api/login from one device in one tail-800 window. Cookie is set with max_age 1 year (auth.py COOKIE_NAME pkm_session) and verify_session allows YEAR_MS, so expiry alone should not explain it. Candidate causes to investigate: separate cookie jars (Safari tab vs installed PWA standalone) so one context never logged in; cookie_secure/samesite behaviour over Tailscale HTTP; something clearing cookies on reload. Each 401 bounces the user to /login and resets the journal view, which amplified the daily-notes-only-shows-today complaint (pkm-03x6/pkm-wstt). Investigate before changing auth code.

## Reasons for Scrapping

Not a bug: Arthur confirms the repeated 401 -> /login bounces in the 2026-07-22 logs were self-inflicted — cookies were being cleared regularly during sync testing that day, hence the multiple logins. Auth code behaves correctly.
