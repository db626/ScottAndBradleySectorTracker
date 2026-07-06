// app.js
// Current & Future — sector tracker
//
// Data flow:
//   1. Price grid: pull daily history per ETF from Stooq (no key needed), compute
//      % change for each period against an explicit reference date, color each
//      cell on a diverging red->white->green scale computed per-column (so 1D moves
//      and 5Y moves are both visually meaningful, not squashed by one shared scale).
//   2. News: three Marketaux queries per sector per day (big name / sector change /
//      up-and-comer), cached in localStorage so you don't re-spend API credits
//      re-loading the page. A manual "Refresh news" button forces a re-fetch.

const STORAGE = {
  marketauxKey: "cf_marketaux_key",
  alphaVantageKey: "cf_alphavantage_key",
  twelveDataKey: "cf_twelvedata_key",
  gnewsKey: "cf_gnews_key",
  newsCache: "cf_news_cache_v1", // { "2026-07-04": { technology: {bigName:{...}, sector:{...}, upComer:{...}}, ... } }
  chathamCache: "cf_chatham_cache_v1" // { "2026-07-04": { technology: {title, link, pubDate}, ... } }
};

// Public RSS feeds — headlines only, no login needed for any of these.
// Combined into one pool, then keyword-matched to sectors just like before.
const GLOBAL_NATIONAL_FEEDS = [
  { name: "Chatham House", url: "https://www.chathamhouse.org/path/whatsnew.xml" },
  { name: "Foreign Affairs (CFR)", url: "https://www.foreignaffairs.com/rss.xml" },
  { name: "AEI", url: "https://www.aei.org/feed/" },
  { name: "NPR Business", url: "https://feeds.npr.org/1006/rss.xml" },
  { name: "NYT Business", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml" },
  { name: "WSJ Business", url: "https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness" },
  { name: "WashingtonWise (Schwab)", url: "https://feeds.pacific-content.com/washingtonwise-investor" },
  { name: "Fox Business Markets", url: "https://moxie.foxbusiness.com/google-publisher/markets.xml" },
  { name: "Farnam Street", url: "https://fs.blog/feed/" },
  { name: "Utility Dive", url: "https://www.utilitydive.com/feeds/news" },
  { name: "HousingWire", url: "https://www.housingwire.com/feed" }
];
// Two independent free CORS proxies, tried in sequence. Public proxies like
// these can get temporarily rate-limited or flaky under heavy use, so relying
// on just one meant a single bad moment looked like everything being broken.
const CORS_PROXIES = [
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?url="
];

async function fetchViaProxyChain(targetUrl) {
  let lastError = null;
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetchWithTimeout(proxy + encodeURIComponent(targetUrl));
      if (res.ok) return res;
      lastError = new Error(`Proxy responded with ${res.status}`);
    } catch (err) {
      lastError = err;
      console.warn(`Proxy failed (${proxy}):`, err.message);
    }
  }
  throw lastError || new Error("All proxies failed");
}

const todayStr = () => new Date().toISOString().slice(0, 10);

// ---------- PRICE DATA (Stooq) ----------

async function fetchStooqHistory(etf) {
  const url = `https://stooq.com/q/d/l/?s=${etf.toLowerCase()}.us&i=d`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Stooq request failed (${res.status})`);
  const text = await res.text();
  if (!text || text.startsWith("<") || text.toLowerCase().includes("exceeded")) {
    throw new Error("Stooq returned no usable data");
  }
  const lines = text.trim().split("\n");
  // Header: Date,Open,High,Low,Close,Volume
  const rows = lines.slice(1).map(line => {
    const [date, open, high, low, close, volume] = line.split(",");
    return { date, close: parseFloat(close) };
  }).filter(r => r.date && !isNaN(r.close));
  return rows; // ascending by date
}

function getAlphaVantageKey() {
  return localStorage.getItem(STORAGE.alphaVantageKey) || "";
}

function setAlphaVantageKey(key) {
  localStorage.setItem(STORAGE.alphaVantageKey, key.trim());
}

async function fetchAlphaVantageHistory(etf) {
  const key = getAlphaVantageKey();
  if (!key) throw new Error("no Alpha Vantage key set");
  // NOTE: outputsize=full (years of history) became a premium-only parameter on
  // Alpha Vantage's free tier at some point after this app was first built.
  // compact returns the most recent ~100 trading days — enough for 1D/1W/1M,
  // NOT enough for YTD/1Y/3Y/5Y, which will show "no data" via this fallback.
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${etf}&outputsize=compact&apikey=${key}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Alpha Vantage request failed (${res.status})`);
  const json = await res.json();
  if (json.Note) throw new Error("Alpha Vantage rate limit hit (25/day on free tier) — try again tomorrow");
  if (json.Information) throw new Error("Alpha Vantage: " + json.Information);
  const series = json["Time Series (Daily)"];
  if (!series) throw new Error("Alpha Vantage returned no time series data");
  const rows = Object.entries(series)
    .map(([date, values]) => ({ date, close: parseFloat(values["4. close"]) }))
    .filter(r => r.date && !isNaN(r.close))
    .sort((a, b) => a.date.localeCompare(b.date)); // ascending
  return rows;
}

function getTwelveDataKey() {
  return localStorage.getItem(STORAGE.twelveDataKey) || "";
}

function setTwelveDataKey(key) {
  localStorage.setItem(STORAGE.twelveDataKey, key.trim());
}

async function fetchTwelveDataHistory(etf) {
  const key = getTwelveDataKey();
  if (!key) throw new Error("no Twelve Data key set");
  // Free tier allows outputsize up to 5000 — comfortably covers 5 years of
  // daily bars (~1260 trading days) without hitting a "premium only" wall
  // the way Alpha Vantage's full-history option did.
  const url = `https://api.twelvedata.com/time_series?symbol=${etf}&interval=1day&outputsize=1500&apikey=${key}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Twelve Data request failed (${res.status})`);
  const json = await res.json();
  if (json.status === "error") throw new Error("Twelve Data: " + (json.message || "unknown error"));
  const values = json.values;
  if (!values || !values.length) throw new Error("Twelve Data returned no time series data");
  const rows = values
    .map(v => ({ date: v.datetime, close: parseFloat(v.close) }))
    .filter(r => r.date && !isNaN(r.close))
    .sort((a, b) => a.date.localeCompare(b.date)); // Twelve Data returns newest-first; flip to ascending
  return rows;
}

// Tries Stooq first (no key needed), then Twelve Data (much better free daily
// quota and real historical depth), then Alpha Vantage as a last resort
// (tightest quota, and its free tier no longer allows full history).
async function fetchHistory(etf) {
  try {
    const rows = await fetchStooqHistory(etf);
    return { rows, source: "Stooq" };
  } catch (stooqErr) {
    console.warn(`Stooq failed for ${etf}, trying Twelve Data fallback:`, stooqErr.message);
    if (getTwelveDataKey()) {
      await sleep(1500); // space out the fallback attempt, not just between sectors
      try {
        const rows = await fetchTwelveDataHistory(etf);
        return { rows, source: "Twelve Data" };
      } catch (tdErr) {
        console.warn(`Twelve Data failed for ${etf}, trying Alpha Vantage fallback:`, tdErr.message);
      }
    }
    if (!getAlphaVantageKey()) {
      throw new Error("Stooq unreachable (likely CORS) — add a Twelve Data or Alpha Vantage key in Settings to use a fallback");
    }
    await sleep(1500); // space out this attempt too — Alpha Vantage's limit is especially tight
    const rows = await fetchAlphaVantageHistory(etf);
    return { rows, source: "Alpha Vantage" };
  }
}

function closeOnOrBefore(history, targetDate) {
  // history is ascending by date; find the latest entry with date <= targetDate
  let result = null;
  for (const row of history) {
    if (row.date <= targetDate) result = row;
    else break;
  }
  return result;
}

function isoDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function isoDateNYearsAgo(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

function computeChangesForHistory(history) {
  if (!history.length) return null;
  const latest = history[history.length - 1];
  const results = {};

  // Trading-day-based periods: walk back N *entries* in the array, not N calendar days,
  // since the array only contains trading days already.
  const tradingDayPeriods = { "1D": 1, "1W": 5, "1M": 21 };
  for (const [id, n] of Object.entries(tradingDayPeriods)) {
    const idx = history.length - 1 - n;
    if (idx >= 0) {
      const ref = history[idx];
      results[id] = {
        pct: ((latest.close - ref.close) / ref.close) * 100,
        refDate: ref.date
      };
    } else {
      results[id] = null;
    }
  }

  // YTD: last close of the prior calendar year
  const currentYear = new Date().getFullYear();
  const priorYearEnd = `${currentYear - 1}-12-31`;
  const ytdRef = closeOnOrBefore(history, priorYearEnd);
  results["YTD"] = ytdRef ? {
    pct: ((latest.close - ytdRef.close) / ytdRef.close) * 100,
    refDate: ytdRef.date
  } : null;

  // Calendar-date lookback periods
  const yearPeriods = { "1Y": 1, "3Y": 3, "5Y": 5 };
  for (const [id, yrs] of Object.entries(yearPeriods)) {
    const targetDate = isoDateNYearsAgo(yrs);
    const ref = closeOnOrBefore(history, targetDate);
    results[id] = ref ? {
      pct: ((latest.close - ref.close) / ref.close) * 100,
      refDate: ref.date
    } : null;
  }

  return { latest, results };
}

// ---------- COLOR GRADIENT ----------

// Diverging scale, computed per column (per period) across whatever sectors loaded
// successfully, anchored at 0. Returns a CSS color string.
// Magnitude thresholds per period, based on rough real-world benchmarks for
// each timeframe (a 5% weekly move is a big deal; a 5% monthly move is not).
// Each tier's "max" is the upper bound of |pct| for that label to apply.
const MAGNITUDE_THRESHOLDS = {
  "1D": [{ max: 0.5, label: "quiet" }, { max: 1.5, label: "active" }, { max: 3, label: "big move" }, { max: Infinity, label: "major move" }],
  "1W": [{ max: 2, label: "quiet" }, { max: 4, label: "active" }, { max: 7, label: "big move" }, { max: Infinity, label: "major move" }],
  "1M": [{ max: 4, label: "quiet" }, { max: 7, label: "active" }, { max: 12, label: "big move" }, { max: Infinity, label: "major move" }]
};

function classifyMagnitude(pct, period) {
  const tiers = MAGNITUDE_THRESHOLDS[period] || MAGNITUDE_THRESHOLDS["1D"];
  const abs = Math.abs(pct);
  return tiers.find(t => abs <= t.max)?.label || tiers[tiers.length - 1].label;
}

function tickerItemHTML(sectorName, period, pct) {
  const sign = pct >= 0 ? "+" : "";
  const direction = pct >= 0 ? "ticker-up" : "ticker-down";
  const label = classifyMagnitude(pct, period);
  const flagged = label === "big move" || label === "major move";
  const labelHTML = flagged ? `<span class="ticker-flag">${label} —</span> ` : "";
  const periodNote = period === "1D" ? "" : ` (${period})`;
  return `<span class="ticker-item">${labelHTML}${sectorName}${periodNote} <span class="${direction}">${sign}${pct.toFixed(1)}%</span></span>`;
}

function renderTicker() {
  const wrap = document.getElementById("ticker-wrap");
  const track = document.getElementById("ticker-track");
  const items = [];

  for (const sector of SECTORS) {
    const data = priceDataBySector[sector.id];
    if (!data || data.error) continue;

    // Always show the daily number — this is the ticker's steady heartbeat.
    if (data.results["1D"]) {
      items.push(tickerItemHTML(sector.name, "1D", data.results["1D"].pct));
    }
    // Only call out 1W/1M specifically when they cross into "big" or "major"
    // territory — otherwise every sector would show 3 near-identical numbers
    // and the flagged ones wouldn't stand out.
    for (const period of ["1W", "1M"]) {
      const cell = data.results[period];
      if (!cell) continue;
      const label = classifyMagnitude(cell.pct, period);
      if (label === "big move" || label === "major move") {
        items.push(tickerItemHTML(sector.name, period, cell.pct));
      }
    }
  }

  if (!items.length) {
    wrap.hidden = true;
    return;
  }

  // Duplicate the sequence once so the CSS animation (which translates -50%)
  // loops seamlessly instead of showing a visible jump-cut at the end.
  track.innerHTML = items.join("") + items.join("");
  wrap.hidden = false;
}

function formatDate(isoDate) {
  // "2026-07-01" -> "01 JUL '26" — the year matters here since 1Y/3Y/5Y
  // reference dates would otherwise look confusingly similar to recent ones
  const [year, month, day] = isoDate.split("-");
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return `${day} ${months[parseInt(month, 10) - 1]} '${year.slice(2)}`;
}

function colorForValue(pct, columnMax) {
  if (pct === null || pct === undefined || isNaN(pct)) return "var(--cell-neutral)";
  const magnitude = Math.min(Math.abs(pct) / (columnMax || 1), 1);
  if (pct >= 0) {
    // white -> ink-green
    return `rgba(46, 107, 68, ${0.08 + magnitude * 0.85})`;
  } else {
    // white -> brick-red
    return `rgba(163, 61, 44, ${0.08 + magnitude * 0.85})`;
  }
}

function textColorForMagnitude(pct, columnMax) {
  const magnitude = Math.min(Math.abs(pct) / (columnMax || 1), 1);
  return magnitude > 0.45 ? "#fff" : "var(--ink)";
}

// ---------- PRICE GRID RENDER ----------

let priceDataBySector = {}; // id -> { latest, results } | { error: true }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Plain fetch() has no timeout — if a server or proxy hangs without ever
// responding (not even an error), the promise waits forever. Since sectors
// are processed one at a time, a single stuck request freezes everything
// after it, which is exactly what caused "Refresh news" to get permanently
// stuck. Every network call in this app now goes through this instead.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadAllPrices() {
  const btn = document.getElementById("refresh-prices-btn");
  const originalLabel = btn.textContent;
  btn.textContent = "⏳ Refreshing…";
  btn.disabled = true;

  const progressTrack = document.getElementById("prices-progress-track");
  const progressFill = document.getElementById("prices-progress-fill");
  progressTrack.hidden = false;
  progressFill.style.width = "0%";

  const grid = document.getElementById("grid-body");
  grid.querySelectorAll(".sector-row .status").forEach(el => el.textContent = "loading…");

  // Sequential, not Promise.all — firing 11 requests at once trips rate limits.
  // Real delays now happen before every individual API attempt (see fetchHistory),
  // not just between sectors, so a sector that cascades through all 3 fallback
  // tiers is properly spaced out rather than bursting.
  for (let i = 0; i < SECTORS.length; i++) {
    const sector = SECTORS[i];
    try {
      const { rows, source } = await fetchHistory(sector.etf);
      priceDataBySector[sector.id] = computeChangesForHistory(rows);
      priceDataBySector[sector.id].source = source;
    } catch (err) {
      console.error(`Price fetch failed for ${sector.etf}:`, err);
      priceDataBySector[sector.id] = { error: true, message: err.message };
    }
    renderGrid(); // update incrementally so you see rows fill in one by one
    progressFill.style.width = `${Math.round(((i + 1) / SECTORS.length) * 100)}%`;
    await sleep(2000); // slower top-to-bottom fill, comfortably under free-tier limits
  }

  progressTrack.hidden = true;
  btn.textContent = originalLabel;
  btn.disabled = false;
  renderTicker(); // built from the same priceDataBySector we just finished populating
}

const CATEGORY_INFO = {
  cyclical: { label: "Cyclical", description: "A stock category that tracks the economic cycle closely" },
  sensitive: { label: "Sensitive", description: "A stock category with some economic sensitivity, softened by pricing power or steady demand" },
  defensive: { label: "Defensive", description: "A stock category where demand holds up regardless of the cycle" }
};
const CATEGORY_ORDER = ["cyclical", "sensitive", "defensive"];

function renderGrid() {
  const tbody = document.getElementById("grid-body");
  tbody.innerHTML = "";

  // Compute per-column max |pct| for gradient scaling
  const columnMax = {};
  for (const period of PERIODS) {
    let max = 0;
    for (const sector of SECTORS) {
      const data = priceDataBySector[sector.id];
      const cell = data && !data.error ? data.results[period.id] : null;
      if (cell && Math.abs(cell.pct) > max) max = Math.abs(cell.pct);
    }
    columnMax[period.id] = max || 1;
  }

  for (const category of CATEGORY_ORDER) {
    const sectorsInGroup = SECTORS.filter(s => s.category === category);
    if (!sectorsInGroup.length) continue;

    const headerRow = document.createElement("tr");
    headerRow.className = `category-header-row category-${category}`;
    const headerCell = document.createElement("td");
    headerCell.colSpan = PERIODS.length + 1;
    headerCell.innerHTML = `<div class="category-label">${CATEGORY_INFO[category].label}</div><div class="category-description">${CATEGORY_INFO[category].description}</div>`;
    headerRow.appendChild(headerCell);
    tbody.appendChild(headerRow);

    for (const sector of sectorsInGroup) {
      const row = document.createElement("tr");
      row.className = "sector-row";

      const nameCell = document.createElement("td");
      nameCell.className = "sector-name-cell";
      const data = priceDataBySector[sector.id];
      const sourceTag = (data && !data.error && data.source && data.source !== "Stooq")
        ? `<span class="source-tag">via ${data.source}</span>`
        : "";
      nameCell.innerHTML = `<span class="sector-name">${sector.name}</span><span class="sector-etf">${sector.etf}</span>${sourceTag}`;
      row.appendChild(nameCell);

      if (!data || data.error) {
        const errCell = document.createElement("td");
        errCell.colSpan = PERIODS.length;
        errCell.className = "status error-cell";
        errCell.textContent = data && data.message ? `Couldn't load price data (${data.message})` : "loading…";
        row.appendChild(errCell);
      } else {
        for (const period of PERIODS) {
          const cell = document.createElement("td");
          cell.className = "price-cell";
          const val = data.results[period.id];
          if (!val) {
            cell.textContent = "—";
            cell.classList.add("no-data");
          } else {
            const bg = colorForValue(val.pct, columnMax[period.id]);
            const fg = textColorForMagnitude(val.pct, columnMax[period.id]);
            cell.style.backgroundColor = bg;
            cell.style.color = fg;
            const sign = val.pct >= 0 ? "+" : "";
            cell.innerHTML = `<div class="pct">${sign}${val.pct.toFixed(1)}%</div><div class="ref-date">since ${formatDate(val.refDate)}</div>`;
          }
          row.appendChild(cell);
        }
      }

      tbody.appendChild(row);
    }
  }
}

// ---------- NEWS (Marketaux) ----------

function getMarketauxKey() {
  return localStorage.getItem(STORAGE.marketauxKey) || "";
}

function setMarketauxKey(key) {
  localStorage.setItem(STORAGE.marketauxKey, key.trim());
}

function loadNewsCache() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE.newsCache) || "{}");
  } catch {
    return {};
  }
}

function saveNewsCache(cache) {
  localStorage.setItem(STORAGE.newsCache, JSON.stringify(cache));
}

async function marketauxQuery(params) {
  const key = getMarketauxKey();
  if (!key) throw new Error("no API key set");
  const url = new URL("https://api.marketaux.com/v1/news/all");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("language", "en");
  url.searchParams.set("limit", "3");
  url.searchParams.set("api_token", key);

  // Try direct fetch first. If Marketaux blocks browser CORS (which earlier
  // testing suggested might be the case), fall back to the same read-only
  // public proxy used for the RSS feeds, rather than silently failing.
  try {
    const res = await fetchWithTimeout(url.toString());
    if (res.ok) {
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || "Marketaux error");
      return json.data || [];
    }
  } catch (directErr) {
    console.warn("Marketaux direct fetch failed, trying proxy:", directErr.message);
  }

  const proxied = await fetchViaProxyChain(url.toString());
  if (!proxied.ok) throw new Error(`Marketaux unreachable even via proxy (${proxied.status})`);
  const json = await proxied.json();
  if (json.error) throw new Error(json.error.message || "Marketaux error");
  return json.data || [];
}

function pickFirstHeadline(articles) {
  if (!articles || !articles.length) return null;
  const a = articles[0];
  return { title: a.title, url: a.url, source: a.source, published_at: a.published_at };
}

function getGNewsKey() {
  return localStorage.getItem(STORAGE.gnewsKey) || "";
}

function setGNewsKey(key) {
  localStorage.setItem(STORAGE.gnewsKey, key.trim());
}

// GNews is a simple headline API — no ticker/company tagging like Marketaux,
// just keyword search, but it's confirmed to support direct browser CORS
// (no proxy needed) which makes it a solid backup when Marketaux is down.
// GNews's parser may choke on punctuation inside company names (hyphens,
// ampersands — "Freeport-McMoRan", "Johnson & Johnson") and on overly long
// OR-chains. This strips risky characters and caps term count defensively,
// since GNews was consistently returning 400 Bad Request (not a quota
// error) rather than genuinely finding zero matches.
function sanitizeForGNews(terms, maxTerms = 3) {
  return terms
    .slice(0, maxTerms)
    .map(t => t.replace(/[-&]/g, " ").replace(/\s+/g, " ").trim())
    .join(" OR ");
}

async function gnewsQuery(query) {
  const key = getGNewsKey();
  if (!key) throw new Error("no GNews key set");
  const url = new URL("https://gnews.io/api/v4/search");
  url.searchParams.set("q", query);
  url.searchParams.set("lang", "en");
  url.searchParams.set("max", "3");
  url.searchParams.set("token", key);
  const res = await fetchWithTimeout(url.toString());
  if (!res.ok) throw new Error(`GNews request failed (${res.status})`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.join("; "));
  return (json.articles || []).map(a => ({
    title: a.title,
    url: a.url,
    source: a.source?.name,
    published_at: a.publishedAt
  }));
}

async function fetchSectorDedicatedNews(sector) {
  if (!sector.dedicatedFeeds || !sector.dedicatedFeeds.length) return null;
  return Promise.all(sector.dedicatedFeeds.map(async feed => {
    try {
      const xml = await fetchFeedXML(feed.url);
      return { name: feed.name, items: parseRSSItems(xml, feed.name), fetchFailed: false };
    } catch (err) {
      console.warn(`Dedicated feed failed (${feed.name}) for ${sector.name}:`, err.message);
      return { name: feed.name, items: [], fetchFailed: true, error: err.message };
    }
  }));
}

function pickFreshestFromGroups(groups) {
  const all = groups.flatMap(g => g.items).filter(i => i.pubDate);
  if (!all.length) return null;
  all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return all[0];
}

function pickKeywordMatchFromGroups(groups, keywords) {
  const terms = keywords.map(k => k.toLowerCase().split(" ")[0]);
  const all = groups.flatMap(g => g.items).filter(i => i.pubDate);
  all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return all.find(item => {
    const haystack = (item.title + " " + item.description).toLowerCase();
    return terms.some(term => haystack.includes(term));
  }) || null;
}

async function fetchNewsForSector(sector, globalGroups = null) {
  // Dedicated per-sector feeds are the primary source — deterministic, no
  // quota, no cross-sector keyword mismatches (e.g. a Taylor Swift story
  // wrongly matching both Financials and Communication Services, which
  // happened under the old shared-pool approach).
  const dedicatedGroups = await fetchSectorDedicatedNews(sector);
  let result = { bigName: null, sector: null, upComer: null, viaDedicated: [] };

  if (dedicatedGroups) {
    console.log(`[${sector.name}] dedicated feeds:`, dedicatedGroups.map(g => `${g.name}: ${g.fetchFailed ? "FETCH FAILED (" + g.error + ")" : g.items.length + " items"}`));
    result.sector = pickFreshestFromGroups(dedicatedGroups);
    result.bigName = pickKeywordMatchFromGroups(dedicatedGroups, sector.bigNameCompanies);
    result.upComer = pickKeywordMatchFromGroups(dedicatedGroups, sector.upComerKeywords);
    result.viaDedicated = dedicatedGroups.filter(g => g.items.length).map(g => g.name);
    // Distinguish "dedicated feeds are unreachable" (network/CORS failure)
    // from "dedicated feeds work fine but had nothing matching today" —
    // these look identical from the outside without this tracking, and that
    // ambiguity cost real diagnostic time tonight.
    if (dedicatedGroups.every(g => g.fetchFailed)) {
      result.dedicatedFeedsUnreachable = true;
      result.dedicatedFeedsError = dedicatedGroups[0]?.error;
    }
  }

  // Before ever touching Marketaux/GNews, also check the shared 11-source
  // global/national pool (already fetched once per refresh for the 🌍 row —
  // this costs zero extra network calls) for whichever categories the
  // sector's own 2 dedicated feeds didn't cover. A story from NYT Business
  // or WSJ Business, say, can easily be a perfect match for a specific
  // sector even though those feeds aren't dedicated to it.
  if (globalGroups) {
    const totalGlobalItems = globalGroups.reduce((sum, g) => sum + g.items.length, 0);
    console.log(`[${sector.name}] global pool has ${totalGlobalItems} items across ${globalGroups.length} feeds`);
    if (!result.sector) {
      result.sector = pickKeywordMatchFromGroups(globalGroups, sector.sectorKeywords);
      console.log(`[${sector.name}] sector-news search against global pool, terms:`, sector.sectorKeywords.map(k => k.split(" ")[0]), "-> match:", result.sector?.title || "none");
    }
    if (!result.bigName) {
      result.bigName = pickKeywordMatchFromGroups(globalGroups, sector.bigNameCompanies);
      console.log(`[${sector.name}] big-name search against global pool, terms:`, sector.bigNameCompanies.map(k => k.split(" ")[0]), "-> match:", result.bigName?.title || "none");
    }
    if (!result.upComer) {
      result.upComer = pickKeywordMatchFromGroups(globalGroups, sector.upComerKeywords);
      console.log(`[${sector.name}] up-comer search against global pool, terms:`, sector.upComerKeywords.map(k => k.split(" ")[0]), "-> match:", result.upComer?.title || "none");
    }
  } else {
    console.log(`[${sector.name}] globalGroups was null/undefined — the pool wasn't passed through at all`);
  }

  const stillMissing = !result.bigName || !result.sector || !result.upComer;
  if (!stillMissing) return result;

  // Fill in only the missing categories via Marketaux, then GNews if
  // Marketaux fails outright — same error-surfacing discipline as before.
  const runQuery = async (params) => {
    try {
      return { ok: true, articles: await marketauxQuery(params) };
    } catch (err) {
      console.error(`Marketaux query failed for ${sector.name}:`, err.message);
      return { ok: false, error: err.message, articles: [] };
    }
  };

  const needBigName = !result.bigName;
  const needSector = !result.sector;
  const needUpComer = !result.upComer;

  const [bigNameResult, sectorResult, upComerResult] = await Promise.all([
    needBigName ? runQuery({ symbols: sector.bigNames.join(",") }) : Promise.resolve({ ok: true, articles: [] }),
    needSector ? runQuery({ search: sector.sectorKeywords.join(" OR ") }) : Promise.resolve({ ok: true, articles: [] }),
    needUpComer ? runQuery({ search: sector.upComerKeywords.join(" OR "), symbols_exclude: sector.bigNames.join(",") }) : Promise.resolve({ ok: true, articles: [] })
  ]);

  if (needBigName && !bigNameResult.ok) result.bigNameError = bigNameResult.error;
  if (needSector && !sectorResult.ok) result.sectorError = sectorResult.error;
  if (needUpComer && !upComerResult.ok) result.upComerError = upComerResult.error;

  if (needBigName && bigNameResult.ok) result.bigName = pickFirstHeadline(bigNameResult.articles);
  if (needSector && sectorResult.ok) result.sector = pickFirstHeadline(sectorResult.articles);
  if (needUpComer && upComerResult.ok) result.upComer = pickFirstHeadline(upComerResult.articles);

  // If Marketaux failed outright for something still missing, try GNews
  const stillNeedGNews = (needBigName && !result.bigName) || (needSector && !result.sector) || (needUpComer && !result.upComer);
  if (stillNeedGNews && getGNewsKey()) {
    const runGNews = async (query) => {
      try {
        return { ok: true, articles: await gnewsQuery(query) };
      } catch (err) {
        console.error(`GNews query failed for ${sector.name}:`, err.message);
        return { ok: false, error: err.message, articles: [] };
      }
    };
    if (needBigName && !result.bigName) {
      const r = await runGNews(sanitizeForGNews(sector.bigNameCompanies));
      if (r.ok) { result.bigName = pickFirstHeadline(r.articles); result.viaFallback = "GNews"; }
    }
    if (needSector && !result.sector) {
      const r = await runGNews(sanitizeForGNews(sector.sectorKeywords));
      if (r.ok) { result.sector = pickFirstHeadline(r.articles); result.viaFallback = "GNews"; }
    }
    if (needUpComer && !result.upComer) {
      const r = await runGNews(sanitizeForGNews(sector.upComerKeywords));
      if (r.ok) { result.upComer = pickFirstHeadline(r.articles); result.viaFallback = "GNews"; }
    }
  }

  return result;
}

// ---------- GLOBAL & NATIONAL NEWS (public RSS feeds, no login) ----------

async function fetchFeedXML(feedUrl) {
  // Try direct fetch first — if a feed ever adds permissive CORS headers,
  // this just works with no proxy involved.
  try {
    const res = await fetchWithTimeout(feedUrl);
    if (res.ok) return await res.text();
  } catch {
    // fall through to proxy
  }
  const proxied = await fetchViaProxyChain(feedUrl);
  if (!proxied.ok) throw new Error(`Feed unreachable (${proxied.status}): ${feedUrl}`);
  return await proxied.text();
}

function parseRSSItems(xmlText, sourceName) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");

  // RSS uses <item>; Atom (e.g. The Register) uses <entry> with a different
  // internal structure — link is an <link href="..."> attribute, not text
  // content, and dates use <updated> instead of <pubDate>.
  const rssItems = Array.from(doc.querySelectorAll("item"));
  if (rssItems.length) {
    return rssItems.map(item => ({
      title: item.querySelector("title")?.textContent || "",
      link: item.querySelector("link")?.textContent || "",
      description: item.querySelector("description")?.textContent || "",
      pubDate: item.querySelector("pubDate")?.textContent || "",
      source: sourceName
    }));
  }

  const atomEntries = Array.from(doc.querySelectorAll("entry"));
  return atomEntries.map(entry => ({
    title: entry.querySelector("title")?.textContent || "",
    link: entry.querySelector("link")?.getAttribute("href") || "",
    description: entry.querySelector("summary")?.textContent || entry.querySelector("content")?.textContent || "",
    pubDate: entry.querySelector("updated")?.textContent || entry.querySelector("published")?.textContent || "",
    source: sourceName
  }));
}

async function fetchAllGlobalNationalItems() {
  // Keep grouped by source (not flattened) so matching can rotate fairly
  // between sources instead of always favoring whichever feed happens to
  // post most frequently or most recently.
  const groups = await Promise.all(
    GLOBAL_NATIONAL_FEEDS.map(async feed => {
      try {
        const xml = await fetchFeedXML(feed.url);
        return { name: feed.name, items: parseRSSItems(xml, feed.name) };
      } catch (err) {
        console.warn(`Feed failed (${feed.name}):`, err.message);
        return { name: feed.name, items: [] };
      }
    })
  );
  return groups; // [{ name, items: [...] }, ...]
}

// Match each sector to one item, rotating which source gets first priority
// per sector (sector index determines the starting point in the rotation) so
// a high-volume source doesn't quietly dominate every single sector's match.
function matchItemsToSectors(feedGroups) {
  const bySector = {};
  SECTORS.forEach((sector, sectorIndex) => {
    const terms = sector.sectorKeywords.map(k => k.toLowerCase());
    const rotation = [
      ...feedGroups.slice(sectorIndex % feedGroups.length),
      ...feedGroups.slice(0, sectorIndex % feedGroups.length)
    ];
    let match = null;
    for (const group of rotation) {
      match = group.items.find(item => {
        const haystack = (item.title + " " + item.description).toLowerCase();
        return terms.some(term => haystack.includes(term.split(" ")[0]));
      });
      if (match) break;
    }
    bySector[sector.id] = match || null;
  });
  return bySector;
}

function loadChathamCache() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE.chathamCache) || "{}");
  } catch {
    return {};
  }
}

function saveChathamCache(cache) {
  localStorage.setItem(STORAGE.chathamCache, JSON.stringify(cache));
}

// Returns the raw feed groups (not pre-matched to sectors) so the same fetch
// can be reused both for the 🌍 row AND as a supplementary search pool for
// 🌱/📰/🏢 — previously this 11-source pool sat unused for those 3 categories
// even though e.g. NYT Business or WSJ Business often carries stories that
// are a perfect match for a specific sector.
async function loadGlobalNationalGroups(forceRefresh = false) {
  const today = todayStr();
  const cache = loadChathamCache();
  if (!forceRefresh && cache[today]) return cache[today];

  try {
    const groups = await fetchAllGlobalNationalItems();
    saveChathamCache({ [today]: groups });
    return groups;
  } catch (err) {
    console.error("Global/national news feeds failed:", err);
    return null;
  }
}

async function loadAllNews(forceRefresh = false) {
  const btn = document.getElementById("refresh-news-btn");
  const originalLabel = btn.textContent;
  btn.textContent = "⏳ Refreshing…";
  btn.disabled = true;

  const progressTrack = document.getElementById("news-progress-track");
  const progressFill = document.getElementById("news-progress-fill");
  progressTrack.hidden = false;
  progressFill.style.width = "0%";

  try {
    const key = getMarketauxKey();
    const newsPanel = document.getElementById("news-panel");
    if (!key) {
      newsPanel.innerHTML = `<p class="news-empty">Add your free Marketaux API key in Settings to load news.</p>`;
      return;
    }

    const cache = loadNewsCache();
    const today = todayStr();
    const globalGroups = await loadGlobalNationalGroups(forceRefresh);
    const chathamBySector = globalGroups ? matchItemsToSectors(globalGroups) : null;

    if (!forceRefresh && cache[today]) {
      renderNews(cache[today], chathamBySector);
      return;
    }

    newsPanel.innerHTML = `<p class="news-empty">Loading news…</p>`;
    const todayData = {};
    for (let i = 0; i < SECTORS.length; i++) {
      const sector = SECTORS[i];
      try {
        todayData[sector.id] = await fetchNewsForSector(sector, globalGroups);
      } catch (err) {
        console.error(`News fetch failed for ${sector.name}:`, err);
        todayData[sector.id] = { error: err.message };
      }
      progressFill.style.width = `${Math.round(((i + 1) / SECTORS.length) * 100)}%`;
    }

    const newCache = { [today]: todayData };
    saveNewsCache(newCache);
    renderNews(todayData, chathamBySector);
  } finally {
    btn.textContent = originalLabel;
    btn.disabled = false;
    progressTrack.hidden = true;
  }
}

function headlineRow(icon, label, item) {
  if (!item) return `<div class="headline"><span class="headline-icon">${icon}</span><span class="headline-empty">No ${label.toLowerCase()} found today</span></div>`;
  const url = item.url || item.link;
  const rawDate = item.published_at || item.pubDate;
  const date = rawDate ? new Date(rawDate).toLocaleDateString() : "";
  const source = item.source || "";
  return `
    <div class="headline">
      <span class="headline-icon">${icon}</span>
      <a href="${url}" target="_blank" rel="noopener" class="headline-title">${item.title}</a>
      <span class="headline-meta">${source}${date ? " · " + date : ""}</span>
    </div>`;
}

function findSharedFeedNames() {
  const feedToSectors = {};
  for (const sector of SECTORS) {
    if (!sector.dedicatedFeeds) continue;
    for (const feed of sector.dedicatedFeeds) {
      if (!feedToSectors[feed.name]) feedToSectors[feed.name] = [];
      feedToSectors[feed.name].push(sector.name);
    }
  }
  const shared = {};
  for (const [name, sectors] of Object.entries(feedToSectors)) {
    if (sectors.length > 1) shared[name] = sectors;
  }
  return shared;
}

function renderNews(dataBySector, chathamBySector) {
  const newsPanel = document.getElementById("news-panel");
  newsPanel.innerHTML = "";
  const sharedFeeds = findSharedFeedNames();

  for (const sector of SECTORS) {
    const entry = dataBySector[sector.id];
    const chathamItem = chathamBySector ? chathamBySector[sector.id] : null;
    const card = document.createElement("div");
    card.className = "news-card";
    if (!entry || entry.error) {
      card.innerHTML = `<h3>${sector.name}</h3><p class="news-empty">${entry && entry.error ? entry.error : "No news loaded"}</p>`;
    } else {
      const sourceNames = sector.dedicatedFeeds
        ? sector.dedicatedFeeds.map(f => {
            if (sharedFeeds[f.name]) {
              const others = sharedFeeds[f.name].filter(s => s !== sector.name);
              return `${f.name} (also covers ${others.join(", ")})`;
            }
            return f.name;
          }).join(", ")
        : "";
      card.innerHTML = `
        <h3>${sector.name}</h3>
        ${sourceNames ? `<p class="sector-sources">Checks first: ${sourceNames} — plus everything in the Sources section above</p>` : ""}
        ${entry.dedicatedFeedsUnreachable ? `<p class="unreachable-note">⚠ dedicated feeds unreachable${entry.dedicatedFeedsError ? ` (${entry.dedicatedFeedsError})` : ""} — likely blocked by proxy/CORS, not just "no news today"</p>` : ""}
        ${entry.viaFallback ? `<p class="fallback-note">via ${entry.viaFallback} (dedicated feeds, the global/national pool, and Marketaux all had nothing for at least one category)</p>` : ""}
        ${headlineRow("🌱", "up-and-comer", entry.upComer)}
        ${headlineRow("📰", "sector news", entry.sector)}
        ${headlineRow("🏢", "big name", entry.bigName)}
        ${headlineRow("🌍", "global and national news", chathamItem)}
      `;
    }
    newsPanel.appendChild(card);
  }
}

// ---------- SETTINGS PANEL ----------

// Default keys, pre-filled so a new browser (e.g. your dad's) just needs to
// click "Save key" once rather than typing them in. NOTE: since this repo is
// public, these values are visible to anyone who looks at the source code —
// fine for free-tier keys with no billing risk, but don't put anything more
// sensitive here.
const DEFAULT_MARKETAUX_KEY = "kt7qHxWPmrzNCHikjEp2Gd4OOGoHmnKsXBh4QAq4";
const DEFAULT_ALPHAVANTAGE_KEY = "QJF4DPTOAMMEQ4FS";
const DEFAULT_TWELVEDATA_KEY = "9779392e115a4aa8ad4ebe7b02744ffe";
const DEFAULT_GNEWS_KEY = "e08daf51237ab4491e59380820885332";

function initSettings() {
  const input = document.getElementById("marketaux-key-input");
  input.value = getMarketauxKey() || DEFAULT_MARKETAUX_KEY;
  document.getElementById("save-key-btn").addEventListener("click", () => {
    setMarketauxKey(input.value);
    loadAllNews(true);
  });

  const avInput = document.getElementById("alphavantage-key-input");
  avInput.value = getAlphaVantageKey() || DEFAULT_ALPHAVANTAGE_KEY;
  document.getElementById("save-av-key-btn").addEventListener("click", () => {
    setAlphaVantageKey(avInput.value);
    loadAllPrices();
  });

  const tdInput = document.getElementById("twelvedata-key-input");
  tdInput.value = getTwelveDataKey() || DEFAULT_TWELVEDATA_KEY;
  document.getElementById("save-td-key-btn").addEventListener("click", () => {
    setTwelveDataKey(tdInput.value);
    loadAllPrices();
  });

  const gnewsInput = document.getElementById("gnews-key-input");
  gnewsInput.value = getGNewsKey() || DEFAULT_GNEWS_KEY;
  document.getElementById("save-gnews-key-btn").addEventListener("click", () => {
    setGNewsKey(gnewsInput.value);
    loadAllNews(true);
  });
}

// ---------- INIT ----------

document.addEventListener("DOMContentLoaded", () => {
  initSettings();
  loadAllPrices();
  loadAllNews();

  document.getElementById("refresh-prices-btn").addEventListener("click", loadAllPrices);
  document.getElementById("refresh-news-btn").addEventListener("click", () => loadAllNews(true));
});
