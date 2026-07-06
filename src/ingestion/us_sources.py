"""美股資料擷取層 — SEC EDGAR / yfinance / FINRA,v1 全免費源。

關鍵原則:
- 13F 一律以 filing_date(申報日)作為系統「可得日」,絕不以季末
  event_date 回填 —— stale signal bias 防治的第一道防線。
- yfinance 為非官方端點,所有呼叫包 retry 與斷線降級(當日缺值以
  NULL 入庫,不以前日值冒充)。
- 估值快照每日入庫 raw_valuation_snapshot,自建 point-in-time 資料庫
  (forward P/E Z-score 路徑B的基礎,上線首日即開始累積)。
"""
from __future__ import annotations
import pandas as pd


def fetch_13f_holdings_delta(cik_list: list[str], quarter: str) -> pd.DataFrame:
    """機構持股季度增減(13F-HR),重點對沖基金與主動型機構。

    Args:
        cik_list: 追蹤的機構 CIK 清單(config 維護)。
        quarter: 'YYYYQn'。

    Returns:
        DataFrame[ticker, cik, shares_delta_pct, filing_date, event_date]

    Warning:
        filing_date 距 event_date 可達45天。此指標 is_trigger=0,
        僅作背景確認因子;回測時以 filing_date 對齊,嚴禁 lookahead。
    """
    raise NotImplementedError


def fetch_form4_insider_buys(obs_date: str, tickers: list[str]) -> pd.DataFrame:
    """內部人買賣申報(Form 4)。買進權重高於賣出(賣出雜訊多)。

    Returns:
        DataFrame[ticker, insider_role, txn_type, shares, value_usd,
                  filing_date]

    Note:
        僅保留公開市場買進(transaction code 'P')為觸發訊號;
        賣出彙總後僅作扣分因子,不單獨觸發。
    """
    raise NotImplementedError


def fetch_finra_short_interest(settlement_date: str) -> pd.DataFrame:
    """FINRA 雙週頻 short interest。

    Returns:
        DataFrame[ticker, si_shares, si_pct_float, days_to_cover,
                  publication_date]

    Warning:
        以 publication_date(公布日,約結算後8個交易日)為可得日。
        is_trigger=0,僅背景因子。
    """
    raise NotImplementedError


def fetch_etf_flow_proxy(obs_date: str, etfs: tuple = ("XLK", "SOXX")) -> pd.DataFrame:
    """產業ETF資金流替代指標:每日流通在外單位數變化 × NAV + 量能。

    Returns:
        DataFrame[etf, shares_outstanding_delta, est_flow_usd, volume]

    Note:
        免費源以 shares outstanding 日變化近似申贖,精度足夠做
        產業輪動方向判斷,不做金額級別的精細分析。
    """
    raise NotImplementedError


def snapshot_valuation_daily(tickers: list[str]) -> pd.DataFrame:
    """每日估值快照 → raw_valuation_snapshot(point-in-time自建庫)。

    Returns:
        DataFrame[ticker, fwd_pe, trailing_pe, peg, ev_ebitda, fcf_yield,
                  target_median, target_low, target_high, n_analysts]

    Note:
        FCF yield = (Operating CF - CapEx) / MarketCap,自財報欄位計算。
        任一欄位缺值以 NULL 入庫並記 log,不得前值冒充。
        此表是12個月後啟用 forward P/E 自身歷史 Z-score 的唯一基礎,
        排程失敗須告警(缺日=永久資料破洞)。
    """
    raise NotImplementedError
