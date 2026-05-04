/**
 * ai-trading-system - AI 加密货币自动交易系统
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

/**
 * 交易循环 - 定时执行交易决策
 */
import cron from "node-cron";
import { createLogger } from "../utils/loggerUtils.js";
import { createClient } from "@libsql/client";
import { createTradingAgent, generateTradingPrompt, getAccountRiskConfig, getTradingStrategy, getStrategyParams } from "../agents/tradingAgent.js";
import { createExchangeClient } from "../services/exchangeClient.js";
import { getChinaTimeISO } from "../utils/timeUtils.js";
import { RISK_PARAMS } from "../config/riskParams.js";
import { getQuantoMultiplier } from "../utils/contractUtils.js";
import { initNewsClient, fetchCryptoNews, fetchExchangeAnnouncements, fetchLatestEvents, aggregateSentiment } from "../services/newsClient.js";
import { checkRiskGuard, formatRiskGuardForPrompt, calculateSafePositionSize, calculateSafeLeverage, logRiskEvent } from "../services/riskGuard.js";
import { newsCache, okxCircuitBreaker, CACHE_TTL } from "../services/dataCache.js";
import { sendNotification, notifyRiskBlocked, notifyCircuitBreaker, notifySystemStart } from "../services/telegramNotifier.js";
import { extractDecisionJSON, StructuredDecision, decisionToSummary } from "../agents/structuredDecision.js";

const logger = createLogger({
  name: "trading-loop",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

// 支持的币种 - 从配置中读取
const SYMBOLS = [...RISK_PARAMS.TRADING_SYMBOLS] as string[];

// 交易开始时间
let tradingStartTime = new Date();
let iterationCount = 0;

// 账户风险配置
let accountRiskConfig = getAccountRiskConfig();

/**
 * 确保数值是有效的有限数字，否则返回默认值
 */
function ensureFinite(value: number, defaultValue: number = 0): number {
  if (!Number.isFinite(value)) {
    return defaultValue;
  }
  return value;
}

/**
 * 确保数值在指定范围内
 */
function ensureRange(value: number, min: number, max: number, defaultValue?: number): number {
  if (!Number.isFinite(value)) {
    return defaultValue !== undefined ? defaultValue : (min + max) / 2;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 决策质量评分模型（客观 0-100 分）
 * 
 * 纯数学计算，脱离 AI 自评。精简为3维评估：
 * - 趋势共振(40): EMA排列 + K线斜率 + MACD方向
 * - 周期对齐(35): 1h/1d 趋势一致性（LEI核心周期）
 * - 量价确认(25): 量比 + RSI健康区
 */
interface IndicatorSnapshot {
  price: number; ema20: number; ema60: number; ema120: number; ma200: number;
  macd: number; rsi14: number; volume: number; avgVolume: number;
  slope20: number; // 每根K线的平均涨跌幅%
}

interface QualityScoreResult {
  total: number;           // 总分 0-100
  trendResonance: number;  // 趋势共振 0-40
  timeframeAlignment: number; // 周期对齐 0-35
  volumeConfirmation: number; // 量价确认 0-25
}

function calculateQualityScore(
  current: IndicatorSnapshot,
  timeframes: Record<string, IndicatorSnapshot>
): QualityScoreResult {
  const result: QualityScoreResult = {
    total: 0, trendResonance: 0, timeframeAlignment: 0, volumeConfirmation: 0,
  };

  // === 1. 趋势共振 (0-40 分) ===
  // EMA 短中长期排列 (0-16)
  const bullish = current.ema20 > current.ema60 && current.ema60 > current.ema120 && current.price > current.ema20;
  const bearish = current.ema20 < current.ema60 && current.ema60 < current.ema120 && current.price < current.ema20;
  if (bullish) result.trendResonance += 16;
  else if (bearish) result.trendResonance += 16;
  // 部分排列（20>60或60>120单边）给8分
  else if ((current.ema20 > current.ema60 && current.price > current.ema20) ||
           (current.ema20 < current.ema60 && current.price < current.ema20)) {
    result.trendResonance += 8;
  }
  // EMA 粘合扣分（方向不明）
  if (Math.abs(current.ema20 - current.ema60) / current.ema60 < 0.002) result.trendResonance -= 4;

  // K线斜率方向确认 (0-12)
  // slope20 > 0.05% 表示明显上升，< -0.05% 表示明显下降
  if (current.slope20 > 0.05) result.trendResonance += 6;
  else if (current.slope20 < -0.05) result.trendResonance += 6;
  if (Math.abs(current.slope20) > 0.15) result.trendResonance += 6; // 强趋势
  else if (Math.abs(current.slope20) > 0.08) result.trendResonance += 3;

  // MACD 动量方向 (0-12) — 只做多系统，仅多方动量加分
  if (current.macd > 0) result.trendResonance += 6; // 多方动量确认
  // 空方动量不加分（只做多系统，下跌趋势不视为高质量信号）
  // MACD绝对值大小（趋势力度）
  if (current.price > 0) {
    const macdRatio = Math.abs(current.macd) / current.price * 100;
    if (macdRatio > 0.5) result.trendResonance += 6;
    else if (macdRatio > 0.2) result.trendResonance += 3;
  }

  result.trendResonance = ensureRange(result.trendResonance, 0, 40);

  // === 2. 三周期对齐 (0-35 分) ===
  // 5m（短期）/ 1h（中期）/ 1d（长期）三级共振，长期 > 中期 > 短期
  const tf5m = timeframes["5m"];
  const tf1h = timeframes["1h"];
  const tf1d = timeframes["1d"];

  function getTfDir(tf: IndicatorSnapshot | undefined): number {
    if (!tf || tf.price <= 0) return 0;
    if (tf.ema20 > tf.ema60 && tf.price > tf.ema20) return 1;
    if (tf.ema20 < tf.ema60 && tf.price < tf.ema20) return -1;
    return 0;
  }

  if (tf1h && tf1d && tf1h.price > 0 && tf1d.price > 0) {
    const dir1h = getTfDir(tf1h);
    const dir1d = getTfDir(tf1d);
    const dir5m = getTfDir(tf5m);

    // 评分权重：1d（长期）主导，1h（中期）次之，5m（短期）辅助
    let score = 0;

    // 1d 长期趋势确立格局（最高权重）
    if (dir1d !== 0) score += 12;
    else score += 4;

    // 1h/1d 共振（核心判断）
    if (dir1h !== 0 && dir1h === dir1d) score += 14;
    else if (dir1h !== 0 && dir1d !== 0 && dir1h !== dir1d) score += 5;
    else if (dir1h !== 0) score += 8;

    // 5m 短期确认（只做多场景：5m多头确认加分，空头不扣分但降分）
    if (dir5m !== 0) {
      if (dir1h > 0 && dir5m === 1) score += 6; // 短中期共振做多
      else if (dir1d > 0 && dir5m === 1) score += 4; // 长期多头+短期确认
      else if (dir1h < 0 && dir5m === -1) score += 0; // 空头共振（系统只做多，不额外加分）
      else if (dir5m === 1 && dir1h <= 0) score += 3; // 短期先行信号
      else score += 2; // 方向不一致
    } else {
      score += 3; // 5m中性
    }

    result.timeframeAlignment = ensureRange(score, 0, 35);

    // 斜率共振加分：1d和1h斜率同向额外加分
    if (tf1h.slope20 * tf1d.slope20 > 0) {
      result.timeframeAlignment = Math.min(35, result.timeframeAlignment + 3);
    }
    // 5m斜率也同向再加1分
    if (tf5m && tf5m.slope20 * tf1h.slope20 > 0) {
      result.timeframeAlignment = Math.min(35, result.timeframeAlignment + 2);
    }
  } else {
    result.timeframeAlignment = 15; // 数据不足
  }

  // === 3. 量价确认 (0-25 分) ===
  // 量比确认 (0-15)
  const volumeRatio = current.avgVolume > 0 ? current.volume / current.avgVolume : 1;
  if (volumeRatio > 1.5) result.volumeConfirmation += 15; // 放量
  else if (volumeRatio > 1.0) result.volumeConfirmation += 10; // 温和放量
  else if (volumeRatio > 0.5) result.volumeConfirmation += 5;  // 缩量
  // 极度缩量（<0.3）扣分，代表无参与意愿
  if (volumeRatio < 0.3) result.volumeConfirmation = Math.max(0, result.volumeConfirmation - 5);

  // RSI 健康区 (0-10)
  if (current.rsi14 >= 45 && current.rsi14 <= 65) result.volumeConfirmation += 10; // 健康区间
  else if ((current.rsi14 >= 35 && current.rsi14 < 45) || (current.rsi14 > 65 && current.rsi14 <= 75)) {
    result.volumeConfirmation += 5; // 偏强/偏弱
  }
  // 极端区域不额外加分（超买超卖不等于反向信号）

  result.volumeConfirmation = ensureRange(result.volumeConfirmation, 0, 25);

  result.total = result.trendResonance + result.timeframeAlignment + result.volumeConfirmation;
  return result;
}
// 信号量并发控制器 — 限制同时进行的 API 请求数，防止触发交易所风控
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(maxConcurrent: number) {
    this.permits = maxConcurrent;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!();
    } else {
      this.permits++;
    }
  }
}

// 全局信号量：最多 4 个并发请求（Gate.io 频率限制友好）
const apiSemaphore = new Semaphore(4);

/**
 * P1-1: 增量指标计算缓存
 * 
 * 核心思路：当新周期只增加 1 根 K 线时，利用上一周期的中间状态递推更新，
 * 避免对全量历史数据重新遍历（O(n²) → O(1)）。
 * 
 * 支持的递推指标：
 *   - EMA (20, 50) — 只需上一个 EMA 值
 *   - RSI (Wilder 7, 14) — 只需上一个 avgGain/avgLoss
 *   - MACD (12, 26, 9) — 只需上一个 EMA12/EMA26/DEA
 *   - BOLL (20, 2) — 需要最近 20 个价格（滑动窗口）
 *   - ADX (14) — 需要最近 14 个 TR/DM 值（滑动窗口）
/**
 * 增量指标缓存状态（仅保留核心 8 指标所需）
 */
interface IndicatorState {
  candleCount: number;
  lastClose: number;
  timestamp: number;
  high: number;
  low: number;

  // EMA 状态 (递推核心)
  ema20: number;
  ema60: number;
  ema120: number;
  ma200: number;

  // MACD 中间状态
  ema12: number;
  ema26: number;
  dea: number;

  // RSI14 Wilder 平滑
  rsi14AvgGain: number;
  rsi14AvgLoss: number;

  // 斜率需要的价格窗口 (最近20个收盘价)
  closeWindow: number[];
}

const indicatorCache = new Map<string, IndicatorState>();

/**
 * 从缓存中递推计算核心指标（仅适用于新增 1 根 K 线的场景）
 */
function tryIncrementalIndicators(
  cacheKey: string,
  newCandle: { close: number; high: number; low: number; volume: number }
): any | null {
  const state = indicatorCache.get(cacheKey);
  if (!state) return null;

  const { close, high, low, volume } = newCandle;

  // 递推 EMA
  const k20 = 2 / (20 + 1);
  const k60 = 2 / (60 + 1);
  const k120 = 2 / (120 + 1);
  const newEma20 = state.ema20 + k20 * (close - state.ema20);
  const newEma60 = state.ema60 + k60 * (close - state.ema60);
  const newEma120 = state.ema120 + k120 * (close - state.ema120);

  // 递推 MACD
  const k12 = 2 / (12 + 1);
  const k26 = 2 / (26 + 1);
  const kDea = 2 / (9 + 1);
  const newEma12 = state.ema12 + k12 * (close - state.ema12);
  const newEma26 = state.ema26 + k26 * (close - state.ema26);
  const newMacd = newEma12 - newEma26;
  const newDea = state.dea + kDea * (newMacd - state.dea);

  // 递推 RSI14 (Wilder)
  const diff = close - state.lastClose;
  const gain = diff > 0 ? diff : 0;
  const loss = diff < 0 ? -diff : 0;
  const newRsi14AvgGain = (state.rsi14AvgGain * 13 + gain) / 14;
  const newRsi14AvgLoss = (state.rsi14AvgLoss * 13 + loss) / 14;
  const newRsi14 = newRsi14AvgLoss === 0 ? 100 : 100 - 100 / (1 + newRsi14AvgGain / newRsi14AvgLoss);

  // 更新收盘窗口 (斜率计算)
  const newCloseWindow = [...state.closeWindow, close].slice(-20);

  // 更新缓存
  indicatorCache.set(cacheKey, {
    candleCount: state.candleCount + 1,
    lastClose: close,
    timestamp: Date.now(),
    ema20: newEma20,
    ema60: newEma60,
    ema120: newEma120,
    ma200: state.ma200, // 增量不更新 MA200，保留上次值
    ema12: newEma12,
    ema26: newEma26,
    dea: newDea,
    rsi14AvgGain: newRsi14AvgGain,
    rsi14AvgLoss: newRsi14AvgLoss,
    closeWindow: newCloseWindow,
    high, low,
  });

  // 计算斜率
  const slope20 = calcSlope20(newCloseWindow.length >= 20 ? newCloseWindow : []);

  return {
    currentPrice: close,
    ema20: newEma20,
    ema60: newEma60,
    ema120: newEma120,
    ma200: 0, // 增量不计算 MA200，需要全量
    macd: newMacd,
    rsi14: Math.max(0, Math.min(100, newRsi14)),
    volume,
    avgVolume: 0,
    slope20,
  };
}

/**
 * 构建增量缓存状态（全量计算后调用）
 * @returns 完整的指标结果对象
 */
function buildIndicatorState(
  cacheKey: string,
  closes: number[],
  highs: number[],
  lows: number[],
  volumes: number[]
): any {
  if (closes.length < 2) return null;

  const n = closes.length;
  const ema20 = calcEMA(closes, 20);
  const ema60 = calcEMA(closes, 60);
  const ema120 = calcEMA(closes, 120);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdResult = calcMACD(closes);
  const rsi14 = calcRSI(closes, 14);
  const ma200 = calcMA(closes, 200);

  // 从 RSI 反推 avgGain/avgLoss
  const rs14 = rsi14 >= 100 ? 999 : rsi14 <= 0 ? 0.001 : rsi14 / (100 - rsi14);
  const lastDiff14 = closes[n - 1] - closes[Math.max(0, n - 15)];
  const avgLoss14 = Math.abs(lastDiff14) / (rs14 + 1);
  const avgGain14 = rs14 * avgLoss14;

  // 计算平均成交量
  const recentVolumes = volumes.slice(-20);
  let volSum = 0;
  for (const v of recentVolumes) volSum += v;
  const avgVol = recentVolumes.length > 0 ? volSum / recentVolumes.length : 0;

  indicatorCache.set(cacheKey, {
    candleCount: n,
    lastClose: closes[n - 1],
    timestamp: Date.now(),
    ema20,
    ema60,
    ema120,
    ma200,
    ema12,
    ema26,
    dea: macdResult.dea,
    rsi14AvgGain: avgGain14,
    rsi14AvgLoss: avgLoss14,
    closeWindow: closes.slice(-20),
    high: highs[n - 1],
    low: lows[n - 1],
  });

  // 返回完整的指标结果
  const slope20 = calcSlope20(closes);

  return {
    currentPrice: closes[n - 1],
    ema20,
    ema60,
    ema120,
    ma200,
    macd: macdResult.macd,
    rsi14,
    volume: volumes[n - 1] || 0,
    avgVolume: avgVol,
    slope20,
  };
}

/**
 * 收集所有市场数据（包含多时间框架分析和时序数据）
 * 优化：Promise.all 并发 K 线获取 + 信号量限流 + 数据验证
 */
async function collectMarketData() {
  const exchangeClient = createExchangeClient();
  const marketData: Record<string, any> = {};

  // 并发获取所有 symbol 的市场数据（每个 symbol 内部也并发拉取多时间框架 K 线）
  const symbolPromises = SYMBOLS.map(async (symbol) => {
    try {
      const contract = `${symbol}_USDT`;
      
      // 获取价格（带重试）
      let ticker: any = null;
      let retryCount = 0;
      const maxRetries = 2;
      
      while (retryCount <= maxRetries) {
        try {
          ticker = await exchangeClient.getFuturesTicker(contract);
          const price = Number.parseFloat(ticker.last || "0");
          if (price === 0 || !Number.isFinite(price)) {
            throw new Error(`价格无效: ${ticker.last}`);
          }
          break;
        } catch (error) {
          retryCount++;
          if (retryCount > maxRetries) {
            logger.error(`${symbol} 价格获取失败（${maxRetries}次重试）:`, error as any);
            throw error;
          }
          logger.warn(`${symbol} 价格获取失败，重试 ${retryCount}/${maxRetries}...`);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      // 并发获取所有时间框架的K线数据（聚焦1h和1d，5m仅用于形态识别）
      const timeframes = [
        { interval: "1h" as const, limit: 168 },  // 7天数据
        { interval: "1d" as const, limit: 90 },   // 90天数据
        { interval: "5m" as const, limit: 20 },   // 形态识别专用（不参与评分）
      ] as const;

      const candleResults = await Promise.all(
        timeframes.map(async (tf) => {
          await apiSemaphore.acquire();
          try {
            const candles = await exchangeClient.getFuturesCandles(contract, tf.interval, tf.limit);
            return { key: tf.interval, candles };
          } finally {
            apiSemaphore.release();
          }
        })
      );

      const candlesMap: Record<string, any[]> = {};
      for (const r of candleResults) {
        candlesMap[r.key] = r.candles;
      }

      const candles1h = candlesMap["1h"] || [];
      const candles1d = candlesMap["1d"] || [];
      const candles5m = candlesMap["5m"] || [];  // 形态识别专用

      // 并发计算三级时间框架指标 (5m/1h/1d)
      const [indicators5m, indicators1h, indicators1d] =
        await Promise.all([
          calculateIndicators(candles5m),
          calculateIndicators(candles1h),
          calculateIndicators(candles1d),
        ]);
      
      // 主决策指标以1h为准（中长期趋势锚点）
      const indicators = indicators1h;
      
      // 计算 1h 序列数据（用于 EMA 拐头/交叉/破线等转折点检测）
      const intradaySeries = calculateIntradaySeries(candles1h);
      
      // 验证技术指标有效性和数据完整性
      const dataTimestamp = getChinaTimeISO();
      const dataQuality = {
        price: Number.isFinite(Number.parseFloat(ticker.last || "0")),
        ema20: Number.isFinite(indicators.ema20),
        macd: Number.isFinite(indicators.macd),
        rsi14: Number.isFinite(indicators.rsi14) && indicators.rsi14 >= 0 && indicators.rsi14 <= 100,
        volume: Number.isFinite(indicators.volume) && indicators.volume >= 0,
        candleCount: {
          "5m": candles5m?.length ?? 0,
          "1h": candles1h?.length ?? 0,
          "1d": candles1d?.length ?? 0,
        }
      };
      
      const issues: string[] = [];
      if (!dataQuality.price) issues.push("价格无效");
      if (!dataQuality.ema20) issues.push("EMA20无效");
      if (!dataQuality.macd) issues.push("MACD无效");
      if (!dataQuality.rsi14) issues.push("RSI14无效或超出范围");
      if (!dataQuality.volume) issues.push("成交量无效");
      if (indicators.volume === 0) issues.push("当前成交量为0");
      
      if (issues.length > 0) {
        logger.warn(`${symbol} 数据质量问题 [${dataTimestamp}]: ${issues.join(", ")}`);
        logger.debug(`${symbol} K线数量:`, dataQuality.candleCount);
      } else {
        logger.debug(`${symbol} 数据质量检查通过 [${dataTimestamp}]`);
      }
      
      // 获取资金费率
      let fundingRate = 0;
      try {
        const fr = await exchangeClient.getFundingRate(contract);
        fundingRate = Number.parseFloat(fr.r || "0");
        if (!Number.isFinite(fundingRate)) fundingRate = 0;
      } catch (error) {
        logger.warn(`获取 ${symbol} 资金费率失败:`, error as any);
      }
      
      let openInterest = { latest: 0, average: 0 };
      
      // 将各时间框架指标添加到市场数据（仅1h和1d）
      marketData[symbol] = {
        price: Number.parseFloat(ticker.last || "0"),
        change24h: Number.parseFloat(ticker.change_percentage || "0"),
        volume24h: Number.parseFloat(ticker.volume_24h || "0"),
        fundingRate,
        openInterest,
        ...indicators,
        ...intradaySeries,  // 序列数据：priceSeries, ema20Series, ema60Series, ema120Series
        klines5m: candles5m,  // 5m K线序列（形态识别专用）
        timeframes: {
          "5m": indicators5m,
          "1h": indicators1h,
          "1d": indicators1d,
        },
      };
      
      // === 决策质量评分（聚焦1h和1d，斜率纳入趋势判断） ===
      const qualityScore = calculateQualityScore(
        {
          price: ensureFinite(Number.parseFloat(ticker.last || "0"), 0),
          ema20: ensureFinite(indicators.ema20),
          ema60: ensureFinite(indicators.ema60),
          ema120: ensureFinite(indicators.ema120),
          ma200: ensureFinite(indicators.ma200),
          macd: ensureFinite(indicators.macd),
          rsi14: ensureFinite(indicators.rsi14, 50),
          volume: ensureFinite(indicators.volume),
          avgVolume: ensureFinite(indicators.avgVolume),
          slope20: ensureFinite(indicators.slope20 || 0),
        },
        {
          "5m": { price: indicators5m.currentPrice || 0, ema20: indicators5m.ema20 || 0, ema60: indicators5m.ema60 || 0, ema120: indicators5m.ema120 || 0, ma200: indicators5m.ma200 || 0, macd: indicators5m.macd || 0, rsi14: indicators5m.rsi14 || 50, volume: indicators5m.volume || 0, avgVolume: indicators5m.avgVolume || 0, slope20: indicators5m.slope20 || 0 },
          "1h": { price: indicators1h.currentPrice || 0, ema20: indicators1h.ema20 || 0, ema60: indicators1h.ema60 || 0, ema120: indicators1h.ema120 || 0, ma200: indicators1h.ma200 || 0, macd: indicators1h.macd || 0, rsi14: indicators1h.rsi14 || 50, volume: indicators1h.volume || 0, avgVolume: indicators1h.avgVolume || 0, slope20: indicators1h.slope20 || 0 },
          "1d": { price: indicators1d.currentPrice || 0, ema20: indicators1d.ema20 || 0, ema60: indicators1d.ema60 || 0, ema120: indicators1d.ema120 || 0, ma200: indicators1d.ma200 || 0, macd: indicators1d.macd || 0, rsi14: indicators1d.rsi14 || 50, volume: indicators1d.volume || 0, avgVolume: indicators1d.avgVolume || 0, slope20: indicators1d.slope20 || 0 },
        }
      );
      logger.info(`${symbol} 质量评分: ${qualityScore.total}/100 [趋势:${qualityScore.trendResonance} 周期:${qualityScore.timeframeAlignment} 量价:${qualityScore.volumeConfirmation}]`);

      // 保存技术指标到数据库（核心8指标 + 质量评分）
      await dbClient.execute({
        sql: `INSERT INTO trading_signals 
              (symbol, timestamp, price, ema_20, ema_60, ema_120, ma_200, macd, rsi_14, rsi_7, volume, avg_volume, slope_20, quality_score, score_components) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          symbol, dataTimestamp,
          ensureFinite(Number.parseFloat(ticker.last || "0"), 0),
          ensureFinite(indicators.ema20),
          ensureFinite(indicators.ema60),
          ensureFinite(indicators.ema120),
          ensureFinite(indicators.ma200),
          ensureFinite(indicators.macd),
          ensureFinite(indicators.rsi14, 50),
          50,  // rsi_7 兼容旧列，固定默认值
          ensureFinite(indicators.volume),
          ensureFinite(indicators.avgVolume),
          ensureFinite(indicators.slope20 || 0),
          qualityScore.total,
          JSON.stringify({ resonance: qualityScore.trendResonance, alignment: qualityScore.timeframeAlignment, volume: qualityScore.volumeConfirmation }),
        ],
      });
    } catch (error) {
      logger.error(`收集 ${symbol} 市场数据失败:`, error as any);
    }
  });

  // 等待所有 symbol 数据获取完成
  await Promise.allSettled(symbolPromises);

  return marketData;
}

/**
 * 收集消息面数据（快讯/公告/社交情绪）
 * 遍历 SYMBOLS 列表，为每个币种获取消息面数据
 * 优化：增加缓存机制，减少重复请求
 * 失败不影响主流程
 */
async function collectNewsData(): Promise<Record<string, any>> {
  const newsData: Record<string, any> = {};

  if (process.env.GATE_NEWS_MCP_ENABLED === "false") {
    return newsData;
  }

  for (const symbol of SYMBOLS) {
    try {
      // 尝试从缓存获取
      const cacheKey = `news:${symbol}`;
      const cached = newsCache.get(cacheKey);
      if (cached) {
        newsData[symbol] = cached;
        logger.debug(`${symbol} 消息面数据使用缓存`);
        continue;
      }

      // 缓存未命中，请求新数据
      const [newsResult, announcementsResult, eventsResult] = await Promise.allSettled([
        fetchCryptoNews(symbol, 5),
        fetchExchangeAnnouncements(symbol, 5),
        fetchLatestEvents(symbol, 5),
      ]);

      const news = newsResult.status === "fulfilled" ? newsResult.value : [];
      const announcements = announcementsResult.status === "fulfilled" ? announcementsResult.value : [];
      const events = eventsResult.status === "fulfilled" ? eventsResult.value : [];
      const sentiment = news.length > 0 ? aggregateSentiment(news) : null;

      const result = { news, announcements, events, sentiment };
      newsData[symbol] = result;

      // 写入缓存（15 分钟有效期）
      newsCache.set(cacheKey, result, CACHE_TTL.NEWS);
    } catch (error) {
      logger.warn(`获取 ${symbol} 消息面数据失败:`, error as any);
      newsData[symbol] = { news: [], announcements: [], events: [], sentiment: null };
    }
  }
  return newsData;
}

/**
 * 计算日内时序数据（3分钟级别）
 * 参照 1.md 格式
 * @param candles 全部历史数据（至少60个数据点）
 */
function calculateIntradaySeries(candles: any[]) {
  if (!candles || candles.length === 0) {
    return {
      priceSeries: [],
      volumeSeries: [],
      ema20Series: [],
      ema60Series: [],
      ema120Series: [],
      macdSeries: [],
      rsi7Series: [],
      rsi14Series: [],
    };
  }

  const closes = candles.map((c) => Number.parseFloat(c.c || "0")).filter(n => Number.isFinite(n));
  
  if (closes.length === 0) {
    return {
      priceSeries: [],
      volumeSeries: [],
      ema20Series: [],
      ema60Series: [],
      ema120Series: [],
      macdSeries: [],
      rsi7Series: [],
      rsi14Series: [],
    };
  }

  const priceSeries = closes;
  const volumeSeries: number[] = [];
  const ema20Series: number[] = [];
  const ema60Series: number[] = [];
  const ema120Series: number[] = [];
  const macdSeries: number[] = [];
  const rsi7Series: number[] = [];
  const rsi14Series: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    const historicalPrices = closes.slice(0, i + 1);
    
    ema20Series.push(historicalPrices.length >= 20 ? calcEMA(historicalPrices, 20) : historicalPrices[historicalPrices.length - 1]);
    ema60Series.push(historicalPrices.length >= 60 ? calcEMA(historicalPrices, 60) : (historicalPrices.length > 1 ? ema60Series[i-1] || closes[i] : closes[i]));
    ema120Series.push(historicalPrices.length >= 120 ? calcEMA(historicalPrices, 120) : (historicalPrices.length > 1 ? ema120Series[i-1] || closes[i] : closes[i]));
    
    macdSeries.push(historicalPrices.length >= 26 ? calcMACD(historicalPrices).macd : 0);
    rsi7Series.push(historicalPrices.length >= 8 ? calcRSI(historicalPrices, 7) : 50);
    rsi14Series.push(historicalPrices.length >= 15 ? calcRSI(historicalPrices, 14) : 50);

    // 成交量序列
    const vol = Number.parseFloat(candles[i]?.v || "0");
    volumeSeries.push(Number.isFinite(vol) ? vol : 0);
  }

  const sliceIndex = Math.max(0, priceSeries.length - 10);
  return {
    priceSeries: priceSeries.slice(sliceIndex),
    volumeSeries: volumeSeries.slice(sliceIndex),
    ema20Series: ema20Series.slice(sliceIndex),
    ema60Series: ema60Series.slice(sliceIndex),
    ema120Series: ema120Series.slice(sliceIndex),
    macdSeries: macdSeries.slice(sliceIndex),
    rsi7Series: rsi7Series.slice(sliceIndex),
    rsi14Series: rsi14Series.slice(sliceIndex),
  };
}

/**
 * 计算更长期的上下文数据（1小时级别 - 用于短线交易）
 * 参照 1.md 格式
 */
function calculateLongerTermContext(candles: any[]) {
  if (!candles || candles.length < 26) {
    return {
      ema20: 0,
      ema50: 0,
      atr3: 0,
      atr14: 0,
      currentVolume: 0,
      avgVolume: 0,
      macdSeries: [],
      rsi14Series: [],
    };
  }

  const closes = candles.map((c) => Number.parseFloat(c.c || "0")).filter(n => Number.isFinite(n));
  const highs = candles.map((c) => Number.parseFloat(c.h || "0")).filter(n => Number.isFinite(n));
  const lows = candles.map((c) => Number.parseFloat(c.l || "0")).filter(n => Number.isFinite(n));
  const volumes = candles.map((c) => Number.parseFloat(c.v || "0")).filter(n => Number.isFinite(n));

  // 计算 EMA
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  // 计算 ATR
  const atr3 = calcATR(highs, lows, closes, 3);
  const atr14 = calcATR(highs, lows, closes, 14);

  // 计算成交量
  const currentVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
  const avgVolume = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;

  // 计算最近10个数据点的 MACD 和 RSI14
  const macdSeries: number[] = [];
  const rsi14Series: number[] = [];
  
  const recentPoints = Math.min(10, closes.length);
  for (let i = closes.length - recentPoints; i < closes.length; i++) {
    const historicalPrices = closes.slice(0, i + 1);
    macdSeries.push(historicalPrices.length >= 26 ? calcMACD(historicalPrices).macd : 0);
    rsi14Series.push(calcRSI(historicalPrices, 14));
  }

  return {
    ema20,
    ema50,
    atr3,
    atr14,
    currentVolume,
    avgVolume,
    macdSeries,
    rsi14Series,
  };
}

/**
 * 计算 ATR (Average True Range) — 波动率指标
 * 周期默认 14，用于衡量市场波动性，辅助止损止盈设置
 * O(n) Wilder 平滑递推计算
 */
function calcATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (highs.length < 2 || lows.length < 2 || closes.length < 2) {
    return 0;
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return 0;

  // Wilder 平滑递推
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return Number.isFinite(atr) ? atr : 0;
}

// 计算 EMA
function calcEMA(prices: number[], period: number) {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return Number.isFinite(ema) ? ema : 0;
}

// 计算 MA（简单移动平均）
function calcMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const slice = prices.slice(-period);
  let sum = 0;
  for (const p of slice) sum += p;
  const ma = sum / slice.length;
  return Number.isFinite(ma) ? ma : 0;
}

// 计算最近20个收盘价的线性回归斜率
function calcSlope20(prices: number[]): number {
  if (prices.length < 2) return 0;
  const n = prices.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += prices[i];
    sumXY += i * prices[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return Number.isFinite(slope) ? slope : 0;
}

// 计算 RSI（Wilder 平滑算法）
// 修正：原版使用简单平均，不符合标准 RSI 定义
// Wilder 平滑：后续 avg = (prev * (period-1) + current) / period
function calcRSI(prices: number[], period: number) {
  if (prices.length < period + 1) return 50; // 数据不足，返回中性值
  
  // 第一步：计算初始平均涨跌
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  
  // 第二步：Wilder 平滑递推
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  
  return ensureRange(rsi, 0, 100, 50);
}

// 计算 MACD（完整版：MACD线 + DEA信号线 + Histogram）
interface MACDResult {
  macd: number;   // DIF: EMA12 - EMA26
  dea: number;    // DEA/Signal: EMA9 of MACD
  histogram: number; // (MACD - DEA) * 2
}

function calcMACD(prices: number[]): MACDResult {
  const empty: MACDResult = { macd: 0, dea: 0, histogram: 0 };
  if (prices.length < 26) return empty;
  
  // O(n) 单次遍历计算 EMA12, EMA26, MACD序列, EMA9(MACD)
  const k12 = 2 / (12 + 1);
  const k26 = 2 / (26 + 1);
  const k9 = 2 / (9 + 1);
  
  let ema12 = prices[0];
  let ema26 = prices[0];
  let emaMacd = 0;
  let macdSeriesInit = false;
  
  let lastMacd = 0;
  
  for (let i = 1; i < prices.length; i++) {
    ema12 = prices[i] * k12 + ema12 * (1 - k12);
    ema26 = prices[i] * k26 + ema26 * (1 - k26);
    const macdVal = ema12 - ema26;
    
    if (i >= 26) {
      if (!macdSeriesInit) {
        emaMacd = macdVal;
        macdSeriesInit = true;
      } else {
        emaMacd = macdVal * k9 + emaMacd * (1 - k9);
      }
    }
    lastMacd = macdVal;
  }
  
  const macd = lastMacd;
  const dea = macdSeriesInit ? emaMacd : macd;
  const histogram = (macd - dea) * 2;
  
  return {
    macd: Number.isFinite(macd) ? macd : 0,
    dea: Number.isFinite(dea) ? dea : macd,
    histogram: Number.isFinite(histogram) ? histogram : 0,
  };
}

/**
 * 计算 ADX (Average Directional Index) — 趋势强度指标
 * 周期默认 14，ADX > 25 表示强趋势，< 20 表示震荡
 */
function calcADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (highs.length < period + 1 || lows.length < period + 1 || closes.length < period + 1) {
    return 0;
  }
  
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trueRanges: number[] = [];
  
  for (let i = 1; i < highs.length; i++) {
    const highDiff = highs[i] - highs[i - 1];
    const lowDiff = lows[i - 1] - lows[i];
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
    
    // +DM / -DM 计算
    if (highDiff > lowDiff && highDiff > 0) {
      plusDM.push(highDiff);
    } else {
      plusDM.push(0);
    }
    if (lowDiff > highDiff && lowDiff > 0) {
      minusDM.push(lowDiff);
    } else {
      minusDM.push(0);
    }
  }
  
  if (trueRanges.length < period) return 0;
  
  // Wilder 平滑 +DI, -DI
  let smoothATR = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  
  const dxValues: number[] = [];
  for (let i = period; i < trueRanges.length; i++) {
    if (smoothATR === 0) {
      dxValues.push(0);
    } else {
      const plusDI = (smoothPDM / smoothATR) * 100;
      const minusDI = (smoothMDM / smoothATR) * 100;
      const diSum = plusDI + minusDI;
      if (diSum === 0) {
        dxValues.push(0);
      } else {
        dxValues.push(Math.abs(plusDI - minusDI) / diSum * 100);
      }
    }
    
    // Wilder 平滑递推
    smoothATR = smoothATR - smoothATR / period + trueRanges[i];
    smoothPDM = smoothPDM - smoothPDM / period + plusDM[i];
    smoothMDM = smoothMDM - smoothMDM / period + minusDM[i];
  }
  
  if (dxValues.length < period) return 0;
  
  // ADX = EMA of DX
  const adx = calcEMA(dxValues, period);
  return Number.isFinite(adx) ? adx : 0;
}

/**
 * 计算布林带 BOLL (Bollinger Bands)
 * 默认参数：period=20, multiplier=2
 * 返回 { upper, middle, lower, bandwidth, percentB }
 */
interface BOLLResult {
  upper: number;     // 上轨
  middle: number;    // 中轨 (SMA20)
  lower: number;     // 下轨
  bandwidth: number; // 带宽 (upper-lower)/middle * 100
  percentB: number;  // %B 指标
}

function calcBOLL(prices: number[], period: number = 20, multiplier: number = 2): BOLLResult {
  const empty: BOLLResult = { upper: 0, middle: 0, lower: 0, bandwidth: 0, percentB: 0 };
  if (prices.length < period) return empty;
  
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  
  if (!Number.isFinite(sma)) return empty;
  
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  
  if (!Number.isFinite(stdDev)) return empty;
  
  const upper = sma + multiplier * stdDev;
  const lower = sma - multiplier * stdDev;
  const bandwidth = sma !== 0 ? ((upper - lower) / sma) * 100 : 0;
  const currentPrice = prices[prices.length - 1];
  const percentB = upper !== lower ? ((currentPrice - lower) / (upper - lower)) : 0.5;
  
  return {
    upper,
    middle: sma,
    lower,
    bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0,
    percentB: Number.isFinite(percentB) ? ensureRange(percentB, 0, 1, 0.5) : 0.5,
  };
}

/**
 * 计算技术指标
 * 
 * K线数据格式：FuturesCandlestick 对象
 * {
 *   t: number,    // 时间戳
 *   v: number,    // 成交量
 *   c: string,    // 收盘价
 *   h: string,    // 最高价
 *   l: string,    // 最低价
 *   o: string,    // 开盘价
 *   sum: string   // 总成交额
 * }
 */
function calculateIndicators(candles: any[]) {
  const empty = () => ({
    currentPrice: 0, ema20: 0, ema60: 0, ema120: 0, ma200: 0,
    macd: 0, rsi14: 50, volume: 0, avgVolume: 0, slope20: 0,
  });

  if (!candles || candles.length === 0) return empty();

  // 处理对象格式的K线数据
  const closes = candles
    .map((c) => {
      if (c && typeof c === 'object' && 'c' in c) return Number.parseFloat(c.c);
      if (Array.isArray(c)) return Number.parseFloat(c[2]);
      return NaN;
    })
    .filter(n => Number.isFinite(n));

  const volumes = candles
    .map((c) => {
      if (c && typeof c === 'object' && 'v' in c) {
        const vol = Number.parseFloat(c.v);
        return Number.isFinite(vol) && vol >= 0 ? vol : 0;
      }
      if (Array.isArray(c)) {
        const vol = Number.parseFloat(c[1]);
        return Number.isFinite(vol) && vol >= 0 ? vol : 0;
      }
      return 0;
    })
    .filter(n => n >= 0);

  if (closes.length === 0) return empty();

  // 核心均线组：EMA 20/60/120 + MA200牛熊线
  const ema20 = calcEMA(closes, 20);
  const ema60 = calcEMA(closes, 60);
  const ema120 = calcEMA(closes, 120);
  // MA200: 简单移动平均，需要至少200根K线
  const ma200 = closes.length >= 200
    ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200
    : 0;

  // MACD (12,26,9)
  const macdResult = calcMACD(closes);

  // RSI14
  const rsi14 = calcRSI(closes, 14);

  // 斜率：最近20根K线的线性回归斜率%
  const slope20 = calculateSlopePercent(closes.slice(-20));

  return {
    currentPrice: ensureFinite(closes.at(-1) || 0),
    ema20: ensureFinite(ema20),
    ema60: ensureFinite(ema60),
    ema120: ensureFinite(ema120),
    ma200: ensureFinite(ma200),
    macd: ensureFinite(macdResult.macd),
    rsi14: ensureRange(rsi14, 0, 100, 50),
    volume: ensureFinite(volumes.at(-1) || 0),
    avgVolume: ensureFinite(volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0),
    slope20: ensureFinite(slope20),
  };
}

/**
 * 计算线性回归斜率（百分比）
 * 基于最小二乘法，返回每单位x的y变化率相对于y均值的百分比
 */
function calculateSlopePercent(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const meanY = sumY / n;
  return meanY !== 0 ? (slope / meanY) * 100 : 0;
}

/**
 * 计算 Sharpe Ratio
 * 使用最近30天的账户历史数据
 */
async function calculateSharpeRatio(): Promise<number> {
  try {
    // 尝试获取所有账户历史数据（不限制30天）
    const result = await dbClient.execute({
      sql: `SELECT total_value, timestamp FROM account_history 
            ORDER BY timestamp ASC`,
      args: [],
    });
    
    if (!result.rows || result.rows.length < 2) {
      return 0; // 数据不足，返回0
    }
    
    // 计算每次交易的收益率（而不是每日）
    const returns: number[] = [];
    for (let i = 1; i < result.rows.length; i++) {
      const prevValue = Number.parseFloat(result.rows[i - 1].total_value as string);
      const currentValue = Number.parseFloat(result.rows[i].total_value as string);
      
      if (prevValue > 0) {
        const returnRate = (currentValue - prevValue) / prevValue;
        returns.push(returnRate);
      }
    }
    
    if (returns.length < 2) {
      return 0;
    }
    
    // 计算平均收益率
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    
    // 计算收益率的标准差
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev === 0) {
      return avgReturn > 0 ? 10 : 0; // 无波动但有收益，返回高值
    }
    
    // Sharpe Ratio = (平均收益率 - 无风险利率) / 标准差
    // 假设无风险利率为0
    const sharpeRatio = avgReturn / stdDev;
    
    return Number.isFinite(sharpeRatio) ? sharpeRatio : 0;
  } catch (error) {
    logger.error("计算 Sharpe Ratio 失败:", error as any);
    return 0;
  }
}

/**
 * 获取账户信息
 * 
 * Gate.io 的 account.total 不包含未实现盈亏
 * 总资产（不含未实现盈亏）= account.total = available + positionMargin
 * 
 * 因此：
 * - totalBalance 不包含未实现盈亏
 * - returnPercent 反映已实现盈亏
 * - 前端显示时需加上 unrealisedPnl
 */
async function getAccountInfo() {
  const exchangeClient = createExchangeClient();
  
  try {
    const account = await exchangeClient.getFuturesAccount();
    
    // 从数据库获取初始资金
    const initialResult = await dbClient.execute(
      "SELECT total_value FROM account_history ORDER BY timestamp ASC LIMIT 1"
    );
    const initialBalance = initialResult.rows[0]
      ? Number.parseFloat(initialResult.rows[0].total_value as string)
      : 100;
    
    // 从数据库获取峰值净值
    const peakResult = await dbClient.execute(
      "SELECT MAX(total_value) as peak FROM account_history"
    );
    const peakBalance = peakResult.rows[0]?.peak 
      ? Number.parseFloat(peakResult.rows[0].peak as string)
      : initialBalance;
    
    // 从 Gate.io API 返回的数据中提取字段
    const accountTotal = Number.parseFloat(account.total || "0");
    const availableBalance = Number.parseFloat(account.available || "0");
    const unrealisedPnl = Number.parseFloat(account.unrealisedPnl || "0");
    
    // Gate.io 的 account.total 不包含未实现盈亏
    // totalBalance 直接使用 account.total（不包含未实现盈亏）
    const totalBalance = accountTotal;
    
    // 资产归0检测与策略重置
    // 当净值跌到初始资金的 5% 以下时，视为当前策略失败
    // 重置初始/峰值基准，从当前净值重新开始，不继承历史回撤
    const STRATEGY_RESET_THRESHOLD = 0.05; // 5% 阈值
    let strategyReset = false;
    let effectiveInitialBalance = initialBalance;
    let effectivePeakBalance = peakBalance;
    
    if (totalBalance > 0 && totalBalance <= initialBalance * STRATEGY_RESET_THRESHOLD) {
      logger.warn(`⚠️ 策略重置触发: 当前净值 ${totalBalance.toFixed(2)} USDT ≤ 初始资金 ${initialBalance.toFixed(2)} USDT 的 ${STRATEGY_RESET_THRESHOLD * 100}%，视为策略失败，重置基准`);
      effectiveInitialBalance = totalBalance;
      effectivePeakBalance = totalBalance;
      strategyReset = true;

      // 清理旧的历史记录，避免前端回撤计算仍基于旧的 1000 USDT 峰值
      // 删除所有 account_history，只保留一条新基准记录
      const dbClient = createClient({
        url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
      });
      await dbClient.execute("DELETE FROM account_history");
      await dbClient.execute({
        sql: `INSERT INTO account_history
              (timestamp, total_value, available_cash, unrealized_pnl, realized_pnl, return_percent)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          getChinaTimeISO(),
          totalBalance,
          totalBalance, // 重置后可用 = 总资产（无持仓）
          0,
          0,
          0,
        ],
      });
      dbClient.close();
      logger.info(`✅ 历史账户记录已清理，新基准: ${totalBalance.toFixed(2)} USDT`);

      // 同步更新 .env 中的 INITIAL_BALANCE，避免下次重启时 init.ts 插回旧值
      try {
        const envPath = process.env.DOTENV_CONFIG_PATH || ".env";
        const fs = await import("fs/promises");
        let envContent = await fs.readFile(envPath, "utf-8");
        const balanceRegex = /^INITIAL_BALANCE=.*$/m;
        if (balanceRegex.test(envContent)) {
          envContent = envContent.replace(balanceRegex, `INITIAL_BALANCE=${totalBalance.toFixed(2)}`);
        } else {
          envContent += `\nINITIAL_BALANCE=${totalBalance.toFixed(2)}\n`;
        }
        await fs.writeFile(envPath, envContent, "utf-8");
        logger.info(`✅ .env INITIAL_BALANCE 已更新: ${totalBalance.toFixed(2)} USDT`);
      } catch (envErr) {
        logger.warn(`⚠️ 更新 .env 失败: ${(envErr as Error).message}`);
      }
    }
    
    // 实时收益率 = (总资产 - 初始资金) / 初始资金 * 100
    // 策略重置后，收益率从 0% 重新开始
    const returnPercent = ((totalBalance - effectiveInitialBalance) / effectiveInitialBalance) * 100;
    
    // 计算 Sharpe Ratio
    const sharpeRatio = await calculateSharpeRatio();
    
    return {
      totalBalance,      // 总资产（不包含未实现盈亏）
      availableBalance,  // 可用余额
      unrealisedPnl,     // 未实现盈亏
      returnPercent,     // 收益率（策略重置后从 0% 开始）
      sharpeRatio,       // 夏普比率
      initialBalance: effectiveInitialBalance,    // 初始净值（策略重置后为当前净值）
      peakBalance: effectivePeakBalance,          // 峰值净值（策略重置后为当前净值）
      strategyReset,     // 是否触发了策略重置
    };
  } catch (error) {
    logger.error("获取账户信息失败:", error as any);
    return {
      totalBalance: 0,
      availableBalance: 0,
      unrealisedPnl: 0,
      returnPercent: 0,
      sharpeRatio: 0,
      initialBalance: 0,
      peakBalance: 0,
    };
  }
}

/**
 * 从 Gate.io 同步持仓到数据库
 * 优化：确保持仓数据的准确性和完整性
 * 数据库中的持仓记录主要用于：
 * 1. 保存止损止盈订单ID等元数据
 * 2. 提供历史查询和监控页面展示
 * 实时持仓数据应该直接从 Gate.io 获取
 */
async function syncPositionsFromGate(cachedPositions?: any[]) {
  const exchangeClient = createExchangeClient();
  
  try {
    // 如果提供了缓存数据，使用缓存；否则重新获取
    const gatePositions = cachedPositions || await exchangeClient.getPositions();
    const dbResult = await dbClient.execute("SELECT symbol, sl_order_id, tp_order_id, stop_loss, profit_target, entry_order_id, opened_at, peak_pnl_percent, partial_close_percentage FROM positions");
    const dbPositionsMap = new Map(
      dbResult.rows.map((row: any) => [row.symbol, row])
    );
    
    // 检查 Gate.io 是否有持仓（可能 API 有延迟）
    const activeGatePositions = gatePositions.filter((p: any) => Number.parseFloat(p.size || "0") !== 0);
    
    // 如果 Gate.io 返回0个持仓但数据库有持仓，可能是 API 延迟，不清空数据库
    if (activeGatePositions.length === 0 && dbResult.rows.length > 0) {
      logger.warn(`Gate.io 返回0个持仓，但数据库有 ${dbResult.rows.length} 个持仓，可能是 API 延迟，跳过同步`);
      return;
    }
    
    await dbClient.execute("DELETE FROM positions");
    
    let syncedCount = 0;
    
    for (const pos of gatePositions) {
      const size = Number.parseFloat(pos.size || "0");
      if (size === 0) continue;
      
      const symbol = pos.contract.replace("_USDT", "");
      let entryPrice = Number.parseFloat(pos.entryPrice || "0");
      let currentPrice = Number.parseFloat(pos.markPrice || "0");
      const leverage = Number.parseInt(pos.leverage || "1");
      const side = size > 0 ? "long" : "short";
      const quantity = Math.abs(size);
      const unrealizedPnl = Number.parseFloat(pos.unrealisedPnl || "0");
      let liquidationPrice = Number.parseFloat(pos.liqPrice || "0");
      
      if (entryPrice === 0 || currentPrice === 0) {
        try {
          const ticker = await exchangeClient.getFuturesTicker(pos.contract);
          if (currentPrice === 0) {
            currentPrice = Number.parseFloat(ticker.markPrice || ticker.last || "0");
          }
          if (entryPrice === 0) {
            entryPrice = currentPrice;
          }
        } catch (error) {
          logger.error(`获取 ${symbol} 行情失败:`, error as any);
        }
      }
      
      if (liquidationPrice === 0 && entryPrice > 0) {
        liquidationPrice = side === "long" 
          ? entryPrice * (1 - 0.9 / leverage)
          : entryPrice * (1 + 0.9 / leverage);
      }
      
      const dbPos = dbPositionsMap.get(symbol);
      
      // 保留原有的 entry_order_id，不要覆盖
      const entryOrderId = dbPos?.entry_order_id || `synced-${symbol}-${Date.now()}`;
      
      await dbClient.execute({
        sql: `INSERT INTO positions 
              (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
               leverage, side, stop_loss, profit_target, sl_order_id, tp_order_id, entry_order_id, opened_at, peak_pnl_percent, partial_close_percentage)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          symbol,
          quantity,
          entryPrice,
          currentPrice,
          liquidationPrice,
          unrealizedPnl,
          leverage,
          side,
          dbPos?.stop_loss || null,
          dbPos?.profit_target || null,
          dbPos?.sl_order_id || null,
          dbPos?.tp_order_id || null,
          entryOrderId, // 保留原有的订单ID
          dbPos?.opened_at || getChinaTimeISO(), // 保留原有的开仓时间
          dbPos?.peak_pnl_percent || 0, // 保留峰值盈利
          dbPos?.partial_close_percentage || 0, // 保留已平仓百分比（关键修复）
        ],
      });
      
      syncedCount++;
    }
    
    const activeGatePositionsCount = gatePositions.filter((p: any) => Number.parseFloat(p.size || "0") !== 0).length;
    if (activeGatePositionsCount > 0 && syncedCount === 0) {
      logger.error(`Gate.io 有 ${activeGatePositionsCount} 个持仓，但数据库同步失败！`);
    }
    
  } catch (error) {
    logger.error("同步持仓失败:", error as any);
  }
}

/**
 * 获取持仓信息 - 直接从 Gate.io 获取最新数据
 * @param cachedGatePositions 可选，已获取的原始Gate持仓数据，避免重复调用API
 * @returns 格式化后的持仓数据
 */
async function getPositions(cachedGatePositions?: any[]) {
  const exchangeClient = createExchangeClient();
  
  try {
    // 如果提供了缓存数据，使用缓存；否则重新获取
    const gatePositions = cachedGatePositions || await exchangeClient.getPositions();
    
    // 从数据库获取持仓的开仓时间、峰值盈利、分批状态和保护止损
    const dbResult = await dbClient.execute(
      "SELECT symbol, opened_at, peak_pnl_percent, leverage, partial_close_percentage, stop_loss FROM positions"
    );
    const dbDataMap = new Map(
      dbResult.rows.map((row: any) => [row.symbol, {
        opened_at: row.opened_at,
        peak_pnl_percent: Number.parseFloat(row.peak_pnl_percent as string || "0"),
        leverage: Number.parseInt(row.leverage as string || "1"),
        partial_close_percentage: Number.parseFloat(row.partial_close_percentage as string || "0"),
        stop_loss: row.stop_loss === null || row.stop_loss === undefined
          ? null
          : Number.parseFloat(row.stop_loss as string),
      }])
    );
    
    // 过滤并格式化持仓
    const positions = gatePositions
      .filter((p: any) => Number.parseFloat(p.size || "0") !== 0)
      .map((p: any) => {
        const size = Number.parseFloat(p.size || "0");
        const symbol = p.contract.replace("_USDT", "");
        
        // 从数据库读取开仓时间、峰值盈利和杠杆数
        const dbData = dbDataMap.get(symbol);
        let openedAt = dbData?.opened_at;
        const peakPnlPercent = dbData?.peak_pnl_percent || 0;
        const partialClosePercentage = dbData?.partial_close_percentage || 0;
        const stopLossOverride = dbData?.stop_loss ?? null;
        const gateLeverage = Number.parseInt(p.leverage || "1");
        
        // 🔧 修复：优先使用数据库中记录的杠杆数（开仓时的杠杆数），而不是 Gate.io 的实时杠杆数
        const leverage = dbData?.leverage || gateLeverage;
        
        // 如果杠杆数不一致，记录警告
        if (dbData && gateLeverage !== leverage) {
          logger.warn(
            `⚠️ ${symbol} 杠杆数不一致: Gate.io=${gateLeverage}x, 数据库(开仓时)=${leverage}x. ` +
            `将使用开仓时的杠杆数 ${leverage}x。`
          );
        }
        
        // 如果数据库中没有开仓时间，尝试从Gate.io的create_time获取
        if (!openedAt && p.create_time) {
          // Gate.io的create_time是UNIX时间戳（秒），需要转换为ISO字符串
          if (typeof p.create_time === 'number') {
            openedAt = new Date(p.create_time * 1000).toISOString();
          } else {
            openedAt = p.create_time;
          }
        }
        
        // 如果还是没有，使用当前时间（这种情况不应该发生）
        if (!openedAt) {
          openedAt = getChinaTimeISO();
          logger.warn(`${symbol} 持仓的开仓时间缺失，使用当前时间`);
        }
        
        return {
          symbol,
          contract: p.contract,
          quantity: Math.abs(size),
          side: size > 0 ? "long" : "short",
          entry_price: Number.parseFloat(p.entryPrice || "0"),
          current_price: Number.parseFloat(p.markPrice || "0"),
          liquidation_price: Number.parseFloat(p.liqPrice || "0"),
          unrealized_pnl: Number.parseFloat(p.unrealisedPnl || "0"),
          leverage, // 使用数据库中的杠杆数
          margin: Number.parseFloat(p.margin || "0"),
          opened_at: openedAt,
          peak_pnl_percent: peakPnlPercent, // 添加峰值盈利字段
          partial_close_percentage: partialClosePercentage,
          stop_loss: stopLossOverride,
        };
      });
    
    return positions;
  } catch (error) {
    logger.error("获取持仓失败:", error as any);
    return [];
  }
}

/**
 * 获取历史成交记录（最近10条）
 * 从数据库获取历史交易记录（监控页的交易历史）
 */
async function getTradeHistory(limit: number = 10) {
  try {
    // 从数据库获取历史交易记录
    const result = await dbClient.execute({
      sql: `SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`,
      args: [limit],
    });
    
    if (!result.rows || result.rows.length === 0) {
      return [];
    }
    
    // 转换数据库格式到提示词需要的格式
    const trades = result.rows.map((row: any) => {
      return {
        symbol: row.symbol,
        side: row.side, // long/short
        type: row.type, // open/close
        price: Number.parseFloat(row.price || "0"),
        quantity: Number.parseFloat(row.quantity || "0"),
        leverage: Number.parseInt(row.leverage || "1"),
        pnl: row.pnl ? Number.parseFloat(row.pnl) : null,
        fee: Number.parseFloat(row.fee || "0"),
        timestamp: row.timestamp,
        status: row.status,
      };
    });
    
    // 按时间正序排列（最旧 → 最新）
    trades.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    return trades;
  } catch (error) {
    logger.error("获取历史成交记录失败:", error as any);
    return [];
  }
}

/**
 * 获取最近N次的AI决策记录
 */
async function getRecentDecisions(limit: number = 3) {
  try {
    const result = await dbClient.execute({
      sql: `SELECT timestamp, iteration, decision, account_value, positions_count 
            FROM agent_decisions 
            ORDER BY timestamp DESC 
            LIMIT ?`,
      args: [limit],
    });
    
    if (!result.rows || result.rows.length === 0) {
      return [];
    }
    
    // 返回格式化的决策记录（从旧到新）
    return result.rows.reverse().map((row: any) => ({
      timestamp: row.timestamp,
      iteration: row.iteration,
      decision: row.decision,
      account_value: Number.parseFloat(row.account_value || "0"),
      positions_count: Number.parseInt(row.positions_count || "0"),
    }));
  } catch (error) {
    logger.error("获取最近决策记录失败:", error as any);
    return [];
  }
}

/**
 * 获取最近N次的信号质量评分记录
 */
async function getRecentQualityScores(limit: number = 5) {
  try {
    const result = await dbClient.execute({
      sql: `SELECT timestamp, symbol, price, quality_score, score_components 
            FROM trading_signals 
            WHERE quality_score IS NOT NULL AND quality_score > 0
            ORDER BY timestamp DESC 
            LIMIT ?`,
      args: [limit],
    });
    
    if (!result.rows || result.rows.length === 0) {
      return [];
    }
    
    return result.rows.reverse().map((row: any) => ({
      timestamp: row.timestamp,
      symbol: row.symbol,
      price: Number.parseFloat(row.price || "0"),
      qualityScore: Number.parseFloat(row.quality_score || "0"),
      components: row.score_components ? JSON.parse(row.score_components) : null,
    }));
  } catch (error) {
    logger.error("获取最近质量评分失败:", error as any);
    return [];
  }
}


/**
 * 同步风险配置到数据库
 */
async function syncConfigToDatabase() {
  try {
    const config = getAccountRiskConfig();
    const timestamp = getChinaTimeISO();
    
    // 更新或插入配置
    await dbClient.execute({
      sql: `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
      args: ['account_stop_loss_usdt', config.stopLossUsdt.toString(), timestamp],
    });
    
    await dbClient.execute({
      sql: `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
      args: ['account_take_profit_usdt', config.takeProfitUsdt.toString(), timestamp],
    });
    
    logger.info(`配置已同步到数据库: 止损线=${config.stopLossUsdt} USDT, 止盈线=${config.takeProfitUsdt} USDT`);
  } catch (error) {
    logger.error("同步配置到数据库失败:", error as any);
  }
}

/**
 * 从数据库加载风险配置
 */
async function loadConfigFromDatabase() {
  try {
    const stopLossResult = await dbClient.execute({
      sql: `SELECT value FROM system_config WHERE key = ?`,
      args: ['account_stop_loss_usdt'],
    });
    
    const takeProfitResult = await dbClient.execute({
      sql: `SELECT value FROM system_config WHERE key = ?`,
      args: ['account_take_profit_usdt'],
    });
    
    if (stopLossResult.rows.length > 0 && takeProfitResult.rows.length > 0) {
      accountRiskConfig = {
        stopLossUsdt: Number.parseFloat(stopLossResult.rows[0].value as string),
        takeProfitUsdt: Number.parseFloat(takeProfitResult.rows[0].value as string),
        syncOnStartup: accountRiskConfig.syncOnStartup,
      };
      
      logger.info(`从数据库加载配置: 止损线=${accountRiskConfig.stopLossUsdt} USDT, 止盈线=${accountRiskConfig.takeProfitUsdt} USDT`);
    }
  } catch (error) {
    logger.warn("从数据库加载配置失败，使用环境变量配置:", error as any);
  }
}

/**
 * 修复历史盈亏记录
 * 每个周期结束时自动调用，确保所有交易记录的盈亏计算正确
 */
async function fixHistoricalPnlRecords() {
  try {
    // 查询所有平仓记录
    const result = await dbClient.execute({
      sql: `SELECT * FROM trades WHERE type = 'close' ORDER BY timestamp DESC LIMIT 50`,
      args: [],
    });

    if (!result.rows || result.rows.length === 0) {
      return;
    }

    let fixedCount = 0;

    for (const closeTrade of result.rows) {
      const id = closeTrade.id;
      const symbol = closeTrade.symbol as string;
      const side = closeTrade.side as string;
      const closePrice = Number.parseFloat(closeTrade.price as string);
      const quantity = Number.parseFloat(closeTrade.quantity as string);
      const recordedPnl = Number.parseFloat(closeTrade.pnl as string || "0");
      const recordedFee = Number.parseFloat(closeTrade.fee as string || "0");
      const timestamp = closeTrade.timestamp as string;

      // 查找对应的开仓记录
      const openResult = await dbClient.execute({
        sql: `SELECT * FROM trades WHERE symbol = ? AND type = 'open' AND timestamp < ? ORDER BY timestamp DESC LIMIT 1`,
        args: [symbol, timestamp],
      });

      if (!openResult.rows || openResult.rows.length === 0) {
        continue;
      }

      const openTrade = openResult.rows[0];
      const openPrice = Number.parseFloat(openTrade.price as string);

      // 获取合约乘数
      const contract = `${symbol}_USDT`;
      const quantoMultiplier = await getQuantoMultiplier(contract);

      // 重新计算正确的盈亏
      const priceChange = side === "long" 
        ? (closePrice - openPrice) 
        : (openPrice - closePrice);
      
      const grossPnl = priceChange * quantity * quantoMultiplier;
      const openFee = openPrice * quantity * quantoMultiplier * 0.0005;
      const closeFee = closePrice * quantity * quantoMultiplier * 0.0005;
      const totalFee = openFee + closeFee;
      const correctPnl = grossPnl - totalFee;

      // 计算差异
      const pnlDiff = Math.abs(recordedPnl - correctPnl);
      const feeDiff = Math.abs(recordedFee - totalFee);

      // 如果差异超过0.5 USDT，就需要修复
      if (pnlDiff > 0.5 || feeDiff > 0.1) {
        logger.warn(`修复交易记录 ID=${id} (${symbol} ${side})`);
        logger.warn(`  盈亏: ${recordedPnl.toFixed(2)} → ${correctPnl.toFixed(2)} USDT (差异: ${pnlDiff.toFixed(2)})`);
        
        // 更新数据库
        await dbClient.execute({
          sql: `UPDATE trades SET pnl = ?, fee = ? WHERE id = ?`,
          args: [correctPnl, totalFee, id],
        });
        
        fixedCount++;
      }
    }

    if (fixedCount > 0) {
      logger.info(`修复了 ${fixedCount} 条历史盈亏记录`);
    }
  } catch (error) {
    logger.error("修复历史盈亏记录失败:", error as any);
  }
}

/**
 * 清仓所有持仓
 */
async function closeAllPositions(reason: string): Promise<void> {
  const exchangeClient = createExchangeClient();
  
  try {
    logger.warn(`清仓所有持仓，原因: ${reason}`);
    
    const positions = await exchangeClient.getPositions();
    const activePositions = positions.filter((p: any) => Number.parseFloat(p.size || "0") !== 0);
    
    if (activePositions.length === 0) {
      return;
    }
    
    for (const pos of activePositions) {
      const size = Number.parseFloat(pos.size || "0"); // 修复：使用 parseFloat 而非 parseInt
      const contract = pos.contract;
      const symbol = contract.replace("_USDT", "");
      
      // 跳过无效的持仓
      if (size === 0 || !Number.isFinite(size)) {
        logger.warn(`跳过无效持仓: ${symbol}, size=${pos.size}`);
        continue;
      }
      
      try {
        await exchangeClient.placeOrder({
          contract,
          size: -size,
          price: 0, // 市价单必须传 price: 0
          reduceOnly: true, // 只减仓，不开新仓
        });
        
        logger.info(`已平仓: ${symbol} ${Math.abs(size)}张`);
      } catch (error) {
        logger.error(`平仓失败: ${symbol}`, error as any);
      }
    }
    
    logger.warn(`清仓完成`);
  } catch (error) {
    logger.error("清仓失败:", error as any);
    throw error;
  }
}

/**
 * 检查账户余额是否触发止损或止盈
 * @returns true: 触发退出条件, false: 继续运行
 */
async function checkAccountThresholds(accountInfo: any): Promise<boolean> {
  const totalBalance = accountInfo.totalBalance;
  
  // 检查止损线
  if (totalBalance <= accountRiskConfig.stopLossUsdt) {
    logger.error(`触发止损线！余额: ${totalBalance.toFixed(2)} USDT <= ${accountRiskConfig.stopLossUsdt} USDT`);
    await closeAllPositions(`账户余额触发止损线 (${totalBalance.toFixed(2)} USDT)`);
    return true;
  }
  
  // 检查止盈线
  if (totalBalance >= accountRiskConfig.takeProfitUsdt) {
    logger.warn(`触发止盈线！余额: ${totalBalance.toFixed(2)} USDT >= ${accountRiskConfig.takeProfitUsdt} USDT`);
    await closeAllPositions(`账户余额触发止盈线 (${totalBalance.toFixed(2)} USDT)`);
    return true;
  }
  
  return false;
}

/**
 * 执行交易决策
 * 优化：增强错误处理和数据验证，确保数据实时准确
 */
async function executeTradingDecision() {
  iterationCount++;
  const minutesElapsed = Math.floor((Date.now() - tradingStartTime.getTime()) / 60000);
  const intervalMinutes = Number.parseInt(process.env.TRADING_INTERVAL_MINUTES || "5");
  
  logger.info(`\n${"=".repeat(80)}`);
  logger.info(`交易周期 #${iterationCount} (运行${minutesElapsed}分钟)`);
  logger.info(`${"=".repeat(80)}\n`);

  let marketData: any = {};
  let newsData: Record<string, any> = {};
  let accountInfo: any = null;
  let positions: any[] = [];

  try {
    // 1. 并行收集市场数据和消息面数据
    try {
      const [marketResult, newsResult] = await Promise.allSettled([
        collectMarketData(),
        collectNewsData(),
      ]);

      if (marketResult.status === "fulfilled") {
        marketData = marketResult.value;
      } else {
        throw marketResult.reason;
      }

      if (newsResult.status === "fulfilled") {
        newsData = newsResult.value;
        const newsSymbols = Object.keys(newsData).filter(s => {
          const d = newsData[s];
          return d && (d.news?.length > 0 || d.announcements?.length > 0 || d.sentiment);
        });
        if (newsSymbols.length > 0) {
          logger.info(`消息面数据获取成功: ${newsSymbols.join(", ")}`);
        }
      } else {
        logger.warn("消息面数据获取失败，继续使用技术面数据");
      }

      const validSymbols = SYMBOLS.filter(symbol => {
        const data = marketData[symbol];
        if (!data || data.price === 0) {
          return false;
        }
        return true;
      });
      
      if (validSymbols.length === 0) {
        logger.error("市场数据获取失败，跳过本次循环");
        return;
      }
    } catch (error) {
      logger.error("收集市场数据失败:", error as any);
      return;
    }
    
    // 2. 获取账户信息
    try {
      accountInfo = await getAccountInfo();
      
      if (!accountInfo || accountInfo.totalBalance === 0) {
        logger.error("账户数据异常，跳过本次循环");
        return;
      }
      
      // 2.5 风控检查（新增）
      try {
        const riskState = await checkRiskGuard(accountInfo.totalBalance);
        if (!riskState.canTrade) {
          const blockedReason = riskState.blockedReason || "未知原因";
          logger.warn(`⛔ 风控拦截: ${blockedReason}`);
          await logRiskEvent({
            type: "blocked",
            message: blockedReason,
            balance: accountInfo.totalBalance,
          });
          // 发送 Telegram 告警
          await notifyRiskBlocked(blockedReason, accountInfo.totalBalance);
          return; // 跳过本次交易周期
        }
        logger.info(`✅ 风控通过: ${riskState.isRecoveryMode ? "恢复模式" : "正常模式"} | 今日盈亏: ${riskState.dailyPnLPercent >= 0 ? "+" : ""}${riskState.dailyPnLPercent.toFixed(2)}% | 连续亏损: ${riskState.consecutiveLosses}次`);
        
        // 将风控状态存入全局上下文，供后续使用
        (global as any).__riskState = riskState;
      } catch (riskError) {
        logger.warn("风控检查失败，继续交易（降级模式）:", riskError as any);
      }
      
      // 检查账户余额是否触发止损或止盈
      const shouldExit = await checkAccountThresholds(accountInfo);
      if (shouldExit) {
        logger.error("账户余额触发退出条件，系统即将停止！");
        setTimeout(() => {
          process.exit(0);
        }, 5000);
        return;
      }
      
    } catch (error) {
      logger.error("获取账户信息失败:", error as any);
      return;
    }
    
    // 3. 同步持仓信息（优化：只调用一次API，避免重复）
    try {
      const exchangeClient = createExchangeClient();
      const rawGatePositions = await exchangeClient.getPositions();
      
      // 添加详细日志：显示原始持仓数据
      logger.info(`Gate.io 原始持仓数据: ${JSON.stringify(rawGatePositions.map((p: any) => ({
        contract: p.contract,
        size: p.size,
        entryPrice: p.entryPrice,
        unrealisedPnl: p.unrealisedPnl
      })))}`);
      
      // 使用同一份数据进行处理和同步，避免重复调用API
      positions = await getPositions(rawGatePositions);
      
      // 添加详细日志：显示处理后的持仓数据
      logger.info(`处理后的持仓数量: ${positions.length}`);
      if (positions.length > 0) {
        logger.info(`持仓详情: ${JSON.stringify(positions.map(p => ({
          symbol: p.symbol,
          side: p.side,
          quantity: p.quantity,
          entry_price: p.entry_price,
          unrealized_pnl: p.unrealized_pnl
        })))}`);
      }
      
      await syncPositionsFromGate(rawGatePositions);
      
      const dbPositions = await dbClient.execute("SELECT COUNT(*) as count FROM positions");
      const dbCount = (dbPositions.rows[0] as any).count;
      
      if (positions.length !== dbCount) {
        logger.warn(`持仓同步不一致: Gate=${positions.length}, DB=${dbCount}`);
        // 再次同步，使用同一份数据
        await syncPositionsFromGate(rawGatePositions);
      }
    } catch (error) {
      logger.error("持仓同步失败:", error as any);
    }
    
    // 4. ====== 强制风控检查（在AI执行前） ======
    const exchangeClient = createExchangeClient();
    
    for (const pos of positions) {
      const symbol = pos.symbol;
      const side = pos.side;
      const leverage = pos.leverage;
      const entryPrice = pos.entry_price;
      const currentPrice = pos.current_price;
      
      // 计算盈亏百分比（考虑杠杆）
      const priceChangePercent = entryPrice > 0 
        ? ((currentPrice - entryPrice) / entryPrice * 100 * (side === 'long' ? 1 : -1))
        : 0;
      const pnlPercent = priceChangePercent * leverage;
      
      // 获取并更新峰值盈利
      let peakPnlPercent = 0;
      try {
        const dbPosResult = await dbClient.execute({
          sql: "SELECT peak_pnl_percent FROM positions WHERE symbol = ?",
          args: [symbol],
        });
        
        if (dbPosResult.rows.length > 0) {
          peakPnlPercent = Number.parseFloat(dbPosResult.rows[0].peak_pnl_percent as string || "0");
          
          // 如果当前盈亏超过历史峰值，更新峰值
          if (pnlPercent > peakPnlPercent) {
            peakPnlPercent = pnlPercent;
            await dbClient.execute({
              sql: "UPDATE positions SET peak_pnl_percent = ? WHERE symbol = ?",
              args: [peakPnlPercent, symbol],
            });
            logger.info(`${symbol} 峰值盈利更新: ${peakPnlPercent.toFixed(2)}%`);
          }
        }
      } catch (error: any) {
        logger.warn(`获取峰值盈利失败 ${symbol}: ${error.message}`);
      }
      
      let shouldClose = false;
      let closeReason = "";
      
      // a) 最大持仓时间强制平仓检查（从环境变量读取）
      const openedTime = new Date(pos.opened_at);
      const now = new Date();
      const holdingHours = (now.getTime() - openedTime.getTime()) / (1000 * 60 * 60);
      const MAX_HOLDING_HOURS = RISK_PARAMS.MAX_HOLDING_HOURS;
      
      if (holdingHours >= MAX_HOLDING_HOURS) {
        shouldClose = true;
        closeReason = `持仓时间已达 ${holdingHours.toFixed(1)} 小时，超过${MAX_HOLDING_HOURS}小时限制`;
      }
      
      // b) 极端止损保护（防止爆仓，最后的安全网）
      // 只在极端情况下强制平仓，避免账户爆仓
      // 常规止损由AI决策，这里只是最后的安全网
      const EXTREME_STOP_LOSS = RISK_PARAMS.EXTREME_STOP_LOSS_PERCENT; // 从环境变量读取
      
      logger.info(`${symbol} 极端止损检查: 当前盈亏=${pnlPercent.toFixed(2)}%, 极端止损线=${EXTREME_STOP_LOSS}%`);
      
      if (pnlPercent <= EXTREME_STOP_LOSS) {
        shouldClose = true;
        closeReason = `触发极端止损保护 (${pnlPercent.toFixed(2)}% ≤ ${EXTREME_STOP_LOSS}%，防止爆仓)`;
        logger.error(`${closeReason}`);
      }
      
      // c) 超短线策略专属风控规则
      const strategy = getTradingStrategy();
      if (strategy === 'ultra-short' && !shouldClose) {
        const holdingMinutes = holdingHours * 60;
        
        // 计算手续费成本（开仓 + 平仓，总共约 0.1%）
        // 考虑杠杆后，需要的盈利百分比 = 0.1% * 杠杆
        const feeThreshold = 0.1 * leverage;
        
        // 移动止盈的第一档触发阈值
        const params = getStrategyParams(strategy);
        const trailingStopTrigger = params.trailingStop.level1.trigger; // 4%
        
        // 规则1：每周期2%锁利规则（优先级最高）
        // 每个交易周期内，如果盈利 >2% 但未触发移动止盈（<4%），立即平仓锁定利润
        if (pnlPercent > 2 && pnlPercent < trailingStopTrigger) {
          shouldClose = true;
          closeReason = `超短线策略周期锁利规则：盈利${pnlPercent.toFixed(2)}% >2%，未达到移动止盈触发线${trailingStopTrigger}%，立即平仓锁定利润`;
          logger.info(`【超短线周期锁利】${symbol} ${closeReason}`);
        }
        
        // 规则2：30分钟盈利平仓规则（保底规则）
        // 如果持仓超过30分钟，处于盈利状态，但没有触发移动止盈，且覆盖了交易费，进行平仓
        if (!shouldClose && holdingMinutes >= 30 && pnlPercent > feeThreshold && pnlPercent < trailingStopTrigger) {
          shouldClose = true;
          closeReason = `超短线策略30分钟盈利平仓规则：持仓${holdingMinutes.toFixed(1)}分钟，盈利${pnlPercent.toFixed(2)}%（已覆盖手续费${feeThreshold.toFixed(2)}%），但未达到移动止盈触发线${trailingStopTrigger}%，执行保守平仓`;
          logger.info(`【超短线30分钟规则】${symbol} ${closeReason}`);
        }
      }
      
      // d) 其他风控检查已移除，交由AI全权决策
      // AI负责：止损、移动止盈、分批止盈、时间止盈、峰值回撤等策略性决策
      // 系统只保留底线安全保护（极端止损、最大持仓时间强制平仓、账户回撤保护）
      
      logger.info(`${symbol} 持仓监控: 盈亏=${pnlPercent.toFixed(2)}%, 持仓时间=${holdingHours.toFixed(1)}h, 峰值盈利=${peakPnlPercent.toFixed(2)}%, 杠杆=${leverage}x`);
      
      // 执行强制平仓
      if (shouldClose) {
        logger.warn(`【强制平仓】${symbol} ${side} - ${closeReason}`);
        
        // 验证持仓数量是否有效
        if (pos.quantity === 0 || !Number.isFinite(pos.quantity)) {
          logger.error(`无效的持仓数量: ${symbol}, quantity=${pos.quantity}`);
          continue;
        }
        
        try {
          const contract = `${symbol}_USDT`;
          const size = side === 'long' ? -pos.quantity : pos.quantity;
          
          // 1. 执行平仓订单
          const order = await exchangeClient.placeOrder({
            contract,
            size,
            price: 0,
            reduceOnly: true,
          });
          
          logger.info(`已下达强制平仓订单 ${symbol}，订单ID: ${order.id}`);
          
          // 2. 等待订单完成并获取成交信息（最多重试5次）
          let actualExitPrice = 0;
          let actualQuantity = Math.abs(pos.quantity);
          let pnl = 0;
          let totalFee = 0;
          let orderFilled = false;
          
          for (let retry = 0; retry < 5; retry++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            
            try {
              const orderStatus = await exchangeClient.getOrder(order.id?.toString() || "");
              
              if (orderStatus.status === 'finished') {
                actualExitPrice = Number.parseFloat(orderStatus.fill_price || orderStatus.price || "0");
                actualQuantity = Math.abs(Number.parseFloat(orderStatus.size || "0"));
                orderFilled = true;
                
                // 获取合约乘数
                const quantoMultiplier = await getQuantoMultiplier(contract);
                
                // 计算盈亏
                const entryPrice = pos.entry_price;
                const priceChange = side === "long" 
                  ? (actualExitPrice - entryPrice) 
                  : (entryPrice - actualExitPrice);
                
                const grossPnl = priceChange * actualQuantity * quantoMultiplier;
                
                // 计算手续费（开仓 + 平仓）
                const openFee = entryPrice * actualQuantity * quantoMultiplier * 0.0005;
                const closeFee = actualExitPrice * actualQuantity * quantoMultiplier * 0.0005;
                totalFee = openFee + closeFee;
                
                // 净盈亏
                pnl = grossPnl - totalFee;
                
                logger.info(`平仓成交: 价格=${actualExitPrice}, 数量=${actualQuantity}, 盈亏=${pnl.toFixed(2)} USDT`);
                break;
              }
            } catch (statusError: any) {
              logger.warn(`查询订单状态失败 (重试${retry + 1}/5): ${statusError.message}`);
            }
          }
          
          // 3. 记录到trades表（无论是否成功获取详细信息都要记录）
          try {
            // 关键验证：检查盈亏计算是否正确
            const finalPrice = actualExitPrice || pos.current_price;
            const quantoMultiplier = await getQuantoMultiplier(contract);
            const notionalValue = finalPrice * actualQuantity * quantoMultiplier;
            const priceChangeCheck = side === "long" 
              ? (finalPrice - pos.entry_price) 
              : (pos.entry_price - finalPrice);
            const expectedPnl = priceChangeCheck * actualQuantity * quantoMultiplier - totalFee;
            
            // 检测盈亏是否被错误地设置为名义价值
            if (Math.abs(pnl - notionalValue) < Math.abs(pnl - expectedPnl)) {
              logger.error(`【强制平仓】检测到盈亏计算异常！`);
              logger.error(`  当前pnl: ${pnl.toFixed(2)} USDT 接近名义价值 ${notionalValue.toFixed(2)} USDT`);
              logger.error(`  预期pnl: ${expectedPnl.toFixed(2)} USDT`);
              logger.error(`  开仓价: ${pos.entry_price}, 平仓价: ${finalPrice}, 数量: ${actualQuantity}, 合约乘数: ${quantoMultiplier}`);
              
              // 强制修正为正确值
              pnl = expectedPnl;
              logger.warn(`  已自动修正pnl为: ${pnl.toFixed(2)} USDT`);
            }
            
            // 详细日志
            logger.info(`【强制平仓盈亏详情】${symbol} ${side}`);
            logger.info(`  原因: ${closeReason}`);
            logger.info(`  开仓价: ${pos.entry_price.toFixed(4)}, 平仓价: ${finalPrice.toFixed(4)}, 数量: ${actualQuantity}张`);
            logger.info(`  净盈亏: ${pnl.toFixed(2)} USDT, 手续费: ${totalFee.toFixed(4)} USDT`);
            
            await dbClient.execute({
              sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, pnl, fee, timestamp, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              args: [
                order.id?.toString() || "",
                symbol,
                side,
                "close",
                finalPrice, // 使用验证后的价格
                actualQuantity,
                pos.leverage || 1,
                pnl, // 已验证和修正的盈亏
                totalFee,
                getChinaTimeISO(),
                orderFilled ? "filled" : "pending",
              ],
            });
            logger.info(`已记录强制平仓交易到数据库: ${symbol}, 盈亏=${pnl.toFixed(2)} USDT, 原因=${closeReason}`);
          } catch (dbError: any) {
            logger.error(`记录强制平仓交易失败: ${dbError.message}`);
            // 即使数据库写入失败，也记录到日志以便后续补救
            logger.error(`缺失的交易记录: ${JSON.stringify({
              order_id: order.id,
              symbol,
              side,
              type: "close",
              price: actualExitPrice,
              quantity: actualQuantity,
              pnl,
              reason: closeReason,
            })}`);
          }
          
          // 4. 从数据库删除持仓记录
          await dbClient.execute({
            sql: "DELETE FROM positions WHERE symbol = ?",
            args: [symbol],
          });
          
          logger.info(`强制平仓完成 ${symbol}，原因：${closeReason}`);
          
        } catch (closeError: any) {
          logger.error(`强制平仓失败 ${symbol}: ${closeError.message}`);
          // 即使失败也记录到日志
          logger.error(`强制平仓失败详情: symbol=${symbol}, side=${side}, quantity=${pos.quantity}, reason=${closeReason}`);
        }
      }
    }
    
    // 重新获取持仓（可能已经被强制平仓）
    positions = await getPositions();
    
    // 4. 不再保存账户历史（已移除资金曲线模块）
    // try {
    //   await saveAccountHistory(accountInfo);
    // } catch (error) {
    //   logger.error("保存账户历史失败:", error as any);
    //   // 不影响主流程
    // }
    
    // 5. 数据完整性最终检查
    const dataValid = 
      marketData && Object.keys(marketData).length > 0 &&
      accountInfo && accountInfo.totalBalance > 0 &&
      Array.isArray(positions);
    
    if (!dataValid) {
      logger.error("数据完整性检查失败，跳过本次循环");
      logger.error(`市场数据: ${Object.keys(marketData).length}, 账户: ${accountInfo?.totalBalance}, 持仓: ${positions.length}`);
      return;
    }
    
    // 6. 修复历史盈亏记录
    try {
      await fixHistoricalPnlRecords();
    } catch (error) {
      logger.warn("修复历史盈亏记录失败:", error as any);
      // 不影响主流程，继续执行
    }
    
    // 7. 获取历史成交记录（最近20条）
    let tradeHistory: any[] = [];
    try {
      tradeHistory = await getTradeHistory(20);
    } catch (error) {
      logger.warn("获取历史成交记录失败:", error as any);
      // 不影响主流程，继续执行
    }
    
    // 8. 获取最近的AI决策（最近5次）
    let recentDecisions: any[] = [];
    try {
      recentDecisions = await getRecentDecisions(5);
    } catch (error) {
      logger.warn("获取最近决策记录失败:", error as any);
      // 不影响主流程，继续执行
    }
    
    // 8b. 获取最近信号质量评分（最近5次）
    let recentQualityScores: any[] = [];
    try {
      recentQualityScores = await getRecentQualityScores(5);
    } catch (error) {
      logger.warn("获取最近质量评分失败:", error as any);
    }
    
    // 9. 生成提示词并调用 Agent
    const prompt = generateTradingPrompt({
      minutesElapsed,
      iteration: iterationCount,
      intervalMinutes,
      marketData,
      newsData,
      accountInfo,
      positions,
      tradeHistory,
      recentDecisions,
      recentQualityScores,
      positionCount: positions.length,
    });
    
    // 输出完整提示词到日志
    logger.info("【入参 - AI 提示词】");
    logger.info("=".repeat(80));
    logger.info(prompt);
    logger.info("=".repeat(80) + "\n");
    
    // 传递市场数据给Agent（用于子Agent）
    const agent = await createTradingAgent(intervalMinutes, marketData);
    
    try {
      // 设置足够大的 maxOutputTokens 以避免输出被截断
      // DeepSeek API 限制: max_tokens 范围为 [1, 8192]
      const response = await agent.generateText(prompt, {
        maxOutputTokens: 8192,
        maxSteps: 20,
        temperature: 0.4,
      });
      
      // 从响应中提取AI的完整回复，不进行任何切分
      let decisionText = "";
      
      // 添加调试日志，查看响应的原始结构
      logger.debug(`响应类型: ${typeof response}`);
      if (response && typeof response === 'object') {
        logger.debug(`响应结构: ${JSON.stringify(Object.keys(response))}`);
        const steps = (response as any).steps || [];
        logger.debug(`步骤数量: ${steps.length}`);
      }
      
      if (typeof response === 'string') {
        decisionText = response;
        logger.debug(`字符串响应长度: ${decisionText.length}`);
      } else if (response && typeof response === 'object') {
        const steps = (response as any).steps || [];
        
        // 收集所有AI的文本回复（完整保存，不切分）
        const allTexts: string[] = [];
        
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          logger.debug(`处理步骤 ${i + 1}/${steps.length}`);
          
          let stepText = "";
          
          // 优先从 step.content 中提取文本
          if (step.content && Array.isArray(step.content)) {
            logger.debug(`  内容项数量: ${step.content.length}`);
            const textItems: string[] = [];
            for (const item of step.content) {
              if (item.type === 'text' && item.text) {
                const textLength = item.text.length;
                logger.debug(`  提取文本内容，长度: ${textLength}`);
                textItems.push(item.text.trim());
              }
            }
            if (textItems.length > 0) {
              stepText = textItems.join('\n\n');
            }
          }
          
          // 如果 step.content 中没有内容，才检查 step.text
          if (!stepText && step.text && typeof step.text === 'string') {
            logger.debug(`  从 step.text 提取内容，长度: ${step.text.length}`);
            stepText = step.text.trim();
          }
          
          // 只添加非空文本，避免重复
          if (stepText) {
            allTexts.push(stepText);
          }
        }
        
        // 完整合并所有文本，用双换行分隔
        if (allTexts.length > 0) {
          decisionText = allTexts.join('\n\n');
          logger.debug(`合并后文本总长度: ${decisionText.length}`);
        }
        
        // 如果没有找到文本消息，尝试其他字段
        if (!decisionText) {
          decisionText = (response as any).text || (response as any).message || (response as any).content || "";
          logger.debug(`从备用字段提取，长度: ${decisionText.length}`);
        }
        
        // 如果还是没有文本回复，说明AI只是调用了工具，没有做出决策
        if (!decisionText && steps.length > 0) {
          decisionText = "AI调用了工具但未产生决策结果";
          logger.warn("AI 响应中未找到任何文本内容");
        }
      }
      
      logger.info("【输出 - AI 决策】");
      logger.info("=".repeat(80));
      logger.info(decisionText || "无决策输出");
      logger.info("=".repeat(80) + "\n");

      // 解析结构化决策 JSON
      let structuredDecision: StructuredDecision | null = null;
      let decisionSummary = "";
      try {
        structuredDecision = extractDecisionJSON(decisionText);
        if (structuredDecision) {
          // 注入当前周期技术指标数据（使用 BTC 作为主指标）
          const mainSymbol = "BTC";
          const md = marketData[mainSymbol] || {};
          (structuredDecision as any).indicators = {
            rsi: md.rsi14,
            macd: md.macd,
            dea: md.macdSignal,
            histogram: md.macdHistogram,
            adx: md.adx14,
            ema20: md.ema20,
            ema50: md.ema50,
            bollUpper: md.bollUpper,
            bollMid: md.bollMiddle,
            bollLower: md.bollLower,
            price: md.price,
            volume: md.volume,
            timestamp: getChinaTimeISO(),
          };
          
          decisionSummary = decisionToSummary(structuredDecision);
          logger.info("【结构化决策解析成功】");
          logger.info(decisionSummary);
          logger.info(`动作: ${structuredDecision.decision.action} | 置信度: ${(structuredDecision.decision.confidence * 100).toFixed(0)}%`);
          logger.info(`趋势: ${structuredDecision.market_analysis.trend} | 风险: ${structuredDecision.risk_assessment.risk_level}`);
        } else {
          logger.warn("未能从 AI 回复中提取结构化决策 JSON");
        }
      } catch (err) {
        logger.warn(`结构化决策解析异常: ${err}`);
      }

      // 保存决策记录（含结构化数据）
      await dbClient.execute({
        sql: `INSERT INTO agent_decisions 
              (timestamp, iteration, market_analysis, decision, actions_taken, account_value, positions_count, structured_decision)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          getChinaTimeISO(),
          iterationCount,
          JSON.stringify(marketData),
          decisionText,
          "[]",
          accountInfo.totalBalance,
          positions.length,
          structuredDecision ? JSON.stringify(structuredDecision) : null,
        ],
      });
      
      // Agent 执行后重新同步持仓数据（优化：只调用一次API）
      const updatedRawPositions = await exchangeClient.getPositions();
      await syncPositionsFromGate(updatedRawPositions);
      const updatedPositions = await getPositions(updatedRawPositions);
      
      // 重新获取更新后的账户信息，包含最新的未实现盈亏
      const updatedAccountInfo = await getAccountInfo();
      const finalUnrealizedPnL = updatedPositions.reduce((sum: number, pos: any) => sum + (pos.unrealized_pnl || 0), 0);
      
      logger.info("【最终 - 持仓状态】");
      logger.info("=".repeat(80));
      logger.info(`账户: ${updatedAccountInfo.totalBalance.toFixed(2)} USDT (可用: ${updatedAccountInfo.availableBalance.toFixed(2)}, 收益率: ${updatedAccountInfo.returnPercent.toFixed(2)}%)`);
      
      if (updatedPositions.length === 0) {
        logger.info("持仓: 无");
      } else {
        logger.info(`持仓: ${updatedPositions.length} 个`);
        updatedPositions.forEach((pos: any) => {
          // 计算盈亏百分比：考虑杠杆倍数
          // 对于杠杆交易：盈亏百分比 = (价格变动百分比) × 杠杆倍数
          const priceChangePercent = pos.entry_price > 0 
            ? ((pos.current_price - pos.entry_price) / pos.entry_price * 100 * (pos.side === 'long' ? 1 : -1))
            : 0;
          const pnlPercent = priceChangePercent * pos.leverage;
          logger.info(`  ${pos.symbol} ${pos.side === 'long' ? '做多' : '做空'} ${pos.quantity}张 (入场: ${pos.entry_price.toFixed(2)}, 当前: ${pos.current_price.toFixed(2)}, 盈亏: ${pos.unrealized_pnl >= 0 ? '+' : ''}${pos.unrealized_pnl.toFixed(2)} USDT / ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
        });
      }
      
      logger.info(`未实现盈亏: ${finalUnrealizedPnL >= 0 ? '+' : ''}${finalUnrealizedPnL.toFixed(2)} USDT`);
      logger.info("=".repeat(80) + "\n");
      
    } catch (agentError) {
      logger.error("Agent 执行失败:", agentError as any);
      try {
        await syncPositionsFromGate();
      } catch (syncError) {
        logger.error("同步失败:", syncError as any);
      }
    }
    
    // 每个周期结束时自动修复历史盈亏记录
    try {
      logger.info("检查并修复历史盈亏记录...");
      await fixHistoricalPnlRecords();
    } catch (fixError) {
      logger.error("修复历史盈亏失败:", fixError as any);
      // 不影响主流程，继续执行
    }
    
  } catch (error) {
    logger.error("交易循环执行失败:", error as any);
    try {
      await syncPositionsFromGate();
    } catch (recoveryError) {
      logger.error("恢复失败:", recoveryError as any);
    }
  }
}

/**
 * 初始化交易系统配置
 */
export async function initTradingSystem() {
  logger.info("初始化交易系统配置...");
  
  // 1. 加载配置
  accountRiskConfig = getAccountRiskConfig();
  logger.info(`环境变量配置: 止损线=${accountRiskConfig.stopLossUsdt} USDT, 止盈线=${accountRiskConfig.takeProfitUsdt} USDT`);
  
  // 2. 如果启用了启动时同步，则同步配置到数据库
  if (accountRiskConfig.syncOnStartup) {
    await syncConfigToDatabase();
  } else {
    // 否则从数据库加载配置
    await loadConfigFromDatabase();
  }
  
  logger.info(`最终配置: 止损线=${accountRiskConfig.stopLossUsdt} USDT, 止盈线=${accountRiskConfig.takeProfitUsdt} USDT`);
  
  // 3. 初始化 Gate News MCP 客户端（消息面数据）
  try {
    await initNewsClient();
  } catch (error) {
    logger.warn("Gate News MCP 初始化失败，消息面数据将不可用:", error as any);
  }
}

/**
 * 启动交易循环
 */
export function startTradingLoop() {
  const intervalMinutes = Number.parseInt(
    process.env.TRADING_INTERVAL_MINUTES || "5"
  );
  
  logger.info(`启动交易循环，间隔: ${intervalMinutes} 分钟`);
  logger.info(`支持币种: ${SYMBOLS.join(", ")}`);
  
  // 立即执行一次
  executeTradingDecision();
  
  // 设置定时任务
  const cronExpression = `*/${intervalMinutes} * * * *`;
  cron.schedule(cronExpression, () => {
    executeTradingDecision();
  });
  
  logger.info(`定时任务已设置: ${cronExpression}`);
}

/**
 * 重置交易开始时间（用于恢复之前的交易）
 */
export function setTradingStartTime(time: Date) {
  tradingStartTime = time;
}

/**
 * 重置迭代计数（用于恢复之前的交易）
 */
export function setIterationCount(count: number) {
  iterationCount = count;
}
