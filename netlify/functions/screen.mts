// 每日選股 API:/api/screen?market=tw|us|etf&code=XXXX、/api/news?q=..&q2=..
// 資料源全為免費公開端點(TWSE OpenAPI / TWSE RWD / Yahoo Finance / Google News RSS)。
// TWSE www 端點有嚴格流量限制(約3請求/5秒):所有請求序列化+間隔,
// 且整組資料集存 Netlify Blobs 共用快取,25分鐘內的重複請求(含查詢代號
// 的不同快取鍵)不再回源。僅為研究用訊號清單,非投資建議。
import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { scoreTaiwan, scoreUS, scoreETF } from "./lib/scoring.mjs";

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 8000) {
  const res = await fetch(url, {
    ...init,
    headers: { ...UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url: string, timeoutMs = 8000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function taipeiDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 8 * 3600_000 - offsetDays * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

const num = (s: unknown): number => {
  const n = parseFloat(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/** 民國年月字串(如 11506)→ '2026/06' */
function rocYmToLabel(ym: unknown): string | null {
  const s = String(ym ?? "").replace(/\D/g, "");
  if (s.length < 4) return null;
  const mm = s.slice(-2);
  const y = parseInt(s.slice(0, -2), 10) + 1911;
  return Number.isFinite(y) ? `${y}/${mm}` : null;
}

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

// ---------------- Netlify Blobs 共用快取 ----------------
async function cachedJson<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  let store: ReturnType<typeof getStore> | null = null;
  try { store = getStore("market-cache"); } catch { /* 本地無blobs時直接回源 */ }
  if (store) {
    try {
      const hit: any = await store.get(key, { type: "json" });
      if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
    } catch {}
  }
  const data = await fetcher();
  if (store) { try { await store.setJSON(key, { at: Date.now(), data }); } catch {} }
  return data;
}

// ---------------- 台股題材標籤(常見權值/熱門股,人工整理;未收錄者顯示產業別) ----------------
const TW_THEMES: Record<string, string> = {
  "2330": "全球晶圓代工龍頭,先進製程與CoWoS先進封裝供不應求",
  "2317": "電子代工龍頭,AI伺服器組裝(GB系列)與電動車布局",
  "2454": "手機SoC龍頭,切入邊緣AI與雲端ASIC客製晶片",
  "2308": "電源管理龍頭,AI資料中心電源與液冷散熱方案",
  "2382": "AI伺服器主力組裝廠(雲端CSP大單)",
  "3231": "AI伺服器代工與GPU運算板",
  "6669": "超大規模資料中心白牌伺服器(Meta/微軟供應鏈)",
  "2376": "AI伺服器與電競板卡",
  "2377": "電競品牌與AI伺服器",
  "2357": "PC品牌廠,AI PC與伺服器雙引擎",
  "4938": "代工組裝與零組件(iPhone/伺服器)",
  "2324": "NB代工與伺服器",
  "2356": "伺服器與NB代工(AI伺服器L11)",
  "3706": "伺服器代工與AI邊緣運算",
  "3017": "散熱模組龍頭,AI伺服器氣冷+液冷",
  "3324": "AI伺服器水冷板與散熱模組",
  "3653": "均熱片與散熱基板(GPU供應鏈)",
  "2059": "伺服器滑軌龍頭(機櫃導軌)",
  "2301": "電源供應器與AI資料中心電源",
  "2385": "電源供應器與鍵鼠模組",
  "6409": "不斷電系統(UPS)隱形冠軍",
  "2303": "成熟製程晶圓代工",
  "3711": "封測龍頭,先進封裝與測試",
  "3037": "ABF載板三雄之一,AI晶片載板",
  "8046": "ABF載板,高階HPC應用",
  "2368": "伺服器PCB(AI加速卡厚板)",
  "2313": "HDI高密度板(手機/衛星)",
  "6213": "CCL銅箔基板",
  "2383": "高階CCL銅箔基板,AI伺服器M8等級用料",
  "2379": "網通IC設計(交換器/WiFi)",
  "3034": "面板驅動IC與SoC",
  "2408": "DRAM記憶體(HBM題材外圍)",
  "3443": "ASIC設計服務(台積電集團,AI晶片NRE)",
  "3661": "高階ASIC設計服務,北美AI客戶",
  "3529": "嵌入式記憶體IP(先進製程授權)",
  "5269": "高速傳輸介面IC",
  "6415": "電源管理IC",
  "2345": "資料中心交換器(400G/800G)龍頭",
  "3008": "手機光學鏡頭龍頭",
  "3406": "光學鏡頭(VR/手機)",
  "2409": "TFT面板",
  "3481": "TFT面板",
  "1513": "重電統包工程,台電強韌電網計畫",
  "1519": "變壓器外銷美國,電網+AI資料中心供電",
  "1504": "工業馬達與重電,機器人關節布局",
  "1503": "重電變壓器與配電",
  "2360": "半導體與電動車量測設備",
  "3131": "先進封裝濕製程設備(CoWoS供應鏈)",
  "3583": "半導體再生晶圓與設備",
  "2049": "線性滑軌與滾珠螺桿(自動化/機器人)",
  "1590": "氣動元件(自動化,中國市場)",
  "2603": "貨櫃航運(長榮海運)",
  "2609": "貨櫃航運",
  "2615": "貨櫃航運(近洋線)",
  "2618": "航空客貨運",
  "2610": "航空客貨運",
  "2002": "一貫化鋼廠龍頭",
  "1101": "水泥本業+儲能/低碳轉型",
  "1301": "塑化集團龍頭",
  "1303": "塑化(電子級材料)",
  "6505": "煉油與石化",
  "1216": "食品飲料龍頭集團(統一超商/星巴克/家樂福母公司),內需防禦型",
  "2912": "超商通路龍頭(7-ELEVEN)",
  "2207": "汽車總代理龍頭(Toyota/Lexus)",
  "2105": "輪胎(全球佈局)",
  "9910": "運動鞋代工(Nike核心供應商)",
  "9904": "製鞋代工與通路(寶勝)",
  "2881": "金控(富邦,壽險+銀行)",
  "2882": "金控(國泰,壽險龍頭)",
  "2884": "金控(玉山,銀行為主)",
  "2885": "金控(元大,證券龍頭)",
  "2886": "金控(兆豐,官股外匯銀行)",
  "2891": "金控(中信,銀行獲利王)",
  "2892": "金控(第一,官股銀行)",
  "5880": "金控(合庫,官股)",
  "5871": "租賃龍頭(兩岸中小企業金融)",
  "2412": "電信龍頭,防禦型高股息",
  "3045": "電信三雄,資通訊整合",
  "4904": "電信三雄,5G企業專網",
  "2542": "營建開發商(雙北推案),資產題材與升息敏感",
  "2545": "營建開發(北台灣豪宅)",
  "9945": "營建與潤泰集團資產(南山人壽)",
  // ---- 上櫃 ----
  "5347": "成熟製程晶圓代工(台積電轉投資)",
  "6488": "半導體矽晶圓大廠",
  "5483": "矽晶圓與再生能源(環球晶母公司)",
  "8069": "電子紙獨家龍頭(ESL標籤/電子書)",
  "5274": "伺服器遠端管理晶片(BMC)獨佔,AI伺服器必備",
  "4966": "高速傳輸介面IC(Retimer,AI伺服器)",
  "8299": "NAND快閃記憶體控制晶片",
  "3293": "遊戲機台與線上博弈遊戲(金雞母)",
  "6180": "遊戲營運(遊戲橘子)與金流/電商轉投資",
  "3105": "砷化鎵晶圓代工(射頻PA)",
  "6510": "半導體測試介面板(探針卡)",
  "6446": "生技新藥(罕病藥P1101外銷美國)",
  "1565": "隱形眼鏡代工(星歐)",
  "5425": "半導體通路與台半二極體",
};

// ---------------- 台股 ----------------
/** T86 三大法人:由今日往回序列抓,湊滿5個交易日即停(www.twse流量限制嚴格,不可平行)。 */
async function fetchT86Days(maxDays = 5) {
  const days: { date: string; j: any }[] = [];
  for (let i = 0; i < 12 && days.length < maxDays; i++) {
    const date = taipeiDate(i);
    try {
      const j = await fetchJson(
        `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${date}&selectType=ALLBUT0999`,
        {}, 6000,
      );
      if (j?.stat === "OK" && j?.data?.length) days.push({ date, j });
    } catch {}
    if (days.length < maxDays && i < 11) await sleep(250);
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** 去年最後交易日全市場收盤(YTD基準)。整年不變 → blob 快取30天。 */
async function fetchPrevYearEndCloses(): Promise<Record<string, number>> {
  const year = new Date(Date.now() + 8 * 3600_000).getUTCFullYear() - 1;
  return cachedJson(`prevye-${year}`, 30 * 86400_000, async () => {
    const map: Record<string, number> = {};
    for (const md of ["1231", "1230", "1229", "1228"]) {
      try {
        const j = await fetchJson(
          `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&date=${year}${md}&type=ALLBUT0999`,
          {}, 8000,
        );
        if (j?.stat === "OK") {
          const tables = j.tables ?? [j];
          const tbl = tables.find(
            (t: any) => Array.isArray(t?.fields) && t.fields.includes("證券代號") && t.fields.includes("收盤價"),
          );
          if (tbl) {
            const iC = tbl.fields.indexOf("證券代號");
            const iP = tbl.fields.indexOf("收盤價");
            for (const row of tbl.data ?? []) {
              const p = num(row[iP]);
              if (p > 0) map[String(row[iC]).trim()] = p;
            }
            if (Object.keys(map).length) return map;
          }
        }
      } catch {}
      await sleep(300);
    }
    return map;
  });
}

// ---------------- FinMind(上櫃資料源)----------------
// TPEX 官網與 openapi 皆封鎖境外IP(Netlify主機在美國,台灣瀏覽器可通、
// 伺服器不可),故上櫃改用 FinMind 整合源(GCP,無地區限制,涵蓋上櫃
// 法人/報價/本益比/月營收)。可於 Netlify 環境變數設 FINMIND_TOKEN
// (免費註冊)以提高流量上限;未設亦可低量使用。
const FINMIND = "https://api.finmindtrade.com/api/v4/data";

function fmToken(): string {
  try { return (globalThis as any).Netlify?.env?.get?.("FINMIND_TOKEN") ?? ""; } catch { return ""; }
}

async function fmQuery(dataset: string, params: string, timeoutMs = 9000): Promise<any[]> {
  const tok = fmToken();
  // FinMind v4 認證:優先用 Authorization: Bearer 標頭(官方現行方式),
  // 同時附上 token 查詢參數以相容舊版。無 token 會回 400(v4 強制認證)。
  const init: RequestInit = tok ? { headers: { Authorization: `Bearer ${tok}` } } : {};
  const j = await fetchJson(
    `${FINMIND}?dataset=${dataset}&${params}${tok ? `&token=${encodeURIComponent(tok)}` : ""}`,
    init, timeoutMs,
  );
  if (j?.status && j.status !== 200) throw new Error(`FinMind ${dataset}:${j?.msg ?? j.status}`);
  return Array.isArray(j?.data) ? j.data : [];
}

const isoDate = (offsetDays = 0) =>
  new Date(Date.now() + 8 * 3600_000 - offsetDays * 86400_000).toISOString().slice(0, 10);

/** FinMind 法人買賣超:近9個日曆日逐日平行查(全市場),取最近5個交易日。 */
async function fetchFinMindInstiDays(maxDays = 5) {
  const diag: string[] = [];
  const settled = await Promise.allSettled(
    Array.from({ length: 9 }, (_, i) => {
      const d = isoDate(i);
      return fmQuery(
        "TaiwanStockInstitutionalInvestorsBuySell",
        `start_date=${d}&end_date=${d}`, 9500,
      ).then((rows) => ({ d, rows }));
    }),
  );
  const days: { d: string; rows: any[] }[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") {
      if (s.value.rows.length) days.push(s.value);
    } else {
      diag.push(String((s.reason as any)?.message ?? s.reason).slice(0, 90));
    }
  }
  days.sort((a, b) => a.d.localeCompare(b.d));
  return { days: days.slice(-maxDays), diag: [...new Set(diag)].slice(0, 3) };
}

type ChipAcc = { name: string; nets: number[]; foreignSum: number; trustSum: number; otc?: boolean };

/** 將一組(fields,data)的法人表累加進 chips。外資欄位含「(不含外資自營商)」
 *  字樣,不可用排除「自營」的方式比對(v5前的bug:外資被算成0)。 */
function addChipDays(
  chips: Map<string, ChipAcc>,
  days: { fields: string[]; data: any[][] }[],
  nDays: number, startIdx: number, otc: boolean,
) {
  days.forEach((day, k) => {
    const fields = day.fields;
    const iCode = fields.findIndex((f) => f.includes("代號"));
    const iName = fields.findIndex((f) => f.includes("名稱"));
    const iForeign = fields.findIndex(
      (f) => (f.includes("外陸資") || f.includes("外資及陸資")) && f.includes("買賣超") &&
             !f.startsWith("外資自營商") && !f.includes("-外資自營商"),
    );
    const iTrust = fields.findIndex((f) => f.includes("投信") && f.includes("買賣超"));
    if (iCode < 0 || iForeign < 0) return;
    for (const row of day.data) {
      const code = String(row[iCode]).trim();
      if (!/^\d{4}$/.test(code)) continue;
      let acc = chips.get(code);
      if (!acc) {
        acc = { name: iName >= 0 ? String(row[iName]).trim() : "", nets: new Array(nDays).fill(0), foreignSum: 0, trustSum: 0, otc };
        chips.set(code, acc);
      }
      const f = num(row[iForeign]) || 0;
      const t = iTrust >= 0 ? (num(row[iTrust]) || 0) : 0;
      acc.nets[startIdx + k] = f + t;
      acc.foreignSum += f;
      acc.trustSum += t;
    }
  });
}

/** 月營收陣列(上市/上櫃同格式)併入 revMap,欄位名模糊比對。 */
function addRevRows(revMap: Map<string, any>, revAll: any[]) {
  if (!Array.isArray(revAll) || !revAll.length) return;
  const keys = Object.keys(revAll[0]);
  const kCode = keys.find((k) => k.includes("公司代號"));
  const kInd = keys.find((k) => k.includes("產業別"));
  const kYoY = keys.find((k) => k.includes("去年同月增減"));
  const kAcc = keys.find((k) => k.includes("前期比較增減") || k.includes("去年累計增減"));
  const kYm = keys.find((k) => k.includes("資料年月"));
  if (!kCode || !kYoY) return;
  for (const r of revAll) {
    revMap.set(String(r[kCode]).trim(), {
      industry: kInd ? String(r[kInd]).trim() : null,
      revYoY: num(r[kYoY]),
      revAccYoY: kAcc ? num(r[kAcc]) : NaN,
      revLabel: kYm ? rocYmToLabel(r[kYm]) : null,
    });
  }
}

/** 台股完整資料集(上市+上櫃合併rows),blob 快取25分鐘。 */
async function buildTwDataset() {
  const prevYE = await fetchPrevYearEndCloses().catch(() => ({} as Record<string, number>));

  // 上市(TWSE T86,序列)與 FinMind 法人(平行逐日)同時進行
  const [t86Days, fmInsti] = await Promise.all([fetchT86Days(), fetchFinMindInstiDays()]);
  if (t86Days.length < 3)
    throw new Error(`TWSE T86 資料不足(近12日僅取得${t86Days.length}日,可能為證交所流量限制,請1-2分鐘後再試)`);
  const lastFmDay = fmInsti.days.at(-1)?.d ?? null;

  let revErr: string | null = null;
  let fmPriceErr: string | null = null;
  const [priceAll, valAll, revL, fmPrice, fmPER, fmRevCur, fmRevPrev] = await Promise.all([
    fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"),
    fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL"),
    fetchJson("https://openapi.twse.com.tw/v1/opendata/t187ap05_L", {}, 12000).catch(
      (e) => { revErr = String(e?.message ?? e); return []; },
    ),
    lastFmDay
      ? fmQuery("TaiwanStockPrice", `start_date=${lastFmDay}&end_date=${lastFmDay}`, 9500).catch(
          (e) => { fmPriceErr = String(e?.message ?? e).slice(0, 90); return []; },
        )
      : Promise.resolve([]),
    lastFmDay
      ? fmQuery("TaiwanStockPER", `start_date=${lastFmDay}&end_date=${lastFmDay}`, 9500).catch(() => [])
      : Promise.resolve([]),
    fmQuery("TaiwanStockMonthRevenue", `start_date=${isoDate(75)}&end_date=${isoDate(0)}`, 9500).catch(() => []),
    fmQuery("TaiwanStockMonthRevenue", `start_date=${isoDate(75 + 365)}&end_date=${isoDate(300)}`, 9500).catch(() => []),
  ]);

  const revMap = new Map<string, any>();
  addRevRows(revMap, revL);

  // 上市法人序列(T86)
  const chips = new Map<string, ChipAcc>();
  addChipDays(
    chips,
    t86Days.map((d) => ({ fields: d.j.fields, data: d.j.data })),
    t86Days.length, 0, false,
  );

  // FinMind 法人序列(涵蓋上市+上櫃;僅用於 T86 沒有的代號 = 上櫃)
  const tpexChips = new Map<string, ChipAcc>();
  fmInsti.days.forEach((day, k) => {
    for (const r of day.rows) {
      const code = String(r.stock_id ?? "").trim();
      if (!/^\d{4}$/.test(code) || chips.has(code)) continue;
      const net = (num(r.buy) || 0) - (num(r.sell) || 0);
      const isForeign = r.name === "Foreign_Investor";
      const isTrust = r.name === "Investment_Trust";
      if (!isForeign && !isTrust) continue;
      let acc = tpexChips.get(code);
      if (!acc) {
        acc = { name: "", nets: new Array(fmInsti.days.length).fill(0), foreignSum: 0, trustSum: 0, otc: true };
        tpexChips.set(code, acc);
      }
      acc.nets[k] += net;
      if (isForeign) acc.foreignSum += net;
      else acc.trustSum += net;
    }
  });

  // FinMind 上櫃月營收:最近一期 vs 去年同月 → 年增率,併入 revMap
  if (Array.isArray(fmRevCur) && fmRevCur.length) {
    const latest = new Map<string, any>();
    for (const r of fmRevCur) {
      const cur = latest.get(r.stock_id);
      if (!cur || r.revenue_year * 100 + r.revenue_month > cur.revenue_year * 100 + cur.revenue_month)
        latest.set(r.stock_id, r);
    }
    const prevKeyed = new Map<string, number>();
    for (const r of fmRevPrev ?? [])
      prevKeyed.set(`${r.stock_id}-${r.revenue_year}-${r.revenue_month}`, num(r.revenue));
    for (const [sid, r] of latest) {
      if (revMap.has(sid)) continue; // 上市已有官方彙總
      const prev = prevKeyed.get(`${sid}-${r.revenue_year - 1}-${r.revenue_month}`);
      if (prev && prev > 0 && num(r.revenue) > 0) {
        revMap.set(sid, {
          industry: null,
          revYoY: (num(r.revenue) / prev - 1) * 100,
          revAccYoY: NaN,
          revLabel: `${r.revenue_year}/${String(r.revenue_month).padStart(2, "0")}`,
        });
      }
    }
  }

  const valMap = new Map<string, any>();
  for (const v of valAll) valMap.set(v.Code, v);

  const rows: any[] = [];
  const pushRow = (code: string, name: string, close: number, volume: number,
                   turnover: number, acc: ChipAcc, pe: number, pb: number, dy: number) => {
    const f = revMap.get(code) ?? {};
    const base = prevYE[code];
    rows.push({
      code,
      name: name || acc.name,
      close, volume, turnover,
      nets: acc.nets,
      foreignSum: acc.foreignSum,
      trustSum: acc.trustSum,
      pe, pb, dividendYield: dy,
      industry: f.industry ?? null,
      theme: TW_THEMES[code] ?? null,
      revYoY: f.revYoY ?? NaN,
      revAccYoY: f.revAccYoY ?? NaN,
      revLabel: f.revLabel ?? null,
      revMapLoaded: revMap.size > 0,
      ytd: base && base > 0 && close > 0 ? ((close / base) - 1) * 100 : NaN,
      otc: !!acc.otc,
    });
  };

  // 上市
  for (const p of priceAll) {
    const acc = chips.get(p.Code);
    if (!acc) continue;
    const v = valMap.get(p.Code) ?? {};
    pushRow(p.Code, p.Name, num(p.ClosingPrice), num(p.TradeVolume), num(p.TradeValue),
            acc, num(v.PEratio), num(v.PBratio), num(v.DividendYield));
  }

  // 上櫃(FinMind):以法人涵蓋的代號為主,配 FinMind 當日報價與本益比。
  // FinMind TaiwanStockPrice 涵蓋上市+上櫃,僅取 T86 沒有的代號(=上櫃)。
  const fmPriceMap = new Map<string, any>();
  for (const r of fmPrice ?? []) fmPriceMap.set(String(r.stock_id).trim(), r);
  const fmPerMap = new Map<string, any>();
  for (const r of fmPER ?? []) fmPerMap.set(String(r.stock_id).trim(), r);

  let otcCount = 0;
  for (const [code, acc] of tpexChips) {
    const p = fmPriceMap.get(code);
    if (!p) continue; // 無報價則跳過(FinMind當日資料不足)
    const per = fmPerMap.get(code) ?? {};
    const close = num(p.close);
    const shares = num(p.Trading_Volume); // 股
    const amt = num(p.Trading_money);      // 元
    if (!(close > 0) || !(amt >= 300_000_000)) continue; // 同上市:成交金額門檻
    pushRow(code, String(p.stock_name ?? p.name ?? "").trim() || code, close, shares, amt,
            acc, num(per.PER), num(per.PBR), num(per.dividend_yield));
    otcCount++;
  }

  return {
    asOf: t86Days[t86Days.length - 1].date,
    rows,
    revCount: revMap.size,
    revErr,
    prevYECount: Object.keys(prevYE).length,
    otcCount,
    otcChipDays: fmInsti.days.length,
    otcDiag: {
      instiDays: fmInsti.days.length,
      instiCodes: tpexChips.size,
      price: fmPriceErr ?? `OK(${Array.isArray(fmPrice) ? fmPrice.length : 0}檔)`,
      errors: fmInsti.diag,
      token: fmToken() ? "有" : "無(免費低量)",
    },
  };
}

async function screenTaiwan(pick: string | null = null) {
  const ds: any = await cachedJson(`tw-dataset5-${taipeiDate(0)}`, 25 * 60_000, buildTwDataset);
  const scored = scoreTaiwan(ds.rows, { pick });
  return {
    market: "TW",
    asOf: ds.asOf,
    universeSize: ds.rows.length,
    rows: scored.rows,
    picked: scored.picked,
    pickedError: pick && !scored.picked
      ? `查無「${pick}」——查詢範圍為上市+上櫃普通股,且需通過流動性門檻(當日成交金額≥3億)${
          ds.otcCount
            ? ""
            : `;⚠ 本次上櫃(FinMind)未取得【診斷】法人代號數:${ds.otcDiag?.instiCodes ?? 0};報價:${ds.otcDiag?.price};token:${ds.otcDiag?.token}${
                (ds.otcDiag?.errors ?? []).length ? ",錯誤:" + ds.otcDiag.errors.join(" | ") : ""
              }`
        }`
      : null,
    notes: [
      "涵蓋範圍:上市(TWSE)+ 上櫃(TPEX)普通股;籌碼分數:外資+投信近5日連買天數×買超強度之橫斷面百分位",
      ds.otcCount > 0
        ? `上櫃已納入 ${ds.otcCount} 檔(FinMind 法人 ${ds.otcChipDays} 日);上櫃YTD暫無(缺去年底基準)`
        : `⚠ 上櫃(FinMind)本次未取得,僅涵蓋上市【診斷】法人代號:${ds.otcDiag?.instiCodes ?? 0};報價:${ds.otcDiag?.price};token:${ds.otcDiag?.token}${(ds.otcDiag?.errors ?? []).length ? ",錯誤:" + ds.otcDiag.errors.join(" | ") : ""}`,
      "估值分數:P/E 橫斷面便宜度70% + 殖利率排名30%",
      ds.revCount > 0
        ? `基本面:月營收彙總已載入 ${ds.revCount} 家(公告期間未申報者摘要會註明);常見標的另有人工題材標籤`
        : `⚠ 月營收資料源未取得${ds.revErr ? `(${ds.revErr})` : ""},本次摘要缺基本面段落`,
      ds.prevYECount > 0
        ? `YTD 以去年最後交易日收盤為基準(上市 ${ds.prevYECount} 檔)`
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
  return { ticker, closes, vols, ts };
}

async function fetchYahooValuations(
  tickers: string[],
): Promise<Record<string, { pe: number | null; epsGrowth: number | null }>> {
  const map: Record<string, { pe: number | null; epsGrowth: number | null }> = {};
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
          : null;
      if (pe > 0 || epsGrowth != null)
        map[q.symbol] = { pe: pe > 0 ? pe : null, epsGrowth };
    }
  } catch { /* 降級 */ }
  return map;
}

async function buildUsDataset() {
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
  const soxxRet20 = soxx.closes.at(-1)! / soxx.closes.at(-21)! - 1;

  const vals = await fetchYahooValuations(US_TICKERS);
  const valuationAvailable = Object.keys(vals).length >= 5;

  const rows: any[] = [];
  for (const t of US_TICKERS) {
    const c = charts.get(t);
    if (!c) continue;
    const close = c.closes.at(-1)!;
    const ret20 = close / c.closes.at(-21)! - 1;
    const ma20 = mean(c.closes.slice(-20));
    const v = vals[t];
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
      ytd: ytdFrom(c.closes, c.ts),
    });
  }
  return { rows, valuationAvailable };
}

async function screenUS(pick: string | null = null) {
  const ds = await cachedJson("us-dataset", 25 * 60_000, buildUsDataset);
  const scored = scoreUS(ds.rows, { valuationAvailable: ds.valuationAvailable, pick });
  return {
    market: "US",
    asOf: new Date().toISOString().slice(0, 10),
    universeSize: ds.rows.length,
    valuationDegraded: !ds.valuationAvailable,
    rows: scored.rows,
    picked: scored.picked,
    pickedError: pick && !scored.picked
      ? `查無「${pick}」——美股查詢範圍目前限定 ${US_TICKERS.length} 檔 NDX/SOX 追蹤清單:${US_TICKERS.join("、")}`
      : null,
    notes: [
      "籌碼替代分數:相對SOXX 20日超額報酬60% + 5日/20日量能比40%(免費源無分點/內部人日頻資料)",
      ds.valuationAvailable
        ? "估值分數:Forward P/E 橫斷面便宜度;摘要含預估EPS成長與題材標籤(Yahoo Finance)"
        : "⚠ 估值源暫時不可用,本次估值層降級為中性50分",
      "觸發定義:相對強於SOXX、站上20日均線、量能≥1.2x;YTD以去年底收盤為基準",
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

async function buildEtfDataset() {
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
  return { rows, failed };
}

async function screenETFs() {
  const ds = await cachedJson("etf-dataset", 6 * 3600_000, buildEtfDataset);
  return {
    market: "ETF",
    asOf: new Date().toISOString().slice(0, 10),
    universeSize: ds.rows.length,
    rows: scoreETF(ds.rows, { threshold: 0.05 }),
    notes: [
      "年化報酬與YTD以還原股息之調整價(adjusted close)計算 = 含息總報酬;✓達標 = 年化報酬≥5%且成立滿3年",
      "排序:達標者優先,再依風險調整報酬(年化報酬÷年化波動)由高至低——「穩健」看的是這一欄,不是報酬絕對值",
      "近5年涵蓋2024多頭與2025回檔,數字已含一次完整循環;過去績效不保證未來報酬",
      ...(ds.failed.length ? [`⚠ 本次未能取得:${ds.failed.join("、")}(資料源無回應)`] : []),
    ],
  };
}

// ---------------- 新聞題材 ----------------
/** Google News RSS(相關性佳,台股中文新聞主力來源)。 */
function parseRss(xml: string) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const g = (tag: string) => {
      const mm = m[1].match(
        new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`),
      );
      return mm ? mm[1].trim() : "";
    };
    const pub = g("pubDate");
    return {
      title: g("title").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      publisher: g("source").replace(/<[^>]+>/g, ""),
      link: g("link"),
      time: pub ? new Date(pub).toISOString() : null,
    };
  }).filter((n) => n.title && n.link).slice(0, 6);
}

async function fetchGoogleNews(query: string, zh: boolean) {
  const loc = zh ? "hl=zh-TW&gl=TW&ceid=TW:zh-Hant" : "hl=en-US&gl=US&ceid=US:en";
  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${loc}`, 6000,
  );
  return parseRss(xml);
}

/** Yahoo 搜尋新聞,以 relatedTickers 過濾確保與標的相關。 */
async function fetchYahooNewsFiltered(symbol: string) {
  const j = await fetchJson(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=10&quotesCount=0`,
    {}, 6000,
  );
  return (j?.news ?? [])
    .filter((n: any) => (n.relatedTickers ?? []).includes(symbol))
    .slice(0, 6)
    .map((n: any) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    }));
}

/** q: 代號(台股為 XXXX.TW)、q2: 中文名稱(台股)。 */
async function fetchNews(q: string, q2: string | null) {
  const isTW = /\.TW$/i.test(q) || /[^\x00-\x7F]/.test(q2 ?? "");
  if (isTW) {
    const code = q.replace(/\.TW$/i, "");
    const queries = [
      q2 ? `"${q2}" ${code}` : code,   // 精確名稱+代號
      q2 ? `${q2} 股` : `${code} 台股`, // 放寬
    ];
    for (const query of queries) {
      try {
        const n = await fetchGoogleNews(query, true);
        if (n.length) return n;
      } catch {}
    }
    try { return await fetchYahooNewsFiltered(q.toUpperCase()); } catch {}
    return [];
  }
  try {
    const n = await fetchYahooNewsFiltered(q.toUpperCase());
    if (n.length) return n;
  } catch {}
  try { return await fetchGoogleNews(`${q} stock`, false); } catch {}
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
      ? "public, s-maxage=21600, stale-while-revalidate=86400"
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
