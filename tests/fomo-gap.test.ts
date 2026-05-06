/**
 * FOMO 缺口检测单元测试
 */
import { describe, it, expect } from 'vitest';

interface GapResult {
  type: string;
  from: number;
  to: number;
  size: number;
}

function detectFomoGaps(candles: { high: number; low: number }[]): GapResult[] {
  const gaps: GapResult[] = [];
  if (!candles || candles.length < 2) return gaps;

  for (let i = 1; i < candles.length; i++) {
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const currLow = candles[i].low;
    const currHigh = candles[i].high;

    if (!Number.isFinite(prevHigh) || !Number.isFinite(currLow) || !Number.isFinite(prevLow) || !Number.isFinite(currHigh)) continue;

    // 跳空上涨: FOMO缺口
    if (currLow > prevHigh) {
      const gapSize = ((currLow - prevHigh) / prevHigh * 100);
      gaps.push({ type: "fomo_up", from: prevHigh, to: currLow, size: gapSize });
    }
    // 跳空下跌: 恐慌缺口
    else if (currHigh < prevLow) {
      const gapSize = ((prevLow - currHigh) / prevLow * 100);
      gaps.push({ type: "panic_down", from: prevLow, to: currHigh, size: gapSize });
    }
  }

  return gaps;
}

describe('FOMO 缺口检测', () => {
  it('应检测到跳空上涨缺口', () => {
    const candles = [
      { high: 100, low: 98 },
      { high: 103, low: 101 }, // 跳空: 101 > 100
    ];
    const gaps = detectFomoGaps(candles);
    expect(gaps.length).toBe(1);
    expect(gaps[0].type).toBe('fomo_up');
    expect(gaps[0].from).toBe(100);
    expect(gaps[0].to).toBe(101);
    expect(gaps[0].size).toBeCloseTo(1, 2);
  });

  it('应检测到跳空下跌缺口', () => {
    const candles = [
      { high: 100, low: 98 },
      { high: 97, low: 95 }, // 跳空: 97 < 98
    ];
    const gaps = detectFomoGaps(candles);
    expect(gaps.length).toBe(1);
    expect(gaps[0].type).toBe('panic_down');
    expect(gaps[0].from).toBe(98);
    expect(gaps[0].to).toBe(97);
  });

  it('无缺口时返回空数组', () => {
    const candles = [
      { high: 100, low: 98 },
      { high: 101, low: 99 }, // 无跳空
    ];
    const gaps = detectFomoGaps(candles);
    expect(gaps.length).toBe(0);
  });

  it('应检测到多个缺口', () => {
    const candles = [
      { high: 100, low: 98 },
      { high: 103, low: 101 }, // FOMO ↑
      { high: 102, low: 100 },
      { high: 98, low: 96 },   // Panic ↓
    ];
    const gaps = detectFomoGaps(candles);
    expect(gaps.length).toBe(2);
    expect(gaps[0].type).toBe('fomo_up');
    expect(gaps[1].type).toBe('panic_down');
  });

  it('空数据或单根K线返回空数组', () => {
    expect(detectFomoGaps([]).length).toBe(0);
    expect(detectFomoGaps([{ high: 100, low: 98 }]).length).toBe(0);
  });

  it('无效数值应跳过', () => {
    const candles = [
      { high: 100, low: 98 },
      { high: NaN, low: 101 },
      { high: 103, low: 101 },
    ];
    const gaps = detectFomoGaps(candles);
    // NaN 应被跳过，只有最后一根可能与第一根比较（但中间跳过了NaN）
    // 实际逻辑：i=1时 NaN 被跳过，i=2时 prevHigh=NaN 也被跳过
    expect(gaps.length).toBe(0);
  });

  it('缺口大小计算应准确', () => {
    const candles = [
      { high: 100000, low: 99500 },
      { high: 101500, low: 101000 }, // 跳空 1000
    ];
    const gaps = detectFomoGaps(candles);
    expect(gaps[0].size).toBeCloseTo(1, 2); // (101000-100000)/100000*100 = 1%
  });
});
