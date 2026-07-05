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
  { name: "WashingtonWise (Schwab)", url: "https://feeds.pacific-content.com/washingtonwise-investor" }
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
      const res = await fetch(proxy + encodeURIComponent(targetUrl));
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
  const res = await fetch(url);
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
  const res = await fetch(url);
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

// Tries Stooq first (no key needed); if that fails and an Alpha Vantage key is
// saved, falls back to Alpha Vantage automatically.
async function fetchHistory(etf) {
  try {
    return await fetchStooqHistory(etf);
  } catch (stooqErr) {
    console.warn(`Stooq failed for ${etf}, trying Alpha Vantage fallback:`, stooqErr.message);
    if (!getAlphaVantageKey()) {
      throw new Error("Stooq unreachable (likely CORS) — add an Alpha Vantage key in Settings to use the fallback");
    }
    return await fetchAlphaVantageHistory(etf);
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
function formatDate(isoDate) {
  // "2026-07-01" -> "01 JUL"
  const [year, month, day] = isoDate.split("-");
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return `${day} ${months[parseInt(month, 10) - 1]}`;
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

async function loadAllPrices() {
  const btn = document.getElementById("refresh-prices-btn");
  const originalLabel = btn.textContent;
  btn.textContent = "⏳ Refreshing…";
  btn.disabled = true;

  const grid = document.getElementById("grid-body");
  grid.querySelectorAll(".sector-row .status").forEach(el => el.textContent = "loading…");

  // Sequential, not Promise.all — firing 11 requests at once trips Alpha
  // Vantage's free-tier per-second rate limit when the Stooq fallback kicks in.
  for (const sector of SECTORS) {
    try {
      const history = await fetchHistory(sector.etf);
      priceDataBySector[sector.id] = computeChangesForHistory(history);
    } catch (err) {
      console.error(`Price fetch failed for ${sector.etf}:`, err);
      priceDataBySector[sector.id] = { error: true, message: err.message };
    }
    renderGrid(); // update incrementally so you see rows fill in one by one
    await sleep(1300); // stay comfortably under Alpha Vantage's ~1 req/sec limit
  }

  btn.textContent = originalLabel;
  btn.disabled = false;
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
      nameCell.innerHTML = `<span class="sector-name">${sector.name}</span><span class="sector-etf">${sector.etf}</span>`;
      row.appendChild(nameCell);

      const data = priceDataBySector[sector.id];

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
    const res = await fetch(url.toString());
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
async function gnewsQuery(query) {
  const key = getGNewsKey();
  if (!key) throw new Error("no GNews key set");
  const url = new URL("https://gnews.io/api/v4/search");
  url.searchParams.set("q", query);
  url.searchParams.set("lang", "en");
  url.searchParams.set("max", "3");
  url.searchParams.set("token", key);
  const res = await fetch(url.toString());
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

async function fetchNewsForSector(sector) {
  // No longer swallowing errors silently — if a query genuinely fails
  // (as opposed to just returning zero matches), that's tracked and surfaced
  // rather than shown as an indistinguishable "not found today."
  const runQuery = async (params) => {
    try {
      return { ok: true, articles: await marketauxQuery(params) };
    } catch (err) {
      console.error(`Marketaux query failed for ${sector.name}:`, err.message);
      return { ok: false, error: err.message, articles: [] };
    }
  };

  const [bigNameResult, sectorResult, upComerResult] = await Promise.all([
    runQuery({ symbols: sector.bigNames.join(",") }),
    runQuery({ search: sector.sectorKeywords.join(" OR ") }),
    runQuery({ search: sector.upComerKeywords.join(" OR "), symbols_exclude: sector.bigNames.join(",") })
  ]);

  // If every single Marketaux query failed outright, and a GNews key is
  // available, fall back to GNews rather than showing an all-error card.
  // GNews can't filter by ticker the way Marketaux does, so "big name" here
  // just searches for the company names directly — an approximation, not
  // the same precision, but better than nothing.
  if (!bigNameResult.ok && !sectorResult.ok && !upComerResult.ok) {
    if (!getGNewsKey()) {
      return { error: bigNameResult.error || "Marketaux request failed" };
    }
    console.warn(`Marketaux fully failed for ${sector.name}, falling back to GNews`);
    try {
      const [bigNameNews, sectorNews, upComerNews] = await Promise.all([
        gnewsQuery(sector.bigNames.join(" OR ")).catch(() => []),
        gnewsQuery(sector.sectorKeywords.slice(0, 5).join(" OR ")).catch(() => []),
        gnewsQuery(sector.upComerKeywords.slice(0, 5).join(" OR ")).catch(() => [])
      ]);
      return {
        bigName: pickFirstHeadline(bigNameNews),
        sector: pickFirstHeadline(sectorNews),
        upComer: pickFirstHeadline(upComerNews),
        viaFallback: "GNews"
      };
    } catch (err) {
      return { error: `Marketaux and GNews both failed: ${err.message}` };
    }
  }

  return {
    bigName: pickFirstHeadline(bigNameResult.articles),
    sector: pickFirstHeadline(sectorResult.articles),
    upComer: pickFirstHeadline(upComerResult.articles)
  };
}

// ---------- GLOBAL & NATIONAL NEWS (public RSS feeds, no login) ----------

async function fetchFeedXML(feedUrl) {
  // Try direct fetch first — if a feed ever adds permissive CORS headers,
  // this just works with no proxy involved.
  try {
    const res = await fetch(feedUrl);
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
  const items = Array.from(doc.querySelectorAll("item"));
  return items.map(item => ({
    title: item.querySelector("title")?.textContent || "",
    link: item.querySelector("link")?.textContent || "",
    description: item.querySelector("description")?.textContent || "",
    pubDate: item.querySelector("pubDate")?.textContent || "",
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

async function loadChathamNews(forceRefresh = false) {
  const today = todayStr();
  const cache = loadChathamCache();
  if (!forceRefresh && cache[today]) return cache[today];

  try {
    const items = await fetchAllGlobalNationalItems();
    const bySector = matchItemsToSectors(items);
    saveChathamCache({ [today]: bySector });
    return bySector;
  } catch (err) {
    console.error("Global/national news feeds failed:", err);
    return null; // renderNews will just omit the row for every sector
  }
}

async function loadAllNews(forceRefresh = false) {
  const btn = document.getElementById("refresh-news-btn");
  const originalLabel = btn.textContent;
  btn.textContent = "⏳ Refreshing…";
  btn.disabled = true;

  try {
    const key = getMarketauxKey();
    const newsPanel = document.getElementById("news-panel");
    if (!key) {
      newsPanel.innerHTML = `<p class="news-empty">Add your free Marketaux API key in Settings to load news.</p>`;
      return;
    }

    const cache = loadNewsCache();
    const today = todayStr();
    const chathamBySector = await loadChathamNews(forceRefresh);

    if (!forceRefresh && cache[today]) {
      renderNews(cache[today], chathamBySector);
      return;
    }

    newsPanel.innerHTML = `<p class="news-empty">Loading news…</p>`;
    const todayData = {};
    for (const sector of SECTORS) {
      try {
        todayData[sector.id] = await fetchNewsForSector(sector);
      } catch (err) {
        console.error(`News fetch failed for ${sector.name}:`, err);
        todayData[sector.id] = { error: err.message };
      }
    }

    const newCache = { [today]: todayData };
    saveNewsCache(newCache);
    renderNews(todayData, chathamBySector);
  } finally {
    btn.textContent = originalLabel;
    btn.disabled = false;
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

function renderNews(dataBySector, chathamBySector) {
  const newsPanel = document.getElementById("news-panel");
  newsPanel.innerHTML = "";

  for (const sector of SECTORS) {
    const entry = dataBySector[sector.id];
    const chathamItem = chathamBySector ? chathamBySector[sector.id] : null;
    const card = document.createElement("div");
    card.className = "news-card";
    if (!entry || entry.error) {
      card.innerHTML = `<h3>${sector.name}</h3><p class="news-empty">${entry && entry.error ? entry.error : "No news loaded"}</p>`;
    } else {
      card.innerHTML = `
        <h3>${sector.name}</h3>
        ${entry.viaFallback ? `<p class="fallback-note">via ${entry.viaFallback} (Marketaux unavailable)</p>` : ""}
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
