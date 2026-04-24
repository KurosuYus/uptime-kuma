const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { LLMModelMonitorType } = require("../monitor-types/llm-model");

/**
 * LLM 监控 Socket.IO 事件处理器
 * @param {Socket} socket Socket.io 实例
 * @param {UptimeKumaServer} server Uptime Kuma 服务器实例
 * @returns {void}
 */
module.exports.llmMonitorSocketHandler = (socket, server) => {

    /**
     * 获取所有 LLM 模型监控列表
     */
    socket.on("getLLMMonitorList", async (callback) => {
        try {
            checkLogin(socket);

            const monitors = await R.findAll("monitor", "type = ? AND user_id = ?", ["llm-model", socket.userID]);

            const monitorList = [];
            for (const monitor of monitors) {
                // 获取最近的心跳统计
                const recentBeats = await R.getAll(
                    "SELECT status, ping FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 20",
                    [monitor.id]
                );

                const successCount = recentBeats.filter(beat => beat.status === 1).length;
                const totalCount = recentBeats.length;
                const successRate = totalCount > 0 ? (successCount / totalCount * 100).toFixed(2) : 0;

                const avgLatency = recentBeats.length > 0
                    ? (recentBeats.reduce((sum, beat) => sum + (beat.ping || 0), 0) / recentBeats.length).toFixed(2)
                    : 0;

                monitorList.push({
                    id: monitor.id,
                    name: monitor.name,
                    modelName: monitor.model_name,
                    upstreamProvider: monitor.upstream_provider,
                    costLevel: monitor.cost_level,
                    healthScore: monitor.health_score || 100,
                    lastProbeTime: monitor.last_probe_time,
                    activeProbe: monitor.active_probe,
                    active: monitor.active,
                    successRate: parseFloat(successRate),
                    avgLatency: parseFloat(avgLatency),
                    totalChecks: totalCount,
                });
            }

            callback({
                ok: true,
                monitors: monitorList,
            });

        } catch (e) {
            log.error("llm-monitor", `getLLMMonitorList error: ${e.message}`);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    /**
     * 获取单个 LLM 监控详情
     */
    socket.on("getLLMMonitorDetail", async (monitorId, callback) => {
        try {
            checkLogin(socket);

            const monitor = await R.load("monitor", monitorId);

            if (!monitor || monitor.user_id !== socket.userID) {
                throw new Error("Monitor not found or access denied");
            }

            if (monitor.type !== "llm-model") {
                throw new Error("Not a LLM monitor");
            }

            // 获取最近的心跳记录
            const recentBeats = await R.getAll(
                "SELECT status, ping, time, msg FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 50",
                [monitor.id]
            );

            // 获取成本日志
            const costLogs = await R.getAll(
                "SELECT * FROM llm_cost_log WHERE monitor_id = ? ORDER BY timestamp DESC LIMIT 100",
                [monitor.id]
            );

            // 计算统计数据
            const successCount = recentBeats.filter(beat => beat.status === 1).length;
            const totalCount = recentBeats.length;
            const successRate = totalCount > 0 ? (successCount / totalCount * 100).toFixed(2) : 0;

            const avgLatency = recentBeats.length > 0
                ? (recentBeats.reduce((sum, beat) => sum + (beat.ping || 0), 0) / recentBeats.length).toFixed(2)
                : 0;

            const totalCost = costLogs.reduce((sum, log) => sum + (log.estimated_cost || 0), 0);
            const totalTokens = costLogs.reduce((sum, log) => sum + (log.tokens_used || 0), 0);

            callback({
                ok: true,
                monitor: {
                    id: monitor.id,
                    name: monitor.name,
                    modelName: monitor.model_name,
                    upstreamProvider: monitor.upstream_provider,
                    costLevel: monitor.cost_level,
                    healthScore: monitor.health_score || 100,
                    lastProbeTime: monitor.last_probe_time,
                    activeProbe: monitor.active_probe,
                    probePayload: monitor.probe_payload,
                    llmApiEndpoint: monitor.llm_api_endpoint,
                    probeTimeout: monitor.probe_timeout,
                    interval: monitor.interval,
                },
                stats: {
                    successRate: parseFloat(successRate),
                    avgLatency: parseFloat(avgLatency),
                    totalChecks: totalCount,
                    totalCost: totalCost.toFixed(6),
                    totalTokens: totalTokens,
                },
                recentBeats: recentBeats,
                costLogs: costLogs,
            });

        } catch (e) {
            log.error("llm-monitor", `getLLMMonitorDetail error: ${e.message}`);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    /**
     * 更新 LLM 监控配置
     */
    socket.on("updateLLMMonitorConfig", async (monitorId, config, callback) => {
        try {
            checkLogin(socket);

            const monitor = await R.load("monitor", monitorId);

            if (!monitor || monitor.user_id !== socket.userID) {
                throw new Error("Monitor not found or access denied");
            }

            if (monitor.type !== "llm-model") {
                throw new Error("Not a LLM monitor");
            }

            // 更新配置
            if (config.costLevel !== undefined) {
                if (!["low", "medium", "high", "critical"].includes(config.costLevel)) {
                    throw new Error("Invalid cost level");
                }
                monitor.cost_level = config.costLevel;

                // 根据成本等级自动调整探测间隔
                const interval = LLMModelMonitorType.getProbeInterval(config.costLevel);
                monitor.interval = interval;
            }

            if (config.activeProbe !== undefined) {
                monitor.active_probe = config.activeProbe;
            }

            if (config.probePayload !== undefined) {
                // 验证 JSON 格式
                if (config.probePayload) {
                    try {
                        JSON.parse(config.probePayload);
                    } catch (e) {
                        throw new Error("Invalid probe payload JSON format");
                    }
                }
                monitor.probe_payload = config.probePayload;
            }

            if (config.probeTimeout !== undefined) {
                if (config.probeTimeout < 1000 || config.probeTimeout > 300000) {
                    throw new Error("Probe timeout must be between 1000ms and 300000ms");
                }
                monitor.probe_timeout = config.probeTimeout;
            }

            if (config.upstreamProvider !== undefined) {
                monitor.upstream_provider = config.upstreamProvider;
            }

            if (config.llmApiEndpoint !== undefined) {
                monitor.llm_api_endpoint = config.llmApiEndpoint;
            }

            if (config.llmApiKey !== undefined) {
                monitor.llm_api_key = config.llmApiKey;
            }

            await R.store(monitor);

            log.info("llm-monitor", `Updated LLM monitor config: ${monitor.name} (ID: ${monitorId})`);

            // 广播更新事件
            server.io.to(socket.userID).emit("llm-monitor-config-updated", {
                monitorId: monitorId,
                config: {
                    costLevel: monitor.cost_level,
                    activeProbe: monitor.active_probe,
                    interval: monitor.interval,
                },
            });

            callback({
                ok: true,
                message: "Configuration updated successfully",
            });

        } catch (e) {
            log.error("llm-monitor", `updateLLMMonitorConfig error: ${e.message}`);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    /**
     * 手动触发健康分数重新计算
     */
    socket.on("recalculateLLMHealthScore", async (monitorId, callback) => {
        try {
            checkLogin(socket);

            const monitor = await R.load("monitor", monitorId);

            if (!monitor || monitor.user_id !== socket.userID) {
                throw new Error("Monitor not found or access denied");
            }

            if (monitor.type !== "llm-model") {
                throw new Error("Not a LLM monitor");
            }

            // 重新计算健康分数
            const monitorType = new LLMModelMonitorType();
            await monitorType.updateHealthScore(monitorId);

            // 获取更新后的分数
            const updatedMonitor = await R.load("monitor", monitorId);

            // 推送更新
            server.io.to(socket.userID).emit("llm-health-score", {
                monitorId: monitorId,
                healthScore: updatedMonitor.health_score,
                modelName: updatedMonitor.model_name,
            });

            callback({
                ok: true,
                healthScore: updatedMonitor.health_score,
            });

        } catch (e) {
            log.error("llm-monitor", `recalculateLLMHealthScore error: ${e.message}`);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    /**
     * 获取 LLM 监控成本统计
     */
    socket.on("getLLMCostStats", async (monitorId, timeRange, callback) => {
        try {
            checkLogin(socket);

            const monitor = await R.load("monitor", monitorId);

            if (!monitor || monitor.user_id !== socket.userID) {
                throw new Error("Monitor not found or access denied");
            }

            if (monitor.type !== "llm-model") {
                throw new Error("Not a LLM monitor");
            }

            // 计算时间范围
            const now = Date.now();
            let startTime;
            switch (timeRange) {
                case "1h":
                    startTime = now - 3600 * 1000;
                    break;
                case "24h":
                    startTime = now - 24 * 3600 * 1000;
                    break;
                case "7d":
                    startTime = now - 7 * 24 * 3600 * 1000;
                    break;
                case "30d":
                    startTime = now - 30 * 24 * 3600 * 1000;
                    break;
                default:
                    startTime = now - 24 * 3600 * 1000; // 默认 24 小时
            }

            // 获取成本日志
            const costLogs = await R.getAll(
                "SELECT * FROM llm_cost_log WHERE monitor_id = ? AND timestamp >= ? ORDER BY timestamp DESC",
                [monitorId, startTime]
            );

            // 统计
            const totalCost = costLogs.reduce((sum, log) => sum + (log.estimated_cost || 0), 0);
            const totalTokens = costLogs.reduce((sum, log) => sum + (log.tokens_used || 0), 0);
            const activeProbes = costLogs.filter(log => log.probe_type === "active").length;
            const passiveReports = costLogs.filter(log => log.probe_type === "passive").length;
            const errors = costLogs.filter(log => log.error_message).length;

            callback({
                ok: true,
                stats: {
                    totalCost: totalCost.toFixed(6),
                    totalTokens: totalTokens,
                    activeProbes: activeProbes,
                    passiveReports: passiveReports,
                    errors: errors,
                    timeRange: timeRange,
                },
                logs: costLogs.slice(0, 50), // 最多返回 50 条
            });

        } catch (e) {
            log.error("llm-monitor", `getLLMCostStats error: ${e.message}`);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    /**
     * 获取所有 LLM 模型的健康分数概览
     */
    socket.on("getLLMHealthOverview", async (callback) => {
        try {
            checkLogin(socket);

            const monitors = await R.findAll("monitor", "type = ? AND user_id = ? AND active = 1", ["llm-model", socket.userID]);

            const overview = [];
            for (const monitor of monitors) {
                overview.push({
                    id: monitor.id,
                    name: monitor.name,
                    modelName: monitor.model_name,
                    healthScore: monitor.health_score || 100,
                    costLevel: monitor.cost_level,
                    upstreamProvider: monitor.upstream_provider,
                    lastProbeTime: monitor.last_probe_time,
                });
            }

            // 按健康分数排序
            overview.sort((a, b) => a.healthScore - b.healthScore);

            callback({
                ok: true,
                overview: overview,
                totalModels: overview.length,
                healthyModels: overview.filter(m => m.healthScore >= 80).length,
                warningModels: overview.filter(m => m.healthScore >= 50 && m.healthScore < 80).length,
                criticalModels: overview.filter(m => m.healthScore < 50).length,
            });

        } catch (e) {
            log.error("llm-monitor", `getLLMHealthOverview error: ${e.message}`);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
