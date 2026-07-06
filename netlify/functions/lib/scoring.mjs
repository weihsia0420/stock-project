// 純函式運算層:與資料抓取解耦,可在無網路環境下單元測試。
// 對應 docs/architecture.md 的 signals + composer 簡化版(MVP)。

/** 橫斷面百分位排名 (0..1)。values 中的 NaN 不參與排名。 */
export function percentileRank(values, v) {
  const arr = values.filter((x) => Number.isFinite(x));
  if (!arr.length || !Number.isFinite(v)) return NaN;
  let below = 0;
  for (const x of arr) if (x < v) below++;
  return below / arr.length;
}

/** 從最新日往回數連續正值天數。dayNets: 舊→新。 */
export function streakOf(dayNets) {
  let s = 0;
  for (let i = dayNets.length - 1; i >= 0; i--) {
    if (dayNets[i] > 0) s++;
    else break;
  }
  return s;
}

/**
 * 台股評分。
 * rows: [{ code, name, close, volume(股), turnover(元),
 *          nets: 舊→新 每日(外資+投信)買賣超股數, foreignSum, trustSum,
 *          pe, pb, dividendYield }]
 * 回傳含 chipScore / valScore / totalScore / triggered / reasons 的陣列。
 */
export function scoreTaiwan(rows, opts = {}) {
  const {
    wChip = 0.6,
    wVal = 0.4,
    minTurnover = 300_000_000, // 流動性門檻:當日成交金額 >= 3億
    streakTrigger = 3,
    intensityTrigger = 0.05,
    pick = null,
  } = opts;

  const universe = rows.filter(
    (r) => r.close > 0 && r.turnover >= minTurnover && r.nets.length >= 3,
  );

  for (const r of universe) {
    r.streak = streakOf(r.nets);
    const sum5 = r.nets.reduce((a, b) => a + b, 0);
    r.netSum = sum5;
    // 買超強度:近N日累計買超 / 近N日估計總量(以今日量近似)
    r.intensity = r.volume > 0 ? sum5 / (r.volume * r.nets.length) : 0;
    r.chipRaw = r.streak * Math.max(r.intensity, 0);
  }

  const chipRaws = universe.map((r) => r.chipRaw);
  const pes = universe.map((r) => (r.pe > 0 ? r.pe : NaN));
  const yields = universe.map((r) =>
    Number.isFinite(r.dividendYield) ? r.dividendYield : NaN,
  );

  for (const r of universe) {
    r.chipScore = Math.round(percentileRank(chipRaws, r.chipRaw) * 100);
    if (r.pe > 0) {
      const cheap = 1 - percentileRank(pes, r.pe); // P/E越低越便宜
      const yr = Number.isFinite(r.dividendYield)
        ? percentileRank(yields, r.dividendYield)
        : 0.5;
      r.valScore = Math.round((0.7 * cheap + 0.3 * yr) * 100);
    } else {
      r.valScore = 50; // 無P/E(虧損或缺值)→ 中性,不給便宜加分
    }
    r.totalScore = Math.round(wChip * r.chipScore + wVal * r.valScore);
    r.triggered = r.streak >= streakTrigger && r.intensity >= intensityTrigger;

    r.reasons = [];
    if (r.streak >= 2) r.reasons.push(`法人連買${r.streak}日`);
    if (r.intensity > 0.005)
      r.reasons.push(`${r.nets.length}日買超佔量${(r.intensity * 100).toFixed(1)}%`);
    if (r.foreignSum > 0 && r.trustSum > 0) r.reasons.push("外資投信同買");
    if (r.pe > 0 && r.valScore >= 60) r.reasons.push(`P/E ${r.pe.toFixed(1)} 相對便宜`);
    if (r.dividendYield >= 3) r.reasons.push(`殖利率${r.dividendYield.toFixed(1)}%`);
    r.summary = buildTwSummary(r);
  }

  return rank(universe, pick);
}

/**
 * 美股評分。
 * rows: [{ ticker, name, close, ret20, mom20(相對20MA), volSurge(5日/20日量比),
 *          rs(相對SOXX 20日超額報酬), fwdPe }]
 */
export function scoreUS(rows, opts = {}) {
  const { wChip = 0.6, wVal = 0.4, valuationAvailable = true, pick = null } = opts;

  const universe = rows.filter((r) => r.close > 0 && Number.isFinite(r.ret20));

  for (const r of universe) {
    r.chipRaw = 0.6 * (Number.isFinite(r.rs) ? r.rs : 0) +
      0.4 * (Number.isFinite(r.volSurge) ? r.volSurge - 1 : 0);
  }
  const chipRaws = universe.map((r) => r.chipRaw);
  const pes = universe.map((r) => (r.fwdPe > 0 ? r.fwdPe : NaN));

  for (const r of universe) {
    r.chipScore = Math.round(percentileRank(chipRaws, r.chipRaw) * 100);
    if (valuationAvailable && r.fwdPe > 0) {
      r.valScore = Math.round((1 - percentileRank(pes, r.fwdPe)) * 100);
    } else {
      r.valScore = 50;
    }
    r.totalScore = Math.round(wChip * r.chipScore + wVal * r.valScore);
    r.triggered =
      (r.rs ?? 0) > 0 && (r.mom20 ?? 0) > 0 && (r.volSurge ?? 0) >= 1.2;

    r.reasons = [];
    if (Number.isFinite(r.rs))
      r.reasons.push(`相對SOXX ${r.rs >= 0 ? "+" : ""}${(r.rs * 100).toFixed(1)}%`);
    if (Number.isFinite(r.volSurge) && r.volSurge >= 1.1)
      r.reasons.push(`量能放大${r.volSurge.toFixed(2)}x`);
    if (Number.isFinite(r.mom20) && r.mom20 > 0)
      r.reasons.push(`站上20日均線+${(r.mom20 * 100).toFixed(1)}%`);
    if (r.fwdPe > 0 && r.valScore >= 60)
      r.reasons.push(`Fwd P/E ${r.fwdPe.toFixed(1)} 相對便宜`);
    r.summary = buildUsSummary(r);
  }

  return rank(universe, pick);
}

const trimRow = (r) => ({
  code: r.code ?? r.ticker,
  name: r.name ?? "",
  close: r.close,
  ytd: Number.isFinite(r.ytd) ? +r.ytd.toFixed(1) : null,
  chipScore: r.chipScore,
  valScore: r.valScore,
  totalScore: r.totalScore,
  triggered: r.triggered,
  reasons: r.reasons,
  summary: r.summary ?? "",
});

/** 排序:triggered 優先,再依 totalScore 降冪。
 *  回傳 { rows: 前25名, picked: 指定代號之完整結果(含全universe排名)|null } */
function rank(universe, pick) {
  universe.sort((a, b) => {
    if (a.triggered !== b.triggered) return a.triggered ? -1 : 1;
    return b.totalScore - a.totalScore;
  });
  let picked = null;
  if (pick) {
    const key = String(pick).trim().toUpperCase();
    const idx = universe.findIndex(
      (r) => String(r.code ?? r.ticker).toUpperCase() === key,
    );
    if (idx >= 0)
      picked = { ...trimRow(universe[idx]), rank: idx + 1, of: universe.length };
  }
  return { rows: universe.slice(0, 25).map(trimRow), picked };
}

// ================= 智能摘要(規則式,由實際數據生成) =================

export function buildTwSummary(r) {
  const lots = Math.round(r.netSum / 1000);
  const p = [];
  // 基本面/題材(TWSE 月營收彙總:單月與累計年增率;常見標的另有人工題材標籤)
  if (r.industry) p.push(`【${r.industry}】`);
  if (r.theme) p.push(`${r.theme}。`);
  if (Number.isFinite(r.revYoY)) {
    p.push(
      `${r.revLabel ?? "最新"}單月營收年${r.revYoY >= 0 ? "增" : "減"}${Math.abs(r.revYoY).toFixed(1)}%` +
        (Number.isFinite(r.revAccYoY)
          ? `、累計年${r.revAccYoY >= 0 ? "增" : "減"}${Math.abs(r.revAccYoY).toFixed(1)}%`
          : "") + "。",
    );
    if (r.revYoY >= 20 && (r.revAccYoY ?? 0) >= 10)
      p.push("營收動能強勁,基本面支持籌碼訊號——這是推薦置信度最高的組合。");
    else if (r.revYoY >= 0)
      p.push("營運穩健成長。");
    else
      p.push("⚠ 營收年減,法人買盤與基本面背離,可能是預期落底行情,需自行判斷題材(見下方新聞)。");
  } else {
    p.push(
      r.revMapLoaded
        ? "(該公司尚未公告最新一期月營收,基本面判讀暫缺)"
        : "(月營收資料源暫時無回應,基本面判讀暫缺)",
    );
  }
  if (Number.isFinite(r.ytd))
    p.push(`今年以來股價${r.ytd >= 0 ? "上漲" : "下跌"}${Math.abs(r.ytd).toFixed(1)}%。`);
  p.push(
    `外資+投信近${r.nets.length}日合計${lots >= 0 ? "買超" : "賣超"}約${Math.abs(lots).toLocaleString()}張` +
      (r.streak >= 2 ? `、已連續${r.streak}日站在買方` : "") +
      `,買超強度佔總成交量${(r.intensity * 100).toFixed(1)}%,籌碼動能位居全市場第${r.chipScore}百分位。`,
  );
  if (r.foreignSum > 0 && r.trustSum > 0)
    p.push("外資與投信同步買進,法人共識度較高。");
  else if (r.trustSum > 0 && r.foreignSum <= 0)
    p.push("買盤以投信為主(留意3/6/9/12月季底作帳期的訊號虛高效應)。");
  else if (r.foreignSum > 0)
    p.push("買盤以外資為主。");
  if (r.pe > 0) {
    p.push(
      `本益比${r.pe.toFixed(1)}倍,估值分${r.valScore}(越高代表相對universe越便宜)` +
        (r.dividendYield >= 3 ? `,殖利率${r.dividendYield.toFixed(1)}%提供下檔保護。` : "。"),
    );
  } else {
    p.push("無本益比資料(近四季虧損或資料缺漏),估值層以中性50分計。");
  }
  p.push(
    r.triggered
      ? "已達觸發門檻(連買≥3日且強度≥5%),列為候選訊號——請人工複核基本面與題材後再決策。"
      : "尚未達觸發門檻,列為觀察名單。",
  );
  if (r.valScore < 40)
    p.push("⚠ 估值分偏低,屬動能追價型訊號,回檔風險較高。");
  return p.join("");
}

export function buildUsSummary(r) {
  let fund = "";
  if (r.theme) fund += `【題材】${r.theme}。`;
  if (Number.isFinite(r.epsGrowth)) {
    fund +=
      `市場預估未來EPS較近12個月${r.epsGrowth >= 0 ? "成長" : "衰退"}${Math.abs(r.epsGrowth * 100).toFixed(0)}%` +
      (r.epsGrowth >= 0.15 ? ",獲利動能為推薦主因之一。" : r.epsGrowth >= 0 ? ",獲利溫和成長。" : ",⚠ 獲利預估下修中,訊號僅屬技術面。");
  }
  const p = [];
  if (Number.isFinite(r.rs))
    p.push(
      `近20日報酬${r.rs >= 0 ? "領先" : "落後"}半導體指數ETF(SOXX)${Math.abs(r.rs * 100).toFixed(1)}個百分點`,
    );
  if (Number.isFinite(r.volSurge))
    p.push(`近5日量能為20日均量的${r.volSurge.toFixed(2)}倍`);
  if (Number.isFinite(r.mom20))
    p.push(`股價位於20日均線${r.mom20 >= 0 ? "之上" : "之下"}${Math.abs(r.mom20 * 100).toFixed(1)}%`);
  let s = fund + p.join(",") + `;綜合籌碼替代分數位居樣本第${r.chipScore}百分位。`;
  if (Number.isFinite(r.ytd))
    s += `今年以來${r.ytd >= 0 ? "+" : ""}${r.ytd.toFixed(1)}%。`;
  s += r.fwdPe > 0
    ? `Forward P/E ${r.fwdPe.toFixed(1)}倍,估值分${r.valScore}(相對樣本${r.valScore >= 60 ? "偏便宜" : r.valScore >= 40 ? "中性" : "偏貴"})。`
    : "估值資料暫缺,以中性50分計。";
  s += r.triggered
    ? "已達觸發門檻(相對強於SOXX+站上20日線+量能≥1.2x),列為候選訊號——請複核財報與題材後再決策。"
    : "尚未達觸發門檻,列為觀察名單。";
  if (r.valScore < 40 && r.triggered)
    s += "⚠ 屬動能型訊號且估值偏貴,注意回檔風險。";
  return s;
}

// ================= ETF 長期穩健度篩選 =================

/** 年化報酬:以(含息)還原價序列,months 為回看月數。資料不足回傳 NaN。 */
export function cagrFrom(adj, months) {
  if (!Array.isArray(adj) || adj.length < months + 1) return NaN;
  const a0 = adj[adj.length - 1 - months];
  const a1 = adj[adj.length - 1];
  if (!(a0 > 0) || !(a1 > 0)) return NaN;
  return Math.pow(a1 / a0, 12 / months) - 1;
}

/** 月報酬年化波動度 */
export function annualizedVol(adj) {
  const rets = [];
  for (let i = 1; i < adj.length; i++)
    if (adj[i] > 0 && adj[i - 1] > 0) rets.push(adj[i] / adj[i - 1] - 1);
  if (rets.length < 12) return NaN;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(12);
}

/** 最大回撤(0~1,回傳正值) */
export function maxDrawdown(adj) {
  let peak = -Infinity, mdd = 0;
  for (const x of adj) {
    if (!(x > 0)) continue;
    if (x > peak) peak = x;
    else mdd = Math.max(mdd, 1 - x / peak);
  }
  return mdd;
}

/**
 * ETF 穩健度評估。
 * rows: [{ code, name, market, type, adj: 月頻還原價(舊→新) }]
 * threshold: 年化報酬門檻(預設5%)
 */
export function scoreETF(rows, opts = {}) {
  const { threshold = 0.05 } = opts;
  const out = [];
  for (const r of rows) {
    const adj = (r.adj ?? []).filter((x) => Number.isFinite(x) && x > 0);
    const years = (adj.length - 1) / 12;
    const cagr5 = cagrFrom(adj, 60);
    const cagr3 = cagrFrom(adj, 36);
    const cagrAll = adj.length >= 13
      ? Math.pow(adj[adj.length - 1] / adj[0], 1 / years) - 1
      : NaN;
    const main = Number.isFinite(cagr5) ? cagr5 : years >= 3 ? cagrAll : NaN;
    const vol = annualizedVol(adj);
    const mdd = maxDrawdown(adj);
    const sharpe = Number.isFinite(main) && vol > 0 ? main / vol : NaN;
    const insufficient = !Number.isFinite(main);
    const qualified = !insufficient && main >= threshold;

    let summary =
      `${r.market === "TW" ? "台股" : "美股"}${r.type}ETF。` +
      (insufficient
        ? `成立未滿3年(資料${years.toFixed(1)}年),長期年化報酬尚無法可靠評估,暫不納入達標名單。`
        : `${Number.isFinite(cagr5) ? "近5年" : `成立至今(${years.toFixed(1)}年)`}含息年化報酬${(main * 100).toFixed(1)}%` +
          (Number.isFinite(cagr3) ? `、近3年${(cagr3 * 100).toFixed(1)}%` : "") +
          `;年化波動${(vol * 100).toFixed(1)}%、期間最大回撤${(mdd * 100).toFixed(0)}%,風險調整報酬(年化報酬/波動)${sharpe.toFixed(2)}。` +
          (qualified
            ? `達到5%年化門檻${sharpe >= 0.8 ? ",且波動相對報酬控制良好,適合作為長期核心部位分批布局" : ",但波動較大,建議搭配低波動部位或拉長分批期間"}。`
            : `未達5%年化門檻,較適合作為防禦/配息部位而非報酬引擎。`));

    if (Number.isFinite(r.ytd))
      summary += `今年以來${r.ytd >= 0 ? "+" : ""}${r.ytd.toFixed(1)}%。`;

    out.push({
      code: r.code, name: r.name, market: r.market, type: r.type,
      ytd: Number.isFinite(r.ytd) ? +r.ytd.toFixed(1) : null,
      years: +years.toFixed(1),
      cagr5: Number.isFinite(cagr5) ? +(cagr5 * 100).toFixed(1) : null,
      cagr3: Number.isFinite(cagr3) ? +(cagr3 * 100).toFixed(1) : null,
      cagrMain: Number.isFinite(main) ? +(main * 100).toFixed(1) : null,
      vol: Number.isFinite(vol) ? +(vol * 100).toFixed(1) : null,
      maxDD: +(mdd * 100).toFixed(0),
      sharpe: Number.isFinite(sharpe) ? +sharpe.toFixed(2) : null,
      qualified, insufficient, summary,
    });
  }
  out.sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    return (b.sharpe ?? -9) - (a.sharpe ?? -9);
  });
  return out;
}
