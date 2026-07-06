-- ============================================================
-- 台美科技股主動選股與勝率追蹤模組 — SQLite Schema v1.0
-- 設計原則:
--   1. 台美共用schema,以 market 欄位分軌 ('TW' / 'US')
--   2. 所有指標定義進 indicator_registry,含公式版本號,防止定義漂移
--   3. 訊號狀態機六狀態全程留痕(含「觸發但未成候選」)
--   4. point-in-time 原則:估值快照逐日累積,絕不回填
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- 0. 標的主檔與 universe 快照(存活者偏差防治)
-- ------------------------------------------------------------
CREATE TABLE securities (
    security_id     INTEGER PRIMARY KEY,
    market          TEXT NOT NULL CHECK (market IN ('TW','US')),
    ticker          TEXT NOT NULL,            -- '2330' / 'NVDA'
    name            TEXT,
    sector          TEXT,                     -- 自訂族群:半導體/AI伺服器/散熱/電源/被動元件…
    is_active       INTEGER NOT NULL DEFAULT 1,
    UNIQUE (market, ticker)
);

-- 每日universe成員快照:回測時必須以「當日」名單為準,不得用今日名單回推
CREATE TABLE universe_snapshot (
    snap_date       TEXT NOT NULL,            -- ISO 8601 'YYYY-MM-DD'
    security_id     INTEGER NOT NULL REFERENCES securities(security_id),
    market_cap      REAL,                     -- 台股:億TWD;美股:億USD
    avg_volume_20d  REAL,                     -- 台股:張;美股:成交金額(USD)
    in_universe     INTEGER NOT NULL,         -- 1=通過市值/流動性門檻
    PRIMARY KEY (snap_date, security_id)
);

-- ------------------------------------------------------------
-- 1. 原始資料層(raw_*):只存事實,不存判斷
-- ------------------------------------------------------------
CREATE TABLE raw_price (
    security_id     INTEGER NOT NULL REFERENCES securities(security_id),
    trade_date      TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL,
    volume          REAL,                     -- 台股:張;美股:股
    turnover        REAL,                     -- 成交金額
    PRIMARY KEY (security_id, trade_date)
);

CREATE TABLE raw_chips_tw (
    security_id     INTEGER NOT NULL REFERENCES securities(security_id),
    trade_date      TEXT NOT NULL,
    fi_net          REAL,   -- 外資買賣超(張)
    it_net          REAL,   -- 投信買賣超(張)
    dl_net          REAL,   -- 自營買賣超(張)
    margin_balance  REAL,   -- 融資餘額(張)
    short_balance   REAL,   -- 融券餘額(張)
    sbl_balance     REAL,   -- 借券賣出餘額(張)※分點集中度之替代因子來源
    director_pledge_pct REAL,  -- 董監質押比(月頻,日資料沿用最近值)
    insider_transfer_flag INTEGER DEFAULT 0,  -- 內部人申報轉讓(事件旗標)
    PRIMARY KEY (security_id, trade_date)
);

CREATE TABLE raw_chips_us (
    security_id     INTEGER NOT NULL REFERENCES securities(security_id),
    obs_date        TEXT NOT NULL,            -- 觀察日(=可得日,非事件日)
    source          TEXT NOT NULL CHECK (source IN ('13F','FORM4','FINRA_SI','ETF_FLOW')),
    event_date      TEXT,                     -- 事件實際日期(13F為季末)
    filing_date     TEXT,                     -- 申報日(stale signal判定用)
    payload_json    TEXT NOT NULL,            -- 各源欄位差異大,以JSON存原始欄位
    PRIMARY KEY (security_id, obs_date, source)
);

-- point-in-time 估值快照:上線日起每日累積,是forward P/E Z-score的自建資料庫
CREATE TABLE raw_valuation_snapshot (
    security_id     INTEGER NOT NULL REFERENCES securities(security_id),
    snap_date       TEXT NOT NULL,
    fwd_pe          REAL,
    trailing_pe     REAL,
    peg             REAL,
    ev_ebitda       REAL,
    fcf_yield       REAL,
    target_median   REAL,   -- 分析師目標價中位數
    target_low      REAL,
    target_high     REAL,
    n_analysts      INTEGER,
    source          TEXT DEFAULT 'yfinance',
    PRIMARY KEY (security_id, snap_date)
);

-- ------------------------------------------------------------
-- 2. 指標註冊表:公式版本控管
-- ------------------------------------------------------------
CREATE TABLE indicator_registry (
    indicator_id    TEXT PRIMARY KEY,         -- 'TW_C1_INST_STREAK' 等
    market          TEXT NOT NULL CHECK (market IN ('TW','US','BOTH')),
    layer           TEXT NOT NULL CHECK (layer IN ('CHIP','VALUATION')),
    name_zh         TEXT NOT NULL,
    formula_desc    TEXT NOT NULL,            -- 量化公式文字定義
    data_freq       TEXT NOT NULL CHECK (data_freq IN ('D','W','2W','M','Q')),
    decay_days      INTEGER,                  -- 訊號衰退週期(交易日)
    is_trigger      INTEGER NOT NULL DEFAULT 1, -- 0=僅背景確認因子(13F/SI)
    version         TEXT NOT NULL DEFAULT '1.0',
    active_from     TEXT NOT NULL,
    active_to       TEXT                      -- NULL=現行版本
);

-- 每日指標分數(標準化後 0-100)
CREATE TABLE indicator_scores (
    security_id     INTEGER NOT NULL REFERENCES securities(security_id),
    score_date      TEXT NOT NULL,
    indicator_id    TEXT NOT NULL REFERENCES indicator_registry(indicator_id),
    raw_value       REAL,
    score           REAL CHECK (score BETWEEN 0 AND 100),
    triggered       INTEGER NOT NULL DEFAULT 0,  -- 該指標當日是否達觸發定義
    PRIMARY KEY (security_id, score_date, indicator_id)
);

-- 每日合成分數
CREATE TABLE composite_scores (
    security_id     INTEGER NOT NULL REFERENCES securities(security_id),
    score_date      TEXT NOT NULL,
    chip_score      REAL,       -- 0-100
    val_score       REAL,       -- 0-100
    total_score     REAL,       -- 加權合成
    w_chip          REAL NOT NULL DEFAULT 0.6,   -- 當日使用的權重(留痕)
    w_val           REAL NOT NULL DEFAULT 0.4,
    val_cheap_flag  INTEGER NOT NULL DEFAULT 0,  -- 是否在便宜區間
    PRIMARY KEY (security_id, score_date)
);

-- ------------------------------------------------------------
-- 3. 訊號狀態機
--    chip_triggered → resonance_window → candidate
--      → entered → exited → attributed
--    中途失格:cancelled(防呆條款/排除條件),同樣留痕
-- ------------------------------------------------------------
CREATE TABLE signals (
    signal_id       INTEGER PRIMARY KEY,
    security_id     INTEGER NOT NULL REFERENCES securities(security_id),
    market          TEXT NOT NULL,
    trigger_date    TEXT NOT NULL,            -- 籌碼轉強觸發日
    trigger_combo   TEXT NOT NULL,            -- JSON array of indicator_id(績效歸因主鍵)
    resonance_n     INTEGER NOT NULL,         -- 10(TW) / 15(US日頻)
    window_expiry   TEXT NOT NULL,            -- trigger_date + N 交易日
    val_score_at_trigger REAL,
    status          TEXT NOT NULL DEFAULT 'chip_triggered'
                    CHECK (status IN ('chip_triggered','resonance_window','candidate',
                                      'entered','exited','attributed','cancelled')),
    cancel_reason   TEXT,                     -- 'val_rebound_gt10' / 'negative_event' / 'volume_dry' / 'window_expired'
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE signal_state_log (               -- 狀態轉移全紀錄
    log_id          INTEGER PRIMARY KEY,
    signal_id       INTEGER NOT NULL REFERENCES signals(signal_id),
    from_status     TEXT,
    to_status       TEXT NOT NULL,
    transition_date TEXT NOT NULL,
    note            TEXT
);

-- ------------------------------------------------------------
-- 4. 交易模擬與績效
-- ------------------------------------------------------------
CREATE TABLE trades (
    trade_id        INTEGER PRIMARY KEY,
    signal_id       INTEGER NOT NULL REFERENCES signals(signal_id),
    exit_scheme     TEXT NOT NULL CHECK (exit_scheme IN ('FIXED','ATR')),  -- 對照組平行模擬
    entry_date      TEXT NOT NULL,
    entry_price     REAL NOT NULL,
    tp_level        REAL NOT NULL,            -- FIXED: entry*1.08;ATR: entry+2.5*ATR14
    sl_level        REAL NOT NULL,            -- FIXED: entry*0.95;ATR: entry-1.5*ATR14
    max_hold_days   INTEGER NOT NULL DEFAULT 40,
    exit_date       TEXT,
    exit_price      REAL,
    exit_type       TEXT CHECK (exit_type IN ('TP','SL','TIMEOUT','GAP_SL')),
    -- GAP_SL:跳空穿越停損,exit_price=開盤價而非停損價(系統性風險日的誠實紀錄)
    ret_pct         REAL,
    hold_days       INTEGER,
    is_win          INTEGER,                  -- ret_pct > 0,無模糊地帶
    UNIQUE (signal_id, exit_scheme)
);

-- 週報績效歸因快取(依觸發組合分組)
CREATE TABLE combo_performance (
    period_end      TEXT NOT NULL,            -- 週報基準日
    trigger_combo   TEXT NOT NULL,
    exit_scheme     TEXT NOT NULL,
    n_trades        INTEGER,
    win_rate        REAL,
    payoff_ratio    REAL,
    expectancy      REAL,                     -- 主排序指標
    max_drawdown    REAL,
    kelly_f         REAL,                     -- 僅供參考
    warn_flag       INTEGER DEFAULT 0,        -- 1=勝率高但expectancy≤0(小賺大賠標警)
    PRIMARY KEY (period_end, trigger_combo, exit_scheme)
);

-- ------------------------------------------------------------
-- 索引
-- ------------------------------------------------------------
CREATE INDEX idx_scores_date    ON indicator_scores(score_date);
CREATE INDEX idx_signals_status ON signals(status, window_expiry);
CREATE INDEX idx_trades_exit    ON trades(exit_date);
CREATE INDEX idx_valsnap_date   ON raw_valuation_snapshot(snap_date);
