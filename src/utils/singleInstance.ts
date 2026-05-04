/**
 * 单实例锁 — 防止多个交易系统进程同时运行导致 SQLite 锁竞争和重复交易
 * 
 * 使用 PID 文件方案：
 * - 启动时检查 .voltagent/.trading.pid 是否存在
 * - 存在则检查对应 PID 是否存活，存活则拒绝启动
 * - 不存活（僵尸进程）则覆盖 PID 文件继续启动
 * - 进程退出时自动清理 PID 文件
 */
import fs from "fs";
import path from "path";

const PID_FILE = path.join(process.cwd(), ".voltagent", ".trading.pid");

export function acquireSingleInstanceLock(): boolean {
  // 确保 .voltagent 目录存在
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (Number.isFinite(oldPid)) {
      try {
        // signal 0 = 检查进程是否存在，不发送实际信号
        process.kill(oldPid, 0);
        // 进程存活，拒绝启动
        console.error(`❌ 交易系统已在运行中 (PID ${oldPid})，拒绝重复启动。`);
        console.error(`   如需重启，请先终止旧进程: kill ${oldPid}`);
        return false;
      } catch (_e) {
        // 进程不存在（僵尸），清理旧锁
        console.log(`⚠️  检测到僵尸 PID ${oldPid}，已清理旧锁文件。`);
      }
    }
  }

  // 写入当前 PID
  fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");

  // 进程退出时自动清理
  process.on("exit", () => {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  });
  process.on("SIGINT", () => {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  });

  return true;
}
