/**
 * 筹码峰（Volume Profile）Voltagent Tools
 * 供 AI 交易代理调用的筹码分布分析工具
 */

import { createTool } from "@voltagent/core";
import { z } from "zod";
import { createExchangeClient } from "../../services/exchangeClient";
import { RISK_PARAMS } from "../../config/riskParams";
import { VolumeProfileEngine } from "../../analysis/volumeProfile/VolumeProfileEngine";
import type { CandleData } from "../../analysis/volumeProfile/types";

/**
 * 将 K线数据转换为 CandleData 格式
 */
function toCandleData(candle: any): CandleData {
  return {
    t: Number(candle.t),
    o: candle.o,
    h: candle.h,
    l: candle.l,
    c: candle.c,
    v: candle.v,
    sum: candle.sum,
  };
}

/**
 * 获取筹码分布（Volume Profile）
 */
export const getVolumeProfileTool = createTool({
  name: "getVolumeProfile",
  description:
    "获取指定币种的筹码分布分析（Volume Profile），包括POC控制点、价值区域(VA)、筹码集中度、支撑/阻力位。用于识别价格的关键支撑和阻力区域。",
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe("币种代码"),
    interval: z
      .enum(["5m", "15m", "30m", "1h", "4h", "1d"])
      .default("1h")
      .describe("K线周期（默认1H）"),
    limit: z
      .number()
      .default(200)
      .describe("K线数量（决定计算周期范围，200根1H=约8天）"),
  }),
  execute: async ({ symbol, interval, limit }) => {
    const client = createExchangeClient();
    const contract = `${symbol}_USDT`;

    // 获取K线数据
    const candles = await client.getFuturesCandles(contract, interval, limit);
    const ticker = await client.getFuturesTicker(contract);
    const currentPrice = Number(ticker.last || "0");

    const engine = new VolumeProfileEngine();
    const profile = engine.calculateProfile(
      candles.map(toCandleData),
      currentPrice,
      interval.toUpperCase()
    );

    return {
      symbol,
      currentPrice,
      interval: profile.timeframe,
      candleCount: profile.candleCount,
      poc: profile.poc,
      vah: profile.vah,
      val: profile.val,
      concentration: profile.concentration,
      concentrationLabel:
        profile.concentration < 3
          ? "极度密集（即将变盘）"
          : profile.concentration < 8
            ? "高度密集"
            : profile.concentration < 15
              ? "中等密集"
              : "分散",
      deviation: profile.deviation,
      deviationLabel:
        profile.deviation > 5
          ? "价格远高于筹码区，有回调压力"
          : profile.deviation < -5
            ? "价格远低于筹码区，有反弹需求"
            : "价格在筹码区域内",
      hvn: profile.hvn.slice(0, 5).map((h) => ({
        price: h.price,
        strength: h.strength,
      })),
      lvn: profile.lvn.slice(0, 5).map((l) => ({ price: l.price })),
      supports: profile.supportLevels.slice(0, 5).map((s) => ({
        price: s.price,
        strength: s.strength,
        score: s.score,
      })),
      resistances: profile.resistanceLevels.slice(0, 5).map((r) => ({
        price: r.price,
        strength: r.strength,
        score: r.score,
      })),
      formatted: VolumeProfileEngine.formatForPrompt(profile),
      timestamp: new Date().toISOString(),
    };
  },
});

/**
 * 获取筹码支撑阻力位
 */
export const getChipSupportResistanceTool = createTool({
  name: "getChipSupportResistance",
  description:
    "获取基于筹码分布的支撑/阻力位分析。返回最近的关键支撑和阻力价格，以及它们与当前价格的距离。比传统均线更精确地反映资金博弈痕迹。",
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe("币种代码"),
    interval: z
      .enum(["15m", "1h", "4h"])
      .default("1h")
      .describe("K线周期"),
  }),
  execute: async ({ symbol, interval }) => {
    const client = createExchangeClient();
    const contract = `${symbol}_USDT`;

    // 获取3个周期的筹码分布
    const timeframes = {
      "15m": 96,
      "1H": 96,
      "4H": 72,
    };

    const candlesMap: Record<string, any[]> = {};
    for (const [tf, limit] of Object.entries(timeframes)) {
      try {
        candlesMap[tf] = await client.getFuturesCandles(
          contract,
          tf.toLowerCase(),
          limit
        );
      } catch {
        candlesMap[tf] = [];
      }
    }

    const ticker = await client.getFuturesTicker(contract);
    const currentPrice = Number(ticker.last || "0");

    const engine = new VolumeProfileEngine();
    const mtProfile = engine.calculateMultiTimeframe(
      Object.fromEntries(
        Object.entries(candlesMap).map(([tf, candles]) => [
          tf,
          candles.map(toCandleData),
        ])
      ),
      currentPrice
    );

    // 找出所有周期中距离当前价最近的支撑和阻力
    const allSupports: {
      price: number;
      distance: number;
      tf: string;
    }[] = [];
    const allResistances: {
      price: number;
      distance: number;
      tf: string;
    }[] = [];

    for (const [tf, profile] of Object.entries(mtProfile)) {
      if (!profile || typeof profile === "object" && "resonance" in profile) continue;
      const p = profile as any;
      if (!p.supportLevels) continue;

      for (const s of p.supportLevels) {
        const dist = ((currentPrice - s.price) / currentPrice) * 100;
        if (dist > 0 && dist < 20) {
          allSupports.push({ price: s.price, distance: dist, tf });
        }
      }
      for (const r of p.resistanceLevels) {
        const dist = ((r.price - currentPrice) / currentPrice) * 100;
        if (dist > 0 && dist < 20) {
          allResistances.push({ price: r.price, distance: dist, tf });
        }
      }
    }

    // 按距离排序
    allSupports.sort((a, b) => a.distance - b.distance);
    allResistances.sort((a, b) => a.distance - b.distance);

    // 检测共振（多周期同一价位）
    const resonanceSupport =
      mtProfile.resonance.supportResonance
        .filter((s) => {
          const dist = ((currentPrice - s.price) / currentPrice) * 100;
          return dist > 0 && dist < 20;
        })
        .slice(0, 3);

    const resonanceResistance =
      mtProfile.resonance.resistanceResonance
        .filter((r) => {
          const dist = ((r.price - currentPrice) / currentPrice) * 100;
          return dist > 0 && dist < 20;
        })
        .slice(0, 3);

    return {
      symbol,
      currentPrice,
      nearestSupport:
        allSupports.length > 0
          ? { price: allSupports[0].price, distance: allSupports[0].distance.toFixed(2) + "%" }
          : null,
      nearestResistance:
        allResistances.length > 0
          ? { price: allResistances[0].price, distance: allResistances[0].distance.toFixed(2) + "%" }
          : null,
      allSupports: allSupports.slice(0, 5).map((s) => ({
        price: s.price,
        distance: s.distance.toFixed(2) + "%",
        timeframe: s.tf,
      })),
      allResistances: allResistances.slice(0, 5).map((r) => ({
        price: r.price,
        distance: r.distance.toFixed(2) + "%",
        timeframe: r.tf,
      })),
      multiCycleResonance: {
        support: resonanceSupport.map((s) => ({
          price: s.price,
          cycleCount: s.timeframeCount,
        })),
        resistance: resonanceResistance.map((r) => ({
          price: r.price,
          cycleCount: r.timeframeCount,
        })),
      },
      formattedResonance: VolumeProfileEngine.formatResonanceForPrompt(mtProfile),
      timestamp: new Date().toISOString(),
    };
  },
});
