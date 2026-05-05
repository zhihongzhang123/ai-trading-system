# 交易系统修改记录 v8.0

## 本次修改 (2026-05-05) — LEI 体系整合 + 筹码峰引擎

### 1. LEI 代理人 v7 学习体系注入
- **内容**: 将 Pulse/LEI 五大核心交易框架整合到系统认知层
  - ① 价量关系体系（量=分歧，持仓量=屯兵量）
  - ② TQQQ 黄金三角+对冲体系（50/25/25 配置，DCA/BTD，期货/期权对冲）
  - ③ 高质量股票暴跌 LEAPS 策略
  - ④ 全市场动量检测策略
  - ⑤ 筹码峰/Volume Profile 理论
- **文档**: `docs/chip-distribution-analysis.md` (942行深度参考)

### 2. 筹码峰引擎 (Volume Profile Engine) — Phase 1
- **架构**: `BucketAggregator → IndicatorCalculator → VolumeProfileEngine → VolumeProfileCache`
- **算法**: K线等分法（Candle Equal-Split Allocation），兼容 OKX REST K线 API
- **模块**:
  - `src/analysis/volumeProfile/types.ts` — 类型定义（ProfileBucket, ChipLevel, ResonanceLevel）
  - `src/analysis/volumeProfile/BucketAggregator.ts` — K线成交量桶聚合
  - `src/analysis/volumeProfile/IndicatorCalculator.ts` — POC/VAH/VAL 计算
  - `src/analysis/volumeProfile/VolumeProfileEngine.ts` — 多周期共振检测（15m/1H/4H）
  - `src/analysis/volumeProfile/VolumeProfileCache.ts` — 缓存层
  - `src/tools/trading/volumeProfileTools.ts` — Voltagent 工具封装

### 3. AI Trading Agent 工具注册
- **文件**: `src/agents/tradingAgent.ts`
- **变更**: 注入 `getVolumeProfileTool` + `getChipSupportResistanceTool`
- **效果**: AI 交易循环原生支持筹码峰查询，与传统指标协同决策

### 4. 市场情绪 API 端点
- **文件**: `src/api/routes.ts` — 新增 `GET /api/sentiment`
- **数据源**: Alternative.me Fear & Greed Index + 实时新闻情绪聚合
- **覆盖**: BTC/ETH/SOL 三币种
- **依赖**: `src/services/newsClient.js` (fetchCryptoNews + aggregateSentiment)

### 5. 前端监控页增强
- **文件**: `public/index.html`, `monitor-script.js`, `monitor-styles.css`
- **变更**: +183行前端代码优化

## 本次修改 (2026-05-04)

### 1. MACD 评分逻辑修复
- **文件**: `src/scheduler/tradingLoop.ts:128-129`
- **问题**: 原 if/else 均 +6 分导致分数僵化在 64-67
- **修复**: 只做多模式下仅 `MACD > 0` 时 +6 分，负向动量不加分
- **效果**: 分数恢复动态范围 59-65

### 2. 有效杠杆计算
- **前端**: 使用 `(quantity * currentPrice) / openValue` 动态计算，上限 3x
- **预警**: >3x 显示黄色警告
- **历史杠杆列** (`monitor-script.js:257`): 从 DB 原始 leverage 改为动态计算

### 3. 单实例防护
- **文件**: `src/utils/singleInstance.ts`
- **方案**: `.voltagent/.trading.pid` 文件系统锁
- **逻辑**: 启动检测存活 PID → 覆盖僵尸进程 → 退出清理

### 4. 动态冷却机制
- **文件**: `src/services/riskGuard.ts`
- **升级**: 固定 60 分钟 → 阶梯动态模型
- **公式**: 基础值 + consecutiveLosses 递增 + dailyLossPercent 补偿
- **上限**: 240 分钟

### 5. 前端 CSS 变量化
- **文件**: `public/monitor-styles.css`
- **变更**: 硬编码颜色 → CSS 语义变量
- **变量**: `--score-good/mid/bad`、`--accent-green/red/warning/orange`

### 6. AI 决策面板 UI 修复
- **文件**: `public/monitor-script.js:850-858`
- **问题 1**: JS 设置 `overflow: visible` 覆盖 CSS `overflow-y: auto`，导致不能滚动
- **问题 2**: JS 用 `maxHeight` 控制，CSS 用 `height` 控制，两者冲突导致展开/收起异常
- **修复**: 移除 JS 对 overflow/maxHeight 的内联覆盖，完全交由 CSS `.collapsed` 类控制

### 7. 交易间隔调整
- **文件**: `.env`
- **变更**: `TRADING_INTERVAL_MINUTES=30` (原 60)
- **行为**: 启动立即执行一次，之后每 30 分钟触发

## 运行信息
- **路径**: `/private/tmp/nof1.ai/`
- **启动**: `cd /private/tmp/nof1.ai && node dist/index.js`
- **端口**: 3100
- **交易所**: OKX
- **策略**: 只做多，5m/1h/1d 三周期共振
