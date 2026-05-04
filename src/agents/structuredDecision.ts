/**
 * 结构化决策 JSON 解析器
 * 从 AI 回复中提取并验证决策 JSON 块
 */

export interface StructuredDecision {
  decision: {
    action: string;
    symbol: string;
    confidence: number;
    reasoning: string;
    entry_price: number;
    stop_loss: number;
    take_profit: number;
    position_size_percent: number;
    leverage: number;
  };
  market_analysis: {
    trend: string;
    volatility: string;
    key_support: number;
    key_resistance: number;
    signals: string[];
  };
  risk_assessment: {
    risk_level: string;
    risk_reward_ratio: number;
    max_drawdown_percent: number;
  };
  self_review: {
    last_trade_result: string;
    lessons_learned: string;
    improvement_plan: string;
  };
}

const VALID_ACTIONS = [
  "hold", "open_long",
  "close_long",
  "add_position", "reduce_position"
];

const VALID_TRENDS = ["bullish", "bearish", "neutral"];
const VALID_VOLATILITY = ["high", "medium", "low"];
const VALID_RISK_LEVELS = ["low", "medium", "high"];
const VALID_RESULTS = ["win", "loss", "none"];

/**
 * 从 AI 回复文本中提取 JSON 代码块
 */
export function extractDecisionJSON(text: string): StructuredDecision | null {
  // 尝试匹配 ```json ... ``` 代码块
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    return parseAndValidate(jsonBlockMatch[1]);
  }

  // 尝试匹配最后一个 { ... } 块
  const lastBraceMatch = text.match(/\{[\s\S]*\}\s*$/);
  if (lastBraceMatch) {
    return parseAndValidate(lastBraceMatch[0]);
  }

  // 降级：从纯文本中提取结构化数据
  return fallbackParse(text);
}

/**
 * 降级解析器：从纯文本决策中提取关键信息
 */
function fallbackParse(text: string): StructuredDecision | null {
  let action = "hold";
  if (/开多|做多|买入|open_long/i.test(text)) action = "open_long";
  else if (/开空|做空|卖出|open_short/i.test(text)) action = "hold"; // 系统只做多，做空指令降级为观望
  else if (/平多|close_long/i.test(text)) action = "close_long";
  else if (/平空|close_short/i.test(text)) action = "close_long"; // 平空映射为平仓
  else if (/加仓|add_position/i.test(text)) action = "add_position";
  else if (/减仓|reduce_position/i.test(text)) action = "reduce_position";
  else if (/观望|等待|不入场|不开仓|hold/i.test(text)) action = "hold";

  let trend = "neutral";
  if (/多头|上涨|bullish/i.test(text)) trend = "bullish";
  else if (/空头|下跌|bearish/i.test(text)) trend = "bearish";

  let riskLevel = "medium";
  if (/极度危险|极度保守|高风险/i.test(text)) riskLevel = "high";
  else if (/低风险|保守/i.test(text)) riskLevel = "low";

  let confidence = 0.5;
  const confMatch = text.match(/置信度[：:]\s*(\d+)%/);
  if (confMatch) confidence = parseInt(confMatch[1]) / 100;
  else if (action === "hold") confidence = 0.8;

  const signals: string[] = [];
  if (/超卖|oversold/i.test(text)) signals.push("RSI超卖");
  if (/超买|overbought/i.test(text)) signals.push("RSI超买");
  if (/金叉/i.test(text)) signals.push("MACD金叉");
  if (/死叉/i.test(text)) signals.push("MACD死叉");
  if (/背离/i.test(text)) signals.push("MACD背离");
  if (/震荡/i.test(text)) signals.push("震荡行情");

  let drawdown = 0;
  const ddMatch = text.match(/回撤[：:]?\s*-?(\d+\.?\d*)%/);
  if (ddMatch) drawdown = parseFloat(ddMatch[1]);

  const lines = text.split("\n");
  let reasoning = "";
  // 优先从「核心逻辑」或「决策理由」类段落提取
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // 跳过Markdown表格行（包含 | 的行）
    if (line.includes("|")) continue;
    // 跳过空行和标题行
    if (!line || line.startsWith("#") || line.startsWith("**")) continue;
    // 查找包含决策理由的句子
    if ((line.includes("逻辑") || line.includes("理由") || line.includes("原因")) && line.length > 10 && line.length < 300) {
      reasoning = line.replace(/[#*：:>]/g, "").trim();
      break;
    }
  }
  // 降级：从最后一段非表格文本中提取
  if (!reasoning) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.includes("|") || !line || line.startsWith("#") || line.startsWith("-") || line.startsWith("*")) continue;
      if (line.length > 20 && line.length < 300) {
        reasoning = line.replace(/[#*：:>]/g, "").trim();
        break;
      }
    }
  }

  return {
    decision: { action, symbol: "BTC", confidence, reasoning, entry_price: 0, stop_loss: 0, take_profit: 0, position_size_percent: 0, leverage: 1 },
    market_analysis: { trend, volatility: "medium", key_support: 0, key_resistance: 0, signals },
    risk_assessment: { risk_level: riskLevel, risk_reward_ratio: 0, max_drawdown_percent: drawdown },
    self_review: { last_trade_result: "none", lessons_learned: "", improvement_plan: "" },
  };
}

function parseAndValidate(jsonStr: string): StructuredDecision | null {
  try {
    console.log("[PARSE] 尝试解析JSON，长度:", jsonStr.length);
    console.log("[PARSE] JSON前100字符:", jsonStr.substring(0, 100));
    const parsed = JSON.parse(jsonStr);
    console.log("[PARSE] JSON解析成功，顶层键:", Object.keys(parsed));
    return validate(parsed);
  } catch (e: any) {
    console.error("[PARSE] JSON解析失败:", e.message);
    console.error("[PARSE] 失败位置附近:", jsonStr.substring(0, 200));
    return null;
  }
}

function validate(data: any): StructuredDecision | null {
  if (!data || typeof data !== "object") {
    console.warn("[VALIDATE] 数据不是对象:", typeof data);
    return null;
  }

  // 验证 decision 字段
  const d = data.decision;
  if (!d || typeof d !== "object") {
    console.warn("[VALIDATE] 缺少decision字段:", !!d, typeof d);
    return null;
  }
  if (!VALID_ACTIONS.includes(d.action)) {
    console.warn("[VALIDATE] 无效action:", d.action, "合法:", VALID_ACTIONS);
    return null;
  }
  if (typeof d.symbol !== "string" || d.symbol.length === 0) {
    console.warn("[VALIDATE] symbol无效:", d.symbol);
    return null;
  }
  if (typeof d.confidence !== "number" || d.confidence < 0 || d.confidence > 1) {
    console.warn("[VALIDATE] confidence无效:", d.confidence, typeof d.confidence);
    return null;
  }

  // 验证 market_analysis
  const ma = data.market_analysis;
  if (!ma || typeof ma !== "object") {
    console.warn("[VALIDATE] 缺少market_analysis:", !!ma, typeof ma);
    return null;
  }
  if (!VALID_TRENDS.includes(ma.trend)) {
    console.warn("[VALIDATE] 无效trend:", ma.trend, "合法:", VALID_TRENDS);
    return null;
  }
  if (!VALID_VOLATILITY.includes(ma.volatility)) {
    console.warn("[VALIDATE] 无效volatility:", ma.volatility, "合法:", VALID_VOLATILITY);
    return null;
  }
  if (!Array.isArray(ma.signals)) ma.signals = [];

  // 验证 risk_assessment
  const ra = data.risk_assessment;
  if (!ra || typeof ra !== "object") {
    console.warn("[VALIDATE] 缺少risk_assessment:", !!ra, typeof ra);
    return null;
  }
  if (!VALID_RISK_LEVELS.includes(ra.risk_level)) {
    console.warn("[VALIDATE] 无效risk_level:", ra.risk_level, "合法:", VALID_RISK_LEVELS);
    return null;
  }

  // 验证 self_review (可选，允许AI省略)
  let sr = data.self_review;
  if (!sr || typeof sr !== "object") {
    sr = { last_trade_result: "none", lessons_learned: "", improvement_plan: "" };
    data.self_review = sr;
  }

  // 填充默认值
  return {
    decision: {
      action: d.action,
      symbol: d.symbol,
      confidence: d.confidence,
      reasoning: d.reasoning || "",
      entry_price: typeof d.entry_price === "number" ? d.entry_price : 0,
      stop_loss: typeof d.stop_loss === "number" ? d.stop_loss : 0,
      take_profit: typeof d.take_profit === "number" ? d.take_profit : 0,
      position_size_percent: typeof d.position_size_percent === "number" ? d.position_size_percent : 0,
      leverage: typeof d.leverage === "number" ? d.leverage : 0,
    },
    market_analysis: {
      trend: ma.trend,
      volatility: ma.volatility,
      key_support: typeof ma.key_support === "number" ? ma.key_support : 0,
      key_resistance: typeof ma.key_resistance === "number" ? ma.key_resistance : 0,
      signals: ma.signals,
    },
    risk_assessment: {
      risk_level: ra.risk_level,
      risk_reward_ratio: typeof ra.risk_reward_ratio === "number" ? ra.risk_reward_ratio : 0,
      max_drawdown_percent: typeof ra.max_drawdown_percent === "number" ? ra.max_drawdown_percent : 0,
    },
    self_review: {
      last_trade_result: VALID_RESULTS.includes(sr.last_trade_result) ? sr.last_trade_result : "none",
      lessons_learned: sr.lessons_learned || "",
      improvement_plan: sr.improvement_plan || "",
    },
  };
}

/**
 * 将结构化决策转换为摘要文本（用于前端显示）
 */
export function decisionToSummary(decision: StructuredDecision): string {
  const { action, symbol, confidence, reasoning } = decision.decision;
  const { trend, volatility, signals } = decision.market_analysis;
  const { risk_level, risk_reward_ratio } = decision.risk_assessment;

  const actionLabels: Record<string, string> = {
    hold: "持仓观望",
    open_long: "开多",
    open_short: "开空（系统限制：已禁止）",
    close_long: "平多",
    close_short: "平空（映射为平仓）",
    add_position: "加仓",
    reduce_position: "减仓",
  };

  const trendLabels: Record<string, string> = {
    bullish: "多头",
    bearish: "空头",
    neutral: "震荡",
  };

  return [
    `操作: ${actionLabels[action] || action} ${symbol}`,
    `置信度: ${(confidence * 100).toFixed(0)}%`,
    `趋势: ${trendLabels[trend] || trend}`,
    `波动: ${volatility}`,
    `风险: ${risk_level}`,
    `盈亏比: ${risk_reward_ratio.toFixed(1)}`,
    `信号: ${signals.join(", ") || "无"}`,
    `理由: ${reasoning}`,
  ].join(" | ");
}
