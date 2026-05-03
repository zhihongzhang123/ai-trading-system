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
 * Account Recorder - Record account assets every 10 minutes
 * 账户资产记录器 - 每10分钟记录一次账户资产（包含未实现盈亏）
 */
import cron from "node-cron";
import { createLogger } from "../utils/loggerUtils";
import { createClient } from "@libsql/client";
import { createExchangeClient } from "../services/exchangeClient";
import { getChinaTimeISO } from "../utils/timeUtils";

const logger = createLogger({
  name: "account-recorder",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

/**
 * Record account assets including unrealized PnL
 * 记录账户资产（包含未实现盈亏）
 * @param skipLog 是否跳过日志输出（避免实时监控时日志过多）
 */
export async function recordAccountAssets(skipLog: boolean = false) {
  try {
    const exchangeClient = createExchangeClient();
    
    // Get account information from Gate.io
    const account = await exchangeClient.getFuturesAccount();
    
    // Extract account data
    // Gate.io 的 account.total 不包含未实现盈亏
    // 需要主动加上 unrealisedPnl 才是真实的总资产
    const accountTotal = Number.parseFloat(account.total || "0");
    const availableBalance = Number.parseFloat(account.available || "0");
    const unrealisedPnl = Number.parseFloat(account.unrealisedPnl || "0");
    
    // Total balance = account.total + unrealisedPnl (包含未实现盈亏的总资产)
    const totalBalance = accountTotal + unrealisedPnl;
    
    // Get initial balance from database
    const initialResult = await dbClient.execute(
      "SELECT total_value FROM account_history ORDER BY timestamp ASC LIMIT 1"
    );
    const initialBalance = initialResult.rows[0]
      ? Number.parseFloat(initialResult.rows[0].total_value as string)
      : totalBalance; // Use current balance as initial if no history exists
    
    // Calculate realized PnL and return percentage
    const realizedPnl = totalBalance - initialBalance;
    const returnPercent = initialBalance > 0 
      ? (realizedPnl / initialBalance) * 100 
      : 0;
    
    // Save to database
    await dbClient.execute({
      sql: `INSERT INTO account_history 
            (timestamp, total_value, available_cash, unrealized_pnl, realized_pnl, return_percent)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        getChinaTimeISO(),
        totalBalance,
        availableBalance,
        unrealisedPnl,
        realizedPnl,
        returnPercent,
      ],
    });
    
    if (!skipLog) {
      logger.info(
        `📊 Account recorded: Total=${totalBalance.toFixed(2)} USDT, ` +
        `Available=${availableBalance.toFixed(2)} USDT, ` +
        `Unrealized PnL=${unrealisedPnl >= 0 ? '+' : ''}${unrealisedPnl.toFixed(2)} USDT, ` +
        `Return=${returnPercent >= 0 ? '+' : ''}${returnPercent.toFixed(2)}%`
      );
    }
    
    return { totalBalance, availableBalance, unrealisedPnl, returnPercent };
  } catch (error) {
    logger.error("Failed to record account assets:", error as any);
    return null;
  }
}

/**
 * Start account recorder
 * 启动账户资产记录器
 */
export function startAccountRecorder() {
  const intervalMinutes = Number.parseInt(
    process.env.ACCOUNT_RECORD_INTERVAL_MINUTES || "10"
  );
  
  logger.info(`Starting account recorder, interval: ${intervalMinutes} minutes`);
  
  // Execute immediately on startup
  recordAccountAssets();
  
  // Schedule periodic recording
  const cronExpression = `*/${intervalMinutes} * * * *`;
  cron.schedule(cronExpression, () => {
    recordAccountAssets();
  });
  
  logger.info(`Account recorder scheduled: ${cronExpression}`);
}

