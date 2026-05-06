/**
 * 质量评分计算单元测试
 */
import { describe, it, expect } from 'vitest';

// 从 tradingLoop.ts 中提取的评分逻辑（纯函数，可独立测试）
interface IndicatorSnapshot {
  price: number; ema20: number; ema60: number; ema120: number; ma200: number;
  macd: number; rsi14: number; volume: number; avgVolume: number;
  slope20: number;
}

interface QualityScoreResult {
  total: number;
  resonance: number;
  alignment: number;
  trend: number;
  volume: number;
  position: number;
}

function ensureRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function calculateQualityScore(
  current: IndicatorSnapshot,
  timeframes: Record<string, IndicatorSnapshot>
): QualityScoreResult {
  const result: QualityScoreResult = {
    total: 0, resonance: 0, alignment: 0, trend: 0, volume: 0, position: 0,
  };

  // === 1. EMA共振排列 (0-20 分) ===
  const bullish = current.ema20 > current.ema60 && current.ema60 > current.ema120 && current.price > current.ema20;
  const bearish = current.ema20 < current.ema60 && current.ema60 < current.ema120 && current.price < current.ema20;
  if (bullish) result.resonance += 16;
  else if (bearish) result.resonance += 16;
  else if ((current.ema20 > current.ema60 && current.price > current.ema20) ||
           (current.ema20 < current.ema60 && current.price < current.ema20)) {
    result.resonance += 8;
  }
  if (Math.abs(current.ema20 - current.ema60) / current.ema60 < 0.002) result.resonance -= 4;
  result.resonance = ensureRange(result.resonance, 0, 20);

  // === 2. 三周期对齐 (0-35 分) ===
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
    let score = 0;
    if (dir1d !== 0) score += 12; else score += 4;
    if (dir1h !== 0 && dir1h === dir1d) score += 14;
    else if (dir1h !== 0 && dir1d !== 0 && dir1h !== dir1d) score += 5;
    else if (dir1h !== 0) score += 8;
    if (dir5m !== 0) {
      if (dir1h > 0 && dir5m === 1) score += 6;
      else if (dir1d > 0 && dir5m === 1) score += 4;
      else if (dir1h < 0 && dir5m === -1) score += 0;
      else if (dir5m === 1 && dir1h <= 0) score += 3;
      else score += 2;
    } else { score += 3; }
    result.alignment = ensureRange(score, 0, 35);
    if (tf1h.slope20 * tf1d.slope20 > 0) result.alignment = Math.min(35, result.alignment + 3);
    if (tf5m && tf5m.slope20 * tf1h.slope20 > 0) result.alignment = Math.min(35, result.alignment + 2);
  } else {
    result.alignment = 15;
  }

  // === 3. 趋势强度 (0-20 分) ===
  if (current.slope20 > 0.05) result.trend += 4;
  else if (current.slope20 < -0.05) result.trend += 4;
  if (Math.abs(current.slope20) > 0.15) result.trend += 4;
  else if (Math.abs(current.slope20) > 0.08) result.trend += 2;
  if (current.macd > 0) result.trend += 6;
  if (current.price > 0) {
    const macdRatio = Math.abs(current.macd) / current.price * 100;
    if (macdRatio > 0.5) result.trend += 6;
    else if (macdRatio > 0.2) result.trend += 3;
  }
  result.trend = ensureRange(result.trend, 0, 20);

  // === 4. 量价确认 (0-15 分) ===
  const volumeRatio = current.avgVolume > 0 ? current.volume / current.avgVolume : 1;
  if (volumeRatio > 1.5) result.volume += 15;
  else if (volumeRatio > 1.0) result.volume += 10;
  else if (volumeRatio > 0.5) result.volume += 5;
  if (volumeRatio < 0.3) result.volume = Math.max(0, result.volume - 5);
  result.volume = ensureRange(result.volume, 0, 15);

  // === 5. 入场位置 (0-10 分) ===
  if (current.rsi14 >= 45 && current.rsi14 <= 65) result.position += 10;
  else if ((current.rsi14 >= 35 && current.rsi14 < 45) || (current.rsi14 > 65 && current.rsi14 <= 75)) {
    result.position += 5;
  }
  result.position = ensureRange(result.position, 0, 10);

  result.total = result.resonance + result.alignment + result.trend + result.volume + result.position;
  return result;
}

describe('质量评分计算', () => {
  const makeSnapshot = (overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot => ({
    price: 100000, ema20: 99000, ema60: 98000, ema120: 97000, ma200: 95000,
    macd: 500, rsi14: 55, volume: 1000, avgVolume: 800, slope20: 0.1,
    ...overrides,
  });

  const makeTimeframes = (dir: 'bullish' | 'bearish' | 'mixed' = 'bullish') => {
    if (dir === 'bullish') {
      return {
        '5m': makeSnapshot({ price: 100100, ema20: 100050, ema60: 100000, slope20: 0.1 }),
        '1h': makeSnapshot({ price: 100000, ema20: 99000, ema60: 98000, slope20: 0.1 }),
        '1d': makeSnapshot({ price: 99500, ema20: 98000, ema60: 96000, slope20: 0.08 }),
      };
    }
    if (dir === 'bearish') {
      return {
        '5m': makeSnapshot({ price: 99000, ema20: 99500, ema60: 100000, slope20: -0.1 }),
        '1h': makeSnapshot({ price: 99000, ema20: 100000, ema60: 101000, slope20: -0.1 }),
        '1d': makeSnapshot({ price: 98000, ema20: 99000, ema60: 100000, slope20: -0.08 }),
      };
    }
    return {
      '5m': makeSnapshot({ price: 100100, ema20: 100050, ema60: 100000, slope20: 0.1 }),
      '1h': makeSnapshot({ price: 100000, ema20: 99000, ema60: 98000, slope20: 0.1 }),
      '1d': makeSnapshot({ price: 99000, ema20: 100000, ema60: 101000, slope20: -0.08 }),
    };
  };

  it('完美多头排列应得高分 (>=75)', () => {
    const current = makeSnapshot({
      price: 100000, ema20: 99000, ema60: 98000, ema120: 97000,
      macd: 800, rsi14: 55, volume: 1500, avgVolume: 800, slope20: 0.2,
    });
    const result = calculateQualityScore(current, makeTimeframes('bullish'));
    expect(result.total).toBeGreaterThanOrEqual(75);
    expect(result.resonance).toBeGreaterThan(0);
    expect(result.alignment).toBeGreaterThan(0);
  });

  it('完美空头排列总分应低于多头', () => {
    const current = makeSnapshot({
      price: 95000, ema20: 96000, ema60: 97000, ema120: 98000,
      macd: -500, rsi14: 40, volume: 800, avgVolume: 800, slope20: -0.15,
    });
    const bearishResult = calculateQualityScore(current, makeTimeframes('bearish'));
    const bullishCurrent = makeSnapshot({
      price: 100000, ema20: 99000, ema60: 98000, ema120: 97000,
      macd: 800, rsi14: 55, volume: 1500, avgVolume: 800, slope20: 0.2,
    });
    const bullishResult = calculateQualityScore(bullishCurrent, makeTimeframes('bullish'));
    expect(bearishResult.total).toBeLessThan(bullishResult.total);
  });

  it('EMA粘合应降低共振分', () => {
    const normal = makeSnapshot({ ema20: 99000, ema60: 98000 });
    const sticky = makeSnapshot({ ema20: 99000, ema60: 98900 }); // 非常接近
    const tf = makeTimeframes('bullish');
    
    const normalResult = calculateQualityScore(normal, tf);
    const stickyResult = calculateQualityScore(sticky, tf);
    
    expect(stickyResult.resonance).toBeLessThan(normalResult.resonance);
  });

  it('放量应获得更高量价分', () => {
    const lowVol = makeSnapshot({ volume: 400, avgVolume: 1000 }); // 量比 0.4
    const highVol = makeSnapshot({ volume: 2000, avgVolume: 1000 }); // 量比 2.0
    const tf = makeTimeframes('bullish');
    
    const lowResult = calculateQualityScore(lowVol, tf);
    const highResult = calculateQualityScore(highVol, tf);
    
    expect(highResult.volume).toBeGreaterThan(lowResult.volume);
  });

  it('RSI健康区(45-65)应获得最高位置分', () => {
    const healthy = makeSnapshot({ rsi14: 55 });
    const overbought = makeSnapshot({ rsi14: 80 });
    const oversold = makeSnapshot({ rsi14: 25 });
    const tf = makeTimeframes('bullish');
    
    const healthyResult = calculateQualityScore(healthy, tf);
    const overboughtResult = calculateQualityScore(overbought, tf);
    const oversoldResult = calculateQualityScore(oversold, tf);
    
    expect(healthyResult.position).toBe(10);
    expect(overboughtResult.position).toBeLessThan(healthyResult.position);
    expect(oversoldResult.position).toBeLessThan(healthyResult.position);
  });

  it('总分应为各维度之和', () => {
    const current = makeSnapshot();
    const result = calculateQualityScore(current, makeTimeframes('bullish'));
    expect(result.total).toBe(result.resonance + result.alignment + result.trend + result.volume + result.position);
  });

  it('各维度分数应在合理范围内', () => {
    const current = makeSnapshot();
    const result = calculateQualityScore(current, makeTimeframes('bullish'));
    expect(result.resonance).toBeGreaterThanOrEqual(0);
    expect(result.resonance).toBeLessThanOrEqual(20);
    expect(result.alignment).toBeGreaterThanOrEqual(0);
    expect(result.alignment).toBeLessThanOrEqual(35);
    expect(result.trend).toBeGreaterThanOrEqual(0);
    expect(result.trend).toBeLessThanOrEqual(20);
    expect(result.volume).toBeGreaterThanOrEqual(0);
    expect(result.volume).toBeLessThanOrEqual(15);
    expect(result.position).toBeGreaterThanOrEqual(0);
    expect(result.position).toBeLessThanOrEqual(10);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });
});
