/**
 * ai-trading-system - 保守恢复策略
 * Copyright (C) 2025 zhihongzhang123
 *
 * 专为严重亏损后的账户恢复设计
 * 特点：极低杠杆、极小仓位、严格止损、高胜率优先
 * 适用场景：账户亏损 > 50% 后的恢复期
 */
import type { StrategyParams, StrategyPromptContext } from "./types";

/**
 * 保守恢复策略配置
 *
 * 策略特点：
 * - 风险等级：极低风险
 * - 杠杆范围：1-2 倍（最高不超过 2 倍）
 * - 仓位大小：5-10%（极小仓位）
 * - 适用人群：账户严重亏损后的恢复期
 * - 目标：先稳定盈利，逐步恢复本金
 * - 核心理念：宁可错过机会，不可再受损失
 *
 * @param maxLeverage - 系统允许的最大杠杆倍数
 * @returns 保守恢复策略的完整参数配置
 */
export function getConservativeRecoveryStrategy(_maxLeverage: number): StrategyParams {
  return {
    // ==================== 策略标识 ====================
    name: "保守恢复",
    description: "账户严重亏损后的超低风险恢复策略，以保本为第一要务",

    // ==================== 杠杆参数 ====================
    leverageMin: 1,
    leverageMax: 2,
    leverageRecommend: {
      normal: "1x（无杠杆，纯现货思维）",
      good: "1.5x（轻微杠杆）",
      strong: "2x（最高杠杆，仅在极强信号时）",
    },

    // ==================== 仓位参数 ====================
    positionSizeMin: 5,
    positionSizeMax: 10,
    positionSizeRecommend: {
      normal: "5%（极小仓位试水）",
      good: "7%（信号较好时）",
      strong: "10%（极强信号，最多 10%）",
    },

    // ==================== 止损参数 ====================
    stopLoss: {
      low: -2,
      mid: -3,
      high: -4,
    },

    // ==================== 移动止盈 ====================
    trailingStop: {
      level1: { trigger: 3, stopAt: 1 },
      level2: { trigger: 5, stopAt: 3 },
      level3: { trigger: 8, stopAt: 5 },
    },

    // ==================== 分批止盈 ====================
    partialTakeProfit: {
      stage1: { trigger: 3, closePercent: 50 },
      stage2: { trigger: 5, closePercent: 80 },
      stage3: { trigger: 8, closePercent: 100 },
    },

    // ==================== 峰值回撤保护 ====================
    peakDrawdownProtection: 15,

    // ==================== 波动率调整 ====================
    volatilityAdjustment: {
      highVolatility: { leverageFactor: 0.5, positionFactor: 0.5 },
      normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 },
      lowVolatility: { leverageFactor: 1.0, positionFactor: 1.0 },
    },

    // ==================== 入场条件 ====================
    entryCondition: "仅在极强趋势信号时入场。必须满足：1) 价格明确突破关键位；2) 成交量显著放大；3) 至少 3 个时间框架完全一致；4) 消息面配合趋势方向。宁可错过，不可做错。",

    // ==================== 风险容忍度 ====================
    riskTolerance: "极低风险容忍度。单笔交易最大亏损不超过账户 1%。保本为第一要务，盈利为第二目标。任何不确定性都选择观望。",

    // ==================== 交易风格 ====================
    tradingStyle: "极度保守的恢复风格。像保护最后一滴水一样保护本金。只做确定性极高的交易，持仓时间短（1-4 小时），快速止盈止损。",

    // ==================== 代码级保护配置 ====================
    enableCodeLevelProtection: true,
    allowAiOverrideProtection: false,

    // ==================== 最大空仓时间 ====================
    maxIdleHours: 24,
  };
}

/**
 * 生成保守恢复策略的提示词
 */
export function getConservativeRecoveryPrompt(_params: StrategyParams, _context: StrategyPromptContext): string {
  return `【保守恢复策略 - 核心指令】

你是一位经历过重大亏损后变得极其谨慎的专业交易员。你的首要任务是保护剩余本金，其次才是逐步盈利。

核心原则（按优先级）：
1. 保护本金 > 一切：你账户的资金来之不易，每一分钱都值得珍惜
2. 宁可错过，不可做错：错过一次机会不会让你亏钱，但做错一次会让你雪上加霜
3. 小步慢跑：用最小的仓位、最低的杠杆，逐步建立信心和盈利
4. 快速止损：一旦方向不对，立即止损，不要抱有任何幻想
5. 及时止盈：有利润就跑，不要贪心，落袋为安

入场铁律（必须全部满足才能开仓）：
- 价格在 EMA20 和 EMA50 之上（做多）或之下（做空）
- MACD 柱状图连续 3 根同向放大
- RSI 在趋势方向确认（做多 > 55，做空 < 45）
- 成交量比前 5 根 K 线平均放大 50% 以上
- 3 个以上时间框架信号完全一致
- 没有重要经济数据即将公布（30 分钟内）

仓位管理：
- 每次只用 5-10% 的账户余额
- 杠杆不超过 2 倍
- 同一时间最多持有 1 个仓位
- 持仓时间不超过 4 小时

止损纪律：
- 开仓时立即设置止损
- 止损距离入场价不超过 2-4%
- 触及止损立即平仓，不要犹豫

止盈策略：
- 盈利 3% 时平仓 50%
- 盈利 5% 时再平仓 30%
- 剩余仓位用移动止损保护
- 移动止损：盈利达到 3% 后，止损移至保本位

特别提醒：
- 你现在处于恢复期，不是进攻期
- 每一次交易都要像第一次交易一样谨慎
- 如果今天已经连续亏损 2 次，今天就不要再交易了
- 如果不确定，就选择观望——观望也是一种交易决策`;
}
