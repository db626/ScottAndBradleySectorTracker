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
  newsCache: "cf_news_cache_v1", // { "2026-07-04": { technology: {bigName:{...}, sector:{...}, upComer:{...}}, ... } }
  chathamCache: "cf_chatham_cache_v1" // { "2026-07-04": { technology: {title, link, pubDate}, ... } }
};

// Chatham House's public "What's new" RSS feed — headlines only, no login needed.
// Like almost all RSS feeds, it doesn't send CORS headers for browser fetch, so we
// try direct first and fall back to a read-only public CORS proxy for public XML.
const CHATHAM_FEED_URL = "https://www.chathamhouse.org/path/whatsnew.xml";
const CORS_PROXY = "https://api.allorigins.win/raw?url=";

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
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${etf}&outputsize=full&apikey=${key}`;
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

async function loadAllPrices() {
  const grid = document.getElementById("grid-body");
  grid.querySelectorAll(".sector-row .status").forEach(el => el.textContent = "loading…");

  await Promise.all(SECTORS.map(async sector => {
    try {
      const history = await fetchHistory(sector.etf);
      priceDataBySector[sector.id] = computeChangesForHistory(history);
    } catch (err) {
      console.error(`Price fetch failed for ${sector.etf}:`, err);
      priceDataBySector[sector.id] = { error: true, message: err.message };
    }
  }));

  renderGrid();
}

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

  for (const sector of SECTORS) {
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
          cell.innerHTML = `<div class="pct">${sign}${val.pct.toFixed(1)}%</div><div class="ref-date">since ${val.refDate}</div>`;
        }
        row.appendChild(cell);
      }
    }

    tbody.appendChild(row);
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
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Marketaux request failed (${res.status})`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "Marketaux error");
  return json.data || [];
}

function pickFirstHeadline(articles) {
  if (!articles || !articles.length) return null;
  const a = articles[0];
  return { title: a.title, url: a.url, source: a.source, published_at: a.published_at };
}

async function fetchNewsForSector(sector) {
  const [bigNameArticles, sectorArticles, upComerArticles] = await Promise.all([
    marketauxQuery({ symbols: sector.bigNames.join(",") }).catch(() => []),
    marketauxQuery({ search: sector.sectorKeywords.join(" OR ") }).catch(() => []),
    marketauxQuery({
      search: sector.upComerKeywords.join(" OR "),
      symbols_exclude: sector.bigNames.join(",")
    }).catch(() => [])
  ]);

  return {
    bigName: pickFirstHeadline(bigNameArticles),
    sector: pickFirstHeadline(sectorArticles),
    upComer: pickFirstHeadline(upComerArticles)
  };
}

// ---------- CHATHAM HOUSE (public RSS, no login) ----------

async function fetchChathamFeedXML() {
  // Try direct fetch first — if Chatham House ever adds permissive CORS headers,
  // this just works with no proxy involved.
  try {
    const res = await fetch(CHATHAM_FEED_URL);
    if (res.ok) return await res.text();
  } catch {
    // fall through to proxy
  }
  const proxied = await fetch(CORS_PROXY + encodeURIComponent(CHATHAM_FEED_URL));
  if (!proxied.ok) throw new Error(`Chatham House feed unreachable (${proxied.status})`);
  return await proxied.text();
}

function parseRSSItems(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const items = Array.from(doc.querySelectorAll("item"));
  return items.map(item => ({
    title: item.querySelector("title")?.textContent || "",
    link: item.querySelector("link")?.textContent || "",
    description: item.querySelector("description")?.textContent || "",
    pubDate: item.querySelector("pubDate")?.textContent || ""
  }));
}

// Match each sector to the single most recent Chatham House item whose title or
// description contains one of that sector's keywords (reusing sectorKeywords —
// same regulation/politics/tech language already defined per sector).
function matchChathamItemsToSectors(items) {
  const bySector = {};
  for (const sector of SECTORS) {
    const terms = sector.sectorKeywords.map(k => k.toLowerCase());
    const match = items.find(item => {
      const haystack = (item.title + " " + item.description).toLowerCase();
      return terms.some(term => haystack.includes(term.split(" ")[0])); // loose match on first word of each keyword phrase
    });
    bySector[sector.id] = match || null;
  }
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
    const xml = await fetchChathamFeedXML();
    const items = parseRSSItems(xml);
    const bySector = matchChathamItemsToSectors(items);
    saveChathamCache({ [today]: bySector });
    return bySector;
  } catch (err) {
    console.error("Chatham House feed failed:", err);
    return null; // renderNews will just omit the 🌍 row for every sector
  }
}

async function loadAllNews(forceRefresh = false) {
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
}

function headlineRow(icon, label, item) {
  if (!item) return `<div class="headline"><span class="headline-icon">${icon}</span><span class="headline-empty">No ${label.toLowerCase()} found today</span></div>`;
  const url = item.url || item.link;
  const rawDate = item.published_at || item.pubDate;
  const date = rawDate ? new Date(rawDate).toLocaleDateString() : "";
  const source = item.source || (label === "global affairs" ? "Chatham House" : "");
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
        ${headlineRow("🌱", "up-and-comer", entry.upComer)}
        ${headlineRow("📰", "sector news", entry.sector)}
        ${headlineRow("🏢", "big name", entry.bigName)}
        ${headlineRow("🌍", "global affairs", chathamItem)}
      `;
    }
    newsPanel.appendChild(card);
  }
}

// ---------- SETTINGS PANEL ----------

function initSettings() {
  const input = document.getElementById("marketaux-key-input");
  input.value = getMarketauxKey();
  document.getElementById("save-key-btn").addEventListener("click", () => {
    setMarketauxKey(input.value);
    loadAllNews(true);
  });

  const avInput = document.getElementById("alphavantage-key-input");
  avInput.value = getAlphaVantageKey();
  document.getElementById("save-av-key-btn").addEventListener("click", () => {
    setAlphaVantageKey(avInput.value);
    loadAllPrices();
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
