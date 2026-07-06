# Current & Future — a private sector almanac

A personal-use sector tracker: 11 GICS sectors (via their SPDR ETFs), price
performance across 7 time periods, and three curated headlines per sector
(a sector giant, a piece of sectoral news, and an up-and-comer).

Built for two people. No login, no accounts, no server — just a static site.

## Running it locally

No build step. Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Hosting on GitHub (private repo + GitHub Pages)

1. Create a **private** GitHub repo and push this folder to it.
2. Repo Settings → Pages → set source to the `main` branch, root folder.
3. GitHub will give you a URL like `https://yourusername.github.io/reponame/`
   — note that **GitHub Pages sites are publicly reachable by URL even from a
   private repo**, unless you're on a GitHub Enterprise/organization plan with
   Pages access controls. Since your Marketaux key lives in the browser
   (localStorage) and never touches the repo itself, this is low-risk — but
   don't rely on the URL being a secret. If you want a harder guarantee of
   privacy, host it instead via `python3 -m http.server` on a machine only you
   and your dad access, or look into GitHub Pages with access restrictions
   (Enterprise feature).
4. Send your dad the URL. He opens Settings (⚙) once and pastes in his own
   free Marketaux key (or you can just tell him yours — it's a free-tier key
   with no billing risk).

## Setting up news

1. Go to [marketaux.com](https://www.marketaux.com), sign up free (no card).
2. Copy your API token.
3. In the app, click the ⚙ icon top-right, paste the key, click "Save key."
4. News refreshes once per calendar day automatically and caches in your
   browser's localStorage — click "Refresh news" to force an update sooner
   (this spends more of your daily 100-request quota, so don't do it
   compulsively).

### Optional: GNews fallback

If Marketaux fails entirely for a sector (not just returns zero results —
a genuine API/network failure), the app can fall back to
[GNews](https://gnews.io) instead of showing an error. GNews is confirmed to
support direct browser requests (no CORS proxy needed), which makes it a
solid backup, though it can't tag headlines to specific stock tickers the
way Marketaux does — so the "big name" category becomes an approximate
company-name search rather than precise ticker matching.

To enable it: sign up free at gnews.io (no card, 100 requests/day), paste
the key into the third Settings box, click "Save key." If you never add a
key here, the app works exactly as before — this is purely an optional
safety net. When a card is showing GNews-sourced data, you'll see a small
"via GNews (Marketaux unavailable)" note so it's never silently substituted.

## Network timeouts

Every fetch in this app (Stooq, Twelve Data, Alpha Vantage, Marketaux,
GNews, all RSS/Atom feeds, both CORS proxies) goes through a shared
`fetchWithTimeout` helper with an 8-second cutoff. Plain browser `fetch()`
has no timeout of its own — if a server or proxy hangs without ever
responding (not an error, just silence), the promise waits forever. Since
sectors are processed one at a time, a single stuck request used to freeze
the entire "Refresh news" button permanently. Now every call fails fast and
moves on to the next fallback tier instead.

## Sector news architecture (dedicated feeds + global pool first)

Each sector's 🌱/📰/🏢 rows now search, in order:

1. **That sector's own dedicated trade press** (2 feeds — e.g. TechCrunch +
   Ars Technica for Technology, Fierce Biotech + Fierce Healthcare for
   Health Care), defined per sector in `sectors.js`'s `dedicatedFeeds` field.
2. **The shared 🌍 global/national pool** (Chatham House, NYT Business, WSJ
   Business, etc. — the same 11 sources already fetched once per refresh for
   the 🌍 row). This costs zero extra network calls since that pool is
   already in memory — a story from WSJ Business, say, can easily be a
   perfect match for a specific sector even though WSJ isn't dedicated to it.
3. **Marketaux**, only for whichever categories both of the above left empty.
4. **GNews**, only if Marketaux also fails outright.

This is deterministic and mostly free — no quota, no cross-sector keyword
mismatches (the old shared-pool-only approach could match a story like a
celebrity wedding to both Financials and Communication Services just because
both sectors' keyword lists happened to overlap with the article's text).
Marketaux and GNews are now genuinely last-resort, which meaningfully
reduces dependence on both services' daily quotas.

**Transparency**: every sector card shows exactly which dedicated sources
back it, right under the sector name. Where a source covers more than one
sector (Utility Dive covers both Energy and Utilities), that's called out
explicitly rather than left implicit. If a sector's dedicated feeds are
genuinely unreachable (network/CORS failure, not just "nothing matched
today"), a red warning line says so directly on the card — no need to open
dev tools to tell the two situations apart.

**Atom feed support**: some dedicated sources (The Register) publish Atom,
not RSS — structurally different XML. The feed parser now auto-detects and
handles both formats.

To add or adjust a sector's dedicated feeds, edit the `dedicatedFeeds` array
on that sector in `sectors.js` — same `{ name, url }` shape as the global
feeds.

## Global and national news headlines

Each sector card also shows a 🌍 "global and national news" line, pulled once
a day from six public RSS feeds — no login or membership needed for any of
them, and chosen to span a range of institutional perspectives rather than
lean one direction:

- **Chatham House** — international affairs / geopolitics (UK-based, largely institutional/centrist)
- **Foreign Affairs (Council on Foreign Relations)** — US foreign policy, centrist-establishment
- **American Enterprise Institute (AEI)** — US public policy research (generally described as center-right)
- **NPR Business** — national economic news
- **New York Times Business** — national/business news
- **Wall Street Journal Business** — national/business news (headlines and summaries only — full articles are paywalled, which is fine since you said clicking through to a paywall is OK)
- **WashingtonWise (Charles Schwab)** — Mike Townsend's podcast on how Washington policy affects markets; episodes come out roughly biweekly rather than daily, so this one will often show the same episode for a stretch rather than refresh constantly
- **Fox Business Markets** — national market news, right-of-center institutionally, official feed
- **Farnam Street** — Shane Parrish's blog built around Charlie Munger's "latticework of mental models"; more evergreen investing-philosophy content than daily news, so like WashingtonWise it won't refresh as often as the pure news feeds
- **Utility Dive** — dedicated trade press for the utilities sector (grid, regulation, generation, storage)
- **HousingWire** — dedicated trade press for real estate/mortgage finance

These lean labels are rough, commonly-used descriptions, not precise
measurements. All six are combined into one pool, then matched to sectors by
simple keyword overlap with each sector's `sectorKeywords`, rotating which
source gets priority per sector so no single feed dominates every match. This
costs nothing against your Marketaux quota since it's a separate set of feeds
fetched once per refresh, not per sector.

Because RSS feeds essentially never send browser-CORS headers, this goes
through `api.allorigins.win` (a free, read-only public proxy commonly used for
exactly this) as a fallback if the direct fetch fails. It's only ever handling
public headline text — nothing private, no keys, no login — so the privacy
exposure is minimal, but it is a third party in the request path worth knowing
about. To add or swap feeds later, just edit the `GLOBAL_NATIONAL_FEEDS` array
in `app.js`.

## Price data

Comes from [Stooq](https://stooq.com) first, which needs no API key. If
Stooq's CORS policy blocks browser requests (this can happen without notice
since it's an unofficial-for-this-use-case source), the app falls back
through two more tiers automatically:

1. **[Twelve Data](https://twelvedata.com)** (preferred fallback) — free tier
   gives 800 requests/day and real multi-year history, so YTD/1Y/3Y/5Y still
   work even when running on this fallback.
2. **[Alpha Vantage](https://www.alphavantage.co)** (last resort) — free tier
   is tighter (25 requests/day) and no longer provides full multi-year
   history on the free tier, so YTD/1Y/3Y/5Y will show "—" if the app has to
   fall all the way back to this one.

If all three fail, the sector row shows a clear error message rather than
failing silently.

## Editing sector composition

Open `sectors.js`. Each sector has:

- `bigNames` — hardcoded major holdings (used for the 🏢 headline)
- `sectorKeywords` — search terms for regulation/politics/tech news (📰)
- `upComerKeywords` — growth/innovation language for smaller, newer names (🌱)

These are just plain arrays — edit freely, no other code needs to change.

## Files

```
index.html      the page
styles.css      the almanac/ledger visual design
sectors.js      sector definitions (edit this to change what's tracked)
app.js          price fetching, gradient math, news fetching/caching
assets/         the otter masthead illustration
```
