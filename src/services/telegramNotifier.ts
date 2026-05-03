/**
 * ai-trading-system - Telegram 告警通知服务
 * Copyright (C) 2025 zhihongzhang123
 * 
 * 功能：
 * - 关键事件实时推送（止损、止盈、熔断、异常）
 * - 每日交易摘要
 * - 系统状态心跳
 * 
 * 配置：
 * - TELEGRAM_BOT_TOKEN: Telegram Bot Token
 * - TELEGRAM_CHAT_ID: 接收消息的 Chat ID
 * - TELEGRAM_ENABLED: 是否启用（true/false）
 */

import { createLogger } from "../utils/loggerUtils";

const logger = createLogger({
  name: "telegram-notifier",
  level: "info",
});

interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

interface NotificationPayload {
  type: "alert" | "info" | "warning" | "error" | "summary";
  title: string;
  message: string;
  data?: Record<string, any>;
}

// 从环境变量读取配置
function getConfig(): TelegramConfig {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
    enabled: process.env.TELEGRAM_ENABLED === "true",
  };
}

/**
 * 发送 Telegram 消息
 */
async function sendTelegramMessage(
  text: string,
  parseMode: "Markdown" | "HTML" = "Markdown"
): Promise<boolean> {
  const config = getConfig();
  if (!config.enabled || !config.botToken || !config.chatId) {
    return false;
  }

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000), // 10 秒超时
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      logger.warn(`Telegram 发送失败: ${response.status} ${errorBody}`);
      return false;
    }

    return true;
  } catch (error) {
    logger.warn("Telegram 发送异常:", error);
    return false;
  }
}

/**
 * 格式化告警消息
 */
function formatAlert(payload: NotificationPayload): string {
  const emojiMap: Record<string, string> = {
    alert: "🚨",
    info: "ℹ️",
    warning: "⚠️",
    error: "❌",
    summary: "📊",
  };

  const emoji = emojiMap[payload.type] || "📢";
  const timestamp = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });

  let message = `${emoji} *${payload.title}*\n`;
  message += `时间: ${timestamp}\n`;
  message += `━━━━━━━━━━━━━━━\n`;
  message += `${payload.message}\n`;

  if (payload.data && Object.keys(payload.data).length > 0) {
    message += `\n📋 详细数据:\n`;
    for (const [key, value] of Object.entries(payload.data)) {
      const formattedValue =
        typeof value === "number"
          ? value.toFixed(value % 1 === 0 ? 0 : 2)
          : String(value);
      message += `• ${key}: ${formattedValue}\n`;
    }
  }

  message += `━━━━━━━━━━━━━━━\n`;
  message += `_AI Trading System v1.0_`;

  return message;
}

/**
 * 发送通知
 */
export async function sendNotification(
  payload: NotificationPayload
): Promise<boolean> {
  try {
    const text = formatAlert(payload);
    return await sendTelegramMessage(text);
  } catch (error) {
    logger.warn("发送通知失败:", error);
    return false;
  }
}

/**
 * 快捷方法：发送止损告警
 */
export async function notifyStopLoss(
  symbol: string,
  pnl: number,
  reason: string
): Promise<boolean> {
  return sendNotification({
    type: "alert",
    title: "止损触发",
    message: `${symbol} 止损平仓`,
    data: {
      币种: symbol,
      盈亏: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`,
      原因: reason,
    },
  });
}

/**
 * 快捷方法：发送止盈告警
 */
export async function notifyTakeProfit(
  symbol: string,
  pnl: number,
  percent: number
): Promise<boolean> {
  return sendNotification({
    type: "info",
    title: "止盈触发",
    message: `${symbol} 止盈平仓 🎉`,
    data: {
      币种: symbol,
      盈亏: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`,
      收益率: `${percent.toFixed(2)}%`,
    },
  });
}

/**
 * 快捷方法：发送风控拦截告警
 */
export async function notifyRiskBlocked(
  reason: string,
  balance: number
): Promise<boolean> {
  return sendNotification({
    type: "warning",
    title: "风控拦截",
    message: `交易被风控系统拦截`,
    data: {
      原因: reason,
      当前余额: `${balance.toFixed(2)} USDT`,
    },
  });
}

/**
 * 快捷方法：发送熔断器告警
 */
export async function notifyCircuitBreaker(
  apiName: string,
  state: string
): Promise<boolean> {
  return sendNotification({
    type: "error",
    title: "API 熔断",
    message: `${apiName} 熔断器已${state}`,
  });
}

/**
 * 快捷方法：发送系统启动通知
 */
export async function notifySystemStart(
  strategy: string,
  balance: number
): Promise<boolean> {
  return sendNotification({
    type: "info",
    title: "系统启动",
    message: `AI 交易系统已启动`,
    data: {
      策略: strategy,
      初始余额: `${balance.toFixed(2)} USDT`,
      版本: "v1.0.0",
    },
  });
}

/**
 * 快捷方法：发送每日摘要
 */
export async function notifyDailySummary(
  stats: {
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    maxDrawdown: number;
    balance: number;
  }
): Promise<boolean> {
  return sendNotification({
    type: "summary",
    title: "每日交易摘要",
    message: `今日交易统计`,
    data: {
      交易次数: stats.totalTrades,
      胜率: `${stats.winRate.toFixed(1)}%`,
      总盈亏: `${stats.totalPnl >= 0 ? "+" : ""}${stats.totalPnl.toFixed(2)} USDT`,
      最大回撤: `${stats.maxDrawdown.toFixed(2)}%`,
      当前余额: `${stats.balance.toFixed(2)} USDT`,
    },
  });
}

/**
 * 快捷方法：发送异常告警
 */
export async function notifyError(
  title: string,
  message: string,
  details?: Record<string, any>
): Promise<boolean> {
  return sendNotification({
    type: "error",
    title,
    message,
    data: details,
  });
}
