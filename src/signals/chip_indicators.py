"""第一層:籌碼領先指標庫。

每個函式對應 indicator_registry 一筆註冊,docstring 內含:
量化公式 / 資料頻率 / 訊號衰退週期(decay_days)/ 是否為觸發訊號。

回傳統一格式: DataFrame[security_id, score_date, raw_value, score(0-100),
triggered(0/1)],由 loader 寫入 indicator_scores。
"""
from __future__ import annotations
import pandas as pd

# ================= 台股 =================

def tw_inst_streak(df_chips: pd.DataFrame, df_price: pd.DataFrame) -> pd.DataFrame:
    """TW_C1 三大法人連續買超天數 × 買超強度。

    公式:
        streak = 外資或投信淨買超連續天數(兩者取較長者)
        intensity = 近5日累計買超張數 / 近5日成交量
        raw = streak × intensity;score = 全universe橫斷面百分位×100
    觸發:streak >= 3 且 intensity >= 5%
    頻率:D;衰退週期:10個交易日(投信/外資連買動能約2-4週)
    """
    raise NotImplementedError


def tw_margin_short_reversal(df_chips: pd.DataFrame) -> pd.DataFrame:
    """TW_C2 融資減幅 + 融券增幅同時出現(潛在轉強)。

    公式:
        margin_chg = 融資餘額20日變化率;short_chg = 融券餘額20日變化率
        raw = (-margin_chg) + short_chg(兩項皆正才有意義)
    觸發:margin_chg <= -5% 且 short_chg >= +10%
    頻率:D;衰退週期:15個交易日
    """
    raise NotImplementedError


def tw_concentration_proxy(df_chips: pd.DataFrame) -> pd.DataFrame:
    """TW_C3 集中度替代因子:借券餘額變化 + 法人買超集中度。

    (原分點前15大集中度因免費源限制,v1以此替代;v2評估付費源)
    公式:
        sbl_chg = 借券賣出餘額10日變化率(下降=回補,偏多)
        fi_concentration = 近10日外資買超日數佔比 × 買超金額佔成交比
        raw = 0.4×(-sbl_chg標準化) + 0.6×fi_concentration標準化
    觸發:raw 橫斷面前20%且 sbl_chg < 0
    頻率:D;衰退週期:10個交易日
    """
    raise NotImplementedError


def tw_insider_pledge_signal(df_chips: pd.DataFrame) -> pd.DataFrame:
    """TW_C4 董監質押比變化 + 內部人申報轉讓(扣分因子)。

    公式:
        pledge_delta = 質押比3個月變化(上升=扣分)
        transfer_penalty = 近20日有申報轉讓 → 一律扣分
        score = 100 - 懲罰項(此指標只扣分,不觸發)
    頻率:M(質押)/ D(轉讓事件);is_trigger=0
    """
    raise NotImplementedError


def tw_flow_divergence(df_chips: pd.DataFrame, df_mkt: pd.DataFrame) -> pd.DataFrame:
    """TW_C5 個股與大盤資金流背離。

    公式:
        divergence = sign(個股近5日法人淨買超) − sign(大盤近5日法人淨買賣超)
        正背離(個股買超、大盤賣超)= 逆勢吸籌,偏多
    觸發:正背離連續 >= 3日
    頻率:D;衰退週期:7個交易日(背離訊號短效)
    """
    raise NotImplementedError

# ================= 美股 =================

def us_13f_background(df_13f: pd.DataFrame) -> pd.DataFrame:
    """US_C1 機構持股季度變化 — 背景確認因子(is_trigger=0)。

    公式:
        raw = 追蹤機構清單中增倉機構數 − 減倉機構數,以持股變化%加權
        以 filing_date 為可得日,45天延遲如實反映
    頻率:Q;不設衰退週期(非觸發訊號);不進共振視窗。
    """
    raise NotImplementedError


def us_form4_buys(df_form4: pd.DataFrame) -> pd.DataFrame:
    """US_C2 內部人公開市場買進(觸發訊號,買進權重 >> 賣出)。

    公式:
        raw = Σ(買進金額 × 職位權重) / 市值,職位權重 CEO/CFO=2, Dir=1
        cluster buying(30日內≥3位內部人買進)額外加成×1.5
    觸發:raw > 0 且至少一筆單筆 >= 10萬美元
    頻率:D;衰退週期:15個交易日
    """
    raise NotImplementedError


def us_short_interest_background(df_si: pd.DataFrame) -> pd.DataFrame:
    """US_C3 short interest % of float 變化 — 背景因子(is_trigger=0)。

    公式: raw = si_pct_float 較上期變化;下降=空頭回補,偏多背景
    頻率:2W(以公布日對齊);不觸發、不進視窗。
    """
    raise NotImplementedError


def us_etf_rotation(df_flow: pd.DataFrame) -> pd.DataFrame:
    """US_C4 產業ETF輪動訊號(XLK/SOXX資金流,免費申贖近似)。

    公式:
        raw = SOXX 10日估計淨流入標準化 − SPY 同期(半導體相對強弱)
    觸發:raw 連續5日為正(產業層級順風,個股訊號的放大器)
    頻率:D;衰退週期:10個交易日
    Note: US_C5 選擇權異常量為 v2 待辦(付費源),registry 預留
          indicator_id='US_C5_UOA' 佔位即可,不實作。
    """
    raise NotImplementedError
