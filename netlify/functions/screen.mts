// 每日選股 API:/api/screen?market=tw|us
// 資料源全為免費公開端點(TWSE OpenAPI / TWSE RWD / Yahoo Finance chart)。
// 僅為研究用訊號清單,非投資建議;不做任何繞過 rate limit 的設計。
import type { Context, Config } from "@netlify/functions";
import { scoreTaiwan, scoreUS, scoreETF } from "./lib/scoring.mjs";

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 8000) {
  const res = await fetch(url, {
    ...init,
    headers: { ...UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function taipeiDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 8 * 3600_000 - offsetDays * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

const num = (s: unknown): number => {
  const n = parseFloat(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

// ---------------- 台股 ----------------
/** 民國年月字串(如 11506)→ '2026/06' */
function rocYmToLabel(ym: unknown): string | null {
  const s = String(ym ?? "").replace(/\D/g, "");
  if (s.length < 4) return null;
  const mm = s.slice(-2);
  const y = parseInt(s.slice(0, -2), 10) + 1911;
  return Number.isFinite(y) ? `${y}/${mm}` : null;
}

/** 去年最後交易日全市場收盤價(YTD基準)。失敗回傳空Map,前端顯示「—」。 */
async function fetchPrevYearEndCloses(): Promise<Map<string, number>> {
  const year = new Date(Date.now() + 8 * 3600_000).getUTCFullYear() - 1;
  const settled = await Promise.allSettled(
    ["1226", "1227", "1228", "1229", "1230", "1231"].map((md) =>
      fetchJson(
        `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&date=${year}${md}&type=ALLBUT0999`,
        {}, 10000,
      ).then((j) => ({ d: `${year}${md}`, j })),
    ),
  );
  const oks = settled
    .filter((s): s is PromiseFulfilledResult<any> => s.status === "fulfilled" && s.value.j?.stat === "OK")
    .map((s) => s.value)
    .sort((a, b) => a.d.localeCompare(b.d));
  const latest = oks.at(-1);
  const map = new Map<string, number>();
  if (!latest) return map;
  const tables = latest.j.tables ?? [latest.j];
  const tbl = tables.find(
    (t: any) => Array.isArray(t?.fields) && t.fields.includes("證券代號") && t.fields.includes("收盤價"),
  );
  if (!tbl) return map;
  const iC = tbl.fields.indexOf("證券代號");
  const iP = tbl.fields.indexOf("收盤價");
  for (const row of tbl.data ?? []) {
    const p = num(row[iP]);
    if (p > 0) map.set(String(row[iC]).trim(), p);
  }
  return map;
}

async function screenTaiwan(pick: string | null = null) {
  // 1) 近12個日曆日的 T86(三大法人買賣超),取其中最近5個交易日
  const t86Settled = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      fetchJson(
        `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${taipeiDate(i)}&selectType=ALLBUT0999`,
      ).then((j) => ({ date: taipeiDate(i), j })),
    ),
  );
  const t86Days = t86Settled
    .filter((r): r is PromiseFulfilledResult<{ date: string; j: any }> =>
      r.status === "fulfilled" && r.value.j?.stat === "OK" && r.value.j?.data?.length,
    )
    .map((r) => r.value)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-5);
  if (t86Days.length < 3) throw new Error("TWSE T86 資料不足(近12日僅取得" + t86Days.length + "日)");

  // 2) 當日行情、估值、月營收與去年底收盤(YTD基準)
  let revErr: string | null = null;
  const [priceAll, valAll, revAll, prevYE] = await Promise.all([
    fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"),
    fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL"),
    fetchJson("https://openapi.twse.com.tw/v1/opendata/t187ap05_L", {}, 12000).catch(
      (e) => { revErr = String(e?.message ?? e); return []; },
    ),
    fetchPrevYearEndCloses().catch(() => new Map<string, number>()),
  ]);

  // 月營收 → 基本面亮點(欄位名以關鍵字模糊比對,防 API 欄名微調)
  const revMap = new Map<string, any>();
  if (Array.isArray(revAll) && revAll.length) {
    const keys = Object.keys(revAll[0]);
    const kCode = keys.find((k) => k.includes("公司代號"));
    const kInd = keys.find((k) => k.includes("產業別"));
    const kYoY = keys.find((k) => k.includes("去年同月增減"));
    const kAcc = keys.find((k) => k.includes("前期比較增減") || k.includes("去年累計增減"));
    const kYm = keys.find((k) => k.includes("資料年月"));
    if (kCode && kYoY) {
      for (const r of revAll) {
        revMap.set(String(r[kCode]).trim(), {
          industry: kInd ? String(r[kInd]).trim() : null,
          revYoY: num(r[kYoY]),
          revAccYoY: kAcc ? num(r[kAcc]) : NaN,
          revLabel: kYm ? rocYmToLabel(r[kYm]) : null,
        });
      }
    }
  }

  // 3) 彙整逐檔法人買賣超序列(舊→新)
  type Acc = { name: string; nets: number[]; foreignSum: number; trustSum: number };
  const chips = new Map<string, Acc>();
  t86Days.forEach(({ j }, dayIdx) => {
    const fields: string[] = j.fields;
    const iCode = fields.findIndex((f: string) => f.includes("證券代號"));
    const iName = fields.findIndex((f: string) => f.includes("證券名稱"));
    const iForeign = fields.findIndex(
      (f: string) => f.includes("外陸資買賣超") && !f.includes("自營"),
    );
    const iTrust = fields.findIndex((f: string) => f === "投信買賣超股數");
    for (const row of j.data) {
      const code = String(row[iCode]).trim();
      if (!/^\d{4}$/.test(code)) continue; // 僅四碼普通股
      let acc = chips.get(code);
      if (!acc) {
        acc = { name: String(row[iName]).trim(), nets: new Array(t86Days.length).fill(0), foreignSum: 0, trustSum: 0 };
        chips.set(code, acc);
      }
      const f = num(row[iForeign]) || 0;
      const t = num(row[iTrust]) || 0;
      acc.nets[dayIdx] = f + t;
      acc.foreignSum += f;
      acc.trustSum += t;
    }
  });

  const valMap = new Map<string, any>();
  for (const v of valAll) valMap.set(v.Code, v);

  const rows: any[] = [];
  for (const p of priceAll) {
    const acc = chips.get(p.Code);
    if (!acc) continue;
    const v = valMap.get(p.Code) ?? {};
    const f = revMap.get(p.Code) ?? {};
    rows.push({
      code: p.Code,
      name: p.Name || acc.name,
      close: num(p.ClosingPrice),
      volume: num(p.TradeVolume),
      turnover: num(p.TradeValue),
      nets: acc.nets,
      foreignSum: acc.foreignSum,
      trustSum: acc.trustSum,
      pe: num(v.PEratio),
      pb: num(v.PBratio),
      dividendYield: num(v.DividendYield),
      industry: f.industry ?? null,
      revYoY: f.revYoY ?? NaN,
      revAccYoY: f.revAccYoY ?? NaN,
      revLabel: f.revLabel ?? null,
      revMapLoaded: revMap.size > 0,
      ytd: (() => {
        const base = prevYE.get(p.Code);
        const c = num(p.ClosingPrice);
        return base && base > 0 && c > 0 ? ((c / base) - 1) * 100 : NaN;
      })(),
    });
  }

  const scored = scoreTaiwan(rows, { pick });
  return {
    market: "TW",
    asOf: t86Days[t86Days.length - 1].date,
    universeSize: rows.length,
    rows: scored.rows,
    picked: scored.picked,
    pickedError: pick && !scored.picked
      ? `查無「${pick}」——查詢範圍為上市普通股且當日成交金額≥3億;上櫃與低流動性標的暫不支援`
      : null,
    notes: [
      "籌碼分數:外資+投信近5日連買天數×買超強度之橫斷面百分位",
      "估值分數:P/E 橫斷面便宜度70% + 殖利率排名30%(TWSE BWIBBU)",
      revMap.size > 0
        ? `基本面:TWSE 月營收彙總已載入 ${revMap.size} 家(公告期間未申報者摘要會註明),寫入智能摘要`
        : `⚠ 月營收資料源未取得${revErr ? `(${revErr})` : ""},本次摘要缺基本面段落`,
      prevYE.size > 0
        ? `YTD 以去年最後交易日收盤為基準(${prevYE.size} 檔)`
        : "⚠ 去年底收盤資料未取得,YTD 顯示為 —",
      "流動性門檻:當日成交金額≥3億;觸發定義:連買≥3日且5日買超佔量≥5%",
    ],
  };
}

// ---------------- 美股 ----------------
const US_TICKERS = [
  "NVDA","AAPL","MSFT","GOOGL","AMZN","META","AVGO","TSLA","AMD","QCOM",
  "TXN","INTC","MU","AMAT","LRCX","KLAC","ASML","TSM","ADI","MRVL",
  "NXPI","ON","ARM","PLTR","CRM","ORCL","ADBE","NFLX","CSCO","PANW",
  "CRWD","SNOW","NOW","INTU","SHOP","UBER",
];
const US_THEMES: Record<string, string> = {
  NVDA: "AI GPU與資料中心平台龍頭", AAPL: "iPhone生態系與服務營收",
  MSFT: "Azure雲端與Copilot AI", GOOGL: "搜尋廣告與Gemini AI",
  AMZN: "電商與AWS雲端", META: "社群廣告與AI推薦引擎",
  AVGO: "AI客製化晶片(ASIC)與網通", TSLA: "電動車、自駕與人形機器人",
  AMD: "資料中心CPU/GPU挑戰者", QCOM: "手機SoC與車用/邊緣AI",
  TXN: "類比IC、工業與車用", INTC: "x86處理器與晶圓代工轉型",
  MU: "HBM高頻寬記憶體與記憶體循環", AMAT: "半導體設備(沉積/蝕刻)",
  LRCX: "半導體蝕刻設備", KLAC: "半導體檢測量測設備",
  ASML: "EUV曝光機獨家供應商", TSM: "先進製程晶圓代工龍頭",
  ADI: "高階類比與混合訊號IC", MRVL: "資料中心ASIC與光通訊",
  NXPI: "車用半導體", ON: "碳化矽(SiC)與車用功率半導體",
  ARM: "CPU架構IP授權", PLTR: "政府與企業AI決策平台",
  CRM: "企業CRM與Agentforce AI", ORCL: "雲端資料庫與AI算力租賃",
  ADBE: "創意軟體與生成式AI", NFLX: "串流訂閱與廣告方案",
  CSCO: "網路設備與資安", PANW: "資安平台化龍頭",
  CRWD: "雲原生端點資安", SNOW: "企業資料雲",
  NOW: "企業工作流程自動化AI", INTU: "財稅軟體導入AI",
  SHOP: "電商開店SaaS", UBER: "共享出行與自駕車隊合作",
};

const US_NAMES: Record<string, string> = {
  NVDA: "NVIDIA", AAPL: "Apple", MSFT: "Microsoft", GOOGL: "Alphabet",
  AMZN: "Amazon", META: "Meta", AVGO: "Broadcom", TSLA: "Tesla",
  AMD: "AMD", QCOM: "Qualcomm", TXN: "Texas Instruments", INTC: "Intel",
  MU: "Micron", AMAT: "Applied Materials", LRCX: "Lam Research",
  KLAC: "KLA", ASML: "ASML", TSM: "TSMC ADR", ADI: "Analog Devices",
  MRVL: "Marvell", NXPI: "NXP", ON: "onsemi", ARM: "Arm", PLTR: "Palantir",
  CRM: "Salesforce", ORCL: "Oracle", ADBE: "Adobe", NFLX: "Netflix",
  CSCO: "Cisco", PANW: "Palo Alto", CRWD: "CrowdStrike", SNOW: "Snowflake",
  NOW: "ServiceNow", INTU: "Intuit", SHOP: "Shopify", UBER: "Uber",
};

async function fetchChart(ticker: string) {
  const j = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`,
  );
  const r = j?.chart?.result?.[0];
  const rawC: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
  const rawV: (number | null)[] = r?.indicators?.quote?.[0]?.volume ?? [];
  const rawT: number[] = r?.timestamp ?? [];
  const closes: number[] = [], vols: number[] = [], ts: number[] = [];
  for (let i = 0; i < rawC.length; i++) {
    if (rawC[i] != null && rawC[i]! > 0) {
      closes.push(rawC[i]!);
      vols.push(rawV[i] ?? 0);
      ts.push(rawT[i] ?? 0);
    }
  }
  return { ticker, closes, vols, ts, meta: r?.meta };
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/** YTD%:序列最後一點 vs 去年最後一點(以timestamp判年份)。無去年資料回傳NaN。 */
function ytdFrom(values: number[], ts: number[]): number {
  if (!values.length || values.length !== ts.length) return NaN;
  const nowYear = new Date().getUTCFullYear();
  let baseIdx = -1;
  for (let i = 0; i < ts.length; i++) {
    if (new Date(ts[i] * 1000).getUTCFullYear() < nowYear) baseIdx = i;
    else break;
  }
  if (baseIdx < 0 || !(values[baseIdx] > 0)) return NaN;
  return (values[values.length - 1] / values[baseIdx] - 1) * 100;
}

async function fetchYahooValuations(
  tickers: string[],
): Promise<Map<string, { pe: number; epsGrowth: number }>> {
  // Yahoo quote API 需 cookie+crumb;失敗時整層降級(估值中性50分)
  const map = new Map<string, { pe: number; epsGrowth: number }>();
  try {
    const pre = await fetch("https://fc.yahoo.com", {
      headers: UA, signal: AbortSignal.timeout(6000),
    }).catch(() => null);
    const cookie = pre?.headers.get("set-cookie")?.split(";")[0] ?? "";
    if (!cookie) return map;
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { ...UA, Cookie: cookie }, signal: AbortSignal.timeout(6000),
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.includes("<")) return map;
    const j = await fetchJson(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(",")}&crumb=${encodeURIComponent(crumb)}`,
      { headers: { Cookie: cookie } },
    );
    for (const q of j?.quoteResponse?.result ?? []) {
      const pe = q.forwardPE ?? q.trailingPE;
      const epsGrowth =
        q.epsForward > 0 && q.epsTrailingTwelveMonths > 0
          ? q.epsForward / q.epsTrailingTwelveMonths - 1
          : NaN;
      if (pe > 0 || Number.isFinite(epsGrowth))
        map.set(q.symbol, { pe: pe > 0 ? pe : NaN, epsGrowth });
    }
  } catch { /* 降級 */ }
  return map;
}

async function screenUS(pick: string | null = null) {
  const settled = await Promise.allSettled(
    [...US_TICKERS, "SOXX"].map((t) => fetchChart(t)),
  );
  const charts = new Map<string, { closes: number[]; vols: number[]; ts: number[] }>();
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value.closes.length >= 25) {
      charts.set(s.value.ticker, s.value);
    }
  }
  const soxx = charts.get("SOXX");
  if (!soxx) throw new Error("Yahoo Finance chart 資料取得失敗(含基準SOXX)");
  const soxxRet20 =
    soxx.closes.at(-1)! / soxx.closes.at(-21)! - 1;

  const vals = await fetchYahooValuations(US_TICKERS);
  const valuationAvailable = vals.size >= 5;

  const rows: any[] = [];
  for (const t of US_TICKERS) {
    const c = charts.get(t);
    if (!c) continue;
    const close = c.closes.at(-1)!;
    const ret20 = close / c.closes.at(-21)! - 1;
    const ma20 = mean(c.closes.slice(-20));
    const v = vals.get(t);
    rows.push({
      ticker: t,
      name: US_NAMES[t] ?? t,
      close,
      ret20,
      mom20: close / ma20 - 1,
      volSurge: mean(c.vols.slice(-5)) / mean(c.vols.slice(-20)),
      rs: ret20 - soxxRet20,
      fwdPe: v?.pe ?? NaN,
      epsGrowth: v?.epsGrowth ?? NaN,
      theme: US_THEMES[t] ?? null,
      ytd: ytdFrom(c.closes, (c as any).ts ?? []),
    });
  }

  const scored = scoreUS(rows, { valuationAvailable, pick });
  return {
    market: "US",
    asOf: new Date().toISOString().slice(0, 10),
    universeSize: rows.length,
    valuationDegraded: !valuationAvailable,
    rows: scored.rows,
    picked: scored.picked,
    pickedError: pick && !scored.picked
      ? `查無「${pick}」——美股查詢範圍目前限定 ${US_TICKERS.length} 檔 NDX/SOX 追蹤清單:${US_TICKERS.join("、")}`
      : null,
    notes: [
      "籌碼替代分數:相對SOXX 20日超額報酬60% + 5日/20日量能比40%(免費源無分點/內部人日頻資料)",
      valuationAvailable
        ? "估值分數:Forward P/E 橫斷面便宜度(Yahoo Finance)"
        : "⚠ 估值源暫時不可用,本次估值層降級為中性50分",
      "觸發定義:相對強於SOXX、站上20日均線、量能≥1.2x",
    ],
  };
}

// ---------------- ETF 長期穩健篩選 ----------------
const ETF_LIST: { code: string; yahoo: string; name: string; market: "TW" | "US"; type: string }[] = [
  { code: "0050",   yahoo: "0050.TW",   name: "元大台灣50",        market: "TW", type: "市值型" },
  { code: "006208", yahoo: "006208.TW", name: "富邦台50",          market: "TW", type: "市值型" },
  { code: "0056",   yahoo: "0056.TW",   name: "元大高股息",        market: "TW", type: "高股息" },
  { code: "00878",  yahoo: "00878.TW",  name: "國泰永續高股息",    market: "TW", type: "高股息" },
  { code: "00713",  yahoo: "00713.TW",  name: "元大台灣高息低波",  market: "TW", type: "高息低波" },
  { code: "00692",  yahoo: "00692.TW",  name: "富邦公司治理",      market: "TW", type: "市值/ESG" },
  { code: "00850",  yahoo: "00850.TW",  name: "元大臺灣ESG永續",   market: "TW", type: "ESG" },
  { code: "00881",  yahoo: "00881.TW",  name: "國泰台灣5G+",       market: "TW", type: "科技主題" },
  { code: "00891",  yahoo: "00891.TW",  name: "中信關鍵半導體",    market: "TW", type: "半導體" },
  { code: "00919",  yahoo: "00919.TW",  name: "群益台灣精選高息",  market: "TW", type: "高股息" },
  { code: "00929",  yahoo: "00929.TW",  name: "復華台灣科技優息",  market: "TW", type: "科技高息" },
  { code: "VOO",  yahoo: "VOO",  name: "Vanguard S&P 500",      market: "US", type: "市值型" },
  { code: "VTI",  yahoo: "VTI",  name: "Vanguard 全美市場",     market: "US", type: "市值型" },
  { code: "VT",   yahoo: "VT",   name: "Vanguard 全球市場",     market: "US", type: "全球分散" },
  { code: "QQQ",  yahoo: "QQQ",  name: "Invesco 那斯達克100",   market: "US", type: "科技成長" },
  { code: "SCHD", yahoo: "SCHD", name: "Schwab 高股息成長",     market: "US", type: "高股息" },
  { code: "VIG",  yahoo: "VIG",  name: "Vanguard 股息成長",     market: "US", type: "股息成長" },
  { code: "VYM",  yahoo: "VYM",  name: "Vanguard 高股息",       market: "US", type: "高股息" },
  { code: "DIA",  yahoo: "DIA",  name: "SPDR 道瓊工業",         market: "US", type: "市值型" },
  { code: "IWM",  yahoo: "IWM",  name: "iShares 羅素2000",      market: "US", type: "小型股" },
  { code: "VGT",  yahoo: "VGT",  name: "Vanguard 資訊科技",     market: "US", type: "科技" },
  { code: "SOXX", yahoo: "SOXX", name: "iShares 半導體",        market: "US", type: "半導體" },
  { code: "JEPI", yahoo: "JEPI", name: "JPMorgan 股票收益",     market: "US", type: "收益型" },
];

async function fetchMonthlyAdj(yahoo: string): Promise<{ adj: number[]; ts: number[] }> {
  const j = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?range=10y&interval=1mo`,
    {}, 10000,
  );
  const r = j?.chart?.result?.[0];
  const rawA: (number | null)[] =
    r?.indicators?.adjclose?.[0]?.adjclose ?? r?.indicators?.quote?.[0]?.close ?? [];
  const rawT: number[] = r?.timestamp ?? [];
  const adj: number[] = [], ts: number[] = [];
  for (let i = 0; i < rawA.length; i++) {
    if (Number.isFinite(rawA[i]) && rawA[i]! > 0) {
      adj.push(rawA[i]!);
      ts.push(rawT[i] ?? 0);
    }
  }
  return { adj, ts };
}

async function screenETFs() {
  const settled = await Promise.allSettled(
    ETF_LIST.map(async (e) => {
      const { adj, ts } = await fetchMonthlyAdj(e.yahoo);
      return { ...e, adj, ytd: ytdFrom(adj, ts) };
    }),
  );
  const rows = settled
    .filter((s): s is PromiseFulfilledResult<any> => s.status === "fulfilled" && s.value.adj.length >= 13)
    .map((s) => s.value);
  if (rows.length < 5) throw new Error("ETF 歷史資料取得失敗(Yahoo Finance 無回應)");
  const failed = ETF_LIST.filter((e) => !rows.some((r: any) => r.code === e.code)).map((e) => e.code);

  return {
    market: "ETF",
    asOf: new Date().toISOString().slice(0, 10),
    universeSize: rows.length,
    rows: scoreETF(rows, { threshold: 0.05 }),
    notes: [
      "年化報酬與YTD以還原股息之調整價(adjusted close)計算 = 含息總報酬;✓達標 = 年化報酬≥5%且成立滿3年",
      "排序:達標者優先,再依風險調整報酬(年化報酬÷年化波動)由高至低——「穩健」看的是這一欄,不是報酬絕對值",
      "近5年涵蓋2024多頭與2025回檔,數字已含一次完整循環;過去績效不保證未來報酬",
      ...(failed.length ? [`⚠ 本次未能取得:${failed.join("、")}(資料源無回應)`] : []),
    ],
  };
}

// ---------------- 新聞題材(Yahoo Finance Search,多重備援) ----------------
async function fetchNewsOnce(q: string, locale: boolean) {
  const loc = locale ? "&lang=zh-Hant-TW&region=TW" : "";
  const j = await fetchJson(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=6&quotesCount=0${loc}`,
    {}, 6000,
  );
  return (j?.news ?? []).slice(0, 6).map((n: any) => ({
    title: n.title,
    publisher: n.publisher,
    link: n.link,
    time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
  }));
}

/** 依序嘗試:q(含台灣locale,若為中文/台股代號)→ q 純參數 → q2 各組合。 */
async function fetchNews(q: string, q2: string | null) {
  const attempts: [string, boolean][] = [];
  for (const query of [q, q2].filter(Boolean) as string[]) {
    const isTw = /[^\x00-\x7F]/.test(query) || /\.TW$/i.test(query);
    if (isTw) attempts.push([query, true]);
    attempts.push([query, false]);
  }
  let lastErr: unknown = null;
  for (const [query, locale] of attempts) {
    try {
      const news = await fetchNewsOnce(query, locale);
      if (news.length) return news;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return [];
}

// ---------------- handler ----------------
export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Netlify-CDN-Cache-Control": "public, s-maxage=1800, stale-while-revalidate=7200",
  };
  try {
    if (url.pathname.endsWith("/news")) {
      const q = url.searchParams.get("q") ?? "";
      if (!q) throw new Error("missing q");
      const news = await fetchNews(q, url.searchParams.get("q2"));
      return new Response(
        JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), news }),
        { headers },
      );
    }
    const market = (url.searchParams.get("market") ?? "tw").toLowerCase();
    const pick = url.searchParams.get("code");
    const data =
      market === "us" ? await screenUS(pick)
      : market === "etf" ? await screenETFs()
      : await screenTaiwan(pick);
    const cache = market === "etf"
      ? "public, s-maxage=21600, stale-while-revalidate=86400" // ETF長期數據:快取6小時
      : headers["Netlify-CDN-Cache-Control"];
    return new Response(
      JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), ...data }),
      { headers: { ...headers, "Netlify-CDN-Cache-Control": cache } },
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e?.message ?? e) }),
      { status: 502, headers: { ...headers, "Netlify-CDN-Cache-Control": "no-store" } },
    );
  }
};

export const config: Config = {
  path: ["/api/screen", "/api/news"],
};
