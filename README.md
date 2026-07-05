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

## Global and national news headlines

Each sector card also shows a 🌍 "global and national news" line, pulled once
a day from four public RSS feeds — no login or membership needed for any of
them, and chosen to span a range of institutional perspectives rather than
lean one direction:

- **Chatham House** — international affairs / geopolitics (UK-based, largely institutional/centrist)
- **Brookings Institution** — US public policy research (generally described as center-left)
- **American Enterprise Institute (AEI)** — US public policy research (generally described as center-right)
- **NPR Business** — national economic news

These lean labels are rough, commonly-used descriptions, not precise
measurements — but this mix is deliberately broader than relying on any one
institution's framing. All four are combined into one pool, then matched to
sectors by simple keyword overlap with each sector's `sectorKeywords`. This
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

Comes from [Stooq](https://stooq.com), which needs no API key. If Stooq's
CORS policy ever blocks browser requests (this can change without notice
since it's an unofficial-for-this-use-case source), the sector row will show
an error message instead of silently failing. The next step in that case
would be swapping in Alpha Vantage (free key, 25 requests/day — plenty for
11 ETFs refreshed once a day) as a fallback data source in `app.js`'s
`fetchStooqHistory` function.

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
