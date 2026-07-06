# 台美科技股訊號雷達 stock-project

籌碼動能 × 相對估值雙層過濾的選股研究工具。**非投資建議、非自動下單系統**,所有清單僅為候選訊號,進出場一律需人工複核。

## 成品網頁(MVP)

- `web/index.html` — 前端:台股/美股兩個頁籤,顯示推薦清單(分數、觸發、原因)
- `netlify/functions/screen.mts` — API `/api/screen?market=tw|us`:即時抓公開資料、計算分數
  - 台股:TWSE T86 三大法人(近5交易日)+ STOCK_DAY_ALL 行情 + BWIBBU_ALL 本益比/殖利率
  - 美股:Yahoo Finance 3個月日線(36檔 NDX/SOX 主要科技股 + SOXX 基準)+ Forward P/E(不可用時估值層自動降級為中性)
- `netlify/functions/lib/scoring.mjs` — 純函式評分邏輯(可離線測試:`npm test`)

分數皆為 0–100 橫斷面百分位,總分 = 籌碼 60% + 估值 40%。API 結果由 CDN 快取 30 分鐘。

### 本地開發

```bash
npm install
npm test          # 評分邏輯單元測試(無網路依賴)
npx netlify dev   # 本地啟動(需可連外網路)
```

### 部署

Netlify:publish 目錄 `web/`、functions 目錄 `netlify/functions/`(見 `netlify.toml`)。

## 完整系統設計(v1 規格,逐步實作中)

- `docs/architecture.md` — 系統架構:六狀態訊號狀態機、point-in-time 快照、指標版本控管
- `docs/backtest_plan.md` — 回測驗證計畫:存活者偏差防治、降階版估值層聲明、失效環境清單
- `db/schema.sql` — SQLite schema(13 表:raw 層 / 指標層 / 狀態機 / 交易模擬 / 績效歸因)
- `src/` — Python 模組介面定義(ingestion / signals / composer / tracker)

MVP 網頁與完整系統的關係:網頁是第 1、2、3 層(資料→指標→合成)的簡化即時版;完整版加入歷史資料庫、共振視窗狀態機、三重門檻出場模擬與勝率歸因,依 docs 規格逐步補齊。
