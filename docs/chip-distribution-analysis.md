# 筹码峰（Chip Distribution / Volume Profile）知识体系 & OKX 实现方案

> 文档日期: 2026-05-05
> 适用范围: OKX 加密货币永续合约交易系统
> 现有系统路径: /Users/minimac/ai-trading-system

---

## 一、核心概念

### 1.1 什么是筹码峰

筹码峰（Chip Distribution），在西方交易体系中称为 **Volume Profile** 或 **Market Profile**，是一种将成交量按价格水平分布的可视化分析工具。它回答一个核心问题：

> **"在什么价格水平上，发生了最多的交易？"**

不同于传统成交量指标（在K线底部显示为竖条），筹码峰将成交量**横轴分布**到各个价格水平，展示每个价位上的成交密集程度。

### 1.2 基本术语

| 术语 | 英文 | 含义 |
|------|------|------|
| 筹码峰 | Volume Profile / Chip Distribution | 按价格分布的成交量直方图 |
| 控制点 | Point of Control (POC) | 特定周期内成交量最大的价格水平 |
| 价值区域 | Value Area (VA) | 成交量占比 70% 的价格区间 |
| 价值区域上限 | Value Area High (VAH) | VA 的最高价 |
| 价值区域下限 | Value Area Low (VAL) | VA 的最低价 |
| 密集区 | High Volume Node (HVN) | 成交量明显较高的价格区 |
| 稀疏区 | Low Volume Node (LVN) | 成交量明显较低的价格区（潜在支撑/阻力） |
| 每行成交量 | Volume at Price | 单个价格水平上的总成交量 |

### 1.3 与传统成交量指标的区别

- **传统成交量（Volume Bars）**: 按时间聚合，显示每个时间周期（如1根K线）的总成交量
- **筹码峰（Volume Profile）**: 按价格聚合，显示每个价格水平在指定时间范围内的总成交量
- **订单簿（Order Book）**: 显示当前挂单深度，是瞬时快照
- **筹码峰**: 显示历史成交分布，反映多空双方的资金博弈痕迹

---

## 二、计算方法

### 2.1 基本算法

筹码峰的核心计算逻辑：

```
对于每个价格水平 P_i:
  成交量(P_i) = Σ(该K线中在价格 P_i 附近成交的合约数)

其中，需要将每根K线的成交量按价格区间分配
```

### 2.2 成交量分配方法

由于K线只提供 O/H/L/C 和总成交量，无法精确知道每个价格上的确切成交量，因此使用**近似分配算法**：

#### 方法 A：等分法（最简单）
```
每根K线的成交量 = Total Volume / (High - Low) 个价格单位
均匀分配给从 Low 到 High 的每一个价格水平
```

#### 方法 B：时间价格机会法 TPO (Time Price Opportunity) - 原始方法
```
将交易时段分成若干"时间片段"（如30分钟）
每个时间片段记录价格是否到达该水平
最终"到达次数"分布就形成 TPO Profile
```
- 优点：不依赖成交量数据，只看价格到达频次
- 缺点：不反映成交量大小，对加密货币来说不够精确

#### 方法 C：成交量加权分配（推荐用于加密货币）
```
对于每根K线（固定周期，如1小时）:
  1. 计算价格区间: range = high - low
  2. 将成交量分配到每个 tick 价格水平:
     - 近开盘价/收盘价区域分配更多权重
     - Formula: vol_per_price = totalVol / num_buckets
  
  # 更精确的 HV-LV 插值法
  mid = (high + low) / 2
  for each price bucket:
    weight = 1.0 - |price - mid| / range * 0.4  // 中间价格权重略高
    volume_at_price += totalVolume * weight / Σ(weights)
```

#### 方法 D：Tick 数据精确计算（最佳但数据量大）
```
使用交易所提供的逐笔成交数据 (trades/tick data)
对每一笔 trade，直接累加到对应的价格水平
=> volume_at_price[price] += trade_volume
```
- OKX 支持通过 WebSocket 订阅 `trades` 频道获取逐笔成交
- 实时维护内存中的筹码分布

### 2.3 关键指标计算

#### Point of Control (POC)
```
POC = argmax(volume_at_price) 
     = 成交量最大的价格水平
```

#### Value Area (VA)
```
总成交量 = Σ(volume_at_price) 
目标成交量 = 总成交量 × 0.70 (70%)
从 POC 向两侧扩展（高和低），直到累计成交量 >= 目标成交量
VAH = 累计达标时的最高价格
VAL = 累计达标时的最低价格
```

#### 筹码集中度 (Chip Concentration)
```
集中度 = (VAH - VAL) / POC × 100%

判断标准:
  < 3%   -> 极度密集（即将变盘）
  3-8%   -> 高度密集（强支撑/阻力区）
  8-15%  -> 中等密集
  > 15%  -> 分散（无明显支撑/阻力）
```

#### 筹码偏离度 (Deviation)
```
偏离度 = (当前价格 - POC) / POC × 100%

判断标准:
  > +5%  -> 价格远高于筹码区，有回调压力
  < -5%  -> 价格远低于筹码区，有反弹需求
```

#### 支撑/阻力强度评分
```
强度评分 = 该价格水平的成交量 / POC成交量 × 100

S级（极强）: > 80% of POC
A级（强）  : 50-80%
B级（中）  : 25-50%
C级（弱）  : 10-25%
```

---

## 三、实战应用

### 3.1 核心逻辑：筹码峰与价格行为的关系

```
           价格
           ↑
  ┌──── 稀疏区 (LVN) ──── 阻力区（价格容易在此受阻）
  │         ↑
  │      ┌──┴── 密集区 (HVN / 筹码峰)
  │      │  POC│  <- 最大成交量价格（核心博弈区）
  │      └──┬──
  │         ↓
  │   密集区底部 (VAL) ──── 支撑区（价格容易在此获得支撑）
  │         ↓
  └──── 稀疏区 (LVN) ──── 支撑失效后的加速区
```

### 3.2 五大实战场景

#### 场景 1：POC 作为支撑/阻力
- **做法**: 价格在 POC 上方 → POC 为支撑；价格在 POC 下方 → POC 为阻力
- **入场点**: 价格回调至 POC 附近并出现反转信号
- **止损**: POC 下方/上方 1-2 个 ATR
- **加密货币特有**: 24h POC 对日内交易最有效

#### 场景 2：价值区域突破
- **做法**: 价格突破 VAH（上方突破做多）或跌破 VAL（下方突破做空）
- **入场点**: 突破 VAH/VAL 并伴随成交量放大
- **止损**: VAH 下方（做多）或 VAL 上方（做空）
- **目标**: POC 到下一个密集区

#### 场景 3：LVN 磁吸效应
- **理论**: 价格有"填满"稀疏区的倾向（价格会快速穿过 LVN）
- **做法**: 当价格位于 LVN 下方时看空，LVN 上方时看多
- **入场**: 价格进入 LVN 后，跟随原始方向

#### 场景 4：多重周期筹码共振
- **做法**: 同时查看 15m/1H/4H 三个周期的筹码分布
- **共振买入**: 三个周期均在 POC 附近获得支撑
- **共振卖出**: 三个周期均在 POC 附近受阻
- **背离**: 短期周期突破但长期周期筹码密集区未确认 → 假突破

#### 场景 5：筹码峰与订单簿结合
- **做法**: 筹码峰 POC 附近的订单簿挂单密集区形成双重确认
- **验证**: 订单簿大量挂单 + 筹码峰 = 极强的支撑/阻力

### 3.3 加密货币特有的注意事项

1. **24小时交易**: 筹码峰通常计算最近24小时（适合加密货币）
2. **高波动性**: 加密货币价格波动大，建议使用对数价格桶而非线性
3. **非交易时间**: 加密货币无休市，传统 TPO 的时间段划分不适用
4. **资金费率影响**: 永续合约的资金费率会影响筹码密集区的有效性
5. **多空比验证**: 配合交易所的多空持仓比数据交叉验证

---

## 四、参数选择建议

### 4.1 计算时间窗口

| 交易风格 | 推荐窗口 | 价格桶数量 | 说明 |
|----------|----------|-----------|------|
| 超短线 (5m) | 4小时 | 20-30 | 捕捉近期密集区 |
| 短线 (15m-1H) | 24小时 | 30-50 | 日内交易推荐 |
| 中短线 (4H) | 3-7天 | 50-80 | 波段交易 |
| 中长线 (1D) | 30天 | 80-120 | 趋势交易 |

### 4.2 价格桶 (Price Bucket) 大小

```
桶大小 = ATR(14) × 价格桶系数

推荐系数:
  短周期: 0.1-0.2 × ATR
  中周期: 0.3-0.5 × ATR
  长周期: 0.5-1.0 × ATR

举例（BTC 示例）:
  BTC ATR(14) ≈ $500
  短线桶大小 = 500 × 0.15 = $75/桶
  中短线桶大小 = 500 × 0.4 = $200/桶
```

### 4.3 关键阈值参考

| 参数 | 推荐默认值 | 说明 |
|------|-----------|------|
| 价值区域占比 | 70% | 标准值 |
| 密集区阈值 | > POC × 50% | HVN 判定 |
| 稀疏区阈值 | < POC × 20% | LVN 判定 |
| 价格桶数量上限 | 200 | 防止计算量过大 |
| 数据保留周期 | 当前周期的 2 倍 | 如计算24h，保留48h数据 |

---

## 五、OKX 系统实现方案

### 5.1 数据来源

OKX API 提供以下可用数据源：

| API | Endpoint | 适用方案 |
|-----|----------|---------|
| K线 | `GET /api/v5/market/candles` | 方案A（K线法） |
| 逐笔成交 | WebSocket `trades` 频道 | 方案B（Tick法） |
| 订单簿 | `GET /api/v5/market/books` | 辅助确认 |

### 5.2 架构设计

```
┌─────────────────────────────────────────────────────┐
│                 筹码峰分析系统                          │
├─────────────────────────────────────────────────────┤
│  VolumeProfileEngine (核心引擎)                       │
│  ├─ DataProvider: K线/WebSocket 数据源                │
│  ├─ BucketAggregator: 价格桶分配计算                    │
│  ├─ IndicatorCalculator: POC/VA/集中度 等指标计算      │
│  └─ CacheManager: 结果缓存 + 增量更新                   │
├─────────────────────────────────────────────────────┤
│  VolumeProfileTool (Voltagent Tool)                  │
│  ├─ getVolumeProfile(symbol, period)                 │
│  ├─ getChipSupportResistance(symbol)                 │
│  └─ getMarketStructure(symbol)                       │
├─────────────────────────────────────────────────────┤
│  AI Agent Integration (策略集成)                      │
│  ├─ 决策提示词中注入筹码峰分析结果                      │
│  └─ 支撑/阻力多源交叉验证                              │
└─────────────────────────────────────────────────────┘
```

### 5.3 文件结构

```
src/
├── analysis/
│   ├── volumeProfile/
│   │   ├── index.ts                    # 模块导出
│   │   ├── types.ts                    # 类型定义
│   │   ├── VolumeProfileEngine.ts      # 核心引擎
│   │   ├── BucketAggregator.ts         # 价格桶分配器
│   │   ├── IndicatorCalculator.ts      # 指标计算器
│   │   └── VolumeProfileCache.ts       # 缓存管理
│   └── ...
├── tools/trading/
│   ├── volumeProfileTools.ts           # 筹码峰分析工具（新增）
│   └── ...
└── ...
```

### 5.4 核心类型定义

```typescript
// src/analysis/volumeProfile/types.ts

/** 价格桶 */
export interface PriceBucket {
  price: number;            // 价格（桶的中间价）
  volume: number;           // 该价格水平的总成交量(合约数)
  volumeQuote: number;      // 该价格水平的总成交额(USDT)
  tradeCount: number;       // 成交笔数（仅Tick模式）
  isPOC: boolean;           // 是否控制点
}

/** 筹码峰分析结果 */
export interface VolumeProfileResult {
  symbol: string;
  interval: string;          // 计算周期 "1H", "4H", "1D"
  timeRange: {               // 数据时间范围
    start: number;
    end: number;
  };
  buckets: PriceBucket[];    // 价格桶数组（按价格排序）
  poc: {                     // 控制点
    price: number;
    volume: number;
  };
  valueArea: {               // 价值区域
    high: number;            // VAH
    low: number;             // VAL
    range: number;           // 区间宽度
  };
  concentration: number;     // 集中度 %
  currentPrice: number;      // 当前价格
  deviation: number;         // 偏离度 %
  
  // 支撑/阻力分析
  supportLevels: ChipLevel[];
  resistanceLevels: ChipLevel[];
  
  // 统计
  totalVolume: number;
  totalVolumeQuote: number;
  bucketSize: number;        // 每个桶的价格宽度
}

/** 筹码峰定义的支撑/阻力位 */
export interface ChipLevel {
  price: number;
  type: 'support' | 'resistance';
  strength: 'S' | 'A' | 'B' | 'C';  // 强度等级
  volume: number;
  volumeRatio: number;       // 占 POC 的比例
  description: string;
}

/** 筹码峰配置 */
export interface VolumeProfileConfig {
  valueAreaPercent: number;  // 价值区域占比，默认 0.7
  denseThreshold: number;    // 密集区阈值比例，默认 0.5
  sparseThreshold: number;   // 稀疏区阈值比例，默认 0.2
  maxBuckets: number;        // 最大桶数，默认 200
  atrMultiplier: number;     // ATR乘数计算桶大小，默认 0.3
}
```

### 5.5 核心引擎实现（方案A：K线法）

```typescript
// src/analysis/volumeProfile/VolumeProfileEngine.ts

import { VolumeProfileResult, VolumeProfileConfig, PriceBucket } from './types';
import { BucketAggregator } from './BucketAggregator';
import { IndicatorCalculator } from './IndicatorCalculator';

export class VolumeProfileEngine {
  private config: VolumeProfileConfig;
  private aggregator: BucketAggregator;

  constructor(config?: Partial<VolumeProfileConfig>) {
    this.config = {
      valueAreaPercent: 0.7,
      denseThreshold: 0.5,
      sparseThreshold: 0.2,
      maxBuckets: 200,
      atrMultiplier: 0.3,
      ...config,
    };
    this.aggregator = new BucketAggregator();
  }

  /**
   * 从K线数据计算筹码峰
   * @param candles - OKX K线数据 [{t, o, h, l, c, v, sum}]
   * @param currentPrice - 当前价格
   * @param bucketSize - 价格桶大小（可选，自动计算）
   */
  analyze(
    candles: Candle[],
    currentPrice: number,
    bucketSize?: number
  ): VolumeProfileResult {
    // 1. 计算价格桶大小
    const actualBucketSize = bucketSize ?? this.calculateBucketSize(candles, currentPrice);

    // 2. 聚合成交量到价格桶
    const buckets = this.aggregator.aggregate(candles, actualBucketSize);

    // 3. 裁剪桶数量
    const trimmedBuckets = this.trimBuckets(buckets);

    // 4. 计算各指标
    const calculator = new IndicatorCalculator(trimmedBuckets, this.config);
    const poc = calculator.findPOC();
    const valueArea = calculator.calculateValueArea(poc);
    const concentration = calculator.calculateConcentration(valueArea, poc.price);
    const deviation = calculator.calculateDeviation(currentPrice, poc.price);
    const supportLevels = calculator.findSupportLevels(currentPrice);
    const resistanceLevels = calculator.findResistanceLevels(currentPrice);

    // 5. 组装结果
    return {
      symbol: '',
      interval: '',
      timeRange: {
        start: candles[0]?.t ?? 0,
        end: candles[candles.length - 1]?.t ?? 0,
      },
      buckets: trimmedBuckets,
      poc,
      valueArea,
      concentration,
      currentPrice,
      deviation,
      supportLevels,
      resistanceLevels,
      totalVolume: trimmedBuckets.reduce((s, b) => s + b.volume, 0),
      totalVolumeQuote: trimmedBuckets.reduce((s, b) => s + b.volumeQuote, 0),
      bucketSize: actualBucketSize,
    };
  }

  private calculateBucketSize(candles: Candle[], currentPrice: number): number {
    // 使用 ATR × 系数 计算桶大小
    const closes = candles.map(c => Number(c.c));
    const atr = calculateATR(candles, 14);
    const bucketSize = atr * this.config.atrMultiplier;
    
    // 确保桶大小合理（至少 0.01，最多价格的 1%）
    const minBucket = Math.max(0.01, currentPrice * 0.001);
    const maxBucket = currentPrice * 0.02;
    return Math.max(minBucket, Math.min(maxBucket, bucketSize));
  }

  private trimBuckets(buckets: PriceBucket[]): PriceBucket[] {
    // 只保留成交量非零的桶，限制最多 maxBuckets
    const nonZero = buckets.filter(b => b.volume > 0);
    if (nonZero.length <= this.config.maxBuckets) return nonZero;
    
    // 超过限制时，合并较小成交量的边缘桶
    const mid = Math.floor(nonZero.length / 2);
    const half = Math.floor(this.config.maxBuckets / 2);
    return nonZero.slice(mid - half, mid + half);
  }
}
```

### 5.6 价格桶分配器

```typescript
// src/analysis/volumeProfile/BucketAggregator.ts

export class BucketAggregator {
  /**
   * 将K线成交量分配到价格桶
   * 
   * 分配算法：等分法
   * 每根K线的成交量均匀分配到 Low-High 之间的每个桶
   */
  aggregate(candles: Candle[], bucketSize: number): PriceBucket[] {
    if (candles.length === 0) return [];

    // 确定价格范围
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const c of candles) {
      const low = Number(c.l);
      const high = Number(c.h);
      if (low < minPrice) minPrice = low;
      if (high > maxPrice) maxPrice = high;
    }

    // 创建桶数组
    const bucketCount = Math.ceil((maxPrice - minPrice) / bucketSize);
    const buckets: Map<number, PriceBucket> = new Map();

    for (let i = 0; i <= bucketCount; i++) {
      const bucketPrice = minPrice + (i + 0.5) * bucketSize;
      buckets.set(bucketPrice, {
        price: bucketPrice,
        volume: 0,
        volumeQuote: 0,
        tradeCount: 0,
        isPOC: false,
      });
    }

    // 分配每根K线的成交量
    for (const candle of candles) {
      const open = Number(candle.o);
      const high = Number(candle.h);
      const low = Number(candle.l);
      const close = Number(candle.c);
      const volume = Number(candle.v);
      const volumeQuote = Number(candle.sum ?? 0);

      if (high <= low || volume <= 0) continue;

      // 计算该K线覆盖的桶索引范围
      const firstBucketIdx = Math.floor((low - minPrice) / bucketSize);
      const lastBucketIdx = Math.floor((high - minPrice) / bucketSize);
      const coveredBuckets = lastBucketIdx - firstBucketIdx + 1;

      // 均匀分配成交量
      const volPerBucket = volume / coveredBuckets;
      const volQuotePerBucket = volumeQuote / coveredBuckets;

      for (let idx = firstBucketIdx; idx <= lastBucketIdx; idx++) {
        const bucketPrice = minPrice + (idx + 0.5) * bucketSize;
        const existing = buckets.get(bucketPrice);
        if (existing) {
          existing.volume += volPerBucket;
          existing.volumeQuote += volQuotePerBucket;
        }
      }
    }

    return Array.from(buckets.values())
      .filter(b => b.volume > 0)
      .sort((a, b) => a.price - b.price);
  }

  /**
   * 高级分配：HV-LV 加权法
   * 根据(H-L)/(O-C)关系，给开盘价/收盘价附近的桶更高权重
   */
  aggregateWeighted(candles: Candle[], bucketSize: number): PriceBucket[] {
    // 加权分配逻辑...
    // 1. 计算每根K线的 body (|O-C|) 和 shadow (H-L - |O-C|)
    // 2. body 部分的成交量分配在 O~C 之间
    // 3. shadow 部分的成交量分配在 H~L 之间（低权重）
    // 此处略，实际实现时作为优化
    return this.aggregate(candles, bucketSize);
  }
}
```

### 5.7 指标计算器

```typescript
// src/analysis/volumeProfile/IndicatorCalculator.ts

export class IndicatorCalculator {
  constructor(
    private buckets: PriceBucket[],
    private config: VolumeProfileConfig
  ) {}

  /** 寻找 POC（控制点） */
  findPOC(): { price: number; volume: number } {
    let maxVol = 0;
    let pocPrice = 0;
    for (const b of this.buckets) {
      if (b.volume > maxVol) {
        maxVol = b.volume;
        pocPrice = b.price;
      }
    }
    // 标记 POC
    this.buckets.forEach(b => b.isPOC = b.price === pocPrice);
    return { price: pocPrice, volume: maxVol };
  }

  /** 计算价值区域 VAH/VAL */
  calculateValueArea(poc: { price: number; volume: number }): { high: number; low: number; range: number } {
    const totalVolume = this.buckets.reduce((s, b) => s + b.volume, 0);
    const targetVolume = totalVolume * this.config.valueAreaPercent;

    // 从 POC 向两侧扩展
    const pocIndex = this.buckets.findIndex(b => b.price === poc.price);
    let leftIdx = pocIndex;
    let rightIdx = pocIndex;
    let currentVol = this.buckets[pocIndex].volume;

    // 交替向左右扩展
    while (currentVol < targetVolume) {
      const leftVol = leftIdx > 0 ? this.buckets[leftIdx - 1].volume : 0;
      const rightVol = rightIdx < this.buckets.length - 1 ? this.buckets[rightIdx + 1].volume : 0;

      if (leftVol >= rightVol && leftIdx > 0) {
        leftIdx--;
        currentVol += leftVol;
      } else if (rightIdx < this.buckets.length - 1) {
        rightIdx++;
        currentVol += rightVol;
      } else {
        break;
      }
    }

    return {
      low: this.buckets[leftIdx].price,
      high: this.buckets[rightIdx].price,
      range: this.buckets[rightIdx].price - this.buckets[leftIdx].price,
    };
  }

  /** 计算筹码集中度 */
  calculateConcentration(valueArea: { high: number; low: number; range: number }, pocPrice: number): number {
    if (pocPrice <= 0) return 0;
    return (valueArea.range / pocPrice) * 100;
  }

  /** 计算偏离度 */
  calculateDeviation(currentPrice: number, pocPrice: number): number {
    if (pocPrice <= 0) return 0;
    return ((currentPrice - pocPrice) / pocPrice) * 100;
  }

  /** 寻找支撑位（价格下方的密集区） */
  findSupportLevels(currentPrice: number): ChipLevel[] {
    const pocVolume = Math.max(...this.buckets.map(b => b.volume));
    const belowPrice = this.buckets.filter(b => b.price < currentPrice);
    
    return this.findChipLevels(belowPrice, pocVolume, 'support');
  }

  /** 寻找阻力位（价格上方的密集区） */
  findResistanceLevels(currentPrice: number): ChipLevel[] {
    const pocVolume = Math.max(...this.buckets.map(b => b.volume));
    const abovePrice = this.buckets.filter(b => b.price > currentPrice);
    
    return this.findChipLevels(abovePrice, pocVolume, 'resistance');
  }

  private findChipLevels(
    buckets: PriceBucket[],
    pocVolume: number,
    type: 'support' | 'resistance'
  ): ChipLevel[] {
    // 找到局部极大值（峰值）
    const peaks: ChipLevel[] = [];
    for (let i = 1; i < buckets.length - 1; i++) {
      const prev = buckets[i - 1].volume;
      const curr = buckets[i].volume;
      const next = buckets[i + 1].volume;
      
      if (curr > prev && curr > next && curr > 0) {
        const ratio = curr / pocVolume;
        let strength: ChipLevel['strength'] = 'C';
        if (ratio > 0.8) strength = 'S';
        else if (ratio > 0.5) strength = 'A';
        else if (ratio > 0.25) strength = 'B';

        peaks.push({
          price: buckets[i].price,
          type,
          strength,
          volume: curr,
          volumeRatio: ratio,
          description: this.getLevelDescription(strength, type, buckets[i].price),
        });
      }
    }

    // 按强度排序，返回 Top 5
    return peaks
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 5);
  }

  private getLevelDescription(
    strength: ChipLevel['strength'],
    type: ChipLevel['type'],
    price: number
  ): string {
    const strengthText = { S: '极强', A: '强', B: '中等', C: '弱' };
    const typeText = { support: '支撑', resistance: '阻力' };
    return `${strengthText[strength]}${typeText[type]} $${price.toFixed(1)}`;
  }
}
```

### 5.8 Voltagent Tool 集成

```typescript
// src/tools/trading/volumeProfileTools.ts

import { createTool } from '@voltagent/core';
import { z } from 'zod';
import { createExchangeClient } from '../../services/exchangeClient';
import { RISK_PARAMS } from '../../config/riskParams';
import { VolumeProfileEngine } from '../../analysis/volumeProfile/VolumeProfileEngine';
import { VolumeProfileCache } from '../../analysis/volumeProfile/VolumeProfileCache';

const volumeProfileCache = new VolumeProfileCache(5 * 60 * 1000); // 5分钟缓存

/**
 * 筹码峰分析工具
 * 获取指定币种的筹码分布，包含POC、价值区域、支撑/阻力位等
 */
export const getVolumeProfileTool = createTool({
  name: 'getVolumeProfile',
  description: '获取指定币种的筹码峰分布分析（Volume Profile），包含POC、价值区域、筹码集中度、支撑阻力位等（加密货币专用）',
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe('币种代码'),
    interval: z.enum(['1m', '5m', '15m', '30m', '1H', '4H', '1D']).default('1H').describe('K线周期，影响数据精度'),
    lookbackHours: z.number().default(24).describe('回看小时数，默认24小时'),
    bucketSize: z.number().optional().describe('价格桶大小（美元），不传则自动计算'),
  }),
  execute: async ({ symbol, interval, lookbackHours, bucketSize }) => {
    const cacheKey = `${symbol}_${interval}_${lookbackHours}`;
    const cached = volumeProfileCache.get(cacheKey);
    if (cached) return cached;

    const client = createExchangeClient();
    const contract = `${symbol}_USDT`;

    // 计算需要获取多少根K线
    const intervalMinutes = parseInterval(interval);
    const limit = Math.ceil((lookbackHours * 60) / intervalMinutes);
    const cappedLimit = Math.min(limit, 300); // OKX API 限制 300

    // 获取K线数据
    const candles = await client.getFuturesCandles(contract, interval, cappedLimit);
    
    // 获取当前价格
    const ticker = await client.getFuturesTicker(contract);
    const currentPrice = Number(ticker.last);

    // 计算筹码峰
    const engine = new VolumeProfileEngine();
    const result = engine.analyze(candles, currentPrice, bucketSize);
    
    // 补充元信息
    result.symbol = symbol;
    result.interval = interval;

    // 缓存结果
    volumeProfileCache.set(cacheKey, result);

    return result;
  },
});

/**
 * 筹码支撑/阻力工具
 * 快速获取支撑阻力位摘要
 */
export const getChipSupportResistanceTool = createTool({
  name: 'getChipSupportResistance',
  description: '基于筹码峰（Volume Profile）获取关键支撑阻力位',
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe('币种代码'),
  }),
  execute: async ({ symbol }) => {
    const profile = await getVolumeProfileTool.execute({ symbol, interval: '1H', lookbackHours: 24 });
    
    return {
      symbol,
      currentPrice: profile.currentPrice,
      poc: profile.poc,
      valueArea: profile.valueArea,
      concentration: `${profile.concentration.toFixed(2)}%`,
      deviation: `${profile.deviation.toFixed(2)}%`,
      supportLevels: profile.supportLevels.map(s => `${s.description} (成交量比: ${(s.volumeRatio * 100).toFixed(0)}%)`),
      resistanceLevels: profile.resistanceLevels.map(r => `${r.description} (成交量比: ${(r.volumeRatio * 100).toFixed(0)}%)`),
      marketStructure: describeMarketStructure(profile),
    };
  },
});

function describeMarketStructure(profile: any): string {
  const { currentPrice, poc, valueArea, concentration, deviation } = profile;
  
  if (concentration < 3) return '⚠️ 极度密集 — 即将变盘，谨慎入场';
  if (concentration < 8) return '🔴 高度密集 — 强支撑/阻力区，突破需放量';
  if (concentration < 15) return '🟡 中等密集 — 正常波动区间';
  
  if (deviation > 5) return '🟢 价格偏离筹码区上方 — 注意回调压力';
  if (deviation < -5) return '🟢 价格偏离筹码区下方 — 关注反弹机会';
  
  return '🟢 筹码分散 — 趋势行情，顺势交易';
}

function parseInterval(interval: string): number {
  const map: Record<string, number> = {
    '1m': 1, '5m': 5, '15m': 15, '30m': 30,
    '1H': 60, '4H': 240, '1D': 1440,
  };
  return map[interval] ?? 60;
}
```

### 5.9 缓存管理

```typescript
// src/analysis/volumeProfile/VolumeProfileCache.ts

export class VolumeProfileCache {
  private cache = new Map<string, { data: any; expiresAt: number }>();

  constructor(private ttlMs: number = 5 * 60 * 1000) {} // 默认5分钟

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: any): void {
    this.cache.set(key, { data, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void { this.cache.clear(); }
}
```

### 5.10 在策略提示词中使用

在 `src/strategies/types.ts` 的策略上下文和提示词生成中，增加筹码峰分析注入：

```typescript
// 在策略提示词模板中添加筹码峰段落

/**
 * 筹码峰分析摘要 - 注入策略提示词
 */
function buildChipAnalysisSection(profile: VolumeProfileResult): string {
  return `
【筹码峰分析 (Volume Profile / Chip Distribution)】
• 控制点 POC: $${profile.poc.price.toFixed(1)} (最大成交量价格)
• 价值区域: $${profile.valueArea.low.toFixed(1)} ~ $${profile.valueArea.high.toFixed(1)}
• 筹码集中度: ${profile.concentration.toFixed(1)}%
• 当前价格偏离度: ${profile.deviation.toFixed(1)}%
  ${profile.deviation > 3 ? '→ 价格明显偏离POC，回归概率增大' : ''}
  ${profile.deviation < -3 ? '→ 价格低于POC，可能超卖' : ''}

【关键支撑位（基于筹码密集区）】
${profile.supportLevels.map(s => `• ${s.description}`).join('\n')}

【关键阻力位（基于筹码密集区）】
${profile.resistanceLevels.map(r => `• r.description}`).join('\n')}

【市场结构判断】
${describeMarketStructure(profile)}

【交易建议】
- 支撑位附近做多，止损设在支撑位下方
- 阻力位附近做空（或减仓），突破后追多
- POC 是核心博弈区，价格在 POC 上方偏多，下方偏空
- 价值区域越窄（集中度高），突破后行情越剧烈
`;
}
```

---

## 六、实现优先级与路线图

### Phase 1: 基础版（1-2天）
- [ ] 实现 `BucketAggregator`（等分法）
- [ ] 实现 `IndicatorCalculator`（POC + VA + 集中度）
- [ ] 创建 `VolumeProfileEngine` 核心类
- [ ] 集成 `getVolumeProfileTool` 到工具集
- [ ] 单元测试

### Phase 2: 增强版（2-3天）
- [ ] 加权分配算法（HV-LV 法）
- [ ] 支撑/阻力级别检测
- [ ] 筹码峰 + 订单簿交叉验证
- [ ] 策略提示词注入
- [ ] 前端可视化（筹码峰直方图）

### Phase 3: 高级版（3-5天）
- [ ] WebSocket `trades` 频道实时修正
- [ ] 多周期筹码共振分析
- [ ] 筹码峰历史变化追踪（POC漂移）
- [ ] 机器学习：用筹码峰特征做价格预测
- [ ] 回测框架验证

---

## 七、测试验证方案

### 7.1 数据验证
```typescript
// 测试筹码峰计算是否正确
const testCandles = generateMockCandles({
  // 在 $50000 价格附近制造大量交易
  clusterPrice: 50000,
  clusterVolume: 10000,
  noiseVolume: 100,
});

const engine = new VolumeProfileEngine();
const result = engine.analyze(testCandles, 50100);

// 验证
assert(result.poc.price ≈ 50000, 'POC should be at cluster price');
assert(result.valueArea.low < result.poc.price < result.valueArea.high);
assert(result.concentration > 0);
```

### 7.2 与订单簿交叉校验
```typescript
// 验证筹码峰支撑/阻力与订单簿一致性
const orderBook = await client.getOrderBook('BTC_USDT', 100);
const profile = await engine.analyze(candles, currentPrice);

// 检查筹码峰密集区是否有订单簿大单支撑
for (const level of profile.supportLevels) {
  const bidLevel = orderBook.bids.find(
    b => Math.abs(b.price - level.price) / level.price < 0.001 // 0.1%偏差
  );
  if (bidLevel && bidLevel.size > largeOrderThreshold) {
    // 双重确认
    level.confirmedByOrderBook = true;
  }
}
```

---

## 八、参考资料

- **Volume Profile 原始理论**: J. Peter Steidlmayer, "Markets & Market Logic" (1986)
- **OKX API 文档**: https://www.okx.com/docs-v5/en/#rest-api-market-data-get-candlesticks
- **TradingView PineScript Volume Profile**: 参考开源实现
- **相关论文**: "Volume-Weighted Average Price (VWAP) and Market Profile Strategies"

---

> **总结**: 筹码峰分析是加密货币交易中极具价值的工具，特别适合OKX永续合约市场。本项目采用K线等分法作为起点（数据易获取、计算高效），后续可升级到Tick数据精确计算。核心输出是POC/价值区域/筹码集中度/支撑阻力级别，这些指标可直接注入AI交易策略的决策提示词中。
