"""第二層:相對低估值篩選 — B+C 雙軌設計。

實盤層(路徑B):
  - 過渡期(自建 point-in-time 快照 < 12個月):forward P/E 以
    「橫斷面產業分位數」代打(v_fwd_pe_cross_sectional)
  - 滿12個月後啟用 v_fwd_pe_zscore(自身歷史Z-score),雙軌並行
    一季觀察相關性後決定分位數因子去留

回測層(路徑C):
  - 僅用可歷史重建指標:EV/EBITDA分位數、FCF yield、橫斷面P/E分位數
  - PEG 不進回測(point-in-time 成長預估不可得,回填即 lookahead)
"""
from __future__ import annotations
import pandas as pd


def v_fwd_pe_zscore(snapshots: pd.DataFrame, min_history_days: int = 252) -> pd.DataFrame:
    """V1 Forward P/E 相對自身歷史均值 Z-score。

    公式: z = (今日fwd_pe − 自建快照歷史均值) / 歷史標準差
    便宜:z <= -1
    頻率:D;資料源:raw_valuation_snapshot(自建,絕不回填)
    啟用條件:該標的快照天數 >= min_history_days,否則回傳NaN
             並由 composer 自動 fallback 至橫斷面分位數。
    """
    raise NotImplementedError


def v_fwd_pe_cross_sectional(snapshot_today: pd.DataFrame) -> pd.DataFrame:
    """V1b 橫斷面 forward P/E 產業分位數(過渡期代打 + 回測層使用)。

    公式:同族群當日 fwd_pe 分位數排名,取後30%為便宜
    (台股對自訂族群、美股對 SOX/NDX 子群)
    頻率:D;僅需當日快照,無歷史需求。
    """
    raise NotImplementedError


def v_peg(snapshot_today: pd.DataFrame) -> pd.DataFrame:
    """V2 PEG ratio(僅實盤層,不進回測)。

    公式: PEG = fwd_pe / 預估EPS成長率;便宜:PEG < 1.2 且成長率 > 0
    頻率:D。
    """
    raise NotImplementedError


def v_ev_ebitda_percentile(fundamentals: pd.DataFrame) -> pd.DataFrame:
    """V3 EV/EBITDA 同產業分位數,後30%視為便宜。

    頻率:Q財報更新、D重算(價格變動);歷史可重建 → 回測層主力指標。
    """
    raise NotImplementedError


def v_analyst_target_gap(snapshot_today: pd.DataFrame, history: pd.DataFrame) -> pd.DataFrame:
    """V4 現價 vs 分析師目標價中位數離散度。

    公式:
        gap = (target_median − price) / price
        便宜:gap >= 15% 且 target_median 近60日未被下修逾3%
    頻率:D;目標價修訂方向需自建快照歷史(同路徑B),
    過渡期僅用 gap 靜態值、降權50%。
    """
    raise NotImplementedError


def v_fcf_yield(fundamentals: pd.DataFrame) -> pd.DataFrame:
    """V5 自由現金流殖利率。

    公式: FCF yield = (OCF − CapEx) / 市值;便宜:同產業前30%
    頻率:Q財報、D重算;歷史可重建 → 回測層指標。
    """
    raise NotImplementedError
