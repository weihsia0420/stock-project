"""全域參數設定 — 所有可調參數集中於此,不散落在各模組。

依規格書定義的預設值,調整時只改這裡,並由 indicator_registry 的
version 欄位追蹤公式版本,避免定義漂移。
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class UniverseConfig:
    tw_min_mktcap_100m_twd: float = 100.0      # 新台幣100億
    tw_min_avg_vol_lots: float = 3000.0        # 近一月日均量3,000張
    us_min_mktcap_100m_usd: float = 100.0      # 100億美元
    us_min_avg_turnover_usd: float = 50_000_000.0
    tw_sectors: tuple = ("半導體", "AI伺服器", "散熱", "電源", "電子零組件", "被動元件")
    us_index_sources: tuple = ("NDX", "SOX")
    exclude_biotech: bool = True
    include_software: bool = True


@dataclass(frozen=True)
class ScoringConfig:
    w_chip: float = 0.60                       # 可調權重
    w_val: float = 0.40
    cheap_threshold: float = 60.0              # val_score >= 60 視為便宜區間
    failsafe_rebound_pts: float = 10.0         # 防呆:估值分數回升逾10分即取消


@dataclass(frozen=True)
class ResonanceConfig:
    n_tw: int = 10                             # 台股共振視窗(交易日)
    n_us_daily: int = 15                       # 美股日頻訊號視窗
    # 美股季頻訊號(13F / short interest)不設視窗、不觸發,僅背景因子
    quarterly_as_background_only: bool = True


@dataclass(frozen=True)
class ExitConfig:
    tp_pct: float = 0.08                       # 停利 +8%
    sl_pct: float = -0.05                      # 停損 -5%
    max_hold_days: int = 40
    atr_period: int = 14                       # ATR對照組
    atr_tp_mult: float = 2.5
    atr_sl_mult: float = 1.5
    # payoff ratio 1.6 → 損益兩平勝率 38.5%


@dataclass(frozen=True)
class DataSourceConfig:
    db_path: str = "signal_system.sqlite"
    twse_base: str = "https://openapi.twse.com.tw/v1"
    tpex_base: str = "https://www.tpex.org.tw/openapi/v1"
    edgar_base: str = "https://data.sec.gov"
    edgar_user_agent: str = "REPLACE_WITH_YOUR_EMAIL"   # SEC要求
    finra_si_base: str = "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest"
    yf_snapshot_hour_local: int = 18           # 每日估值快照排程時間
    gas_sheets_endpoint: str = ""              # 沿用現有GAS部署的Web App URL


CONFIG = {
    "universe": UniverseConfig(),
    "scoring": ScoringConfig(),
    "resonance": ResonanceConfig(),
    "exit": ExitConfig(),
    "data": DataSourceConfig(),
}
