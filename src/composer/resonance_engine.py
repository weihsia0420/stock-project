"""第三層:訊號合成、共振視窗與狀態機。

狀態機:
  chip_triggered → resonance_window → candidate → entered
    → exited → attributed
  任一階段失格 → cancelled(留 cancel_reason,供防呆條款有效性分析)
"""
from __future__ import annotations
import pandas as pd


def compute_composite(scores: pd.DataFrame, w_chip: float = 0.6,
                      w_val: float = 0.4) -> pd.DataFrame:
    """合成總分。籌碼/估值各自 0-100 標準化後加權。

    Returns: DataFrame → composite_scores 表
    Note: 權重為當日留痕欄位(w_chip/w_val 入庫),
          回測掃參數時不會汙染歷史紀錄。
    """
    raise NotImplementedError


def open_signals(triggered_today: pd.DataFrame, market: str) -> list[dict]:
    """籌碼觸發 → 建立 signal(status='chip_triggered')。

    共振視窗長度:
        TW → n=10;US日頻(Form4/ETF輪動) → n=15
        US季頻(13F/SI) → 不建立signal,僅寫入背景因子分數
    trigger_combo 記錄觸發的 indicator_id 組合(JSON),為績效歸因主鍵。
    """
    raise NotImplementedError


def daily_window_check(open_windows: pd.DataFrame,
                       composite_today: pd.DataFrame) -> list[dict]:
    """每日重檢所有 resonance_window 狀態的訊號。

    轉候選:val_score 在便宜區間(>= cheap_threshold)→ status='candidate'
    防呆取消:val_score 較觸發日回升 > 10分 → cancelled('val_rebound_gt10')
    視窗到期:→ cancelled('window_expired')
    每次轉移寫入 signal_state_log。
    """
    raise NotImplementedError


def apply_exclusions(candidates: pd.DataFrame,
                     events: pd.DataFrame,
                     volume: pd.DataFrame) -> pd.DataFrame:
    """排除條件:近期重大負面事件(下修財測/訴訟/董事會異動)、
    成交量異常萎縮(20日均量 < 60日均量的40%)。

    被排除者 → cancelled('negative_event' / 'volume_dry'),留痕。
    """
    raise NotImplementedError


def emit_daily_candidates(as_of: str) -> pd.DataFrame:
    """產出每日候選清單(含觸發原因標註)。

    Returns:
        DataFrame[ticker, market, total_score, chip_score, val_score,
                  trigger_combo, trigger_date, days_in_window]
    輸出至週報引擎與 Google Sheets 呈現層。
    """
    raise NotImplementedError
