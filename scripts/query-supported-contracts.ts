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
 * 查询交易所支持的所有合约
 */

import "dotenv/config";
import { createExchangeClient, getExchangeType } from "../src/services/exchangeClient";
import { createLogger } from "../src/utils/loggerUtils";

const logger = createLogger({
  name: "query-contracts",
  level: "info",
});

async function queryContracts() {
  try {
    const exchangeType = getExchangeType();
    const exchangeName = exchangeType === "okx" ? "OKX" : "Gate.io";
    
    // 检查是否使用测试网
    let isTestnet = false;
    if (exchangeType === "okx") {
      isTestnet = process.env.OKX_USE_TESTNET === "true";
    } else {
      isTestnet = process.env.GATE_USE_TESTNET === "true";
    }
    
    console.log(`\n🌐 当前交易所: ${exchangeName}`);
    console.log(`🌐 当前环境: ${isTestnet ? "测试网" : "正式网"}`);
    console.log("=====================================\n");

    // 创建交易所客户端
    const exchangeClient = createExchangeClient();
    
    // 获取所有合约
    console.log("🔍 正在获取合约列表...\n");
    const contracts = await exchangeClient.getAllContracts();
    
    if (!contracts || contracts.length === 0) {
      console.log("⚠️  未找到任何合约");
      return;
    }

    console.log(`📊 共找到 ${contracts.length} 个合约\n`);
    console.log("=====================================\n");

    // 按币种分组
    const contractsBySymbol = new Map<string, any[]>();
    
    for (const contract of contracts) {
      // 从合约名称提取币种（如 BTC_USDT -> BTC）
      const symbol = contract.name?.split('_')[0];
      if (symbol) {
        if (!contractsBySymbol.has(symbol)) {
          contractsBySymbol.set(symbol, []);
        }
        contractsBySymbol.get(symbol)?.push(contract);
      }
    }

    // 按币种排序并显示
    const sortedSymbols = Array.from(contractsBySymbol.keys()).sort();
    
    console.log("📋 支持的币种列表：\n");
    console.log("序号 | 币种 | 合约名称          | 状态   | 杠杆范围     | 最小/最大订单量");
    console.log("-----|------|-------------------|--------|--------------|------------------");
    
    sortedSymbols.forEach((symbol, index) => {
      const contractList = contractsBySymbol.get(symbol) || [];
      contractList.forEach((contract, contractIndex) => {
        const num = contractIndex === 0 ? `${index + 1}` : "";
        const symbolDisplay = contractIndex === 0 ? symbol : "";
        const status = contract.in_delisting ? "下架中" : "正常";
        const leverageMin = contract.leverage_min || "N/A";
        const leverageMax = contract.leverage_max || "N/A";
        const orderSizeMin = contract.order_size_min || "N/A";
        const orderSizeMax = contract.order_size_max || "N/A";
        
        console.log(
          `${num.padEnd(5)}| ${symbolDisplay.padEnd(5)}| ${contract.name.padEnd(18)}| ${status.padEnd(7)}| ${leverageMin}-${leverageMax}x`.padEnd(13) +
          `| ${orderSizeMin}-${orderSizeMax}`
        );
      });
    });

    console.log("\n=====================================\n");
    console.log(`✅ 共有 ${sortedSymbols.length} 个不同的币种\n`);
    
    // 显示一些统计信息
    const activeContracts = contracts.filter((c: any) => !c.in_delisting);
    const delistingContracts = contracts.filter((c: any) => c.in_delisting);
    
    console.log("📊 统计信息：");
    console.log(`   - 正常交易合约: ${activeContracts.length}`);
    console.log(`   - 下架中合约: ${delistingContracts.length}`);
    console.log(`   - 总合约数: ${contracts.length}`);
    
    // 显示一些热门币种的详细信息
    console.log("\n🔥 热门币种详细信息：\n");
    const popularSymbols = ["BTC", "ETH", "SOL", "BNB", "XRP"];
    
    for (const symbol of popularSymbols) {
      const contractList = contractsBySymbol.get(symbol);
      if (contractList && contractList.length > 0) {
        const contract = contractList[0];
        console.log(`${symbol}:`);
        console.log(`   合约名称: ${contract.name}`);
        console.log(`   杠杆范围: ${contract.leverage_min}x - ${contract.leverage_max}x`);
        console.log(`   订单量范围: ${contract.order_size_min} - ${contract.order_size_max}`);
        console.log(`   价格精度: ${contract.order_price_round || "N/A"}`);
        console.log(`   数量精度: ${contract.order_size_round || "N/A"}`);
        console.log(`   状态: ${contract.in_delisting ? "下架中" : "正常交易"}`);
        console.log("");
      }
    }

  } catch (error: any) {
    console.error("❌ 查询失败:", error.message);
    if (error.response) {
      console.error("API 错误详情:", error.response.body || error.response.data);
    }
    process.exit(1);
  }
}

// 运行查询
queryContracts();

