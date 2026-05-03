/**
 * 代理配置模块 - 为所有 HTTP/HTTPS 请求设置全局代理
 * 必须在其他模块导入之前加载
 */
import { setGlobalDispatcher, ProxyAgent } from "undici";

const proxyUrl = process.env.GLOBAL_AGENT_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`[代理] 全局代理已启用: ${proxyUrl}`);
} else {
  console.log("[代理] 未检测到代理配置，使用直连模式");
}
