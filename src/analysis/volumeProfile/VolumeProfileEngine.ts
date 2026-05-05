/**
 * 筹码峰核心引擎 — 编排聚合、计算、缓存
 */

import type { CandleData, VolumeProfileResult, MultiTimeframeProfile, VolumeProfileOptions } from "./types";
import { BucketAggregator } from "./BucketAggregator";
import { IndicatorCalculator } from "./IndicatorCalculator";
import { VolumeProfileCache } from "./VolumeProfileCache";
import { createLogger } from "../../utils/loggerUtils";

const logger = createLogger({ name: "volume-profile", level: "info" });

export class VolumeProfileEngine {
  private aggregator = new BucketAggregator();
  private calculator: IndicatorCalculator;
  private cache: VolumeProfileCache;

  constructor(options?: VolumeProfileOptions) {
    this.calculator = new IndicatorCalculator(options);
    this.cache = new VolumeProfileCache(300); // 5分钟TTL
  }

  /**
   * 计算单个时间周期的筹码分布
   */
  calculateProfile(
    candles: CandleData[],
    currentPrice: number,
    timeframe: string,
    bucketSize?: number
  ): VolumeProfileResult {
    if (candles.length === 0) {
      throw new Error("Empty candles");
    }

    // 计算ATR(14)用于自动桶大小
    const atr = this.calculateATR(candles, 14);
    const effectiveBucketSize = bucketSize || BucketAggregator.autoBucketSize(atr, 0.3);

    // 聚合到价格桶
    const buckets = this.aggregator.aggregate(candles, effectiveBucketSize);
    if (buckets.length === 0) {
      throw new Error("Failed to aggregate buckets");
    }

    return this.calculator.calculate(buckets, currentPrice, timeframe, candles.length);
  }

  /**
   * 带缓存的计算
   */
  getProfileCached(
    symbol: string,
    candles: CandleData[],
    currentPrice: number,
    timeframe: string,
    bucketSize?: number
  ): VolumeProfileResult {
    const cached = this.cache.get(symbol, timeframe, candles.length);
    if (cached) return cached;

    const profile = this.calculateProfile(candles, currentPrice, timeframe, bucketSize);
    this.cache.set(symbol, timeframe, candles.length, profile);
    return profile;
  }

  /**
   * 多周期筹码共振分析
   */
  calculateMultiTimeframe(
    candlesByTimeframe: Record<string, CandleData[]>,
    currentPrice: number
  ): MultiTimeframeProfile {
    const result: MultiTimeframeProfile = {
      "15m": null,
      "1H": null,
      "4H": null,
      resonance: { supportResonance: [], resistanceResonance: [] },
    };

    for (const [tf, candles] of Object.entries(candlesByTimeframe)) {
      try {
        const key = tf as "15m" | "1H" | "4H";
        result[key] = this.calculateProfile(
          candles,
          currentPrice,
          tf
        );
      } catch (e) {
        logger.warn(`筹码峰计算失败 (${tf}):`, e);
      }
    }

    // 检测共振
    result.resonance = this.detectResonance(result as MultiTimeframeProfile);

    return result;
  }

  /**
   * 格式化筹码峰为AI提示词可读文本
   */
  static formatForPrompt(profile: VolumeProfileResult): string {
    const concentrationLabel =
      profile.concentration < 3
        ? "极度密集（即将变盘）"
        : profile.concentration < 8
          ? "高度密集（强支撑/阻力区）"
          : profile.concentration < 15
            ? "中等密集"
            : "分散（无明显支撑/阻力）";

    const deviationLabel =
      profile.deviation > 5
        ? "价格远高于筹码区，有回调压力"
        : profile.deviation < -5
          ? "价格远低于筹码区，有反弹需求"
          : "价格在筹码区域内，属正常波动";

    const topHVN = profile.hvn.slice(0, 3).map((h) => `${h.price.toFixed(1)}(${h.strength})`).join(", ");
    const topSupport = profile.supportLevels.slice(0, 3).map((s) => `${s.price.toFixed(1)}(${s.strength})`).join(", ");
    const topResistance = profile.resistanceLevels.slice(0, 3).map((r) => `${r.price.toFixed(1)}(${r.strength})`).join(", ");

    return [
      `【筹码分布分析 ${profile.timeframe}】`,
      `  POC控制点: ${profile.poc.toFixed(1)} (最大成交量价格)`,
      `  价值区域(VA): ${profile.val.toFixed(1)} ~ ${profile.vah.toFixed(1)}`,
      `  筹码集中度: ${profile.concentration.toFixed(1)}% — ${concentrationLabel}`,
      `  价格偏离度: ${profile.deviation.toFixed(1)}% — ${deviationLabel}`,
      `  密集区(HVN): ${topHVN || "无"}`,
      `  支撑位: ${topSupport || "无"}`,
      `  阻力位: ${topResistance || "无"}`,
      `  总成交量: ${IndicatorCalculator.formatVolume(profile.totalVolume)}`,
      `  K线根数: ${profile.candleCount}`,
    ].join("\n");
  }

  /**
   * 多周期共振文本
   */
  static formatResonanceForPrompt(mt: MultiTimeframeProfile): string {
    const lines = ["【多周期筹码共振】"];

    for (const tf of ["15m", "1H", "4H"] as const) {
      const p = mt[tf];
      if (p) {
        lines.push(`  ${tf} POC=${p.poc.toFixed(1)}, VA=${p.val.toFixed(1)}-${p.vah.toFixed(1)}, 集中度=${p.concentration.toFixed(1)}%`);
      } else {
        lines.push(`  ${tf}: 无数据`);
      }
    }

    if (mt.resonance.supportResonance.length > 0) {
      lines.push(`  ✅ 支撑共振: ${mt.resonance.supportResonance.map((s) => `${s.price.toFixed(1)}(${s.timeframeCount}周期)`).join(", ")}`);
    }
    if (mt.resonance.resistanceResonance.length > 0) {
      lines.push(`  ⚠️ 阻力共振: ${mt.resonance.resistanceResonance.map((r) => `${r.price.toFixed(1)}(${r.timeframeCount}周期)`).join(", ")}`);
    }

    return lines.join("\n");
  }

  // ---- 内部方法 ----

  /**
   * 计算 ATR（用于自动桶大小）
   */
  private calculateATR(candles: CandleData[], period: number): number {
    if (candles.length < period + 1) {
      // fallback: 用价格范围的简单平均
      const avgRange =
        candles.reduce((s, c) => s + (Number(c.h) - Number(c.l)), 0) / candles.length;
      return avgRange;
    }

    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = Number(candles[i].h);
      const low = Number(candles[i].l);
      const prevClose = Number(candles[i - 1].c);
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }

    const atr = trs.slice(-period).reduce((s, v) => s + v, 0) / period;
    return atr > 0 ? atr : candles.reduce((s, c) => s + (Number(c.h) - Number(c.l)), 0) / candles.length;
  }

  /**
   * 检测多周期支撑/阻力共振
   */
  private detectResonance(mt: MultiTimeframeProfile): MultiTimeframeProfile["resonance"] {
    const profiles = Object.values(mt).filter(
      (v): v is VolumeProfileResult => v !== null
    );

    if (profiles.length < 2) {
      return { supportResonance: [], resistanceResonance: [] };
    }

    const tolerance = 0.01; // 1%容差

    // 收集所有支撑位和阻力位
    interface Level {
      price: number;
      timeframeCount: number;
    }

    const supportMap = new Map<string, Level>();
    const resistanceMap = new Map<string, Level>();

    for (const p of profiles) {
      for (const s of p.supportLevels) {
        const key = this.roundPrice(s.price, tolerance);
        const existing = supportMap.get(key);
        if (existing) {
          existing.timeframeCount++;
        } else {
          supportMap.set(key, { price: s.price, timeframeCount: 1 });
        }
      }
      for (const r of p.resistanceLevels) {
        const key = this.roundPrice(r.price, tolerance);
        const existing = resistanceMap.get(key);
        if (existing) {
          existing.timeframeCount++;
        } else {
          resistanceMap.set(key, { price: r.price, timeframeCount: 1 });
        }
      }
    }

    const supportResonance = Array.from(supportMap.values())
      .filter((s) => s.timeframeCount >= 2)
      .sort((a, b) => b.timeframeCount - a.timeframeCount);

    const resistanceResonance = Array.from(resistanceMap.values())
      .filter((r) => r.timeframeCount >= 2)
      .sort((a, b) => b.timeframeCount - a.timeframeCount);

    return { supportResonance, resistanceResonance };
  }

  private roundPrice(price: number, tolerance: number): string {
    const step = Math.max(1, price * tolerance);
    return Math.round(price / step).toString();
  }
}
