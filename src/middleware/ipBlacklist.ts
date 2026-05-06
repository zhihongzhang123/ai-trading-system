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

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Context, Next } from "hono";
import { createLogger } from "../utils/loggerUtils";

const logger = createLogger({
  name: "ip-blacklist",
  level: "info",
});

/**
 * 从文件加载 IP 黑名单
 */
function loadBlacklist(): Set<string> {
  const blacklistPath = join(process.cwd(), "ip-blacklist.txt");
  const blacklist = new Set<string>();

  try {
    if (existsSync(blacklistPath)) {
      const content = readFileSync(blacklistPath, "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmedLine = line.trim();
        // 跳过空行和注释行（以 # 开头）
        if (trimmedLine && !trimmedLine.startsWith("#")) {
          blacklist.add(trimmedLine);
        }
      }

      logger.info(`已加载 ${blacklist.size} 个 IP 黑名单`);
    } else {
      logger.warn("IP 黑名单文件不存在，将使用空黑名单");
    }
  } catch (error: any) {
    logger.error("读取 IP 黑名单文件失败:", error);
  }

  return blacklist;
}

// 加载黑名单
let ipBlacklist = loadBlacklist();

/**
 * 重新加载黑名单（用于热更新）
 */
export function reloadBlacklist() {
  ipBlacklist = loadBlacklist();
}

/**
 * 获取客户端真实 IP 地址
 */
function getClientIp(c: Context): string {
  // 检查常见的代理头（按优先级）
  const forwardedFor = c.req.header("x-forwarded-for");
  if (forwardedFor) {
    // X-Forwarded-For 可能包含多个 IP，取第一个
    const ip = forwardedFor.split(",")[0].trim();
    logger.debug(`从 X-Forwarded-For 获取 IP: ${ip}`);
    return ip;
  }

  const realIp = c.req.header("x-real-ip");
  if (realIp) {
    logger.debug(`从 X-Real-IP 获取 IP: ${realIp}`);
    return realIp.trim();
  }

  // 检查 CF-Connecting-IP (Cloudflare)
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) {
    logger.debug(`从 CF-Connecting-IP 获取 IP: ${cfIp}`);
    return cfIp.trim();
  }

  // 尝试从 Hono 的环境变量中获取
  const env = c.env as any;
  if (env?.ip) {
    logger.debug(`从 Hono env 获取 IP: ${env.ip}`);
    return env.ip;
  }

  // 如果都获取不到，记录警告
  logger.warn("无法获取客户端 IP，使用 unknown");
  return "unknown";
}

/**
 * IP 黑名单中间件
 */
export async function ipBlacklistMiddleware(c: Context, next: Next) {
  const clientIp = getClientIp(c);
  
  // 记录所有请求的 IP（本地环境跳过，避免日志噪音）
  const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === 'localhost';
  if (!isLocal) {
    logger.debug(`请求 IP: ${clientIp} - 路径: ${c.req.path} - 方法: ${c.req.method}`);
  }

  if (ipBlacklist.has(clientIp)) {
    logger.warn(`🚫 拦截黑名单 IP: ${clientIp} - 路径: ${c.req.path}`);
    return c.text("Forbidden", 403);
  }

  await next();
}

