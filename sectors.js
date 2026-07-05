// sectors.js
// One entry per GICS sector, tracked via its SPDR sector ETF.
// bigNames        -> hardcoded major constituents, used for the "big name" headline
// sectorKeywords  -> used for the "sectoral change" headline (regulation/politics/tech)
// upComerKeywords -> used for the "up-and-comer" headline (growth/innovation language)
//
// Edit these lists any time — they're just plain data, no logic depends on their length.

const SECTORS = [
  {
    id: "technology",
    name: "Information Technology",
    etf: "XLK",
    bigNames: ["AAPL", "MSFT", "NVDA", "AVGO", "ORCL"],
    sectorKeywords: ["tech regulation", "antitrust tech", "AI chip export rules", "data privacy law"],
    upComerKeywords: ["emerging tech stock", "tech breakout", "AI startup funding", "disruptive software"]
  },
  {
    id: "healthcare",
    name: "Health Care",
    etf: "XLV",
    bigNames: ["LLY", "UNH", "JNJ", "ABBV", "MRK"],
    sectorKeywords: ["FDA approval", "drug pricing policy", "healthcare regulation", "Medicare policy"],
    upComerKeywords: ["biotech breakthrough", "clinical trial results", "emerging biotech", "gene therapy startup"]
  },
  {
    id: "financials",
    name: "Financials",
    etf: "XLF",
    bigNames: ["BRK.B", "JPM", "V", "MA", "BAC"],
    sectorKeywords: ["interest rate policy", "bank regulation", "Federal Reserve rate", "financial rules"],
    upComerKeywords: ["fintech breakout", "emerging fintech", "digital bank growth", "fintech funding round"]
  },
  {
    id: "consumer_discretionary",
    name: "Consumer Discretionary",
    etf: "XLY",
    bigNames: ["AMZN", "TSLA", "HD", "MCD", "NKE"],
    sectorKeywords: ["consumer spending data", "retail tariffs", "trade policy retail", "consumer confidence"],
    upComerKeywords: ["retail breakout brand", "direct-to-consumer startup", "emerging retail brand", "new consumer brand"]
  },
  {
    id: "communication_services",
    name: "Communication Services",
    etf: "XLC",
    bigNames: ["META", "GOOGL", "NFLX", "DIS", "TMUS"],
    sectorKeywords: ["media regulation", "antitrust media", "telecom policy", "content moderation law"],
    upComerKeywords: ["emerging media platform", "streaming breakout", "social app growth", "media startup funding"]
  },
  {
    id: "industrials",
    name: "Industrials",
    etf: "XLI",
    bigNames: ["GE", "RTX", "CAT", "HON", "UNP"],
    sectorKeywords: ["defense spending policy", "manufacturing tariffs", "infrastructure bill", "trade policy industrial"],
    upComerKeywords: ["industrial startup", "robotics breakout", "emerging manufacturer", "automation startup funding"]
  },
  {
    id: "consumer_staples",
    name: "Consumer Staples",
    etf: "XLP",
    bigNames: ["WMT", "PG", "COST", "KO", "PEP"],
    sectorKeywords: ["food price regulation", "agriculture policy", "packaging regulation", "consumer goods tariffs"],
    upComerKeywords: ["emerging consumer brand", "breakout food brand", "direct-to-consumer staples startup"]
  },
  {
    id: "energy",
    name: "Energy",
    etf: "XLE",
    bigNames: ["XOM", "CVX", "COP", "WMB", "EOG"],
    sectorKeywords: ["OPEC decision", "energy policy", "oil export rules", "renewable energy regulation"],
    upComerKeywords: ["emerging energy startup", "clean energy breakout", "battery technology startup", "renewable energy funding"]
  },
  {
    id: "utilities",
    name: "Utilities",
    etf: "XLU",
    bigNames: ["NEE", "SO", "DUK", "CEG", "AEP"],
    sectorKeywords: ["utility regulation", "grid policy", "energy rate case", "power plant rules"],
    upComerKeywords: ["emerging grid startup", "battery storage breakout", "microgrid startup funding"]
  },
  {
    id: "real_estate",
    name: "Real Estate",
    etf: "XLRE",
    bigNames: ["PLD", "AMT", "EQIX", "WELL", "SPG"],
    sectorKeywords: ["housing policy", "mortgage rate rules", "zoning regulation", "commercial real estate rules"],
    upComerKeywords: ["proptech breakout", "emerging real estate startup", "proptech funding round"]
  },
  {
    id: "materials",
    name: "Materials",
    etf: "XLB",
    bigNames: ["LIN", "SHW", "FCX", "ECL", "NEM"],
    sectorKeywords: ["mining regulation", "commodity tariffs", "chemical regulation", "trade policy materials"],
    upComerKeywords: ["emerging materials startup", "battery materials breakout", "materials science funding"]
  }
];

// Reference-point labels shown next to each period's % change.
// "days" is trading days for the short periods; the longer periods are handled
// as calendar-year lookups in app.js (YTD) or exact calendar-date lookups (1Y/3Y/5Y).
const PERIODS = [
  { id: "1D", label: "1D", tradingDays: 1 },
  { id: "1W", label: "1W", tradingDays: 5 },
  { id: "1M", label: "1M", tradingDays: 21 },
  { id: "YTD", label: "YTD", tradingDays: null },
  { id: "1Y", label: "1Y", years: 1 },
  { id: "3Y", label: "3Y", years: 3 },
  { id: "5Y", label: "5Y", years: 5 }
];
