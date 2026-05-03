/**
 * AI Trading System - AI 驱动的加密货币自动交易系统
 * Copyright (C) 2025 zhihongzhang123
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import type { StrategyParams, StrategyPromptContext } from "./types";

/**
 * 趋势跟踪策略配置
 * 
 * 策略特点：
 * - 风险等级：中低风险
 * - 杠杆范围：40%-70% 最大杠杆（如最大 25 倍，则使用 10-17 倍）
 * - 仓位大小：15-22%
 * - 适用人群：趋势交易者，追求稳健收益
 * - 目标月回报：15-30%
 * - 交易频率：中等，跟随主要趋势
 * 
 * 核心策略：
 * - 趋势确认：等待明确趋势信号后入场
 * - 顺势而为：跟随主要趋势方向交易
 * - 严格止损：趋势反转时及时止损
 * - 让利润奔跑：趋势延续时持有仓位
 * 
 * @param maxLeverage - 系统允许的最大杠杆倍数（从配置文件读取）
 * @returns 趋势跟踪策略的完整参数配置
 */
export function getTrendFollowingStrategy(maxLeverage: number): StrategyParams {
  // 计算趋势跟踪策略的杠杆范围：使用 40%-70% 的最大杠杆
  // 例如：系统最大杠杆 25 倍时，计算出 10-17 倍的杠杆范围
  const trendLevMin = Math.max(2, Math.ceil(maxLeverage * 0.4));  // 最小杠杆：40% 最大杠杆，至少 2 倍
  const trendLevMax = Math.max(3, Math.ceil(maxLeverage * 0.7));  // 最大杠杆：70% 最大杠杆，至少 3 倍
  
  // 计算不同信号强度下推荐的杠杆倍数
  const trendLevNormal = trendLevMin;  // 普通信号：使用最小杠杆
  const trendLevGood = Math.ceil((trendLevMin + trendLevMax) / 2);  // 良好信号：使用中等杠杆
  const trendLevStrong = trendLevMax;  // 强信号：使用最大杠杆
  
  return {
    // ==================== 策略基本信息 ====================
    name: "趋势跟踪",  // 策略名称（中文）
    description: "中低风险杠杆，趋势确认后入场，适合趋势交易者",  // 策略描述
    
    // ==================== 杠杆配置 ====================
    // 杠杆范围：使用 40%-70% 最大杠杆（如系统最大 25 倍，则使用 10-17 倍）
    leverageMin: trendLevMin,  // 最小杠杆倍数
    leverageMax: trendLevMax,  // 最大杠杆倍数
    leverageRecommend: {
      normal: `${trendLevNormal}倍`,   // 普通信号：使用最小杠杆（谨慎入场）
      good: `${trendLevGood}倍`,       // 良好信号：使用中等杠杆（趋势确认）
      strong: `${trendLevStrong}倍`,   // 强信号：使用最大杠杆（强烈趋势）
    },
    
    // ==================== 仓位配置 ====================
    // 仓位范围：15-22%（中等偏小仓位，控制风险）
    positionSizeMin: 15,  // 最小仓位：15%（保守信号）
    positionSizeMax: 22,  // 最大仓位：22%（强信号）
    positionSizeRecommend: {
      normal: "15-17%",   // 普通信号：较小仓位，控制风险
      good: "17-20%",     // 良好信号：中等仓位，趋势确认
      strong: "20-22%",   // 强信号：较大仓位，强烈趋势
    },
    
    // ==================== 止损配置 ====================
    // 根据杠杆倍数分级止损
    // 执行方式：AI 根据此配置主动判断和执行
    stopLoss: {
      low: -4,    // 低杠杆时：亏损 4% 止损（如使用 2-5 倍杠杆）
      mid: -3,    // 中杠杆时：亏损 3% 止损（如使用 6-10 倍杠杆）
      high: -2.5, // 高杠杆时：亏损 2.5% 止损（如使用 11 倍以上杠杆）
    },
    
    // ==================== 移动止盈配置 ====================
    // 盈利后移动止损线保护利润
    // 趋势跟踪策略：让利润奔跑，移动止盈较宽松
    trailingStop: {
      // 趋势跟踪策略：宽松的移动止盈（基准：15 倍杠杆）
      // 注意：这些是基准值，实际使用时 AI 会根据杠杆动态调整
      level1: { trigger: 10, stopAt: 4 },    // 盈利达到 +10% 时，止损线移至 +4%（保护 6% 空间）
      level2: { trigger: 20, stopAt: 10 },   // 盈利达到 +20% 时，止损线移至 +10%（保护 10% 空间）
      level3: { trigger: 35, stopAt: 20 },   // 盈利达到 +35% 时，止损线移至 +20%（保护 15% 空间）
    },
    
    // ==================== 分批止盈配置 ====================
    // 逐步锁定利润（closePercent 为累计平仓百分比）
    partialTakeProfit: {
      stage1: { trigger: 15, closePercent: 30 },   // 盈利达到 +15% 时，平仓 30%
      stage2: { trigger: 30, closePercent: 60 },   // 盈利达到 +30% 时，平仓 60%
      stage3: { trigger: 50, closePercent: 100 },  // 盈利达到 +50% 时，平仓 100%（全部清仓）
    },
    
    // ==================== 峰值回撤保护 ====================
    peakDrawdownProtection: 40,  // 盈利从峰值回撤 40% 时强烈建议平仓
    
    // ==================== 波动率调整 ====================
    // 根据市场波动率动态调整杠杆和仓位
    volatilityAdjustment: {
      highVolatility: {
        leverageFactor: 0.7,   // 高波动时：降低 30% 杠杆
        positionFactor: 0.75,  // 高波动时：降低 25% 仓位
      },
      normalVolatility: {
        leverageFactor: 1.0,   // 正常波动时：不调整
        positionFactor: 1.0,   // 正常波动时：不调整
      },
      lowVolatility: {
        leverageFactor: 1.15,  // 低波动时：提高 15% 杠杆
        positionFactor: 1.1,   // 低波动时：提高 10% 仓位
      },
    },
    
    // ==================== 入场条件 ====================
    entryCondition: "等待明确趋势信号后入场。优先选择：1) 突破关键阻力/支撑位；2) 均线多头/空头排列；3) 成交量配合趋势方向。避免在震荡行情中频繁交易。",
    
    // ==================== 风险容忍度 ====================
    riskTolerance: "中等风险容忍度。接受单笔交易 2-4% 的亏损，但严格控制总账户风险。趋势反转时果断止损，不抱有幻想。",
    
    // ==================== 交易风格 ====================
    tradingStyle: "趋势跟随风格。顺势而为，让利润奔跑。持仓时间中等（数小时到数天），不追求短期暴利，而是捕捉主要趋势行情。",
    
    // ==================== 代码级保护配置 ====================
    enableCodeLevelProtection: false,  // 禁用代码级保护，由 AI 主动执行止损止盈
    allowAiOverrideProtection: false,  // 不使用双重防护
    
    // ==================== 最大空仓时间 ====================
    maxIdleHours: 12,  // 连续空仓超过 12 小时提醒 AI 寻找机会
  };
}

/**
 * 生成趋势跟踪策略的提示词上下文
 * 
 * @param context - 策略提示词生成上下文
 * @returns 策略特定的提示词补充说明
 */
export function getTrendFollowingPrompt(context: StrategyPromptContext): string {
  return `
## 趋势跟踪策略指导

你是专业的趋势跟踪交易员。你的核心任务是识别并跟随市场的主要趋势。

### 交易原则
1. **趋势优先**：只在明确趋势方向时交易，避免震荡行情
2. **顺势而为**：做多上升趋势，做空下降趋势，不逆势操作
3. **让利润奔跑**：趋势延续时持有仓位，不急于止盈
4. **严格止损**：趋势反转信号出现时果断止损

### 入场信号
优先寻找以下信号：
- 突破关键阻力位（做多）或支撑位（做空）
- 均线系统呈现多头排列（做多）或空头排列（做空）
- 成交量放大配合趋势方向
- MACD 金叉/死叉确认趋势

### 出场策略
- 止损：价格回撤达到止损线时果断出场
- 止盈：使用移动止盈保护利润，让趋势延续
- 趋势反转：出现明确反转信号时主动平仓

### 风险提示
- 不要在没有明确趋势时强行交易
- 控制单笔风险在账户净值的 2-4% 以内
- 趋势可能随时反转，保持警惕
`;
}
