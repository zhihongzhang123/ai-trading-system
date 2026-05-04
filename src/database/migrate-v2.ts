/**
 * 数据库迁移 v2 — 扩展 trading_signals 和 agent_decisions 表
 * 
 * trading_signals 新增字段: macd_dea, macd_histogram, adx_14, boll_upper, boll_middle, boll_lower
 * agent_decisions 新增字段: structured_decision
 * 
 * 用法: npx tsx src/database/migrate-v2.ts
 */
import { createClient } from "@libsql/client";

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

interface ColumnDef {
  table: string;
  name: string;
  type: string;
}

const MIGRATION_COLUMNS: ColumnDef[] = [
  { table: "trading_signals", name: "macd_dea", type: "REAL" },
  { table: "trading_signals", name: "macd_histogram", type: "REAL" },
  { table: "trading_signals", name: "adx_14", type: "REAL" },
  { table: "trading_signals", name: "boll_upper", type: "REAL" },
  { table: "trading_signals", name: "boll_middle", type: "REAL" },
  { table: "trading_signals", name: "boll_lower", type: "REAL" },
  { table: "agent_decisions", name: "structured_decision", type: "TEXT" },
];

async function runMigration() {
  let totalChanged = 0;
  let totalAttempted = 0;

  for (const col of MIGRATION_COLUMNS) {
    totalAttempted++;
    const result = await dbClient.execute(`PRAGMA table_info(${col.table})`);
    const existingCols = new Set(result.rows.map((r) => r.name));

    if (!existingCols.has(col.name)) {
      console.log(`[${col.table}] 添加列: ${col.name} ${col.type}`);
      await dbClient.execute(
        `ALTER TABLE ${col.table} ADD COLUMN ${col.name} ${col.type}`
      );
      totalChanged++;
    } else {
      console.log(`[${col.table}] 列已存在: ${col.name}`);
    }
  }

  console.log(`迁移完成，新增 ${totalChanged}/${totalAttempted} 列`);
}

runMigration().catch((err) => {
  console.error("迁移失败:", err);
  process.exit(1);
});
