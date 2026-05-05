/**
 * 价格桶分配器 — K线等分法
 * 将每根K线的成交量均匀分配到 High-Low 之间的价格桶
 */

import type { CandleData, PriceBucket, VolumeProfileOptions } from "./types";

export class BucketAggregator {
  /**
   * 将K线序列分配到价格桶
   * @param candles K线数据
   * @param bucketSize 价格桶大小（如 ATR*0.3）
   */
  aggregate(candles: CandleData[], bucketSize: number): PriceBucket[] {
    if (candles.length === 0 || bucketSize <= 0) return [];

    // 找出全局价格范围
    let globalMin = Infinity;
    let globalMax = -Infinity;
    for (const c of candles) {
      const low = Number(c.l);
      const high = Number(c.h);
      if (low < globalMin) globalMin = low;
      if (high > globalMax) globalMax = high;
    }

    // 计算桶数量（确保至少1个桶）
    const numBuckets = Math.max(1, Math.ceil((globalMax - globalMin) / bucketSize));

    // 初始化桶
    const bucketMap = new Map<number, number>(); // price -> volume
    for (let i = 0; i < numBuckets; i++) {
      const price = globalMin + (i + 0.5) * bucketSize; // 桶中点
      bucketMap.set(price, 0);
    }

    // 将每根K线的成交量分配到对应桶
    for (const candle of candles) {
      const low = Number(candle.l);
      const high = Number(candle.h);
      const volume = Number(candle.v);

      // 找到这根K线覆盖的桶范围
      const firstIdx = Math.floor((low - globalMin) / bucketSize);
      const lastIdx = Math.floor((high - globalMin) / bucketSize);
      const coveredBuckets = Math.max(1, lastIdx - firstIdx + 1);

      // 等分法：均匀分配
      const volPerBucket = volume / coveredBuckets;

      for (let idx = firstIdx; idx <= lastIdx && idx < numBuckets; idx++) {
        if (idx < 0) continue;
        const price = globalMin + (idx + 0.5) * bucketSize;
        const current = bucketMap.get(price) || 0;
        bucketMap.set(price, current + volPerBucket);
      }
    }

    // 转换为数组并按价格升序
    const buckets: PriceBucket[] = [];
    bucketMap.forEach((volume, price) => {
      if (volume > 0) {
        buckets.push({ price, volume });
      }
    });
    buckets.sort((a, b) => a.price - b.price);

    return buckets;
  }

  /**
   * 自动计算价格桶大小（ATR * multiplier）
   */
  static autoBucketSize(atr: number, multiplier: number = 0.3): number {
    return Math.max(1, atr * multiplier);
  }
}
