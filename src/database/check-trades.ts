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

import { createClient } from "@libsql/client";
import { createLogger } from "../utils/loggerUtils";
import "dotenv/config";

const logger = createLogger({
  name: "check-trades",
  level: "info",
});

async function checkTrades() {
  try {
    const dbUrl = process.env.DATABASE_URL || "file:./.voltagent/trading.db";
    const client = createClient({ url: dbUrl });
    
    logger.info("📊 查询最近5条交易记录...\n");
    
    const result = await client.execute({
      sql: `SELECT id, symbol, side, type, price, quantity, leverage, fee, timestamp 
            FROM trades 
            ORDER BY timestamp DESC 
            LIMIT 5`,
      args: [],
    });
    
    if (result.rows.length === 0) {
      logger.info("没有交易记录");
      return;
    }
    
    console.log("交易记录：");
    console.log("=".repeat(100));
    
    for (const row of result.rows) {
      const typeText = row.type === 'open' ? '开' : '平';
      const sideText = row.side === 'long' ? '多' : '空';
      const feeText = row.fee ? `${Number(row.fee).toFixed(4)}` : '0';
      
      console.log(`ID: ${row.id}`);
      console.log(`  币种: ${row.symbol}`);
      console.log(`  操作: ${typeText}${sideText} (side=${row.side}, type=${row.type})`);
      console.log(`  价格: ${Number(row.price).toFixed(4)}`);
      console.log(`  数量: ${row.quantity}`);
      console.log(`  杠杆: ${row.leverage}x`);
      console.log(`  手续费: ${feeText} USDT`);
      console.log(`  时间: ${row.timestamp}`);
      console.log("-".repeat(100));
    }
    
    process.exit(0);
  } catch (error: any) {
    logger.error(`❌ 查询失败: ${error.message}`);
    process.exit(1);
  }
}

checkTrades();

