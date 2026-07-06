"""第四層:出場引擎、勝率追蹤與績效歸因。

出場:固定三重門檻為主(+8%/-5%/40日,先到先觸發),
     ATR對照組(2.5×/1.5×ATR14)平行模擬,每筆signal各生成兩筆trade。
排序:週報主指標 = expectancy;勝率高但 expectancy<=0 → warn_flag=1
     且強制排序沉底,不得因勝率高而前置。
"""
from __future__ import annotations
import pandas as pd


def simulate_exit(entry_price: float, price_path: pd.DataFrame,
                  scheme: str = "FIXED", atr14: float | None = None) -> dict:
    """單筆訊號出場模擬。

    規則:
        逐日檢查 high >= TP → 'TP'(以TP價出場)
               low <= SL → 'SL'(以SL價出場)
        同日同時觸及 → 保守假設先觸SL
        開盤跳空穿越SL → 'GAP_SL',以開盤價出場(誠實紀錄尾部風險)
        40日未觸 → 'TIMEOUT',以第40日收盤出場
    is_win = ret_pct > 0,無模糊地帶。

    Returns: dict 對齊 trades 表欄位
    """
    raise NotImplementedError


def compute_expectancy(trades: pd.DataFrame) -> pd.DataFrame:
    """expectancy = win_rate × avg_win + (1−win_rate) × avg_loss

    依 (trigger_combo, exit_scheme) 分組,另計 payoff_ratio、
    max_drawdown(組合層級以逐筆權益曲線計)、樣本數。
    n_trades < 15 的組合標註「樣本不足」,不參與排序。
    """
    raise NotImplementedError


def kelly_fraction(win_rate: float, payoff: float, cap: float = 0.25) -> float:
    """Kelly f* = w − (1−w)/payoff,上限cap(僅供參考,非部位依據)。

    負值回傳0(該組合不應建倉)。
    """
    raise NotImplementedError


def flag_lowquality_combos(perf: pd.DataFrame) -> pd.DataFrame:
    """小賺大賠標警:win_rate >= 55% 且 expectancy <= 0 → warn_flag=1。

    週報中此類組合以醒目標記呈現並沉底,防止勝率錯覺。
    """
    raise NotImplementedError


def signal_decay_analysis(trades: pd.DataFrame,
                          scores: pd.DataFrame) -> pd.DataFrame:
    """訊號衰退分析:各indicator觸發後第1/5/10/15/20日的平均超額報酬曲線,
    驗證 registry 中 decay_days 假設是否成立,每季校準一次。
    """
    raise NotImplementedError


def build_weekly_report(period_end: str) -> str:
    """週報產出(Markdown):

    1. 本週候選清單與觸發原因
    2. 組合績效表 — 依expectancy排序、warn_flag標警
    3. 勝率趨勢圖(rolling 20筆)
    4. 訊號衰退分析摘要
    5. FIXED vs ATR 對照(expectancy差距 < 0.5% 則維持FIXED)
    輸出:本地 .md + 推送 Google Sheets(沿用GAS端點)。
    """
    raise NotImplementedError
