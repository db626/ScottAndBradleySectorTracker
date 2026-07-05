// sectors.js
// One entry per GICS sector, tracked via its SPDR sector ETF.
// bigNames        -> hardcoded major constituents, used for the "big name" headline
// sectorKeywords  -> used for the "sectoral change" headline (regulation/politics/tech)
// upComerKeywords -> used for the "up-and-comer" headline (growth/innovation language)
// category        -> cyclical / sensitive / defensive, used to group the price grid
//
// NOTE on matching: the RSS-feed matcher (Chatham House/Brookings/AEI/NPR) only
// checks the FIRST WORD of each keyword phrase as a loose substring match — so
// what matters for hit rate isn't phrase length, it's how many DISTINCT root
// words are represented across the list. Marketaux (news API) uses the full
// phrases as an OR'd search query, where longer phrases help precision there.
// Both goals are served by having plenty of varied first-words below.
//
// Edit these lists any time — they're just plain data, no logic depends on their length.

const SECTORS = [
  {
    id: "technology",
    name: "Information Technology",
    etf: "XLK",
    category: "sensitive",
    bigNames: ["AAPL", "MSFT", "NVDA", "AVGO", "ORCL"],
    bigNameCompanies: ["Apple", "Microsoft", "Nvidia", "Broadcom", "Oracle"],
    sectorKeywords: [
      "tech regulation", "antitrust tech", "AI chip export rules", "data privacy law",
      "semiconductor tariffs", "cybersecurity policy", "cloud computing rules",
      "software antitrust", "chip export controls", "AI safety regulation",
      "big tech lawsuit", "digital markets act"
    ],
    upComerKeywords: [
      "emerging tech stock", "tech breakout", "AI startup funding", "disruptive software",
      "unicorn startup tech", "generative AI startup", "quantum computing startup",
      "robotics AI funding", "chip startup breakthrough", "software IPO"
    ]
  },
  {
    id: "healthcare",
    name: "Health Care",
    etf: "XLV",
    category: "defensive",
    bigNames: ["LLY", "UNH", "JNJ", "ABBV", "MRK"],
    bigNameCompanies: ["Eli Lilly", "UnitedHealth", "Johnson & Johnson", "AbbVie", "Merck"],
    sectorKeywords: [
      "FDA approval", "drug pricing policy", "healthcare regulation", "Medicare policy",
      "Medicaid funding", "pharmaceutical tariffs", "insurance mandate",
      "clinical trial rules", "hospital regulation", "vaccine policy",
      "biotech patent law", "healthcare reform"
    ],
    upComerKeywords: [
      "biotech breakthrough", "clinical trial results", "emerging biotech", "gene therapy startup",
      "biotech IPO", "cancer drug breakthrough", "mRNA startup", "medtech funding",
      "diagnostics startup breakthrough", "longevity biotech"
    ]
  },
  {
    id: "financials",
    name: "Financials",
    etf: "XLF",
    category: "cyclical",
    bigNames: ["BRK.B", "JPM", "V", "MA", "BAC"],
    bigNameCompanies: ["Berkshire Hathaway", "JPMorgan", "Visa", "Mastercard", "Bank of America"],
    sectorKeywords: [
      "interest rate policy", "bank regulation", "Federal Reserve rate", "financial rules",
      "banking oversight", "capital requirements rule", "monetary policy decision",
      "credit rating downgrade", "mortgage rate policy", "stablecoin regulation",
      "consumer protection finance", "insurance regulation"
    ],
    upComerKeywords: [
      "fintech breakout", "emerging fintech", "digital bank growth", "fintech funding round",
      "neobank startup", "payments startup funding", "crypto exchange startup",
      "insurtech breakout", "lending startup funding"
    ]
  },
  {
    id: "consumer_discretionary",
    name: "Consumer Discretionary",
    etf: "XLY",
    category: "cyclical",
    bigNames: ["AMZN", "TSLA", "HD", "MCD", "NKE"],
    bigNameCompanies: ["Amazon", "Tesla", "Home Depot", "McDonald's", "Nike"],
    sectorKeywords: [
      "consumer spending data", "retail tariffs", "trade policy retail", "consumer confidence",
      "auto tariffs", "EV subsidy policy", "housing market data", "labor market report",
      "minimum wage policy", "e-commerce regulation", "supply chain tariffs"
    ],
    upComerKeywords: [
      "retail breakout brand", "direct-to-consumer startup", "emerging retail brand", "new consumer brand",
      "EV startup funding", "fashion startup breakout", "restaurant chain breakout",
      "travel startup funding", "gaming startup breakout"
    ]
  },
  {
    id: "communication_services",
    name: "Communication Services",
    etf: "XLC",
    category: "sensitive",
    bigNames: ["META", "GOOGL", "NFLX", "DIS", "TMUS"],
    bigNameCompanies: ["Meta", "Google", "Netflix", "Disney", "T-Mobile"],
    sectorKeywords: [
      "media regulation", "antitrust media", "telecom policy", "content moderation law",
      "spectrum auction policy", "social media regulation", "streaming regulation",
      "broadband policy", "advertising privacy rules", "net neutrality"
    ],
    upComerKeywords: [
      "emerging media platform", "streaming breakout", "social app growth", "media startup funding",
      "creator economy startup", "podcast platform breakout", "gaming platform breakout",
      "advertising tech startup"
    ]
  },
  {
    id: "industrials",
    name: "Industrials",
    etf: "XLI",
    category: "sensitive",
    bigNames: ["GE", "RTX", "CAT", "HON", "UNP"],
    bigNameCompanies: ["General Electric", "RTX", "Caterpillar", "Honeywell", "Union Pacific"],
    sectorKeywords: [
      "defense spending policy", "manufacturing tariffs", "infrastructure bill", "trade policy industrial",
      "defense budget", "aerospace regulation", "shipping tariffs", "rail regulation",
      "labor strike manufacturing", "export controls defense"
    ],
    upComerKeywords: [
      "industrial startup", "robotics breakout", "emerging manufacturer", "automation startup funding",
      "drone startup breakout", "space startup funding", "3D printing startup",
      "defense tech startup"
    ]
  },
  {
    id: "consumer_staples",
    name: "Consumer Staples",
    etf: "XLP",
    category: "defensive",
    bigNames: ["WMT", "PG", "COST", "KO", "PEP"],
    bigNameCompanies: ["Walmart", "Procter & Gamble", "Costco", "Coca-Cola", "PepsiCo"],
    sectorKeywords: [
      "food price regulation", "agriculture policy", "packaging regulation", "consumer goods tariffs",
      "farm subsidy policy", "food safety rules", "grocery antitrust", "sugar tariff policy",
      "labeling regulation", "supply chain food"
    ],
    upComerKeywords: [
      "emerging consumer brand", "breakout food brand", "direct-to-consumer staples startup",
      "beverage startup breakout", "snack brand breakout", "plant-based startup funding",
      "grocery delivery startup"
    ]
  },
  {
    id: "energy",
    name: "Energy",
    etf: "XLE",
    category: "sensitive",
    bigNames: ["XOM", "CVX", "COP", "WMB", "EOG"],
    bigNameCompanies: ["Exxon Mobil", "Chevron", "ConocoPhillips", "Williams Companies", "EOG Resources"],
    sectorKeywords: [
      "OPEC decision", "energy policy", "oil export rules", "renewable energy regulation",
      "drilling regulation", "pipeline policy", "carbon tax policy", "LNG export rules",
      "energy sanctions", "fracking regulation"
    ],
    upComerKeywords: [
      "emerging energy startup", "clean energy breakout", "battery technology startup", "renewable energy funding",
      "solar startup breakout", "hydrogen startup funding", "nuclear startup breakthrough",
      "geothermal startup"
    ]
  },
  {
    id: "utilities",
    name: "Utilities",
    etf: "XLU",
    category: "defensive",
    bigNames: ["NEE", "SO", "DUK", "CEG", "AEP"],
    bigNameCompanies: ["NextEra Energy", "Southern Company", "Duke Energy", "Constellation Energy", "American Electric Power"],
    sectorKeywords: [
      "utility regulation", "grid policy", "energy rate case", "power plant rules",
      "grid modernization policy", "electricity rate hike", "nuclear power policy",
      "water utility regulation", "blackout policy", "clean power mandate"
    ],
    upComerKeywords: [
      "emerging grid startup", "battery storage breakout", "microgrid startup funding",
      "smart grid startup", "grid software startup", "energy storage breakthrough"
    ]
  },
  {
    id: "real_estate",
    name: "Real Estate",
    etf: "XLRE",
    category: "cyclical",
    bigNames: ["PLD", "AMT", "EQIX", "WELL", "SPG"],
    bigNameCompanies: ["Prologis", "American Tower", "Equinix", "Welltower", "Simon Property Group"],
    sectorKeywords: [
      "housing policy", "mortgage rate rules", "zoning regulation", "commercial real estate rules",
      "rent control policy", "REIT tax rule", "affordable housing policy", "eviction policy",
      "data center regulation", "property tax rule"
    ],
    upComerKeywords: [
      "proptech breakout", "emerging real estate startup", "proptech funding round",
      "co-living startup", "real estate marketplace startup"
    ]
  },
  {
    id: "materials",
    name: "Materials",
    etf: "XLB",
    category: "cyclical",
    bigNames: ["LIN", "SHW", "FCX", "ECL", "NEM"],
    bigNameCompanies: ["Linde", "Sherwin-Williams", "Freeport-McMoRan", "Ecolab", "Newmont"],
    sectorKeywords: [
      "mining regulation", "commodity tariffs", "chemical regulation", "trade policy materials",
      "steel tariffs", "copper export policy", "rare earth policy", "environmental mining rule",
      "lithium export rules", "gold reserve policy"
    ],
    upComerKeywords: [
      "emerging materials startup", "battery materials breakout", "materials science funding",
      "recycling startup breakout", "advanced materials startup"
    ]
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
