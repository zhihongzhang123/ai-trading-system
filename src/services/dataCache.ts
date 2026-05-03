/**
 * ai-trading-system - 数据缓存与熔断器
 * Copyright (C) 2025 zhihongzhang123
 * 
 * 功能：
 * - 新闻数据缓存：避免每个周期重复请求
 * - 市场数据 freshness 检查：防止使用过期数据
 * - API 熔断器：连续失败时暂停请求，保护账户
 */

/**
 * 缓存条目接口
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

/**
 * 通用缓存管理器
 */
class DataCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();

  /**
   * 获取缓存数据，如果过期或不存在则返回 null
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  /**
   * 设置缓存数据
   * @param ttlMinutes 缓存有效期（分钟）
   */
  set(key: string, data: T, ttlMinutes: number = 30): void {
    const now = Date.now();
    this.cache.set(key, {
      data,
      timestamp: now,
      expiresAt: now + ttlMinutes * 60 * 1000,
    });
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 清除过期缓存
   */
  cleanup(): void {
    const now = Date.now();
    const entries = Array.from(this.cache.entries());
    for (const [key, entry] of entries) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

/**
 * 熔断器状态
 */
type CircuitBreakerState = "closed" | "open" | "half-open";

/**
 * API 熔断器
 * 当连续失败次数超过阈值时，打开熔断器，暂停请求
 */
class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private readonly failureThreshold: number;
  private readonly recoveryTimeout: number; // ms
  private readonly halfOpenSuccessThreshold: number;
  private readonly name: string;

  constructor(
    name: string,
    options: {
      failureThreshold?: number;
      recoveryTimeout?: number;
      halfOpenSuccessThreshold?: number;
    } = {}
  ) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.recoveryTimeout = options.recoveryTimeout ?? 5 * 60 * 1000; // 5 分钟
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
  }

  /**
   * 执行受保护的调用
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkState();

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * 获取当前状态
   */
  getState(): { state: CircuitBreakerState; failureCount: number } {
    return { state: this.state, failureCount: this.failureCount };
  }

  /**
   * 手动重置熔断器
   */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
  }

  private checkState(): void {
    switch (this.state) {
      case "closed":
        // 正常状态，允许请求
        break;
      case "open":
        // 检查是否过了恢复超时
        if (Date.now() - this.lastFailureTime > this.recoveryTimeout) {
          this.state = "half-open";
          this.successCount = 0;
        } else {
          throw new Error(
            `熔断器 [${this.name}] 已打开，请求被拒绝。剩余冷却时间: ${Math.round(
              (this.recoveryTimeout - (Date.now() - this.lastFailureTime)) / 1000
            )}s`
          );
        }
        break;
      case "half-open":
        // 半开状态，允许试探性请求
        break;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.successCount++;
      if (this.successCount >= this.halfOpenSuccessThreshold) {
        this.state = "closed";
        this.failureCount = 0;
      }
    } else {
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
    }
  }
}

// 导出单例实例
export const newsCache = new DataCache<any>();
export const marketDataCache = new DataCache<any>();
export const okxCircuitBreaker = new CircuitBreaker("OKX-API", {
  failureThreshold: 3,
  recoveryTimeout: 5 * 60 * 1000, // 5 分钟
  halfOpenSuccessThreshold: 2,
});

// 默认缓存时间（分钟）
export const CACHE_TTL = {
  NEWS: 15, // 新闻缓存 15 分钟
  MARKET_DATA: 2, // 市场数据缓存 2 分钟（短周期）
  ACCOUNT_INFO: 1, // 账户信息缓存 1 分钟
};
