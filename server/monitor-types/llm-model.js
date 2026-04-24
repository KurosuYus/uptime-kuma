const { MonitorType } = require("./monitor-type");
const { UP, DOWN, log } = require("../../src/util");
const axios = require("axios");
const { R } = require("redbean-node");

/**
 * LLM 模型健康监控类型
 * 支持主动探测和被动数据收集
 *
 * 核心概念：
 * - heartbeat interval (interval): 心跳显示间隔，控制多久更新一次 UI
 * - probe interval (probe_interval): 主动探测间隔，控制多久执行一次主动探测
 *
 * 逻辑：
 * 1. 被动上报：业务系统自主上报，更新 lastReportTime
 * 2. 主动探测：如果超过 probe_interval 没有被动上报，执行主动探测
 * 3. 心跳显示：按 interval 显示，有新数据显示，没有则保持上次结果
 */
class LLMModelMonitorType extends MonitorType {
    name = "llm-model";

    /**
     * 成本等级对应的探测间隔（秒）
     */
    static PROBE_INTERVALS = {
        low: 30,        // 30 秒
        medium: 120,    // 2 分钟
        high: 300,      // 5 分钟
        critical: 900,  // 15 分钟
    };

    /**
     * 健康分数计算权重
     */
    static HEALTH_WEIGHTS = {
        successRate: 0.7,    // 成功率权重 70%
        latency: 0.3,        // 延迟权重 30%
    };

    /**
     * 延迟阈值（毫秒）
     */
    static LATENCY_THRESHOLDS = {
        excellent: 1000,  // < 1s
        good: 3000,       // < 3s
        fair: 5000,       // < 5s
        poor: 10000,      // < 10s
    };

    /**
     * LLM 监控器状态管理器
     * 跟踪每个监控器的状态，实现独立的主动探测调度
     */
    static monitorStates = new Map();

    /**
     * 获取或创建监控器状态
     * @param {number} monitorId 监控器 ID
     * @returns {object} 监控器状态
     */
    static getMonitorState(monitorId) {
        if (!LLMModelMonitorType.monitorStates.has(monitorId)) {
            LLMModelMonitorType.monitorStates.set(monitorId, {
                lastReportTime: 0,        // 最后被动上报时间
                lastProbeTime: 0,          // 最后主动探测时间
                lastHeartbeat: null,       // 最后显示的心跳
                probeTimer: null,           // 探测定时器
                pendingProbeResult: null,   // 待显示的探测结果
                isProbing: false,          // 是否正在探测
            });
        }
        return LLMModelMonitorType.monitorStates.get(monitorId);
    }

    /**
     * 清理监控器状态
     * @param {number} monitorId 监控器 ID
     */
    static clearMonitorState(monitorId) {
        const state = LLMModelMonitorType.monitorStates.get(monitorId);
        if (state && state.probeTimer) {
            clearTimeout(state.probeTimer);
        }
        LLMModelMonitorType.monitorStates.delete(monitorId);
    }

    /**
     * 更新最后被动上报时间
     * @param {number} monitorId 监控器 ID
     */
    static updateLastReportTime(monitorId) {
        const state = LLMModelMonitorType.getMonitorState(monitorId);
        state.lastReportTime = Date.now();
    }

    /**
     * 启动主动探测调度器
     * 按 probe_interval 间隔执行主动探测
     * @param {object} monitor 监控器对象
     */
    static startProbeScheduler(monitor) {
        const state = LLMModelMonitorType.getMonitorState(monitor.id);

        // 如果已经有定时器在运行，不重复启动
        if (state.probeTimer) {
            return;
        }

        const probeIntervalMs = LLMModelMonitorType.getProbeInterval(monitor) * 1000;

        const scheduleNextProbe = () => {
            state.probeTimer = setTimeout(async () => {
                await LLMModelMonitorType.executeActiveProbe(monitor);
                scheduleNextProbe();  // 调度下一次探测
            }, probeIntervalMs);
        };

        // 启动探测定时器
        scheduleNextProbe();
        log.debug("llm-model", `Started probe scheduler for ${monitor.model_name}, interval: ${probeIntervalMs}ms`);
    }

    /**
     * 执行主动探测
     * @param {object} monitor 监控器对象
     * @returns {Promise<object>} 探测结果
     */
    static async executeActiveProbe(monitor) {
        const state = LLMModelMonitorType.getMonitorState(monitor.id);

        // 如果正在探测中，跳过
        if (state.isProbing) {
            log.debug("llm-model", `Probe already in progress for ${monitor.model_name}, skipping`);
            return null;
        }

        // 如果距离上次被动上报还没超过 probe_interval，跳过
        const probeIntervalMs = LLMModelMonitorType.getProbeInterval(monitor) * 1000;
        const timeSinceLastReport = Date.now() - state.lastReportTime;
        if (timeSinceLastReport < probeIntervalMs) {
            log.debug("llm-model", `Passive report received within probe interval for ${monitor.model_name}, skipping probe`);
            return null;
        }

        state.isProbing = true;
        const startTime = Date.now();

        try {
            log.debug("llm-model", `Executing active probe for ${monitor.model_name}`);

            // 构建探测请求
            const probePayload = LLMModelMonitorType.buildProbePayload(monitor);
            const apiEndpoint = monitor.llm_api_endpoint || monitor.url;
            const timeout = monitor.probe_timeout || 30000;

            // 发送探测请求
            const response = await axios.post(apiEndpoint, probePayload, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${monitor.llm_api_key}`,
                    "User-Agent": "Uptime-Kuma-LLM-Monitor",
                },
                timeout: timeout,
                validateStatus: (status) => status < 600,
            });

            const latency = Date.now() - startTime;

            // 分析响应
            const result = LLMModelMonitorType.analyzeResponse(response, latency, monitor);

            // 保存待显示的探测结果
            state.pendingProbeResult = {
                status: result.status,
                msg: result.message,
                ping: latency,
                time: Date.now(),
            };

            // 更新最后探测时间
            state.lastProbeTime = Date.now();

            // 记录成本
            await LLMModelMonitorType.logCost(monitor.id, probePayload, response.data, "active");

            log.debug("llm-model", `Active probe completed for ${monitor.model_name}: ${result.status}`);

            return result;

        } catch (error) {
            const latency = Date.now() - startTime;
            const errorMsg = LLMModelMonitorType.parseError(error);

            // 保存待显示的探测结果（失败）
            state.pendingProbeResult = {
                status: DOWN,
                msg: errorMsg,
                ping: latency,
                time: Date.now(),
            };

            // 更新最后探测时间
            state.lastProbeTime = Date.now();

            // 记录失败成本
            await LLMModelMonitorType.logCost(monitor.id, null, null, "active", errorMsg);

            log.warn("llm-model", `Active probe failed for ${monitor.model_name}: ${errorMsg}`);

            return { status: DOWN, message: errorMsg };

        } finally {
            state.isProbing = false;
        }
    }

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        const state = LLMModelMonitorType.getMonitorState(monitor.id);

        // 启动探测定时器（如果还没启动）
        if (monitor.active_probe) {
            LLMModelMonitorType.startProbeScheduler(monitor);
        }

        // 如果没有启用主动探测，直接标记为 UP（被动监控模式）
        if (!monitor.active_probe) {
            heartbeat.msg = "Passive monitoring only - no active probe";
            heartbeat.status = UP;
            heartbeat.ping = 0;
            return;
        }

        // 计算心跳间隔
        const heartbeatIntervalMs = (monitor.interval || 60) * 1000;
        const now = Date.now();

        // 检查是否有待显示的探测结果
        const hasPendingProbeResult = state.pendingProbeResult &&
            (now - state.pendingProbeResult.time) <= heartbeatIntervalMs;

        // 检查是否有新的被动上报
        const hasNewReport = state.lastReportTime > 0 &&
            (now - state.lastReportTime) <= heartbeatIntervalMs;

        // 检查是否需要显示新数据
        const hasNewData = hasPendingProbeResult || hasNewReport;

        if (hasNewData) {
            // 有新数据，生成新心跳

            if (hasPendingProbeResult && hasNewReport) {
                // 两者都有，优先使用探测结果（探测结果更实时）
                heartbeat.status = state.pendingProbeResult.status;
                heartbeat.msg = `Probe: ${state.pendingProbeResult.msg}`;
                heartbeat.ping = state.pendingProbeResult.ping;
            } else if (hasPendingProbeResult) {
                // 只有探测结果
                heartbeat.status = state.pendingProbeResult.status;
                heartbeat.msg = `Probe: ${state.pendingProbeResult.msg}`;
                heartbeat.ping = state.pendingProbeResult.ping;
            } else {
                // 只有被动上报（这种情况不应该发生，因为被动上报走的是聚合器）
                heartbeat.status = UP;
                heartbeat.msg = "Passive report received";
                heartbeat.ping = 0;
            }

            // 保存为最后显示的心跳
            state.lastHeartbeat = {
                status: heartbeat.status,
                msg: heartbeat.msg,
                ping: heartbeat.ping,
                time: now,
            };

            // 清除待显示的探测结果
            state.pendingProbeResult = null;

            // 如果状态不是 UP，必须抛出错误
            if (heartbeat.status !== UP) {
                throw new Error(heartbeat.msg);
            }

            // 更新健康分数
            await LLMModelMonitorType.updateHealthScore(monitor.id);

        } else {
            // 没有新数据，保持上次结果

            if (state.lastHeartbeat) {
                heartbeat.status = state.lastHeartbeat.status;
                heartbeat.msg = state.lastHeartbeat.msg + " (no new data)";
                heartbeat.ping = state.lastHeartbeat.ping;
            } else {
                // 没有任何数据，标记为未知
                heartbeat.status = UP;
                heartbeat.msg = "Waiting for data...";
                heartbeat.ping = 0;
            }

            // 不抛出错误，因为这是正常状态
            log.debug("llm-model", `No new data for ${monitor.model_name}, keeping last heartbeat`);
        }
    }

    /**
     * 构建探测请求负载
     * @param {object} monitor 监控对象
     * @returns {object} 请求负载
     */
    static buildProbePayload(monitor) {
        if (monitor.probe_payload) {
            try {
                return JSON.parse(monitor.probe_payload);
            } catch (e) {
                log.warn("llm-model", `Invalid probe_payload JSON for ${monitor.model_name}, using default`);
            }
        }

        return {
            model: monitor.model_name,
            messages: [
                {
                    role: "user",
                    content: "Hi"
                }
            ],
            max_tokens: 1,
            temperature: 0,
        };
    }

    /**
     * 分析 LLM API 响应
     * @param {object} response Axios 响应对象
     * @param {number} latency 请求延迟（毫秒）
     * @param {object} monitor 监控对象
     * @returns {object} 分析结果 { status, message }
     */
    static analyzeResponse(response, latency, monitor) {
        const statusCode = response.status;

        if (statusCode === 200 || statusCode === 201) {
            const data = response.data;

            if (!data) {
                return { status: DOWN, message: "Empty response body" };
            }

            if (data.error) {
                return {
                    status: DOWN,
                    message: `API Error: ${data.error.message || data.error.type || "Unknown error"}`
                };
            }

            if (!data.choices && !data.content && !data.response) {
                return {
                    status: DOWN,
                    message: "Invalid response format - missing choices/content/response"
                };
            }

            return {
                status: UP,
                message: `OK - ${latency}ms - Model: ${monitor.model_name}`
            };

        } else if (statusCode === 429) {
            return { status: DOWN, message: "Rate limit exceeded" };
        } else if (statusCode === 401 || statusCode === 403) {
            return { status: DOWN, message: "Authentication failed" };
        } else if (statusCode === 503 || statusCode === 504) {
            return { status: DOWN, message: "Service unavailable or timeout" };
        } else if (statusCode >= 500) {
            return { status: DOWN, message: `Server error: ${statusCode}` };
        } else {
            return { status: DOWN, message: `Unexpected status code: ${statusCode}` };
        }
    }

    /**
     * 解析错误信息
     * @param {Error} error 错误对象
     * @returns {string} 错误描述
     */
    static parseError(error) {
        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
            return "Request timeout";
        } else if (error.code === "ECONNREFUSED") {
            return "Connection refused";
        } else if (error.code === "ENOTFOUND") {
            return "DNS resolution failed";
        } else if (error.response) {
            const status = error.response.status;
            const data = error.response.data;

            if (status === 429) {
                return "Rate limit exceeded";
            } else if (status === 401 || status === 403) {
                return "Authentication failed";
            } else if (data && data.error) {
                return `API Error: ${data.error.message || data.error.type || status}`;
            } else {
                return `HTTP ${status}`;
            }
        } else if (error.message) {
            return error.message;
        } else {
            return "Unknown error";
        }
    }

    /**
     * 记录成本日志
     * @param {number} monitorId 监控 ID
     * @param {object} request 请求负载
     * @param {object} response 响应数据
     * @param {string} probeType 探测类型 (active/passive)
     * @param {string} errorMessage 错误信息（可选）
     * @returns {Promise<void>}
     */
    static async logCost(monitorId, request, response, probeType, errorMessage = null) {
        try {
            const bean = R.dispense("llm_cost_log");
            bean.monitor_id = monitorId;
            bean.timestamp = Date.now();
            bean.probe_type = probeType;
            bean.error_message = errorMessage;

            if (response && response.usage) {
                bean.tokens_used = response.usage.total_tokens || 0;
                bean.estimated_cost = LLMModelMonitorType.estimateCost(response.usage, monitorId);
            } else {
                bean.tokens_used = 1;
                bean.estimated_cost = 0.00001;
            }

            await R.store(bean);
        } catch (e) {
            log.error("llm-model", `Failed to log cost: ${e.message}`);
        }
    }

    /**
     * 估算成本
     * @param {object} usage Token 使用量对象
     * @param {number} monitorId 监控 ID
     * @returns {number} 估算成本（美元）
     */
    static estimateCost(usage, monitorId) {
        const totalTokens = usage.total_tokens || 0;
        return (totalTokens / 1000) * 0.01;
    }

    /**
     * 更新健康分数
     * @param {number} monitorId 监控 ID
     * @returns {Promise<void>}
     */
    static async updateHealthScore(monitorId) {
        try {
            const recentBeats = await R.getAll(
                "SELECT status, ping, time FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 20",
                [monitorId]
            );

            if (recentBeats.length === 0) {
                return;
            }

            const score = LLMModelMonitorType.calculateHealthScore(recentBeats);

            await R.exec(
                "UPDATE monitor SET health_score = ?, last_probe_time = ? WHERE id = ?",
                [score, Date.now(), monitorId]
            );

            log.debug("llm-model", `Updated health score for monitor ${monitorId}: ${score}`);

        } catch (e) {
            log.error("llm-model", `Failed to update health score: ${e.message}`);
        }
    }

    /**
     * 计算健康分数（0-100）
     * @param {Array} heartbeats 心跳记录数组
     * @returns {number} 健康分数
     */
    static calculateHealthScore(heartbeats) {
        if (heartbeats.length === 0) {
            return 100;
        }

        const successCount = heartbeats.filter(beat => beat.status === 1).length;
        const successRate = successCount / heartbeats.length;

        const successfulBeats = heartbeats.filter(beat => beat.status === 1 && beat.ping > 0);
        let latencyScore = 1.0;

        if (successfulBeats.length > 0) {
            const avgLatency = successfulBeats.reduce((sum, beat) => sum + beat.ping, 0) / successfulBeats.length;

            if (avgLatency < LLMModelMonitorType.LATENCY_THRESHOLDS.excellent) {
                latencyScore = 1.0;
            } else if (avgLatency < LLMModelMonitorType.LATENCY_THRESHOLDS.good) {
                latencyScore = 0.9;
            } else if (avgLatency < LLMModelMonitorType.LATENCY_THRESHOLDS.fair) {
                latencyScore = 0.7;
            } else if (avgLatency < LLMModelMonitorType.LATENCY_THRESHOLDS.poor) {
                latencyScore = 0.5;
            } else {
                latencyScore = 0.3;
            }
        }

        let weightedSuccessRate = 0;
        let totalWeight = 0;

        heartbeats.forEach((beat, index) => {
            const weight = Math.exp(-index * 0.1);
            totalWeight += weight;
            if (beat.status === 1) {
                weightedSuccessRate += weight;
            }
        });

        weightedSuccessRate = weightedSuccessRate / totalWeight;

        const healthScore = (
            weightedSuccessRate * LLMModelMonitorType.HEALTH_WEIGHTS.successRate +
            latencyScore * LLMModelMonitorType.HEALTH_WEIGHTS.latency
        ) * 100;

        return Math.round(Math.max(0, Math.min(100, healthScore)));
    }

    /**
     * 根据成本等级或自定义间隔获取探测间隔
     * @param {object} monitor 监控对象
     * @returns {number} 探测间隔（秒）
     */
    static getProbeInterval(monitor) {
        if (monitor.probe_interval && monitor.probe_interval > 0) {
            return monitor.probe_interval;
        }

        const costLevel = monitor.cost_level || "medium";
        return LLMModelMonitorType.PROBE_INTERVALS[costLevel] || LLMModelMonitorType.PROBE_INTERVALS.medium;
    }
}

module.exports = {
    LLMModelMonitorType,
};
