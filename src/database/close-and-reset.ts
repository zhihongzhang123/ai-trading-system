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
 * 平仓并重置数据库脚本
 * 用于在运行时快速重置系统状态
 */
import { createClient } from "@libsql/client";
import { createLogger } from "../utils/loggerUtils";
import { createExchangeClient, getExchangeType } from "../services/exchangeClient";
import "dotenv/config";

const logger = createLogger({
  name: "close-and-reset",
  level: "info",
});

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS account_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    total_value REAL NOT NULL,
    available_cash REAL NOT NULL,
    unrealized_pnl REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    return_percent REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    quantity REAL NOT NULL,
    entry_price REAL NOT NULL,
    current_price REAL NOT NULL,
    liquidation_price REAL NOT NULL,
    unrealized_pnl REAL NOT NULL,
    leverage INTEGER NOT NULL,
    side TEXT NOT NULL,
    profit_target REAL,
    stop_loss REAL,
    tp_order_id TEXT,
    sl_order_id TEXT,
    entry_order_id TEXT,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    confidence REAL,
    risk_usd REAL,
    peak_pnl_percent REAL DEFAULT 0,
    partial_close_percentage REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trading_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    price REAL NOT NULL,
    ema_20 REAL,
    ema_50 REAL,
    macd REAL,
    rsi_7 REAL,
    rsi_14 REAL,
    volume REAL,
    funding_rate REAL
);

CREATE TABLE IF NOT EXISTS agent_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    market_analysis TEXT NOT NULL,
    decision TEXT NOT NULL,
    actions_taken TEXT NOT NULL,
    account_value REAL NOT NULL,
    positions_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL,
    order_id TEXT,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    amount REAL NOT NULL,
    leverage INTEGER,
    pnl REAL,
    fee REAL,
    status TEXT NOT NULL
);
`;

/**
 * 平仓所有持仓
 */
async function closeAllPositions(): Promise<void> {
  const exchangeClient = createExchangeClient();
  
  try {
    logger.info("📊 获取当前持仓...");
    
    const positions = await exchangeClient.getPositions();
    const activePositions = positions.filter((p: any) => Number.parseFloat(p.size || "0") !== 0);
    
    if (activePositions.length === 0) {
      logger.info("✅ 当前无持仓，跳过平仓");
      return;
    }
    
    logger.warn(`⚠️  发现 ${activePositions.length} 个持仓，开始平仓...`);
    
    for (const pos of activePositions) {
      const size = Number.parseFloat(pos.size || "0");
      const contract = pos.contract;
      const symbol = contract.replace("_USDT", "");
      const side = size > 0 ? "多头" : "空头";
      const quantity = Math.abs(size);
      
      try {
        logger.info(`🔄 平仓中: ${symbol} ${side} ${quantity}张`);
        
        await exchangeClient.placeOrder({
          contract,
          size: -size, // 反向平仓
          price: 0, // 市价单
          reduceOnly: true, // 只减仓，不开新仓
        });
        
        logger.info(`✅ 已平仓: ${symbol} ${side} ${quantity}张`);
      } catch (error: any) {
        logger.error(`❌ 平仓失败: ${symbol} - ${error.message}`);
      }
    }
    
    logger.info("✅ 所有持仓平仓完成");
  } catch (error: any) {
    logger.error(`❌ 平仓过程出错: ${error.message}`);
    throw error;
  }
}

/**
 * 重置数据库
 */
async function resetDatabase(): Promise<void> {
  try {
    const dbUrl = process.env.DATABASE_URL || "file:./.voltagent/trading.db";
    const initialBalance = Number.parseFloat(process.env.INITIAL_BALANCE || "1000");

    logger.info("🗄️  开始重置数据库...");
    logger.info(`数据库路径: ${dbUrl}`);
    logger.info(`初始资金: ${initialBalance} USDT`);

    const client = createClient({
      url: dbUrl,
    });

    // 删除所有表
    logger.info("🗑️  删除现有表...");
    await client.execute("DROP TABLE IF EXISTS trade_logs");
    await client.execute("DROP TABLE IF EXISTS agent_decisions");
    await client.execute("DROP TABLE IF EXISTS trading_signals");
    await client.execute("DROP TABLE IF EXISTS positions");
    await client.execute("DROP TABLE IF EXISTS account_history");
    logger.info("✅ 现有表已删除");

    // 重新创建表
    logger.info("📦 创建新表...");
    await client.executeMultiple(CREATE_TABLES_SQL);
    logger.info("✅ 表创建完成");

    // 插入初始资金记录
    logger.info(`💰 插入初始资金记录: ${initialBalance} USDT`);
    await client.execute({
      sql: `INSERT INTO account_history 
            (timestamp, total_value, available_cash, unrealized_pnl, realized_pnl, return_percent) 
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        new Date().toISOString(),
        initialBalance,
        initialBalance,
        0,
        0,
        0,
      ],
    });

    // 验证初始化结果
    const latestAccount = await client.execute(
      "SELECT * FROM account_history ORDER BY timestamp DESC LIMIT 1"
    );

    if (latestAccount.rows.length > 0) {
      const account = latestAccount.rows[0] as any;
      logger.info("\n" + "=".repeat(60));
      logger.info("✅ 数据库重置成功！");
      logger.info("=".repeat(60));
      logger.info("\n📊 初始账户状态:");
      logger.info(`  总资产: ${account.total_value} USDT`);
      logger.info(`  可用资金: ${account.available_cash} USDT`);
      logger.info(`  未实现盈亏: ${account.unrealized_pnl} USDT`);
      logger.info(`  已实现盈亏: ${account.realized_pnl} USDT`);
      logger.info(`  总收益率: ${account.return_percent}%`);
      logger.info("\n当前无持仓");
      logger.info("\n" + "=".repeat(60));
    }

    client.close();
    
  } catch (error) {
    logger.error("❌ 数据库重置失败:", error as any);
    throw error;
  }
}

/**
 * 同步持仓数据
 */
async function syncPositions(): Promise<void> {
  const exchangeClient = createExchangeClient();
  const dbUrl = process.env.DATABASE_URL || "file:./.voltagent/trading.db";
  
  try {
    const exchangeType = getExchangeType();
    const exchangeName = exchangeType === "okx" ? "OKX" : "Gate.io";
    logger.info(`🔄 从 ${exchangeName} 同步持仓...`);
    
    const client = createClient({
      url: dbUrl,
    });
    
    // 从交易所获取持仓
    const positions = await exchangeClient.getPositions();
    const activePositions = positions.filter((p: any) => Number.parseFloat(p.size || "0") !== 0);
    
    logger.info(`📊 ${exchangeName} 当前持仓数: ${activePositions.length}`);
    
    // 清空本地持仓表
    await client.execute("DELETE FROM positions");
    logger.info("✅ 已清空本地持仓表");
    
    // 同步持仓到数据库
    if (activePositions.length > 0) {
      logger.info(`🔄 同步 ${activePositions.length} 个持仓到数据库...`);
      
      for (const pos of activePositions) {
        const size = Number.parseFloat(pos.size || "0");
        if (size === 0) continue;
        
        const symbol = pos.contract.replace("_USDT", "");
        const entryPrice = Number.parseFloat(pos.entryPrice || "0");
        const currentPrice = Number.parseFloat(pos.markPrice || "0");
        const leverage = Number.parseInt(pos.leverage || "1");
        const side = size > 0 ? "long" : "short";
        const quantity = Math.abs(size);
        const pnl = Number.parseFloat(pos.unrealisedPnl || "0");
        const liqPrice = Number.parseFloat(pos.liqPrice || "0");
        
        await client.execute({
          sql: `INSERT INTO positions 
                (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
                 leverage, side, entry_order_id, opened_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            symbol,
            quantity,
            entryPrice,
            currentPrice,
            liqPrice,
            pnl,
            leverage,
            side,
            "synced",
            new Date().toISOString(),
          ],
        });
        
        logger.info(`   ✅ ${symbol}: ${quantity} 张 (${side}) @ ${entryPrice} | 盈亏: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
      }
    } else {
      logger.info("✅ 当前无持仓");
    }
    
    client.close();
    logger.info("✅ 持仓同步完成");
    
  } catch (error: any) {
    logger.error(`❌ 持仓同步失败: ${error.message}`);
    throw error;
  }
}

/**
 * 主执行函数
 */
async function closeAndReset() {
  logger.info("=".repeat(80));
  logger.info("🔄 开始执行平仓并重置数据库");
  logger.info("=".repeat(80));
  logger.info("");
  
  try {
    // 步骤1：平仓所有持仓
    logger.info("【步骤 1/3】平仓所有持仓");
    logger.info("-".repeat(80));
    await closeAllPositions();
    logger.info("");
    
    // 等待2秒确保平仓完成
    logger.info("⏱️  等待2秒确保平仓完成...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    logger.info("");
    
    // 步骤2：重置数据库
    logger.info("【步骤 2/3】重置数据库");
    logger.info("-".repeat(80));
    await resetDatabase();
    logger.info("");
    
    // 步骤3：同步持仓数据
    const exchangeType = getExchangeType();
    const exchangeName = exchangeType === "okx" ? "OKX" : "Gate.io";
    logger.info(`【步骤 3/3】从 ${exchangeName} 同步持仓数据`);
    logger.info("-".repeat(80));
    await syncPositions();
    logger.info("");
    
    logger.info("=".repeat(80));
    logger.info("🎉 平仓并重置完成！系统已恢复到初始状态");
    logger.info("=".repeat(80));
    logger.info("");
    logger.info("💡 提示：可以重新启动交易系统开始新的交易");
    
  } catch (error) {
    logger.error("=".repeat(80));
    logger.error("❌ 执行失败:", error as any);
    logger.error("=".repeat(80));
    process.exit(1);
  }
}

// 执行主函数
closeAndReset();

