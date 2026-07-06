# 台美科技股主動選股與勝率追蹤模組 — 系統架構文件 v1.0

> **定位聲明:本系統為研究與訊號產生工具,非自動下單系統。所有訊號僅為候選清單,進出場決策一律需人工複核。**

## 1. 模組劃分

| 模組 | 路徑 | 職責 |
|------|------|------|
| 資料擷取層 | `src/ingestion/` | TWSE/TPEX、SEC EDGAR、yfinance、FINRA 的原始資料下載,寫入 raw_* 表。台股呼叫模式沿用現有 GAS 流程的 endpoint 與參數格式 |
| 指標運算層 | `src/signals/` | 籌碼指標(台5+美4,US_C5選擇權異常量為v2佔位)與估值指標(5項,B+C雙軌),產出 indicator_scores |
| 合成觸發層 | `src/composer/` | 標準化加權合成(預設60/40可調)、共振視窗(台10日/美日頻15日/季頻僅背景)、防呆條款、排除條件、每日候選清單 |
| 部位模擬層 | `src/tracker/` | 三重門檻出場引擎(+8%/−5%/40日)與ATR對照組平行模擬 |
| 績效歸因層 | `src/tracker/performance.py` | expectancy主排序、小賺大賠標警、Kelly參考值、訊號衰退分析 |
| 輸出層 | `src/reporting/` | 週報Markdown + Google Sheets同步(Sheets僅為呈現層) |

## 2. 資料流向(文字描述)


```

每日收盤後排程(台股18:00 / 美股台北時間翌日07:00):
(1) ingestion 下載當日原始資料 → raw_price / raw_chips_tw / raw_chips_us / raw_valuation_snapshot(point-in-time快照,絕不回填) (2) universe_snapshot 重算當日成分(市值+流動性門檻,存活者偏差防治) (3) signals 層逐指標計算 → indicator_scores(每指標含triggered旗標) (4) composer 合成 chip_score / val_score / total_score → composite_scores (5) 狀態機運轉: 新觸發 → open_signals 建立 signal(chip_triggered) 既有視窗 → daily_window_check 逐日重檢(轉candidate / 防呆取消 / 到期) candidate → apply_exclusions 過濾 → 正式候選 (6) tracker 對已entered訊號逐日檢查三重門檻(FIXED與ATR雙軌) (7) 每週五收盤後 build_weekly_report → Markdown + Sheets推送

```

## 3. 關鍵設計決策紀錄

**訊號狀態機六狀態全留痕**:`chip_triggered → resonance_window → candidate → entered → exited → attributed`,失格走 `cancelled` 並記錄原因。「觸發但未成候選」的訊號同樣入庫,使防呆條款(估值回升逾10分取消)本身的有效性可被回測驗證。

**stale signal 防治**:美股13F與short interest 一律以 filing_date / publication_date 為系統可得日,`is_trigger=0` 硬編碼於 indicator_registry,不進共振視窗、不觸發,僅作背景確認因子。

**forward P/E 的 B+C 雙軌**:實盤自上線日起每日快照自建 point-in-time 庫,過渡期(<12個月)以橫斷面產業分位數代打;回測層僅用可歷史重建指標(EV/EBITDA分位數、FCF yield、橫斷面P/E分位數),PEG不進回測。回測報告首頁固定標註估值層為降階版。

**分點集中度替代**:v1以借券賣出餘額變化+法人買超集中度替代(TW_C3),v2再評估付費源。

**指標版本控管**:所有公式定義入 indicator_registry 含 version 與生效區間,回測與實盤強制使用同版定義。

## 4. 技術棧與部署

Python 3.11+ / pandas / SQLite(單檔起步,schema已預留升級Postgres的正規化程度)。排程建議 cron 或 GitHub Actions(免費額度足夠日頻任務)。Google Sheets 同步沿用現有 GAS Web App 端點,Python 端僅 POST 結果 JSON,不在 GAS 內做任何運算。

## 5. v2 擴充預留

- US_C5 選擇權異常量(indicator_registry 已佔位 `US_C5_UOA`,待付費源)
- 分點進出集中度正式版(XQ/嘉實評估)
- SQLite → Postgres 遷移(schema 無SQLite專屬語法,直接可攜)
