/**
 * 指标计算器 — POC / VA / 集中度 / 偏离度 / 支撑阻力
 */

import type {
  PriceBucket,
  VolumeProfileResult,
  ChipSupportResistance,
  VolumeProfileOptions,
} from "./types";

const DEFAULT_OPTIONS: Required<VolumeProfileOptions> = {
  bucketSize: 100,
  vaPercent: 0.7,
  hvnThreshold: 0.25,
  lvnThreshold: 0.1,
  minScore: 15,
};

export class IndicatorCalculator {
  private options: Required<VolumeProfileOptions>;

  constructor(options?: VolumeProfileOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 计算 Point of Control（成交量最大的价格）
   */
  static calculatePOC(buckets: PriceBucket[]): number {
    if (buckets.length === 0) return 0;
    let maxVol = 0;
    let poc = buckets[0].price;
    for (const b of buckets) {
      if (b.volume > maxVol) {
        maxVol = b.volume;
        poc = b.price;
      }
    }
    return poc;
  }

  /**
   * 计算 Value Area（价值区域）
   * 从POC向两侧扩展，直到累计成交量达到总成交量的70%
   */
  static calculateValueArea(
    buckets: PriceBucket[],
    poc: number,
    vaPercent: number = 0.7
  ): { vah: number; val: number } {
    if (buckets.length === 0) return { vah: 0, val: 0 };

    const totalVolume = buckets.reduce((s, b) => s + b.volume, 0);
    const targetVolume = totalVolume * vaPercent;

    // 找到POC在buckets中的索引
    const pocIdx = buckets.findIndex((b) => b.price >= poc);
    if (pocIdx < 0) return { vah: 0, val: 0 };

    let accumulated = buckets[pocIdx].volume;
    let leftIdx = pocIdx - 1;
    let rightIdx = pocIdx + 1;

    while (accumulated < targetVolume) {
      const leftVol = leftIdx >= 0 ? buckets[leftIdx].volume : 0;
      const rightVol = rightIdx < buckets.length ? buckets[rightIdx].volume : 0;

      if (leftVol >= rightVol && leftIdx >= 0) {
        accumulated += leftVol;
        leftIdx--;
      } else if (rightIdx < buckets.length) {
        accumulated += rightVol;
        rightIdx++;
      } else {
        break;
      }
    }

    return {
      val: buckets[Math.max(0, leftIdx + 1)].price,
      vah: buckets[Math.min(buckets.length - 1, rightIdx - 1)].price,
    };
  }

  /**
   * 计算完整筹码分布结果
   */
  calculate(
    buckets: PriceBucket[],
    currentPrice: number,
    timeframe: string,
    candleCount: number
  ): VolumeProfileResult {
    const poc = IndicatorCalculator.calculatePOC(buckets);
    const { vah, val } = IndicatorCalculator.calculateValueArea(
      buckets,
      poc,
      this.options.vaPercent
    );

    const totalVolume = buckets.reduce((s, b) => s + b.volume, 0);
    const pocVolume = buckets.find((b) => b.price >= poc)?.volume || 0;

    // 集中度 = (VAH - VAL) / POC * 100%
    const concentration = poc > 0 ? ((vah - val) / poc) * 100 : 0;

    // 偏离度 = (当前价格 - POC) / POC * 100%
    const deviation = poc > 0 ? ((currentPrice - poc) / poc) * 100 : 0;

    // 密集区 HVN
    const hvn = this.findHVN(buckets, pocVolume);

    // 稀疏区 LVN
    const lvn = this.findLVN(buckets, pocVolume);

    // 支撑/阻力
    const { supportLevels, resistanceLevels } = this.findSupportResistance(
      buckets,
      pocVolume,
      currentPrice
    );

    return {
      buckets,
      poc,
      vah,
      val,
      concentration,
      deviation,
      hvn,
      lvn,
      supportLevels,
      resistanceLevels,
      totalVolume,
      timeframe,
      candleCount,
    };
  }

  /**
   * 生成支撑阻力摘要
   */
  generateSupportResistance(profile: VolumeProfileResult): ChipSupportResistance {
    const currentPrice =
      profile.supportLevels.length > 0 || profile.resistanceLevels.length > 0
        ? profile.supportLevels.length > 0
          ? profile.supportLevels[profile.supportLevels.length - 1].price + 1 // 近似
          : profile.resistanceLevels[0].price - 1
        : profile.poc;

    const supports = profile.supportLevels
      .map((s) => ({
        ...s,
        distance: currentPrice > 0 ? ((currentPrice - s.price) / currentPrice) * 100 : 0,
      }))
      .filter((s) => s.distance > 0)
      .sort((a, b) => a.distance - b.distance);

    const resistances = profile.resistanceLevels
      .map((r) => ({
        ...r,
        distance: currentPrice > 0 ? ((r.price - currentPrice) / currentPrice) * 100 : 0,
      }))
      .filter((r) => r.distance > 0)
      .sort((a, b) => a.distance - b.distance);

    const vahWidth = profile.vah - profile.val;

    return {
      currentPrice,
      nearestSupport: supports.length > 0 ? supports[0] : null,
      nearestResistance: resistances.length > 0 ? resistances[0] : null,
      supports,
      resistances,
      poc: profile.poc,
      valueArea: {
        high: profile.vah,
        low: profile.val,
        width: vahWidth,
      },
      concentration: profile.concentration,
    };
  }

  /** 格式化成交量可读 */
  static formatVolume(vol: number): string {
    if (vol >= 1e9) return `${(vol / 1e9).toFixed(2)}B`;
    if (vol >= 1e6) return `${(vol / 1e6).toFixed(2)}M`;
    if (vol >= 1e3) return `${(vol / 1e3).toFixed(2)}K`;
    return vol.toFixed(0);
  }

  // ---- 内部方法 ----

  private findHVN(
    buckets: PriceBucket[],
    pocVolume: number
  ): { price: number; volume: number; strength: string }[] {
    const threshold = pocVolume * this.options.hvnThreshold;
    const result: { price: number; volume: number; strength: string }[] = [];

    for (const b of buckets) {
      if (b.volume >= threshold) {
        const ratio = b.volume / pocVolume;
        let strength = "C";
        if (ratio >= 0.8) strength = "S";
        else if (ratio >= 0.5) strength = "A";
        else if (ratio >= 0.25) strength = "B";

        result.push({ price: b.price, volume: b.volume, strength });
      }
    }

    return result;
  }

  private findLVN(
    buckets: PriceBucket[],
    pocVolume: number
  ): { price: number; volume: number }[] {
    const threshold = pocVolume * this.options.lvnThreshold;
    return buckets.filter((b) => b.volume < threshold && b.volume > 0);
  }

  private findSupportResistance(
    buckets: PriceBucket[],
    pocVolume: number,
    _currentPrice: number
  ): {
    supportLevels: { price: number; strength: string; score: number }[];
    resistanceLevels: { price: number; strength: string; score: number }[];
  } {
    // 局部峰值检测：找出成交量明显高于相邻桶的峰值
    const peaks: { price: number; volume: number; score: number; strength: string }[] = [];

    for (let i = 1; i < buckets.length - 1; i++) {
      const prev = buckets[i - 1].volume;
      const curr = buckets[i].volume;
      const next = buckets[i + 1].volume;

      if (curr > prev && curr > next) {
        const score = Math.round((curr / pocVolume) * 100);
        if (score < this.options.minScore) continue;

        let strength = "C";
        if (score >= 80) strength = "S";
        else if (score >= 50) strength = "A";
        else if (score >= 25) strength = "B";

        peaks.push({ price: buckets[i].price, volume: curr, score, strength });
      }
    }

    // 排序后返回（支撑位从低到高，阻力位从高到低）
    const sorted = peaks.sort((a, b) => a.price - b.price);

    return {
      supportLevels: sorted.map((p) => ({
        price: p.price,
        strength: p.strength,
        score: p.score,
      })),
      resistanceLevels: [...sorted].reverse().map((p) => ({
        price: p.price,
        strength: p.strength,
        score: p.score,
      })),
    };
  }
}
