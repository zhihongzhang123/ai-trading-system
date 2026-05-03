/**
 * ai-trading-system - 趋势跟踪策略 v2.0（优化版）
 * Copyright (C) 2025 zhihongzhang123
 *
 * 优化内容：
 * - 更严格的入场条件：增加震荡过滤器
 * - 动态仓位计算：基于账户状态调整
 * - 增强的止损机制：分级止损 + 时间止损
 * - 更好的移动止盈配置
 */
import type { StrategyParams, StrategyPromptContext } from "./types";

/**
 * 趋势跟踪策略配置（v2.0 优化版）
 */
export function getTrendFollowingStrategy(maxLeverage: number): StrategyParams {
  // 根据 maxLeverage 计算杠杆范围
  const trendLevMin = Math.max(1, Math.ceil(maxLeverage * 0.3));
  const trendLevMax = Math.max(2, Math.ceil(maxLeverage * 0.6));

  return {
    name: "趋势跟踪",
    description: "中低风险，趋势确认后入场，严格风控，适合稳健趋势交易者",

    // ==================== 杠杆配置 ====================
    leverageMin: trendLevMin,
    leverageMax: trendLevMax,
    leverageRecommend: {
      normal: `${trendLevMin}倍`,
      good: `${Math.ceil((trendLevMin + trendLevMax) / 2)}倍`,
      strong: `${trendLevMax}倍`,
    },

    // ==================== 仓位配置 ====================
    positionSizeMin: 10,
    positionSizeMax: 18,
    positionSizeRecommend: {
      normal: "10-12%",
      good: "12-15%",
      strong: "15-18%",
    },

    // ==================== 止损配置 ====================
    stopLoss: {
      low: -3,
      mid: -4,
      high: -5,
    },

    // ==================== 移动止盈 ====================
    trailingStop: {
      level1: { trigger: 8, stopAt: 3 },
      level2: { trigger: 15, stopAt: 8 },
      level3: { trigger: 25, stopAt: 15 },
    },

    // ==================== 分批止盈 ====================
    partialTakeProfit: {
      stage1: { trigger: 10, closePercent: 40 },
      stage2: { trigger: 20, closePercent: 70 },
      stage3: { trigger: 35, closePercent: 100 },
    },

    // ==================== 峰值回撤保护 ====================
    peakDrawdownProtection: 30,

    // ==================== 波动率调整 ====================
    volatilityAdjustment: {
      highVolatility: { leverageFactor: 0.7, positionFactor: 0.75 },
      normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 },
      lowVolatility: { leverageFactor: 1.15, positionFactor: 1.1 },
    },

    // ==================== 入场条件（v2.0 增强版）====================
    entryCondition: "严格趋势确认后才能入场。必须同时满足：1) 价格在 EMA20 和 EMA50 同侧；2) MACD 方向与价格方向一致；3) 至少 2 个时间框架信号一致；4) 非震荡行情（ADX > 25 或价格波动幅度 > 2%）。震荡行情严禁开仓。",

    // ==================== 风险容忍度 ====================
    riskTolerance: "中低风险。单笔最大亏损不超过账户 3%。趋势不明确时宁可观望。",

    // ==================== 交易风格 ====================
    tradingStyle: "趋势跟随，顺势而为。优先捕捉中长期趋势，不追逐短期波动。持仓时间 2-12 小时。",

    // ==================== 代码级保护 ====================
    enableCodeLevelProtection: true,
    allowAiOverrideProtection: false,

    // ==================== 最大空仓时间 ====================
    maxIdleHours: 16,
  };
}

/**
 * 生成趋势跟踪策略的提示词（v2.0 优化版）
 */
export function getTrendFollowingPrompt(_params: StrategyParams, context: StrategyPromptContext): string {
  return `
## 趋势跟踪策略 v2.0 — 核心指令

你是一位专业的趋势跟踪交易员。核心原则：顺势而为，严格风控，宁可错过不做错。

### 入场铁律（必须全部满足）
1. 价格确认：价格在 EMA20 和 EMA50 同侧（做多时在上，做空时在下）
2. 动量确认：MACD 柱状图方向与价格方向一致，且连续 2 根 K 线同向
3. 多时间框架：至少 2 个时间框架（5m + 15m）信号一致
4. 趋势强度：ADX > 25 或最近 5 根 K 线价格波动幅度 > 2%
5. 无重要数据：30 分钟内无重大经济数据公布

### 震荡行情过滤器（以下任一条件满足则视为震荡，禁止开仓）
- 价格反复穿越 EMA20（3 次以上）
- MACD 在零轴附近反复交叉
- RSI 在 40-60 区间徘徊
- ADX < 20
- 布林带收窄（上下轨距离 < 均值的 2%）

### 仓位管理
- 单笔仓位：10-18% 账户余额（根据信号强度）
- 最大同时持仓：${context.maxPositions} 个
- 杠杆范围：${context.extremeStopLossPercent}x 极端止损上限内灵活选择

### 止损纪律
- 开仓立即设止损：-3% 到 -5%（根据杠杆调整）
- 时间止损：持仓超过 4 小时且无明显盈利，考虑平仓
- 趋势反转止损：3 个时间框架出现反转信号，立即平仓

### 止盈策略
- 盈利 10%：平仓 40%
- 盈利 20%：再平仓 30%
- 剩余仓位用移动止损保护
- 移动止损：盈利 8% 后移至 +3%，盈利 15% 后移至 +8%

### 核心哲学
- 趋势是你最好的朋友，但趋势也会反转
- 保护本金比追求利润更重要
- 如果你不确定，就不要交易
- 让盈利奔跑，但要用移动止损保护利润
`;
}
