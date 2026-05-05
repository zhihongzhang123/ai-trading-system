/**
 * 筹码峰（Volume Profile）类型定义
 */

/** 单个价格桶 */
export interface PriceBucket {
  /** 价格水平（桶的中点价格） */
  price: number;
  /** 该价格水平的成交量 */
  volume: number;
}

/** 筹码分布完整结果 */
export interface VolumeProfileResult {
  /** 价格桶列表（按价格升序） */
  buckets: PriceBucket[];
  /** 控制点（成交量最大的价格） */
  poc: number;
  /** 价值区域上限（70%成交量上界） */
  vah: number;
  /** 价值区域下限（70%成交量下界） */
  val: number;
  /** 筹码集中度（VA宽度/POC） */
  concentration: number;
  /** 当前价格偏离POC的百分比 */
  deviation: number;
  /** 密集区列表（HVN - 高成交量节点） */
  hvn: { price: number; volume: number; strength: string }[];
  /** 稀疏区列表（LVN - 低成交量节点） */
  lvn: { price: number; volume: number }[];
  /** 支撑位列表 */
  supportLevels: { price: number; strength: string; score: number }[];
  /** 阻力位列表 */
  resistanceLevels: { price: number; strength: string; score: number }[];
  /** 总成交量 */
  totalVolume: number;
  /** 计算周期（如 "1H", "5m"） */
  timeframe: string;
  /** K线根数 */
  candleCount: number;
}

/** 支撑/阻力检测结果 */
export interface ChipSupportResistance {
  /** 当前价格 */
  currentPrice: number;
  /** 最近支撑位 */
  nearestSupport: { price: number; distance: number; strength: string } | null;
  /** 最近阻力位 */
  nearestResistance: { price: number; distance: number; strength: string } | null;
  /** 所有支撑位 */
  supports: { price: number; distance: number; strength: string; score: number }[];
  /** 所有阻力位 */
  resistances: { price: number; distance: number; strength: string; score: number }[];
  /** POC 位置 */
  poc: number;
  /** 价值区域 */
  valueArea: { high: number; low: number; width: number };
  /** 筹码集中度 */
  concentration: number;
}

/** 计算参数 */
export interface VolumeProfileOptions {
  /** 价格桶大小（默认用 ATR*0.3 自动计算） */
  bucketSize?: number;
  /** 价值区域百分比（默认 70%） */
  vaPercent?: number;
  /** HVN 阈值（相对于POC成交量的百分比，默认 25%） */
  hvnThreshold?: number;
  /** LVN 阈值（相对于POC成交量的百分比，默认 10%） */
  lvnThreshold?: number;
  /** 支撑/阻力最小得分（默认 15） */
  minScore?: number;
}

/** K线数据（兼容现有系统格式） */
export interface CandleData {
  t: number; // 时间戳（秒）
  o: string | number; // 开盘价
  h: string | number; // 最高价
  l: string | number; // 最低价
  c: string | number; // 收盘价
  v: string | number; // 成交量
  sum?: string | number; // 成交额
}

/** 多周期筹码分布 */
export interface MultiTimeframeProfile {
  "15m": VolumeProfileResult | null;
  "1H": VolumeProfileResult | null;
  "4H": VolumeProfileResult | null;
  /** 共振信号 */
  resonance: {
    /** 多周期支撑共振（价格同时被多个周期支撑） */
    supportResonance: ResonanceLevel[];
    /** 多周期阻力共振 */
    resistanceResonance: ResonanceLevel[];
  };
}

/** 共振级别 */
export interface ResonanceLevel {
  price: number;
  timeframeCount: number;
}
