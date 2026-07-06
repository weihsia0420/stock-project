// 每日選股 API:/api/screen?market=tw|us
// 資料源全為免費公開端點(TWSE OpenAPI / TWSE RWD / Yahoo Finance chart)。
// 僅為研究用訊號清單,非投資建議;不做任何繞過 rate limit 的設計。
import type { Context, Config } from "@netlify/functions";
import { scoreTaiwan, scoreUS } from "./lib/scoring.mjs";

const UA = { "User-Agent": "Mozilla/5.0 (stock-project research tool)" };

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
async function screenTaiwan() {
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

  // 2) 當日行情與估值(TWSE OpenAPI 最新快照)
  const [priceAll, valAll] = await Promise.all([
    fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"),
    fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL"),
  ]);

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
    });
  }

  return {
    market: "TW",
    asOf: t86Days[t86Days.length - 1].date,
    universeSize: rows.length,
    rows: scoreTaiwan(rows),
    notes: [
      "籌碼分數:外資+投信近5日連買天數×買超強度之橫斷面百分位",
      "估值分數:P/E 橫斷面便宜度70% + 殖利率排名30%(TWSE BWIBBU)",
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
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`,
  );
  const r = j?.chart?.result?.[0];
  const closes: number[] = (r?.indicators?.quote?.[0]?.close ?? []).filter((x: number) => x != null);
  const vols: number[] = (r?.indicators?.quote?.[0]?.volume ?? []).filter((x: number) => x != null);
  return { ticker, closes, vols, meta: r?.meta };
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

async function fetchYahooValuations(tickers: string[]): Promise<Map<string, number>> {
  // Yahoo quote API 需 cookie+crumb;失敗時整層降級(估值中性50分)
  const map = new Map<string, number>();
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
      if (pe > 0) map.set(q.symbol, pe);
    }
  } catch { /* 降級 */ }
  return map;
}

async function screenUS() {
  const settled = await Promise.allSettled(
    [...US_TICKERS, "SOXX"].map((t) => fetchChart(t)),
  );
  const charts = new Map<string, { closes: number[]; vols: number[] }>();
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value.closes.length >= 25) {
      charts.set(s.value.ticker, s.value);
    }
  }
  const soxx = charts.get("SOXX");
  if (!soxx) throw new Error("Yahoo Finance chart 資料取得失敗(含基準SOXX)");
  const soxxRet20 =
    soxx.closes.at(-1)! / soxx.closes.at(-21)! - 1;

  const pes = await fetchYahooValuations(US_TICKERS);
  const valuationAvailable = pes.size >= 5;

  const rows: any[] = [];
  for (const t of US_TICKERS) {
    const c = charts.get(t);
    if (!c) continue;
    const close = c.closes.at(-1)!;
    const ret20 = close / c.closes.at(-21)! - 1;
    const ma20 = mean(c.closes.slice(-20));
    rows.push({
      ticker: t,
      name: US_NAMES[t] ?? t,
      close,
      ret20,
      mom20: close / ma20 - 1,
      volSurge: mean(c.vols.slice(-5)) / mean(c.vols.slice(-20)),
      rs: ret20 - soxxRet20,
      fwdPe: pes.get(t) ?? NaN,
    });
  }

  return {
    market: "US",
    asOf: new Date().toISOString().slice(0, 10),
    universeSize: rows.length,
    valuationDegraded: !valuationAvailable,
    rows: scoreUS(rows, { valuationAvailable }),
    notes: [
      "籌碼替代分數:相對SOXX 20日超額報酬60% + 5日/20日量能比40%(免費源無分點/內部人日頻資料)",
      valuationAvailable
        ? "估值分數:Forward P/E 橫斷面便宜度(Yahoo Finance)"
        : "⚠ 估值源暫時不可用,本次估值層降級為中性50分",
      "觸發定義:相對強於SOXX、站上20日均線、量能≥1.2x",
    ],
  };
}

// ---------------- handler ----------------
export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const market = (url.searchParams.get("market") ?? "tw").toLowerCase();
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Netlify-CDN-Cache-Control": "public, s-maxage=1800, stale-while-revalidate=7200",
  };
  try {
    const data = market === "us" ? await screenUS() : await screenTaiwan();
    return new Response(
      JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), ...data }),
      { headers },
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e?.message ?? e) }),
      { status: 502, headers: { ...headers, "Netlify-CDN-Cache-Control": "no-store" } },
    );
  }
};

export const config: Config = {
  path: "/api/screen",
};
