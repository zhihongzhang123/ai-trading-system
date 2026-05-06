/**
 * ai-trading-system - AI 加密货币自动交易系统
 * Copyright (C) 2025 zhihongzhang123
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * API 路由
 */
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createClient } from "@libsql/client";
import { createExchangeClient } from "../services/exchangeClient";
import { createLogger } from "../utils/loggerUtils";
import { getTradingStrategy, getStrategyParams } from "../agents/tradingAgent";
import { RISK_PARAMS } from "../config/riskParams";
import { getChinaTimeISO } from "../utils/timeUtils";
import { getQuantoMultiplier } from "../utils/contractUtils";
import { initNewsClient, fetchCryptoNews, aggregateSentiment } from "../services/newsClient.js";
import { ipBlacklistMiddleware } from "../middleware/ipBlacklist";

const logger = createLogger({
  name: "api-routes",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

export function createApiRoutes() {
  const app = new Hono();

  // IP 黑名单中间件 - 拦截黑名单 IP
  app.use("*", ipBlacklistMiddleware);

  // 禁止缓存 API 响应 - 确保刷新页面获取最新数据
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
  });

  // 静态文件服务 - 需要使用绝对路径
  app.use("/*", serveStatic({ root: "./public" }));

  /**
   * 获取账户总览
   * 
   * Gate.io 账户结构：
   * - account.total = available + positionMargin
   * - account.total 不包含未实现盈亏
   * - 真实总资产 = account.total + unrealisedPnl
   * 
   * API返回说明：
   * - totalBalance: 不包含未实现盈亏的总资产（用于计算已实现收益）
   * - unrealisedPnl: 当前持仓的未实现盈亏
   * 
   * 前端显示：
   * - 总资产显示 = totalBalance + unrealisedPnl（实时反映持仓盈亏）
   */
  app.get("/api/account", async (c) => {
    try {
      const exchangeClient = createExchangeClient();
      const account = await exchangeClient.getFuturesAccount();
      
      // 从数据库获取初始资金
      const initialResult = await dbClient.execute(
        "SELECT total_value FROM account_history ORDER BY timestamp ASC LIMIT 1"
      );
      const initialBalance = initialResult.rows[0]
        ? Number.parseFloat(initialResult.rows[0].total_value as string)
        : 100;
      
      // OKX totalEq 已包含未实现盈亏，无需重复叠加
      const totalBalance = Number.parseFloat(account.total || "0");
      const availableBalance = Number.parseFloat(account.available || "0");
      const positionMargin = Number.parseFloat(account.positionMargin || "0");
      const unrealisedPnl = Number.parseFloat(account.unrealisedPnl || "0");
      
      // 净资产 = totalEq（已包含未实现盈亏）
      const equity = totalBalance;
      
      // 保证金占用率 = 保证金 / 总资产
      const marginRatio = totalBalance > 0 ? (positionMargin / totalBalance) * 100 : 0;
      
      // 可用保证金 = 总资产 - 保证金
      const availableMargin = totalBalance - positionMargin;
      
      // 收益率（基于净资产）
      const returnPercent = initialBalance > 0 ? ((equity - initialBalance) / initialBalance) * 100 : 0;
      
      // 查询累计手续费
      const feeResult = await dbClient.execute(
        "SELECT COALESCE(SUM(fee), 0) as total_fee FROM trades WHERE type = 'close'"
      );
      const totalFees = Number.parseFloat(feeResult.rows[0]?.total_fee as string || "0");
      
      // 返佣
      const feeRebatePercent = Number.parseFloat(process.env.FEE_REBATE_PERCENT || "20");
      const rebateAmount = totalFees * (feeRebatePercent / 100);
      
      // 查询持仓数量
      try {
        const positions = await exchangeClient.getPositions();
        const openPositions = positions.filter((p: any) => Math.abs(Number.parseFloat(p.size || "0")) > 0);
        
        return c.json({
          totalBalance,
          equity,  // 净资产（含未实现盈亏）
          availableBalance,
          positionMargin,
          availableMargin,
          marginRatio: Math.round(marginRatio * 100) / 100,
          unrealisedPnl,
          returnPercent: Math.round(returnPercent * 100) / 100,
          initialBalance,
          positionCount: openPositions.length,
          totalFees,
          feeRebatePercent,
          rebateAmount,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // 获取持仓失败不影响账户数据返回
        return c.json({
          totalBalance,
          equity,
          availableBalance,
          positionMargin,
          availableMargin,
          marginRatio: Math.round(marginRatio * 100) / 100,
          unrealisedPnl,
          returnPercent: Math.round(returnPercent * 100) / 100,
          initialBalance,
          positionCount: 0,
          totalFees,
          feeRebatePercent,
          rebateAmount,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取当前持仓 - 从 Gate.io 获取实时数据
   */
  app.get("/api/positions", async (c) => {
    try {
      const exchangeClient = createExchangeClient();
      const gatePositions = await exchangeClient.getPositions();
      
      // 从数据库获取止损止盈信息
      const dbResult = await dbClient.execute("SELECT symbol, stop_loss, profit_target FROM positions");
      const dbPositionsMap = new Map(
        dbResult.rows.map((row: any) => [row.symbol, row])
      );
      
      // 过滤并格式化持仓（注意：size 可能是小数如 0.09，必须用 parseFloat）
      const positions = gatePositions
        .filter((p: any) => Math.abs(Number.parseFloat(p.size || "0")) > 0)
        .map((p: any) => {
          const size = Number.parseFloat(p.size || "0");
          const symbol = p.contract.replace("_USDT", "");
          const dbPos = dbPositionsMap.get(symbol);
          const entryPrice = Number.parseFloat(p.entryPrice || "0");
          const quantity = Math.abs(size);
          const leverage = Number.parseInt(p.leverage || "1");
          
          // 开仓价值（保证金）: 从Gate.io API直接获取
          const openValue = Number.parseFloat(p.margin || "0");
          
          return {
            symbol,
            quantity,
            entryPrice,
            currentPrice: Number.parseFloat(p.markPrice || "0"),
            liquidationPrice: Number.parseFloat(p.liqPrice || "0"),
            unrealizedPnl: Number.parseFloat(p.unrealisedPnl || "0"),
            leverage,
            side: size > 0 ? "long" : "short",
            openValue,
            profitTarget: dbPos?.profit_target ? Number(dbPos.profit_target) : null,
            stopLoss: dbPos?.stop_loss !== null && dbPos?.stop_loss !== undefined ? Number(dbPos.stop_loss) : null,
            stopLossMode: dbPos?.stop_loss !== null && dbPos?.stop_loss !== undefined ? "pnl_percent" : null,
            openedAt: p.create_time || new Date().toISOString(),
          };
        });
      
      return c.json({ positions });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取账户价值历史（用于绘图）
   */
  app.get("/api/history", async (c) => {
    try {
      const limitParam = c.req.query("limit");
      
      let result;
      if (limitParam) {
        // 如果传递了 limit 参数，使用 LIMIT 子句
        const limit = Number.parseInt(limitParam);
        result = await dbClient.execute({
          sql: `SELECT timestamp, total_value, unrealized_pnl, return_percent 
                FROM account_history 
                ORDER BY timestamp DESC 
                LIMIT ?`,
          args: [limit],
        });
      } else {
        // 如果没有传递 limit 参数，返回全部数据
        result = await dbClient.execute(
          `SELECT timestamp, total_value, unrealized_pnl, return_percent 
           FROM account_history 
           ORDER BY timestamp DESC`
        );
      }
      
      const history = result.rows.map((row: any) => ({
        timestamp: row.timestamp,
        totalValue: Number.parseFloat(row.total_value as string) || 0,
        unrealizedPnl: Number.parseFloat(row.unrealized_pnl as string) || 0,
        returnPercent: Number.parseFloat(row.return_percent as string) || 0,
      })).reverse(); // 反转，使时间从旧到新
      
      return c.json({ history });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取交易记录 - 从数据库获取历史仓位（已平仓的记录）
   */
  app.get("/api/trades", async (c) => {
    try {
      const exchangeClient = createExchangeClient();
      const limit = Number.parseInt(c.req.query("limit") || "10");
      const symbol = c.req.query("symbol"); // 可选，筛选特定币种
      
      // 从数据库获取历史交易记录（按 ID 降序，确保最新的在前）
      let sql = `SELECT * FROM trades ORDER BY id DESC LIMIT ?`;
      let args: any[] = [limit];
      
      if (symbol) {
        sql = `SELECT * FROM trades WHERE symbol = ? ORDER BY id DESC LIMIT ?`;
        args = [symbol, limit];
      }
      
      logger.info(`查询交易记录: limit=${limit}, symbol=${symbol || 'all'}`);
      
      const result = await dbClient.execute({
        sql,
        args,
      });
      
      logger.info(`查询到 ${result.rows.length} 条交易记录`);
      
      if (!result.rows || result.rows.length === 0) {
        // 数据库无记录时，从交易所获取订单历史
        try {
          const exchangeOrders = await exchangeClient.getOrderHistory(undefined, 20);
          const trades = exchangeOrders.map((order: any) => {
            const symbol = order.contract?.replace("_USDT", "") || "BTC";
            const size = Math.abs(Number.parseFloat(order.size || "0"));
            const side = Number.parseFloat(order.size || "0") >= 0 ? "long" : "short";
            const fillPrice = Number.parseFloat(order.fill_price || order.price || "0");
            const createTime = order.create_time ? new Date(order.create_time * 1000).toISOString() : "";
            
            return {
              id: order.id,
              orderId: order.id,
              symbol,
              side,
              type: "open",
              price: Number.parseFloat(order.price || "0"),
              fillPrice,
              quantity: size,
              leverage: 1,
              pnl: null,
              fee: 0,
              timestamp: createTime,
              status: order.status || "filled",
            };
          });
          
          return c.json({ trades, fromExchange: true });
        } catch (exchangeError: any) {
          logger.warn("从交易所获取订单历史失败:", exchangeError);
          return c.json({ trades: [] });
        }
      }
      
      // 转换数据库格式到前端需要的格式
      const trades = result.rows.map((row: any) => {
        return {
          id: row.id,
          orderId: row.order_id,
          symbol: row.symbol,
          side: row.side, // long/short
          type: row.type, // open/close
          price: Number.parseFloat(row.price || "0"),
          quantity: Number.parseFloat(row.quantity || "0"),
          leverage: Number.parseInt(row.leverage || "1"),
          pnl: row.pnl ? Number.parseFloat(row.pnl) : null,
          fee: Number.parseFloat(row.fee || "0"),
          timestamp: row.timestamp,
          status: row.status,
        };
      });
      
      return c.json({ trades });
    } catch (error: any) {
      logger.error("获取历史仓位失败:", error);
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取 Agent 决策日志
   */
  app.get("/api/logs", async (c) => {
    try {
      const limit = c.req.query("limit") || "20";
      
      const result = await dbClient.execute({
        sql: `SELECT * FROM agent_decisions 
              ORDER BY timestamp DESC 
              LIMIT ?`,
        args: [Number.parseInt(limit)],
      });
      
      const logs = result.rows.map((row: any) => ({
        id: row.id,
        timestamp: row.timestamp,
        iteration: row.iteration,
        decision: row.decision,
        structuredDecision: row.structured_decision ? JSON.parse(row.structured_decision) : null,
        actionsTaken: row.actions_taken,
        accountValue: row.account_value,
        positionsCount: row.positions_count,
      }));
      
      return c.json({ logs });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取交易统计
   */
  app.get("/api/stats", async (c) => {
    try {
      // 统计总交易次数 - 使用 pnl IS NOT NULL 来确保这是已完成的平仓交易
      const totalTradesResult = await dbClient.execute(
        "SELECT COUNT(*) as count FROM trades WHERE type = 'close' AND pnl IS NOT NULL"
      );
      const totalTrades = (totalTradesResult.rows[0] as any).count;
      
      // 统计盈利交易
      const winTradesResult = await dbClient.execute(
        "SELECT COUNT(*) as count FROM trades WHERE type = 'close' AND pnl IS NOT NULL AND pnl > 0"
      );
      const winTrades = (winTradesResult.rows[0] as any).count;
      
      // 计算胜率
      const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;
      
      // 计算总盈亏
      const pnlResult = await dbClient.execute(
        "SELECT SUM(pnl) as total_pnl FROM trades WHERE type = 'close' AND pnl IS NOT NULL"
      );
      const totalPnl = (pnlResult.rows[0] as any).total_pnl || 0;
      
      // 获取最大单笔盈利和亏损
      const maxWinResult = await dbClient.execute(
        "SELECT MAX(pnl) as max_win FROM trades WHERE type = 'close' AND pnl IS NOT NULL"
      );
      const maxWin = (maxWinResult.rows[0] as any).max_win || 0;
      
      const maxLossResult = await dbClient.execute(
        "SELECT MIN(pnl) as max_loss FROM trades WHERE type = 'close' AND pnl IS NOT NULL"
      );
      const maxLoss = (maxLossResult.rows[0] as any).max_loss || 0;
      
      return c.json({
        totalTrades,
        winTrades,
        lossTrades: totalTrades - winTrades,
        winRate,
        totalPnl,
        maxWin,
        maxLoss,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取信号质量评分历史（用于信号质量面板）
   */
  app.get("/api/quality-scores", async (c) => {
    try {
      const limit = parseInt(c.req.query("limit") || "10");

      const result = await dbClient.execute({
        sql: `SELECT timestamp, symbol, price, quality_score, score_components
              FROM trading_signals
              WHERE quality_score IS NOT NULL AND quality_score > 0
              ORDER BY timestamp DESC
              LIMIT ?`,
        args: [limit],
      });

      const scores = result.rows.map((row: any) => {
        let components: Record<string, number> = {};
        try {
          components = row.score_components ? JSON.parse(row.score_components) : {};
        } catch {
          components = {};
        }
        return {
          timestamp: row.timestamp,
          symbol: row.symbol,
          price: row.price,
          total: Number(row.quality_score),
          components: {
            resonance: components.resonance || 0,
            alignment: components.alignment || 0,
            trend: components.trend || 0,
            volume: components.volume || 0,
            position: components.position || 0,
          },
        };
      });

      return c.json({ scores });
    } catch (error) {
      console.error("获取质量评分失败:", error);
      return c.json({ scores: [] });
    }
  });

  /**
   * 获取最新技术指标（实时仪表盘数据）
   */
  app.get("/api/indicators", async (c) => {
    try {
      const symbol = c.req.query("symbol") || "BTC";
      
      // 优先获取指标非零的最新记录
      let result = await dbClient.execute({
        sql: `SELECT * FROM trading_signals 
              WHERE symbol = ? AND (macd != 0 OR ema_20 != 0)
              ORDER BY timestamp DESC 
              LIMIT 1`,
        args: [symbol],
      });
      
      if (result.rows.length === 0) {
        result = await dbClient.execute({
          sql: `SELECT * FROM trading_signals 
                WHERE symbol = ? 
                ORDER BY timestamp DESC 
                LIMIT 1`,
          args: [symbol],
        });
      }
      
      if (result.rows.length === 0) {
        return c.json({ symbol, indicators: null });
      }
      
      const row = result.rows[0] as any;
      return c.json({
        symbol,
        timestamp: row.timestamp,
        indicators: {
          symbol,
          timestamp: row.timestamp,
          currentPrice: row.price,
          // LEI均线组态（EMA 20/60/120 + MA200牛熊线）
          ema20: row.ema_20,
          ema60: row.ema_60,
          ema120: row.ema_120,
          ma200: row.ma_200,
          // K线斜率（线性回归趋势过滤器）
          slope20: row.slope_20,
          // RSI & MACD
          rsi: row.rsi_14 ?? row.rsi_7,
          rsi14: row.rsi_14,
          macd: row.macd,
          // 成交量 & 量比
          volume: row.volume,
          avgVolume: row.avg_volume,
          volRatio: row.volume && row.avg_volume && row.avg_volume > 0 ? row.volume / row.avg_volume : 1.0,
        },
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取K线数据（用于前端烛台图）
   */
  app.get("/api/candles", async (c) => {
    try {
      const symbol = c.req.query("symbol") || "BTC";
      const interval = c.req.query("interval") || "1h";
      const limit = parseInt(c.req.query("limit") || "200");

      const exchangeClient = createExchangeClient();
      const contract = `${symbol}_USDT`;
      const candles = await exchangeClient.getFuturesCandles(contract, interval, limit);

      // 转换为前端格式
      const result = candles.map((candle: any) => {
        if (candle && typeof candle === "object" && "t" in candle) {
          // OKX FuturesCandlestick 对象格式 (t 已是秒级时间戳)
          return {
            time: Number(candle.t),
            open: Number.parseFloat(candle.o),
            high: Number.parseFloat(candle.h),
            low: Number.parseFloat(candle.l),
            close: Number.parseFloat(candle.c),
            volume: Number.parseFloat(candle.v),
          };
        }
        // 数组格式兼容
        if (Array.isArray(candle)) {
          return {
            time: Math.floor(candle[0] / 1000),
            open: Number.parseFloat(candle[1]),
            high: Number.parseFloat(candle[2]),
            low: Number.parseFloat(candle[3]),
            close: Number.parseFloat(candle[4]),
            volume: Number.parseFloat(candle[5] || "0"),
          };
        }
        return null;
      }).filter(Boolean);

      return c.json({ symbol, interval, candles: result });
    } catch (error: any) {
      logger.error("获取K线数据失败:", error);
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取多个币种的实时价格
   */
  app.get("/api/prices", async (c) => {
    try {
      const symbolsParam = c.req.query("symbols") || "BTC,ETH,SOL,BNB,DOGE,XRP";
      const symbols = symbolsParam.split(",").map(s => s.trim());
      
      const exchangeClient = createExchangeClient();
      const prices: Record<string, number> = {};
      
      // 并发获取所有币种价格
      await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const contract = `${symbol}_USDT`;
            const ticker = await exchangeClient.getFuturesTicker(contract);
            prices[symbol] = Number.parseFloat(ticker.last || "0");
          } catch (error: any) {
            logger.error(`获取 ${symbol} 价格失败:`, error);
            prices[symbol] = 0;
          }
        })
      );
      
      return c.json({ prices });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 获取当前交易策略配置
   */
  app.get("/api/strategy", async (c) => {
    try {
      const strategy = getTradingStrategy();
      const params = getStrategyParams(strategy);
      const intervalMinutes = Number.parseInt(process.env.TRADING_INTERVAL_MINUTES || "20");
      
      // 策略名称映射
      const strategyNames: Record<string, string> = {
        "ultra-short": "超短线",
        "swing-trend": "波段趋势",
        "medium-long": "中长线",
        "conservative": "稳健",
        "balanced": "平衡",
        "aggressive": "激进",
        "aggressive-team": "激进团",
        "rebate-farming": "返佣套利",
        "ai-autonomous": "AI自主",
        "multi-agent-consensus": "陪审团策略"
      };
      
      return c.json({
        strategy,
        strategyName: strategyNames[strategy] || strategy,
        modelName: process.env.AI_MODEL_NAME || "deepseek/deepseek-v3.2-exp",
        intervalMinutes,
        maxLeverage: RISK_PARAMS.MAX_LEVERAGE,
        maxPositions: RISK_PARAMS.MAX_POSITIONS,
        leverageRange: `${params.leverageMin}-${params.leverageMax}x`,
        positionSizeRange: `${params.positionSizeMin}-${params.positionSizeMax}%`,
        enableCodeLevelProtection: params.enableCodeLevelProtection,
        allowAiOverrideProtection: params.allowAiOverrideProtection || false,
        description: params.description
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  /**
   * 手动平仓接口
   */
  app.post("/api/close-position", async (c) => {
    try {
      const body = await c.req.json();
      const { symbol } = body;

      if (!symbol) {
        return c.json({ success: false, message: "缺少必填参数: symbol" }, 400);
      }

      logger.info(`开始手动平仓: ${symbol}`);
      
      const exchangeClient = createExchangeClient();
      const contract = `${symbol}_USDT`;
      
      // 获取当前持仓
      const allPositions = await exchangeClient.getPositions();
      const gatePosition = allPositions.find((p: any) => 
        p.contract === contract && Number.parseFloat(p.size || "0") !== 0
      );
      
      if (!gatePosition) {
        return c.json({ 
          success: false, 
          message: `没有找到 ${symbol} 的持仓` 
        }, 404);
      }
      
      // 获取持仓信息
      const size = Number.parseFloat(gatePosition.size || "0");
      const side = size > 0 ? "long" : "short";
      const entryPrice = Number.parseFloat(gatePosition.entryPrice || "0");
      const currentPrice = Number.parseFloat(gatePosition.markPrice || "0");
      const leverage = Number.parseInt(gatePosition.leverage || "1");
      const quantity = Math.abs(size);
      
      // 获取合约乘数（不同币种的合约乘数不同）
      const quantoMultiplier = await getQuantoMultiplier(contract);
      logger.info(`${symbol} 合约乘数: ${quantoMultiplier}`);
      
      // 计算盈亏
      let grossPnl = 0;
      if (side === "long") {
        grossPnl = (currentPrice - entryPrice) * quantity * quantoMultiplier;
      } else {
        grossPnl = (entryPrice - currentPrice) * quantity * quantoMultiplier;
      }
      
      // 计算手续费
      const takerFee = 0.0005;
      const openFee = entryPrice * quantity * quantoMultiplier * takerFee;
      const closeFee = currentPrice * quantity * quantoMultiplier * takerFee;
      const totalFees = openFee + closeFee;
      const pnl = grossPnl - totalFees;
      
      logger.info(`手动平仓 ${symbol} ${side === "long" ? "做多" : "做空"} ${quantity}张 (入场: ${entryPrice.toFixed(2)}, 当前: ${currentPrice.toFixed(2)}, 盈亏: ${pnl.toFixed(2)})`);
      
      // 执行平仓
      const closeSize = side === "long" ? -quantity : quantity;
      const order = await exchangeClient.placeOrder({
        contract,
        size: closeSize,
        price: 0,  // 市价单
        reduceOnly: true,
      });
      
      logger.info(`已下达手动平仓订单 ${symbol}，订单ID: ${order.id}`);
      
      // 等待订单完成
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 获取实际成交信息
      let actualExitPrice = currentPrice;
      let orderStatus = "filled";
      
      if (order.id) {
        try {
          const orderInfo = await exchangeClient.getOrder(order.id);
          if (orderInfo.status === "finished") {
            actualExitPrice = Number.parseFloat(orderInfo.fillPrice || orderInfo.price || currentPrice.toString());
            orderStatus = "filled";
          }
        } catch (error: any) {
          logger.warn(`获取订单信息失败: ${error.message}`);
        }
      }
      
      // 重新计算实际盈亏（使用实际成交价格）
      if (side === "long") {
        grossPnl = (actualExitPrice - entryPrice) * quantity * quantoMultiplier;
      } else {
        grossPnl = (entryPrice - actualExitPrice) * quantity * quantoMultiplier;
      }
      const actualCloseFee = actualExitPrice * quantity * quantoMultiplier * takerFee;
      const actualPnl = grossPnl - openFee - actualCloseFee;
      
      // 记录到交易历史
      try {
        logger.info(`准备记录平仓交易到数据库: ${symbol}, 订单ID: ${order.id || `manual_${Date.now()}`}`);
        
        const insertResult = await dbClient.execute({
          sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, pnl, fee, timestamp, status)
                VALUES (?, ?, ?, 'close', ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            order.id || `manual_${Date.now()}`,
            symbol,
            side,
            actualExitPrice,
            quantity,
            leverage,
            actualPnl,
            openFee + actualCloseFee,
            getChinaTimeISO(),
            orderStatus,
          ],
        });
        
        logger.info(`✓ 交易历史记录成功，记录ID: ${insertResult.lastInsertRowid}`);
      } catch (dbError: any) {
        logger.error(`✗ 记录交易历史失败: ${dbError.message}`, dbError);
        throw dbError; // 抛出错误以便外层 catch 捕获
      }
      
      // 从数据库删除持仓记录
      try {
        const deleteResult = await dbClient.execute({
          sql: "DELETE FROM positions WHERE symbol = ?",
          args: [symbol],
        });
        logger.info(`✓ 已删除持仓记录: ${symbol}, 影响行数: ${deleteResult.rowsAffected}`);
      } catch (dbError: any) {
        logger.error(`✗ 删除持仓记录失败: ${dbError.message}`, dbError);
        // 这里不抛出错误，因为交易已经完成
      }
      
      logger.info(`手动平仓完成 ${symbol}, 盈亏: ${actualPnl.toFixed(2)} USDT`);
      
      return c.json({
        success: true,
        message: `成功平仓 ${symbol}`,
        data: {
          symbol,
          side,
          quantity,
          entryPrice,
          exitPrice: actualExitPrice,
          pnl: actualPnl,
          fee: openFee + actualCloseFee,
        },
      });
    } catch (error: any) {
      logger.error("手动平仓失败:", error);
      return c.json({ 
        success: false, 
        message: `平仓失败: ${error.message}` 
      }, 500);
    }
  });

  /**
   * 获取市场情绪数据（Fear & Greed 指数 + 实时新闻情绪聚合）
   */
  app.get("/api/sentiment", async (c) => {
    try {
      const symbols = RISK_PARAMS.TRADING_SYMBOLS || ["BTC", "ETH", "SOL"];

      // 并行获取 F&G 指数和各币种新闻情绪
      const [fgResult, ...newsResults] = await Promise.allSettled([
        // Fear & Greed Index
        fetch("https://api.alternative.me/fng/?limit=1").then(r => r.json()),
        // 各币种新闻情绪
        ...symbols.map(async (symbol) => {
          const news = await fetchCryptoNews(symbol, 10);
          const sentiment = news.length > 0 ? aggregateSentiment(news) : null;
          return { symbol, sentiment, total: news.length };
        }),
      ]);

      const response: any = {
        fearGreed: null,
        newsSentiment: [],
        timestamp: new Date().toISOString(),
      };

      // 解析 F&G 指数
      if (fgResult.status === "fulfilled") {
        const data = fgResult.value;
        if (data.data && data.data.length > 0) {
          const fg = data.data[0];
          response.fearGreed = {
            value: parseInt(fg.value),
            classification: fg.value_classification,
            timestamp: fg.timestamp,
          };
        }
      }

      // 解析新闻情绪
      for (const result of newsResults) {
        if (result.status === "fulfilled") {
          response.newsSentiment.push(result.value);
        }
      }

      return c.json(response);
    } catch (error: any) {
      logger.error("获取情绪数据失败:", error);
      return c.json({ error: error.message }, 500);
    }
  });

  return app;
}
