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
  }

  return rank(universe);
}

/**
 * 美股評分。
 * rows: [{ ticker, name, close, ret20, mom20(相對20MA), volSurge(5日/20日量比),
 *          rs(相對SOXX 20日超額報酬), fwdPe }]
 */
export function scoreUS(rows, opts = {}) {
  const { wChip = 0.6, wVal = 0.4, valuationAvailable = true } = opts;

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
  }

  return rank(universe);
}

/** 排序:triggered 優先,再依 totalScore 降冪;回傳前25名輕量欄位。 */
function rank(universe) {
  universe.sort((a, b) => {
    if (a.triggered !== b.triggered) return a.triggered ? -1 : 1;
    return b.totalScore - a.totalScore;
  });
  return universe.slice(0, 25).map((r) => ({
    code: r.code ?? r.ticker,
    name: r.name ?? "",
    close: r.close,
    chipScore: r.chipScore,
    valScore: r.valScore,
    totalScore: r.totalScore,
    triggered: r.triggered,
    reasons: r.reasons,
  }));
}
