/**
 * Pulse Trading — 三栏仪表板适配版 v2.0
 * 适配 2026-05-04 三栏 Grid 布局
 */

class TradingMonitor {
    constructor() {
        this.accountData = null;
        this.equityChart = null;
        this.chartTimeframe = '24';
        this.lastIndicators = null;  // 缓存最新指标数据
        this.lastStructured = null;  // 缓存最新结构化决策
    }

    /** 从 CSS 变量读取颜色值，支持主题切换 */
    cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    async init() {
        await this.loadInitialData();
        this.initEquityChart();
        this.initColorSchemeToggle();
        this.initDecisionToggle();
        this.startDataUpdates();
    }

    // ---- 初始数据加载 ----
    async loadInitialData() {
        try {
            await Promise.all([
                this.loadAccountData(),
                this.loadPositionsData(),
                this.loadTradesData(),
                this.loadLogsData(),
                this.loadStrategyData(),
                this.loadRiskDashboard(),
                this.loadIndicatorsData(),
                this.loadQualityScores(),
                this.loadPerformanceOverview(),
                this.loadSentimentData()
            ]);
        } catch (error) {
            console.error('加载初始数据失败:', error);
        }
    }

   // ---- 账户数据 ----
   async loadAccountData() {
       try {
           const response = await fetch('/api/account', { cache: 'no-cache' });
           const data = await response.json();
           if (data.error) { console.error('API错误:', data.error); return; }

           this.accountData = data;
           // 使用后端返回的 equity（净资产）作为主显示值
           const equity = data.equity || data.totalBalance || 0;

           const el = (id) => document.getElementById(id);

           // 净资产（主显示）
           const accountEquityEl = el('account-equity');
           if (accountEquityEl) accountEquityEl.textContent = equity.toFixed(2);

           // 可用余额
           const availableBalanceEl = el('available-balance');
           if (availableBalanceEl) availableBalanceEl.textContent = (data.availableBalance || 0).toFixed(2);

           // 持仓保证金
           const positionMarginEl = el('position-margin');
           if (positionMarginEl) positionMarginEl.textContent = (data.positionMargin || 0).toFixed(2);

           // 可用保证金
           const availableMarginEl = el('available-margin');
           if (availableMarginEl) availableMarginEl.textContent = (data.availableMargin || 0).toFixed(2);

           // 保证金占用率
           const marginRatioEl = el('margin-ratio');
           if (marginRatioEl) marginRatioEl.textContent = `${(data.marginRatio || 0).toFixed(1)}%`;

           // 未实现盈亏
           const unrealisedPnlEl = el('unrealised-pnl');
           if (unrealisedPnlEl) {
               const pnlValue = (data.unrealisedPnl >= 0 ? '+' : '') + data.unrealisedPnl.toFixed(2);
               unrealisedPnlEl.textContent = pnlValue;
               unrealisedPnlEl.className = 'detail-value ' + (data.unrealisedPnl >= 0 ? 'positive' : 'negative');
           }

           // 初始资金
           const initialBalanceEl = el('initial-balance');
           if (initialBalanceEl) initialBalanceEl.textContent = (data.initialBalance || 0).toFixed(2);

           // 收益率
           const valueChangeEl = el('value-change');
           const valuePercentEl = el('value-percent');
           if (valueChangeEl && valuePercentEl) {
               const returnVal = data.returnPercent || 0;
               const returnAmount = data.equity !== undefined ? (data.equity - (data.initialBalance || 0)) : 0;
               const isPositive = returnAmount >= 0;
               valueChangeEl.textContent = `${isPositive ? '+' : ''}$${Math.abs(returnAmount).toFixed(2)}`;
               valuePercentEl.textContent = `(${isPositive ? '+' : ''}${returnVal.toFixed(2)}%)`;
               valueChangeEl.className = 'change-amount ' + (isPositive ? '' : 'negative');
               valuePercentEl.className = 'change-percent ' + (isPositive ? '' : 'negative');
           }
       } catch (error) {
           console.error('加载账户数据失败:', error);
       }
   }

    // ---- 策略数据 ----
    async loadStrategyData() {
        try {
            const response = await fetch('/api/strategy', { cache: 'no-cache' });
            const data = await response.json();
            if (data.error) { console.error('API错误:', data.error); return; }

            const strategyBadge = document.getElementById('strategy-badge');
            if (strategyBadge) {
                strategyBadge.textContent = data.strategyName;
                strategyBadge.className = 'strategy-badge-inline';
                strategyBadge.classList.add(data.strategy);
            }

            const strategyInfoInline = document.getElementById('strategy-info-inline');
            if (strategyInfoInline) {
                const protectionMode = data.enableCodeLevelProtection ? '代码级' : 'AI';
                strategyInfoInline.textContent = `${data.intervalMinutes}分 | ${data.leverageRange} | ${data.positionSizeRange} | ${protectionMode}`;
            }

            const modelName = document.getElementById('model-name');
            if (modelName) modelName.textContent = data.modelName || '-';
        } catch (error) {
            console.error('加载策略数据失败:', error);
        }
    }

    // ---- 持仓数据 ----
    async loadPositionsData() {
        try {
            const response = await fetch('/api/positions', { cache: 'no-cache' });
            const data = await response.json();
            if (data.error) { console.error('API错误:', data.error); return; }

            const positionsBody = document.getElementById('positions-body');
            const positionsCardsContainer = document.getElementById('positions-cards-container');
            const riskPositionCount = document.getElementById('risk-position-count');

            if (!data.positions || data.positions.length === 0) {
                if (positionsBody) {
                    positionsBody.innerHTML = '<tr><td colspan="8" class="empty-state">暂无持仓</td></tr>';
                }
                if (positionsCardsContainer) {
                    positionsCardsContainer.innerHTML = '<div class="positions-cards-empty">暂无持仓</div>';
                }
                if (riskPositionCount) riskPositionCount.textContent = '0';
                return;
            }

            if (riskPositionCount) riskPositionCount.textContent = data.positions.length.toString();

            data.positions.forEach(pos => {
                // position data used for table/cards rendering below
            });

            // 表格
            if (positionsBody) {
                positionsBody.innerHTML = data.positions.map(pos => {
                    const profitPercent = ((pos.unrealizedPnl / pos.openValue) * 100).toFixed(2);
                    const sideText = pos.side === 'long' ? '做多' : '做空';
                    const sideClass = pos.side === 'long' ? 'positive' : 'negative';
                    // 计算有效杠杆 = 名义价值 / 开仓价值，上限3x
                    const rawLeverage = pos.openValue > 0 ? (pos.quantity * pos.currentPrice) / pos.openValue : 1;
                    const effectiveLeverage = Math.min(rawLeverage, 3);
                    const leverageClass = rawLeverage > 3 ? 'negative' : (rawLeverage > 1.5 ? 'warning' : '');
                    const leverageDisplay = rawLeverage > 3 ? `${effectiveLeverage.toFixed(1)}x⚠️` : `${effectiveLeverage.toFixed(1)}x`;

                    return `<tr>
                        <td>${pos.symbol}</td>
                        <td class="${sideClass}">${sideText}</td>
                        <td class="${leverageClass}">${leverageDisplay}</td>
                        <td>$${pos.entryPrice.toFixed(4)}</td>
                        <td>$${pos.currentPrice.toFixed(4)}</td>
                        <td class="${pos.unrealizedPnl >= 0 ? 'positive' : 'negative'}">
                            ${pos.unrealizedPnl >= 0 ? '+' : ''}$${pos.unrealizedPnl.toFixed(2)}
                        </td>
                        <td class="${pos.unrealizedPnl >= 0 ? 'positive' : 'negative'}">
                            ${pos.unrealizedPnl >= 0 ? '+' : ''}${profitPercent}%
                        </td>
                        <td class="td-actions"><button class="btn-close-position" onclick="monitor.closePosition('${pos.symbol}')">平仓</button></td>
                    </tr>`;
                }).join('');
            }

            // 卡片
            if (positionsCardsContainer) {
                positionsCardsContainer.innerHTML = data.positions.map(pos => {
                    const profitPercent = ((pos.unrealizedPnl / pos.openValue) * 100).toFixed(2);
                    const pnlClass = pos.unrealizedPnl >= 0 ? 'positive' : 'negative';
                    const sideText = pos.side === 'long' ? '多' : '空';
                    // 计算有效杠杆
                    const rawLeverage = pos.openValue > 0 ? (pos.quantity * pos.currentPrice) / pos.openValue : 1;
                    const effectiveLeverage = Math.min(rawLeverage, 3);
                    const leverageDisplay = rawLeverage > 3 ? `${effectiveLeverage.toFixed(1)}x⚠️` : `${effectiveLeverage.toFixed(1)}x`;

                    return `<div class="position-card ${pos.side} ${pnlClass}">
                        <span class="position-card-symbol">${pos.symbol} ${leverageDisplay}</span>
                        <span class="position-card-pnl ${pnlClass}">
                            ${sideText} ${pos.unrealizedPnl >= 0 ? '+' : ''}$${pos.unrealizedPnl.toFixed(2)} (${pos.unrealizedPnl >= 0 ? '+' : ''}${profitPercent}%)
                        </span>
                    </div>`;
                }).join('');
            }
        } catch (error) {
            console.error('加载持仓数据失败:', error);
        }
    }

    // ---- 交易记录 ----
    async loadTradesData() {
        try {
            const response = await fetch('/api/trades?limit=100', { cache: 'no-cache' });
            const data = await response.json();
            if (data.error) { console.error('API错误:', data.error); return; }

            const tradesBody = document.getElementById('trades-body');
            const countEl = document.getElementById('tradesCount');

            if (!data.trades || data.trades.length === 0) {
                if (tradesBody) tradesBody.innerHTML = '<tr><td colspan="9" class="empty-state">暂无交易记录</td></tr>';
                if (countEl) countEl.textContent = '';
                return;
            }

            if (countEl) countEl.textContent = `(${data.trades.length})`;

            // 获取账户余额用于计算有效杠杆
            const accountBalance = this.accountData?.equity || this.accountData?.totalBalance || 73.2;

            if (tradesBody) {
                tradesBody.innerHTML = data.trades.map(trade => {
                    const date = new Date(trade.timestamp);
                    const timeStr = date.toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit'
                    });
                    const typeText = trade.type === 'open' ? '开仓' : '平仓';
                    const typeClass = trade.type === 'open' ? 'buy' : 'sell';
                    const sideText = trade.side === 'long' ? '做多' : '做空';
                    const sideClass = trade.side === 'long' ? 'long' : 'short';
                    const pnlHtml = trade.type === 'close' && trade.pnl !== null && trade.pnl !== undefined
                        ? `<span class="${trade.pnl >= 0 ? 'profit' : 'loss'}">${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}</span>`
                        : '<span class="na">-</span>';

                    const displayPrice = trade.fillPrice && trade.fillPrice > 0 ? trade.fillPrice : trade.price;

                    // 计算有效杠杆 = 名义价值 / 账户余额
                    const notionalValue = (trade.quantity || 0) * displayPrice;
                    const rawLeverage = accountBalance > 0 ? notionalValue / accountBalance : 1;
                    const effectiveLeverage = Math.min(rawLeverage, 3);
                    const leverageClass = rawLeverage > 3 ? 'warning' : '';
                    const leverageDisplay = rawLeverage > 3 ? `${effectiveLeverage.toFixed(1)}x⚠️` : `${effectiveLeverage.toFixed(1)}x`;

                    return `<tr>
                        <td>${timeStr}</td>
                        <td><span class="symbol">${trade.symbol}</span></td>
                        <td><span class="type ${typeClass}">${typeText}</span></td>
                        <td><span class="side ${sideClass}">${sideText}</span></td>
                        <td>$${displayPrice.toFixed(2)}</td>
                        <td>${trade.quantity}</td>
                        <td class="${leverageClass}">${leverageDisplay}</td>
                        <td>${trade.fee.toFixed(4)}</td>
                        <td>${pnlHtml}</td>
                    </tr>`;
                }).join('');
            }
        } catch (error) {
            console.error('加载交易记录失败:', error);
        }
    }

    // ---- 日志 / 指标 / 结构化决策 ----
    async loadLogsData() {
        try {
            const response = await fetch('/api/logs?limit=1', { cache: 'no-cache' });
            const data = await response.json();
            if (data.error) { console.error('API错误:', data.error); return; }

            if (data.logs && data.logs.length > 0) {
                const log = data.logs[0];

                // 元信息
                const decisionMeta = document.getElementById('decision-meta');
                if (decisionMeta) {
                    const timestamp = new Date(log.timestamp).toLocaleString('zh-CN', {
                        year: 'numeric', month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit'
                    });
                    decisionMeta.innerHTML = `<span class="decision-time">${timestamp}</span><span class="decision-iteration">#${log.iteration}</span>`;
                }

                // 结构化决策卡片
                if (log.structuredDecision) {
                    this.updateStructuredDecision(log.structuredDecision);
                }

                // 技术指标面板（从 structuredDecision 的 indicators 字段提取）
                if (log.structuredDecision && log.structuredDecision.indicators) {
                    this.updateIndicators(log.structuredDecision.indicators);
                }

                // AI 决策全文 Markdown
                const decisionContent = document.getElementById('decision-content');
                if (decisionContent) {
                    const decision = log.decision || log.actionsTaken || '暂无决策内容';
                    decisionContent.innerHTML = `<div class="decision-text markdown-content">${marked.parse(decision)}</div>`;
                }
            } else {
                const decisionMeta = document.getElementById('decision-meta');
                if (decisionMeta) decisionMeta.innerHTML = '<span class="decision-time">无数据</span>';

                const decisionContent = document.getElementById('decision-content');
                if (decisionContent) decisionContent.innerHTML = '<p class="no-data">暂无 AI 决策记录</p>';
            }
        } catch (error) {
            console.error('加载日志失败:', error);
            const decisionContent = document.getElementById('decision-content');
            if (decisionContent) decisionContent.innerHTML = `<p class="error">加载失败: ${error.message}</p>`;
        }
    }

    // ---- 更新结构化决策卡片 ----
    updateStructuredDecision(sd) {
        this.lastStructured = sd;
        const el = (id) => document.getElementById(id);

        // 兼容嵌套结构：后端返回 {decision:{action,confidence,...}, market_analysis:{trend,signals,...}, risk_assessment:{risk_level,...}}
        const dec = sd.decision || sd;
        const ma = sd.market_analysis || sd;
        const ra = sd.risk_assessment || sd;

        // 操作
        const actionEl = el('sd-action');
        if (actionEl) {
            const action = (dec.action || sd.action || 'HOLD').toUpperCase();
            actionEl.textContent = action;
            actionEl.className = 'sd-value sd-action-value ' + action.toLowerCase();
        }

        // 置信度
        const confEl = el('sd-confidence');
        const confBar = el('sd-confidence-bar');
        if (confEl) {
            const conf = (dec.confidence ?? sd.confidence) != null ? Math.round((dec.confidence ?? sd.confidence) * 100) + '%' : '--';
            confEl.textContent = conf;
        }
        if (confBar) {
            const pct = (dec.confidence ?? sd.confidence) != null ? Math.round((dec.confidence ?? sd.confidence) * 100) : 0;
            confBar.style.width = pct + '%';
            confBar.className = 'sd-bar-fill ' + (pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low');
        }

        // 趋势
        const trendEl = el('sd-trend');
        if (trendEl) {
            const trend = ma.trend || sd.trend || '--';
            // 英文趋势映射为中文
            const trendMap = { 'bullish': '上涨', 'bearish': '下跌', 'sideways': '震荡', 'neutral': '中性' };
            trendEl.textContent = trendMap[trend] || trend;
        }

        // 风险等级
        const riskEl = el('sd-risk');
        if (riskEl) {
            const risk = ra.risk_level || sd.riskLevel || '--';
            const riskMap = { 'low': '低', 'medium': '中', 'high': '高', 'critical': '极高' };
            const riskCN = riskMap[risk] || risk;
            riskEl.textContent = riskCN;
            if (riskCN === '高' || riskCN === '极高') riskEl.style.color = 'var(--accent-red)';
            else if (riskCN === '中') riskEl.style.color = 'var(--accent-yellow)';
            else riskEl.style.color = 'var(--accent-green)';
        }

        // 盈亏比
        const rrEl = el('sd-rr');
        if (rrEl) {
            const rr = ra.risk_reward_ratio ?? sd.riskRewardRatio;
            rrEl.textContent = rr ? Number(rr).toFixed(1) + ':1' : '--';
        }

        // 信号
        const signalsEl = el('sd-signals');
        if (signalsEl) {
            const sigs = ma.signals || sd.signals;
            if (sigs && Array.isArray(sigs)) {
                signalsEl.textContent = sigs.join(', ');
            } else if (sd.keySignal) {
                signalsEl.textContent = sd.keySignal;
            } else {
                signalsEl.textContent = '--';
            }
        }

        // 推理摘要
        const reasoningEl = el('sd-reasoning');
        if (reasoningEl) {
            reasoningEl.textContent = dec.reasoning || sd.reasoning || sd.summary || '';
        }
    }

    // ---- 更新技术指标面板 ----
    updateIndicators(ind) {
        this.lastIndicators = ind;
        const el = (id) => document.getElementById(id);

        // 当前价（兼容 price 和 currentPrice 两种字段名）
        const price = ind.currentPrice ?? ind.price;
        if (price != null) {
            const pEl = el('ind-price');
            if (pEl) pEl.textContent = Number(price).toFixed(2);
        }

        // EMA20
        if (ind.ema20 != null) {
            const e20El = el('ind-ema20');
            if (e20El) e20El.textContent = ind.ema20.toFixed(2);
        }

        // EMA60 (替换旧 EMA50)
        if (ind.ema60 != null) {
            const e60El = el('ind-ema60');
            if (e60El) e60El.textContent = ind.ema60.toFixed(2);
        }

        // EMA120
        if (ind.ema120 != null) {
            const e120El = el('ind-ema120');
            if (e120El) e120El.textContent = ind.ema120.toFixed(2);
        }

        // MA200 牛熊线
        if (ind.ma200 != null) {
            const m200El = el('ind-ma200');
            if (m200El) m200El.textContent = ind.ma200.toFixed(2);
        }

        // 斜率20
        if (ind.slope20 != null) {
            const s20El = el('ind-slope20');
            if (s20El) {
                const val = ind.slope20.toFixed(4);
                s20El.textContent = val;
                s20El.className = 'indicator-value ' + (ind.slope20 > 0 ? 'overbought' : ind.slope20 < 0 ? 'oversold' : 'neutral');
            }
        }

        // RSI
        if (ind.rsi != null) {
            const rsiEl = el('ind-rsi');
            if (rsiEl) {
                const val = ind.rsi.toFixed(1);
                rsiEl.textContent = val;
                rsiEl.className = 'indicator-value ' + (ind.rsi > 70 ? 'overbought' : ind.rsi < 30 ? 'oversold' : 'neutral');
            }
        }

        // MACD
        if (ind.macd != null) {
            const macdEl = el('ind-macd');
            if (macdEl) {
                macdEl.textContent = ind.macd.toFixed(4);
                macdEl.style.color = ind.macd >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
            }
        }

        // 成交量
        if (ind.volume != null) {
            const vEl = el('ind-volume');
            if (vEl) vEl.textContent = ind.volume.toFixed(2);
        }

        // 量比 (volume / avgVolume)
        if (ind.volume != null && ind.avgVolume != null && ind.avgVolume > 0) {
            const vrEl = el('ind-volratio');
            if (vrEl) {
                const ratio = (ind.volume / ind.avgVolume).toFixed(2);
                vrEl.textContent = ratio;
                vrEl.className = 'indicator-value ' + (ratio > 2 ? 'overbought' : ratio < 0.5 ? 'oversold' : 'neutral');
            }
        }

        // 更新币种标签
        if (ind.symbol) {
            const symEl = el('indicator-symbol');
            if (symEl) symEl.textContent = ind.symbol;
        }
    }

    // ---- 加载指标数据（独立 API） ----
    async loadIndicatorsData() {
        try {
            const res = await fetch('/api/indicators?symbol=BTC', { cache: 'no-cache' });
            const data = await res.json();
            if (data.indicators) {
                this.updateIndicators(data.indicators);
            }
        } catch (err) {
            console.error('加载指标数据失败:', err);
        }
    }

    // ---- 风控仪表盘 ----
    async loadRiskDashboard() {
        try {
            const [statsRes, positionsRes] = await Promise.all([
                fetch('/api/stats', { cache: 'no-cache' }),
                fetch('/api/positions', { cache: 'no-cache' })
            ]);
            const stats = await statsRes.json();
            const posData = await positionsRes.json();
            if (stats.error) return;

            const el = (id) => document.getElementById(id);

            // 信号命中率
            const hitRateEl = el('risk-hit-rate');
            if (hitRateEl) hitRateEl.textContent = stats.winRate != null ? stats.winRate.toFixed(1) + '%' : '--';

            // 连续亏损
            const consecEl = el('risk-consecutive-losses');
            if (consecEl) {
                const consec = await this._calcConsecutiveLosses();
                consecEl.textContent = consec.toString();
                if (consec >= 3) consecEl.className = 'risk-value danger';
                else if (consec >= 2) consecEl.className = 'risk-value warning';
                else consecEl.className = 'risk-value';
            }

            // 冷却倒计时
            const cooldownEl = el('risk-cooldown');
            if (cooldownEl) cooldownEl.textContent = '--';  // 预留

            // 风险状态综合
            const riskStatusEl = el('risk-status');
            if (riskStatusEl) {
                if (stats.winRate != null && stats.winRate < 30) {
                    riskStatusEl.textContent = '警告';
                    riskStatusEl.className = 'risk-status warning';
                } else {
                    riskStatusEl.textContent = '正常';
                    riskStatusEl.className = 'risk-status';
                }
            }
        } catch (error) {
            console.error('加载风控数据失败:', error);
        }
    }

    // ---- 最大回撤计算 ----
    async _calcMaxDrawdown() {
        try {
            const response = await fetch('/api/history', { cache: 'no-cache' });
            const data = await response.json();
            if (!data.history || data.history.length < 2) return null;
            const values = data.history.map(d => parseFloat(d.totalValue));
            let peak = values[0];
            let maxDD = 0;
            for (const v of values) {
                if (v > peak) peak = v;
                const dd = ((peak - v) / peak) * 100;
                if (dd > maxDD) maxDD = dd;
            }
            return maxDD;
        } catch { return null; }
    }

    // ---- 连续亏损次数 ----
    async _calcConsecutiveLosses() {
        try {
            const response = await fetch('/api/trades?limit=50', { cache: 'no-cache' });
            const data = await response.json();
            if (!data.trades || data.trades.length === 0) return 0;
            const closes = data.trades.filter(t => t.type === 'close' && t.pnl != null).reverse();
            let count = 0;
            for (let i = closes.length - 1; i >= 0; i--) {
                if (closes[i].pnl < 0) count++;
                else break;
            }
            return count;
        } catch { return 0; }
    }

    // ---- 夏普比率（简化版） ----
    async _calcSharpe() {
        try {
            const response = await fetch('/api/history', { cache: 'no-cache' });
            const data = await response.json();
            if (!data.history || data.history.length < 5) return null;
            const values = data.history.map(d => parseFloat(d.totalValue));
            const returns = [];
            for (let i = 1; i < values.length; i++) {
                returns.push((values[i] - values[i - 1]) / values[i - 1]);
            }
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
            const std = Math.sqrt(variance);
            if (std === 0) return null;
            return (mean / std) * Math.sqrt(252); // 年化
        } catch { return null; }
    }

    // ---- 信号质量评分 ----
    qsGaugeChart = null;

    async loadQualityScores() {
        try {
            const res = await fetch('/api/quality-scores?limit=1', { cache: 'no-cache' });
            if (!res.ok) return;
            const data = await res.json();
            if (data.scores && data.scores.length > 0) {
                this.renderQualityScore(data.scores[0]);
            }
        } catch (e) {
            // API 可能未实现，静默忽略
        }
    }

    renderQualityScore(score) {
        const el = (id) => document.getElementById(id);
        const total = score.total ?? score.qualityScore ?? 0;
        const comps = score.components || {};

        // 总分
        const totalEl = el('qs-total');
        if (totalEl) {
            totalEl.textContent = total.toFixed(0);
            totalEl.style.color = total >= 75 ? 'var(--accent-green)' : total >= 50 ? 'var(--accent-yellow)' : 'var(--accent-red)';
        }

        // 标签
        const labelEl = el('qs-label');
        if (labelEl) {
            labelEl.textContent = total >= 75 ? '优质信号' : total >= 50 ? '中等信号' : '低质信号';
        }

        // 徽章
        const badgeEl = el('qs-badge');
        if (badgeEl) {
            badgeEl.textContent = `${score.symbol} ${total.toFixed(0)}/100`;
            badgeEl.className = 'quality-score-badge ' + (total >= 75 ? 'high' : total >= 50 ? 'medium' : 'low');
        }

        // 五维评分
        const dims = [
            { id: 'qs-resonance', barId: 'qs-resonance-bar', val: comps.resonance ?? 0, max: 30 },
            { id: 'qs-alignment', barId: 'qs-alignment-bar', val: comps.alignment ?? 0, max: 25 },
            { id: 'qs-trend', barId: 'qs-trend-bar', val: comps.trend ?? 0, max: 15 },
            { id: 'qs-volume', barId: 'qs-volume-bar', val: comps.volume ?? 0, max: 15 },
            { id: 'qs-position', barId: 'qs-position-bar', val: comps.position ?? 0, max: 15 },
        ];

        dims.forEach(d => {
            const valEl = el(d.id);
            const barEl = el(d.barId);
            if (valEl) valEl.textContent = d.val.toFixed(0);
            if (barEl) {
                const pct = d.max > 0 ? (d.val / d.max * 100) : 0;
                barEl.style.width = pct + '%';
                barEl.className = 'qs-dim-fill' + (pct >= 70 ? '' : pct >= 40 ? ' medium' : ' low');
            }
        });

        // 仪表盘 Chart.js
        this.updateGaugeChart(total);
    }

    updateGaugeChart(value) {
        const ctx = document.getElementById('qs-gauge-chart');
        if (!ctx) return;

        if (this.qsGaugeChart) {
            this.qsGaugeChart.data.datasets[0].data = [value, 100 - value];
            this.qsGaugeChart.update('none');
            return;
        }

        const color = value >= 75 ? this.cssVar('--score-good') : value >= 50 ? this.cssVar('--score-mid') : this.cssVar('--score-bad');
        this.qsGaugeChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                datasets: [{
                    data: [value, 100 - value],
                    backgroundColor: [color, this.cssVar('--border-color')],
                    borderWidth: 0,
                    circumference: 270,
                    rotation: 225,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                cutout: '75%',
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
            }
        });
    }

    // ---- 数据更新 ----
    startDataUpdates() {
        // 每15秒更新账户和持仓（OKX API限流保护）
        setInterval(async () => {
            await Promise.all([this.loadAccountData(), this.loadPositionsData()]);
        }, 15000);

        // 每60秒更新交易记录、日志、风控、指标、质量评分、绩效和情绪
        setInterval(async () => {
            await Promise.all([
                this.loadTradesData(),
                this.loadLogsData(),
                this.loadRiskDashboard(),
                this.loadIndicatorsData(),
                this.loadQualityScores(),
                this.loadPerformanceOverview(),
                this.loadSentimentData()
            ]);
        }, 60000);

        // 每60秒更新资产曲线
        setInterval(async () => { await this.updateEquityChart(); }, 60000);
    }

    // ---- 资产曲线 ----
    async initEquityChart() {
        const ctx = document.getElementById('equityChart');
        if (!ctx) { console.error('未找到图表canvas元素'); return; }

        const historyData = await this.loadEquityHistory();
        if (!historyData || historyData.length === 0) {
            const container = ctx.parentElement;
            if (container) {
                const message = document.createElement('div');
                message.className = 'no-data';
                message.style.cssText = `position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: ${this.cssVar('--text-secondary')}; text-align: center;`;
                message.innerHTML = `暂无历史数据<br><small style="color: ${this.cssVar('--text-dim')};">系统将每10分钟自动记录账户资产</small>`;
                container.appendChild(message);
            }
            return;
        }

        this.equityChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: historyData.map(d => {
                    const date = new Date(d.timestamp);
                    return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                }),
                datasets: [{
                    label: '总资产 (USDT)',
                    data: historyData.map(d => parseFloat(d.totalValue.toFixed(2))),
                    borderColor: this.cssVar('--accent-green'),
                    backgroundColor: this.cssVar('--accent-green') + '1a',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: {
                        display: true, position: 'top',
                        labels: { color: this.cssVar('--text-muted'), usePointStyle: true, padding: 15 }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(17, 24, 39, 0.95)',
                        titleColor: '#fff', bodyColor: '#fff',
                        borderColor: 'rgb(59, 130, 246)', borderWidth: 1, padding: 12, displayColors: true,
                        callbacks: {
                            label: function (context) {
                                let label = context.dataset.label || '';
                                if (label) label += ': ';
                                if (context.parsed.y !== null) label += '$' + context.parsed.y;
                                return label;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        display: true,
                        grid: { color: 'rgba(255, 255, 255, 0.06)', drawBorder: false },
                        ticks: { color: this.cssVar('--text-muted'), maxRotation: 45, minRotation: 0, maxTicksLimit: 10 }
                    },
                    y: {
                        display: true, position: 'left',
                        grid: { color: 'rgba(255, 255, 255, 0.06)', drawBorder: false },
                        ticks: {
                            color: this.cssVar('--text-muted'),
                            callback: function (value) { return '$' + value.toFixed(2); }
                        }
                    }
                }
            }
        });
    }

    async loadEquityHistory() {
        try {
            const response = await fetch('/api/history', { cache: 'no-cache' });
            const data = await response.json();
            if (data.error) { console.error('API错误:', data.error); return []; }
            return data.history || [];
        } catch (error) {
            console.error('加载资产历史数据失败:', error);
            return [];
        }
    }

    async updateEquityChart() {
        if (!this.equityChart) { await this.initEquityChart(); return; }
        const historyData = await this.loadEquityHistory();
        if (!historyData || historyData.length === 0) return;
        this.equityChart.data.labels = historyData.map(d => {
            const date = new Date(d.timestamp);
            return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        });
        this.equityChart.data.datasets[0].data = historyData.map(d => parseFloat(d.totalValue.toFixed(2)));
        this.equityChart.data.datasets[0].pointRadius = 0;
        this.equityChart.update('none');
    }

    // ---- AI 决策面板折叠 ----
    initDecisionToggle() {
        const header = document.getElementById('decision-toggle-header');
        const toggle = document.getElementById('decision-toggle');
        const container = document.getElementById('decision-container');
        if (!header || !container) return;

        // 默认展开
        container.classList.remove('collapsed');
        // 不要覆盖 overflow — 让 CSS 控制 overflow-y: auto
        if (toggle) toggle.textContent = '▼ 收起';

        const doToggle = () => {
            const isCollapsed = container.classList.toggle('collapsed');
            if (toggle) toggle.textContent = isCollapsed ? '▶ 展开' : '▼ 收起';
            if (toggle) toggle.classList.toggle('collapsed', isCollapsed);
        };

        header.addEventListener('click', doToggle);
    }

    // ---- 绩效总览面板 ----
    async loadPerformanceOverview() {
        try {
            const [statsRes, historyRes, tradesRes] = await Promise.all([
                fetch('/api/stats', { cache: 'no-cache' }),
                fetch('/api/history', { cache: 'no-cache' }),
                fetch('/api/trades?limit=200', { cache: 'no-cache' })
            ]);
            const stats = await statsRes.json();
            const history = await historyRes.json();
            const trades = await tradesRes.json();
            if (stats.error) return;

            const el = (id) => document.getElementById(id);

            // 累计盈亏
            const totalPnlEl = el('perf-total-pnl');
            if (totalPnlEl && stats.totalPnl != null) {
                const pnl = stats.totalPnl;
                totalPnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
                totalPnlEl.className = 'perf-value ' + (pnl >= 0 ? 'positive' : 'negative');
            }

            // 总交易数
            const totalTradesEl = el('perf-total-trades');
            if (totalTradesEl) {
                const closes = trades.trades ? trades.trades.filter(t => t.type === 'close') : [];
                totalTradesEl.textContent = closes.length.toString();
            }

            // 胜率
            const winrateEl = el('perf-winrate');
            if (winrateEl && stats.winRate != null) {
                winrateEl.textContent = stats.winRate.toFixed(1) + '%';
            }

            // 最大回撤
            const maxddEl = el('perf-maxdd');
            if (maxddEl) {
                const dd = await this._calcMaxDrawdown();
                if (dd != null) {
                    maxddEl.textContent = `-${dd.toFixed(1)}%`;
                    maxddEl.className = 'perf-value negative';
                }
            }

            // 夏普比率
            const sharpeEl = el('perf-sharpe');
            if (sharpeEl) {
                const sharpe = await this._calcSharpe();
                if (sharpe != null) sharpeEl.textContent = sharpe.toFixed(2);
            }

            // 最大单笔
            const maxWinEl = el('perf-maxwin');
            if (maxWinEl && trades.trades) {
                const closes = trades.trades.filter(t => t.type === 'close' && t.pnl != null);
                if (closes.length > 0) {
                    const maxPnl = Math.max(...closes.map(t => t.pnl));
                    const minPnl = Math.min(...closes.map(t => t.pnl));
                    const extreme = Math.abs(maxPnl) >= Math.abs(minPnl) ? maxPnl : minPnl;
                    maxWinEl.textContent = `${extreme >= 0 ? '+' : ''}$${extreme.toFixed(2)}`;
                    maxWinEl.className = 'perf-value ' + (extreme >= 0 ? 'positive' : 'negative');
                }
            }
        } catch (e) {
            console.error('加载绩效总览失败:', e);
        }
    }

    // ---- 市场情绪面板 (Fear & Greed + 实时新闻情绪) ----
    async loadSentimentData() {
        try {
            const res = await fetch('/api/sentiment', { cache: 'no-cache' });
            const data = await res.json();
            if (!data || data.error) return;

            const el = (id) => document.getElementById(id);

            // ---- F&G 指数部分 ----
            const fg = data.fearGreed;
            if (fg) {
                const value = fg.value;
                const classification = fg.classification;

                const fgValueEl = el('fg-value');
                if (fgValueEl) fgValueEl.textContent = value;

                const fgClassEl = el('fg-classification');
                if (fgClassEl) {
                    const classMap = {
                        'Extreme Fear': '极度恐惧', 'Fear': '恐惧', 'Neutral': '中性',
                        'Greed': '贪婪', 'Extreme Greed': '极度贪婪'
                    };
                    fgClassEl.textContent = classMap[classification] || classification;
                }

                const fgUpdatedEl = el('fg-updated');
                if (fgUpdatedEl) {
                    const ts = parseInt(fg.timestamp) * 1000;
                    fgUpdatedEl.textContent = new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
                }

                const gaugeFill = el('gauge-fill');
                if (gaugeFill) {
                    gaugeFill.style.width = (100 - value) + '%';
                }

                const badge = el('sentiment-badge');
                if (badge) {
                    const classMap = {
                        'Extreme Fear': 'fear', 'Fear': 'fear', 'Neutral': 'neutral',
                        'Greed': 'greed', 'Extreme Greed': 'greed'
                    };
                    const textMap = {
                        'Extreme Fear': '极度恐惧', 'Fear': '恐惧', 'Neutral': '中性',
                        'Greed': '贪婪', 'Extreme Greed': '极度贪婪'
                    };
                    badge.textContent = textMap[classification] || classification;
                    badge.className = 'sentiment-badge ' + (classMap[classification] || 'neutral');
                }
            }

            // ---- 实时新闻情绪部分 ----
            const newsRows = el('news-sentiment-rows');
            if (newsRows && data.newsSentiment && data.newsSentiment.length > 0) {
                let html = '';
                for (const item of data.newsSentiment) {
                    const s = item.sentiment;
                    if (!s) continue;
                    const total = s.pos + s.neu + s.neg;
                    if (total === 0) continue;

                    const posPct = Math.round((s.pos / total) * 100);
                    const neuPct = Math.round((s.neu / total) * 100);
                    const negPct = 100 - posPct - neuPct;

                    let dirClass = 'neutral';
                    let dirText = '中性';
                    if (s.direction === '偏多') { dirClass = 'bullish'; dirText = '偏多'; }
                    else if (s.direction === '偏空') { dirClass = 'bearish'; dirText = '偏空'; }

                    html += `<div class="news-sentiment-row">
                        <span class="news-symbol">${item.symbol}</span>
                        <div class="news-bar-container">
                            <div class="news-bar-pos" style="width:${posPct}%"></div>
                            <div class="news-bar-neu" style="width:${neuPct}%"></div>
                            <div class="news-bar-neg" style="width:${negPct}%"></div>
                        </div>
                        <span class="news-direction ${dirClass}">${dirText}</span>
                        <span class="news-count">${total}条</span>
                    </div>`;
                }
                if (html) newsRows.innerHTML = html;
            }
        } catch (e) {
            console.error('加载情绪数据失败:', e);
        }
    }

    // ---- 颜色方案切换 ----
    initColorSchemeToggle() {
        const toggleBtn = document.getElementById('trend-colors-btn');
        if (toggleBtn) {
            this.loadColorScheme();
            toggleBtn.addEventListener('click', () => { this.toggleColorScheme(); });
        }
    }

    loadColorScheme() {
        const savedScheme = localStorage.getItem('colorScheme');
        const body = document.body;
        if (savedScheme === 'reversed') {
            body.classList.add('color-mode-reversed');
            this.updateButtonText('红跌绿涨');
        } else {
            body.classList.remove('color-mode-reversed');
            this.updateButtonText('红涨绿跌');
        }
    }

    toggleColorScheme() {
        const body = document.body;
        const isReversed = body.classList.contains('color-mode-reversed');
        if (isReversed) {
            body.classList.remove('color-mode-reversed');
            this.updateButtonText('红涨绿跌');
            localStorage.setItem('colorScheme', 'default');
        } else {
            body.classList.add('color-mode-reversed');
            this.updateButtonText('红跌绿涨');
            localStorage.setItem('colorScheme', 'reversed');
        }
    }

    updateButtonText(text) {
        const toggleBtn = document.getElementById('trend-colors-btn');
        if (toggleBtn) toggleBtn.textContent = `THEME: ${text}`;
    }

    // ---- Toast ----
    showToast(title, message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
        toast.innerHTML = `
            <div class="toast-icon">${icons[type] || icons.info}</div>
            <div class="toast-content">
                <div class="toast-title">${title}</div>
                <div class="toast-message">${message}</div>
            </div>
            <button class="toast-close">×</button>`;
        container.appendChild(toast);
        toast.querySelector('.toast-close').addEventListener('click', () => { this.removeToast(toast); });
        const timeout = type === 'success' ? 3000 : 5000;
        setTimeout(() => { this.removeToast(toast); }, timeout);
    }

    removeToast(toast) {
        toast.classList.add('toast-removing');
        setTimeout(() => { toast.remove(); }, 300);
    }

    // ---- 平仓 ----
    async closePosition(symbol) {
        if (!confirm(`确认平仓 ${symbol}？`)) return;
        try {
            const buttons = document.querySelectorAll('.btn-close-position');
            buttons.forEach(btn => btn.disabled = true);
            console.log(`开始平仓: ${symbol}`);

            const response = await fetch('/api/close-position', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol }),
            });
            const result = await response.json();

            if (result.success) {
                const pnl = result.data.pnl.toFixed(2);
                const pnlText = result.data.pnl >= 0 ? `+${pnl}` : pnl;
                this.showToast('平仓成功', `${symbol} 已平仓，盈亏: ${pnlText} USDT`, 'success');
                await Promise.all([this.loadAccountData(), this.loadPositionsData(), this.loadTradesData()]);
            } else {
                this.showToast('平仓失败', result.message, 'error');
            }
        } catch (error) {
            console.error('平仓请求失败:', error);
            this.showToast('平仓失败', error.message, 'error');
        } finally {
            const buttons = document.querySelectorAll('.btn-close-position');
            buttons.forEach(btn => btn.disabled = false);
        }
    }
}

// 全局变量
let monitor;

document.addEventListener('DOMContentLoaded', () => {
    monitor = new TradingMonitor();
    monitor.init();
});
