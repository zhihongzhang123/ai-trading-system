/**
 * 筹码峰缓存 — 5分钟 TTL
 */

import type { CandleData, VolumeProfileResult } from "./types";

interface CacheEntry {
  profile: VolumeProfileResult;
  timestamp: number;
}

export class VolumeProfileCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(ttlSeconds: number = 300) {
    this.ttlMs = ttlSeconds * 1000;
  }

  private makeKey(symbol: string, timeframe: string, candleCount: number): string {
    return `${symbol}:${timeframe}:${candleCount}`;
  }

  get(
    symbol: string,
    timeframe: string,
    candleCount: number
  ): VolumeProfileResult | null {
    const key = this.makeKey(symbol, timeframe, candleCount);
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.ttlMs) {
      return entry.profile;
    }
    if (entry) {
      this.cache.delete(key);
    }
    return null;
  }

  set(
    symbol: string,
    timeframe: string,
    candleCount: number,
    profile: VolumeProfileResult
  ): void {
    const key = this.makeKey(symbol, timeframe, candleCount);
    this.cache.set(key, { profile, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}
