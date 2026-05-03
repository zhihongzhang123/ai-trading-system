/**
 * ai-trading-system - 高级风控模块
 * Copyright (C) 2025 zhihongzhang123
 *
 * 多层级风控：日亏损限制、连续亏损冷却、动态仓位计算、紧急停止
 */
import { createClient } from "@libsql/client";
import { createLogger } from "../utils/loggerUtils";
import { formatChinaTime } from "../utils/timeUtils";

const logger = createLogger({ name: "risk-manager", level: "info" });

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

/**
 * 风控配置
 */
export interface RiskGuardConfig {
  // 日亏损限制（百分比，超过则停止交易）
  dailyLossLimitPercent: number;
  // 连续亏损次数限制（超过则进入冷却期）
  maxConsecutiveLosses: number;
  // 冷却期时长（分钟）
  cooldownMinutes: number;
  // 账户恢复目标（当前余额的倍数，达到后恢复正常策略）
  recoveryTargetMultiple: number;
  // 恢复期最大仓位百分比
  recoveryMaxPositionPercent: number;
  // 恢复期最大杠杆
  recoveryMaxLeverage: number;
  // 紧急停止开关（手动设置）
  emergencyStop: boolean;
  // 账户最低余额（低于此值完全停止）
  minAccountBalance: number;
  // 最大单周期亏损（USDT，单次AI决策允许的最大亏损）
  maxLossPerCycle: number;
}

export function getDefaultRiskConfig(): RiskGuardConfig {
  return {
    dailyLossLimitPercent: parseFloat(process.env.DAILY_LOSS_LIMIT_PERCENT || "5"),
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || "3"),
    cooldownMinutes: parseInt(process.env.COOLDOWN_MINUTES || "60"),
    recoveryTargetMultiple: parseFloat(process.env.RECOVERY_TARGET_MULTIPLE || "2.0"),
    recoveryMaxPositionPercent: parseFloat(process.env.RECOVERY_MAX_POSITION_PERCENT || "10"),
    recoveryMaxLeverage: parseInt(process.env.RECOVERY_MAX_LEVERAGE || "2"),
    emergencyStop: process.env.EMERGENCY_STOP === "true",
    minAccountBalance: parseFloat(process.env.MIN_ACCOUNT_BALANCE || "50"),
    maxLossPerCycle: parseFloat(process.env.MAX_LOSS_PER_CYCLE || "3"),
  };
}

/**
 * 风控状态
 */
export interface RiskGuardState {
  isRecoveryMode: boolean;
  isInCooldown: boolean;
  cooldownEndsAt: Date | null;
  dailyPnL: number;
  dailyPnLPercent: number;
  consecutiveLosses: number;
  canTrade: boolean;
  blockedReason: string | null;
  todayStartBalance: number;
}

/**
 * 获取今日盈亏
 */
async function getTodayPnL(): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  const result = await dbClient.execute({
    sql: `SELECT COALESCE(SUM(COALESCE(pnl, 0)), 0) as total_pnl
          FROM trades
          WHERE type = 'close'
          AND timestamp >= ?`,
    args: [todayISO],
  });

  return (result.rows[0]?.total_pnl as number) ?? 0;
}

/**
 * 获取连续亏损次数
 */
async function getConsecutiveLosses(): Promise<number> {
  const result = await dbClient.execute({
    sql: `SELECT pnl, timestamp FROM trades
          WHERE type = 'close'
          ORDER BY timestamp DESC
          LIMIT 20`,
    args: [],
  });

  let count = 0;
  for (const row of result.rows) {
    const pnl = row.pnl as number;
    if (pnl < 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * 获取今日开始时的账户余额
 */
async function getTodayStartBalance(currentBalance: number): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  const result = await dbClient.execute({
    sql: `SELECT total_value FROM account_history
          WHERE timestamp < ?
          ORDER BY timestamp DESC
          LIMIT 1`,
    args: [todayISO],
  });

  return (result.rows[0]?.total_value as number) ?? currentBalance;
}

/**
 * 检查冷却期是否还在生效
 */
async function checkCooldown(cooldownMinutes: number): Promise<{ isInCooldown: boolean; endsAt: Date | null }> {
  const result = await dbClient.execute({
    sql: `SELECT timestamp FROM trades
          WHERE type = 'close' AND pnl < 0
          ORDER BY timestamp DESC
          LIMIT 1`,
    args: [],
  });

  if (result.rows.length === 0) {
    return { isInCooldown: false, endsAt: null };
  }

  const lastLossTime = new Date(result.rows[0].timestamp as string);
  const cooldownEnd = new Date(lastLossTime.getTime() + cooldownMinutes * 60 * 1000);

  if (new Date() < cooldownEnd) {
    return { isInCooldown: true, endsAt: cooldownEnd };
  }

  return { isInCooldown: false, endsAt: null };
}

/**
 * 主要风控检查函数
 */
export async function checkRiskGuard(currentBalance: number, config?: RiskGuardConfig): Promise<RiskGuardState> {
  const cfg = config ?? getDefaultRiskConfig();

  // 1. 紧急停止检查
  if (cfg.emergencyStop) {
    return {
      isRecoveryMode: false,
      isInCooldown: true,
      cooldownEndsAt: null,
      dailyPnL: 0,
      dailyPnLPercent: 0,
      consecutiveLosses: 0,
      canTrade: false,
      blockedReason: "紧急停止已启用（EMERGENCY_STOP=true）",
      todayStartBalance: currentBalance,
    };
  }

  // 2. 最低余额检查
  if (currentBalance < cfg.minAccountBalance) {
    return {
      isRecoveryMode: true,
      isInCooldown: true,
      cooldownEndsAt: null,
      dailyPnL: 0,
      dailyPnLPercent: 0,
      consecutiveLosses: 0,
      canTrade: false,
      blockedReason: `账户余额 ${currentBalance.toFixed(2)} USDT 低于最低限额 ${cfg.minAccountBalance} USDT`,
      todayStartBalance: currentBalance,
    };
  }

  const todayPnL = await getTodayPnL();
  const todayStartBalance = await getTodayStartBalance(currentBalance);
  const dailyPnLPercent = todayStartBalance > 0 ? (todayPnL / todayStartBalance) * 100 : 0;
  const consecutiveLosses = await getConsecutiveLosses();

  // 3. 日亏损限制检查
  if (dailyPnLPercent <= -cfg.dailyLossLimitPercent) {
    return {
      isRecoveryMode: false,
      isInCooldown: true,
      cooldownEndsAt: null,
      dailyPnL: todayPnL,
      dailyPnLPercent,
      consecutiveLosses,
      canTrade: false,
      blockedReason: `今日亏损 ${dailyPnLPercent.toFixed(2)}% 已达限制 ${cfg.dailyLossLimitPercent}%，今日停止交易`,
      todayStartBalance,
    };
  }

  // 4. 连续亏损冷却检查
  if (consecutiveLosses >= cfg.maxConsecutiveLosses) {
    const { isInCooldown, endsAt } = await checkCooldown(cfg.cooldownMinutes);
    if (isInCooldown) {
      return {
        isRecoveryMode: false,
        isInCooldown: true,
        cooldownEndsAt: endsAt,
        dailyPnL: todayPnL,
        dailyPnLPercent,
        consecutiveLosses,
        canTrade: false,
        blockedReason: `连续 ${consecutiveLosses} 次亏损，进入 ${cfg.cooldownMinutes} 分钟冷却期，结束于 ${endsAt?.toLocaleString("zh-CN")}`,
        todayStartBalance,
      };
    }
  }

  // 5. 判断是否处于恢复模式
  const isRecoveryMode = currentBalance < 100 || consecutiveLosses >= 2;

  return {
    isRecoveryMode,
    isInCooldown: false,
    cooldownEndsAt: null,
    dailyPnL: todayPnL,
    dailyPnLPercent,
    consecutiveLosses,
    canTrade: true,
    blockedReason: null,
    todayStartBalance,
  };
}

/**
 * 计算安全仓位大小（基于风控状态动态调整）
 */
export function calculateSafePositionSize(
  balance: number,
  riskState: RiskGuardState,
  config?: RiskGuardConfig,
): number {
  const cfg = config ?? getDefaultRiskConfig();

  if (riskState.isRecoveryMode) {
    // 恢复模式：严格限制仓位
    return Math.min(
      balance * (cfg.recoveryMaxPositionPercent / 100),
      balance * 0.1, // 最多 10%
    );
  }

  // 正常模式：根据连续亏损次数动态调整
  const basePercent = 15; // 基础仓位 15%
  const reductionPerLoss = 3; // 每次亏损减少 3%
  const effectivePercent = Math.max(5, basePercent - riskState.consecutiveLosses * reductionPerLoss);

  return balance * (effectivePercent / 100);
}

/**
 * 计算安全杠杆（基于风控状态动态调整）
 */
export function calculateSafeLeverage(
  maxLeverage: number,
  riskState: RiskGuardState,
  config?: RiskGuardConfig,
): number {
  const cfg = config ?? getDefaultRiskConfig();

  if (riskState.isRecoveryMode) {
    return Math.min(cfg.recoveryMaxLeverage, maxLeverage);
  }

  // 根据连续亏损次数降低杠杆
  const reductionPerLoss = 0.2; // 每次亏损减少 20% 杠杆
  const effectiveLeverage = maxLeverage * (1 - riskState.consecutiveLosses * reductionPerLoss);

  return Math.max(1, Math.round(effectiveLeverage));
}

/**
 * 格式化风控状态为可读文本（注入AI提示词）
 */
export function formatRiskGuardForPrompt(riskState: RiskGuardState, config?: RiskGuardConfig): string {
  const cfg = config ?? getDefaultRiskConfig();

  let text = `【风控状态】\n`;
  text += `- 交易权限: ${riskState.canTrade ? "✅ 允许交易" : `❌ ${riskState.blockedReason}`}\n`;
  text += `- 账户模式: ${riskState.isRecoveryMode ? "🔄 恢复模式（严格风控）" : "🟢 正常模式"}\n`;
  text += `- 今日盈亏: ${riskState.dailyPnL >= 0 ? "+" : ""}${riskState.dailyPnL.toFixed(2)} USDT (${riskState.dailyPnLPercent >= 0 ? "+" : ""}${riskState.dailyPnLPercent.toFixed(2)}%)\n`;
  text += `- 连续亏损: ${riskState.consecutiveLosses} 次（限制 ${cfg.maxConsecutiveLosses} 次）\n`;
  text += `- 今日开始余额: ${riskState.todayStartBalance.toFixed(2)} USDT\n`;

  if (riskState.isRecoveryMode) {
    text += `\n⚠️ 恢复模式限制：\n`;
    text += `- 最大仓位: ${cfg.recoveryMaxPositionPercent}% 账户余额\n`;
    text += `- 最大杠杆: ${cfg.recoveryMaxLeverage}x\n`;
    text += `- 恢复目标: 余额达到当前的 ${cfg.recoveryTargetMultiple}x 后恢复正常\n`;
  }

  return text;
}

/**
 * 记录风控事件到数据库
 */
export async function logRiskEvent(event: {
  type: string;
  message: string;
  balance: number;
}): Promise<void> {
  try {
    await dbClient.execute({
      sql: `INSERT INTO agent_decisions (cycle, timestamp, strategy, action_taken, reason, account_balance)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        0,
        formatChinaTime(),
        "risk-guard",
        event.type,
        event.message,
        event.balance,
      ],
    });
  } catch (err) {
    logger.warn(`记录风控事件失败: ${err}`);
  }
}
