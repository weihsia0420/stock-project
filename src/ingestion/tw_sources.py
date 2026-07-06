"""台股資料擷取層 — TWSE / TPEX 公開 OpenAPI。

設計原則:
- 沿用現有 Google Apps Script 的 API 呼叫模式(同一組 endpoint、同一
  日期參數格式),降低雙系統維護成本;Python 端僅負責運算,Sheets
  為輸出呈現層之一。
- 全部免費公開資料,不做任何繞過 rate limit 的設計。
- 分點進出集中度(原規格指標3)以「借券賣出餘額 + 法人買超集中度」
  替代,v2 再評估付費源。

所有函式回傳 pandas.DataFrame,欄位對齊 schema.sql 的 raw_* 表,
由 loader.py 統一寫入 SQLite。
"""
from __future__ import annotations
import pandas as pd


def fetch_daily_price(trade_date: str, market: str = "TWSE") -> pd.DataFrame:
    """抓取全市場個股日收盤行情。

    Args:
        trade_date: 'YYYY-MM-DD'。TWSE API 需轉民國年格式時在函式內處理。
        market: 'TWSE' 或 'TPEX'。

    Returns:
        DataFrame[ticker, open, high, low, close, volume(張), turnover]

    資料源:
        TWSE: /exchangeReport/STOCK_DAY_ALL
        TPEX: /tpex_mainboard_daily_close_quotes
    """
    raise NotImplementedError


def fetch_institutional_net(trade_date: str, market: str = "TWSE") -> pd.DataFrame:
    """三大法人個股買賣超(外資/投信/自營分列)。

    Returns:
        DataFrame[ticker, fi_net, it_net, dl_net]  # 單位:張

    資料源:
        TWSE: /fund/T86(現有GAS流程已使用,沿用同一參數格式)
        TPEX: /tpex_3insti_daily_trading
    """
    raise NotImplementedError


def fetch_margin_short(trade_date: str, market: str = "TWSE") -> pd.DataFrame:
    """融資融券餘額。

    Returns:
        DataFrame[ticker, margin_balance, short_balance]  # 張

    資料源: TWSE /exchangeReport/MI_MARGN;TPEX 對應端點。
    """
    raise NotImplementedError


def fetch_sbl_balance(trade_date: str) -> pd.DataFrame:
    """借券賣出餘額(分點集中度之替代因子來源)。

    Returns:
        DataFrame[ticker, sbl_balance]  # 張

    資料源: TWSE /exchangeReport/TWT93U(借券賣出餘額日報)。
    """
    raise NotImplementedError


def fetch_director_pledge(year_month: str) -> pd.DataFrame:
    """董監事持股質押比率(月頻,自公開資訊觀測站彙總檔)。

    Args:
        year_month: 'YYYY-MM'

    Returns:
        DataFrame[ticker, director_pledge_pct]

    Note:
        日頻運算時以最近可得月值前向填補(forward fill),
        並確保填補方向只用過去值(point-in-time)。
    """
    raise NotImplementedError


def fetch_insider_transfer_events(trade_date: str) -> pd.DataFrame:
    """內部人申報轉讓事件(公開資訊觀測站每日彙總)。

    Returns:
        DataFrame[ticker, insider_transfer_flag(=1), note]
    """
    raise NotImplementedError
