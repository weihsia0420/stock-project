// 純函式單元測試(無網路依賴):node tests/scoring.test.mjs
import assert from "node:assert/strict";
import {
  percentileRank, streakOf, scoreTaiwan, scoreUS,
  cagrFrom, annualizedVol, maxDrawdown, scoreETF,
} from "../netlify/functions/lib/scoring.mjs";

// percentileRank
assert.equal(percentileRank([1, 2, 3, 4], 4), 0.75);
assert.equal(percentileRank([1, 2, 3, 4], 1), 0);
assert.ok(Number.isNaN(percentileRank([], 1)));

// streakOf:由最新往回數連續正值
assert.equal(streakOf([1, -1, 2, 3, 4]), 3);
assert.equal(streakOf([1, 2, -5]), 0);
assert.equal(streakOf([1, 1, 1]), 3);

// scoreTaiwan:連買強勢股應排最前且觸發
const twRows = [
  { code: "2330", name: "台積電", close: 1000, volume: 20_000_000, turnover: 2e10,
    nets: [3e6, 4e6, 5e6, 6e6, 8e6], foreignSum: 2e7, trustSum: 6e6, pe: 18, pb: 6, dividendYield: 1.5 },
  { code: "2317", name: "鴻海", close: 180, volume: 30_000_000, turnover: 5e9,
    nets: [1e6, -2e6, 5e5, 3e5, 2e5], foreignSum: 1e5, trustSum: 0, pe: 12, pb: 1.6, dividendYield: 3.2 },
  { code: "9999", name: "低量股", close: 30, volume: 100_000, turnover: 3e6,
    nets: [1e4, 1e4, 1e4, 1e4, 1e4], foreignSum: 5e4, trustSum: 0, pe: 8, pb: 1, dividendYield: 5 },
];
const tw = scoreTaiwan(twRows);
assert.equal(tw.length, 2, "低流動性股應被過濾");
assert.equal(tw[0].code, "2330", "連買5日且強度8%者應排第一");
assert.equal(tw[0].triggered, true);
assert.ok(tw[0].reasons.some((r) => r.includes("連買5日")));
assert.ok(tw[0].chipScore >= 0 && tw[0].chipScore <= 100);

// scoreTaiwan:無P/E → 估值中性50
const twNoPe = scoreTaiwan([
  { code: "1111", name: "虧損股", close: 50, volume: 10_000_000, turnover: 5e8,
    nets: [1e6, 1e6, 1e6, 1e6, 1e6], foreignSum: 5e6, trustSum: 0, pe: NaN, pb: 2, dividendYield: NaN },
]);
assert.equal(twNoPe[0].valScore, 50);

// scoreUS:相對強+量增者應觸發;估值降級時 valScore=50
const usRows = [
  { ticker: "NVDA", name: "NVIDIA", close: 150, ret20: 0.12, mom20: 0.05, volSurge: 1.5, rs: 0.08, fwdPe: 35 },
  { ticker: "INTC", name: "Intel", close: 30, ret20: -0.05, mom20: -0.02, volSurge: 0.9, rs: -0.09, fwdPe: 20 },
];
const us = scoreUS(usRows, { valuationAvailable: true });
assert.equal(us[0].code, "NVDA");
assert.equal(us[0].triggered, true);
assert.equal(us[1].triggered, false);
assert.ok(us[1].valScore > us[0].valScore, "P/E較低者估值分應較高");

const usDeg = scoreUS(usRows, { valuationAvailable: false });
assert.equal(usDeg[0].valScore, 50);
assert.equal(usDeg[1].valScore, 50);

// 智能摘要:應包含關鍵敘述
assert.ok(tw[0].summary.includes("連續5日"), "台股摘要應描述連買天數");
assert.ok(tw[0].summary.includes("候選"), "台股摘要應含結論");
assert.ok(us[0].summary.includes("SOXX"), "美股摘要應含相對強弱");

// cagrFrom:每月+1%,60個月 → 年化約12.68%
const monthly1pct = Array.from({ length: 61 }, (_, i) => 100 * 1.01 ** i);
assert.ok(Math.abs(cagrFrom(monthly1pct, 60) - (1.01 ** 12 - 1)) < 1e-9);
assert.ok(Number.isNaN(cagrFrom([100, 101], 60)), "資料不足應回NaN");

// annualizedVol:固定報酬 → 波動0
const flat = Array.from({ length: 25 }, (_, i) => 100 * 1.005 ** i);
assert.ok(annualizedVol(flat) < 1e-9);

// maxDrawdown:100→150→75 → 50%
assert.equal(maxDrawdown([100, 150, 75, 120]), 0.5);

// scoreETF:高報酬者達標且排前;短歷史標記資料不足
const etf = scoreETF([
  { code: "GOOD", name: "好ETF", market: "US", type: "市值型", adj: monthly1pct },          // ~12.7%/yr
  { code: "FLATX", name: "平ETF", market: "TW", type: "高股息", adj: Array.from({ length: 61 }, (_, i) => 100 * 1.002 ** i) }, // ~2.4%/yr
  { code: "NEWX", name: "新ETF", market: "TW", type: "科技", adj: Array.from({ length: 14 }, (_, i) => 100 + i) },
]);
const good = etf.find((e) => e.code === "GOOD");
const flatE = etf.find((e) => e.code === "FLATX");
const newE = etf.find((e) => e.code === "NEWX");
assert.equal(good.qualified, true);
assert.ok(Math.abs(good.cagr5 - 12.7) < 0.1);
assert.equal(flatE.qualified, false);
assert.equal(newE.insufficient, true);
assert.equal(etf[0].code, "GOOD", "達標者應排最前");
assert.ok(good.summary.includes("達到5%年化門檻"));
assert.ok(flatE.summary.includes("未達5%年化門檻"));

console.log("ALL SCORING TESTS PASSED");
