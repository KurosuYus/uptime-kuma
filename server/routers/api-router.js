let express = require("express");
const {
    allowDevAllOrigin,
    allowAllOrigin,
    percentageToColor,
    filterAndJoin,
    sendHttpError,
} = require("../util-server");
const { R } = require("redbean-node");
const apicache = require("../modules/apicache");
const Monitor = require("../model/monitor");
const dayjs = require("dayjs");
const { UP, MAINTENANCE, DOWN, PENDING, flipStatus, log, badgeConstants } = require("../../src/util");
const StatusPage = require("../model/status_page");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { makeBadge } = require("badge-maker");
const { Prometheus } = require("../prometheus");
const Database = require("../database");
const { UptimeCalculator } = require("../uptime-calculator");
const { Settings } = require("../settings");
const { LLMModelMonitorType } = require("../monitor-types/llm-model");

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();
let io = server.io;

// ============================================================================
// LLM 监控报告聚合器
// ============================================================================

/**
 * 内存中的报告聚合器
 * 按心跳间隔收集报告，计算平均值后生成单个心跳
 */
class LLMReportAggregator {
    constructor() {
        // 存储每个监控器的聚合数据
        // monitorId -> { reports: [], lastHeartbeatTime: timestamp, timer: timeoutId }
        this.aggregators = new Map();
    }

    /**
     * 添加报告到聚合器
     * @param {number} monitorId 监控器 ID
     * @param {object} report 报告数据 { success, latency, errorCode, timestamp }
     * @param {object} monitor 监控器对象
     */
    async addReport(monitorId, report, monitor) {
        if (!this.aggregators.has(monitorId)) {
            this.aggregators.set(monitorId, {
                reports: [],
                lastHeartbeatTime: Date.now(),
                timer: null,
                monitor: monitor
            });
        }

        const aggregator = this.aggregators.get(monitorId);
        aggregator.reports.push(report);

        // 更新 LLM 监控器的最后被动上报时间
        // 这样主动探测就知道有被动数据进来了
        LLMModelMonitorType.updateLastReportTime(monitorId);

        // 如果还没有定时器，创建一个
        if (!aggregator.timer) {
            const intervalMs = (monitor.interval || 60) * 1000;
            aggregator.timer = setTimeout(async () => {
                await this.flushAggregator(monitorId);
            }, intervalMs);
        }
    }

    /**
     * 刷新聚合器，生成心跳
     * @param {number} monitorId 监控器 ID
     */
    async flushAggregator(monitorId) {
        const aggregator = this.aggregators.get(monitorId);
        if (!aggregator || aggregator.reports.length === 0) {
            return;
        }

        const { reports, monitor } = aggregator;

        try {
            // 计算聚合统计
            const totalReports = reports.length;
            const successCount = reports.filter(r => r.success).length;
            const failureCount = totalReports - successCount;
            const successRate = successCount / totalReports;

            // 计算平均延迟（只计算成功的）
            const successfulReports = reports.filter(r => r.success);
            const avgLatency = successfulReports.length > 0
                ? successfulReports.reduce((sum, r) => sum + r.latency, 0) / successfulReports.length
                : 0;

            // 决定整体状态：如果成功率 >= 50%，认为是 UP
            const overallSuccess = successRate >= 0.5;
            const status = overallSuccess ? UP : DOWN;

            // 收集错误代码（如果有）
            const errorCodes = reports
                .filter(r => !r.success && r.errorCode)
                .map(r => r.errorCode);
            const uniqueErrors = [...new Set(errorCodes)];

            // 生成消息
            let msg;
            if (overallSuccess) {
                msg = `OK (${successCount}/${totalReports} success, ${Math.round(avgLatency)}ms avg)`;
            } else {
                const errorSummary = uniqueErrors.length > 0 ? ` [${uniqueErrors.join(", ")}]` : "";
                msg = `Failed (${failureCount}/${totalReports} failures)${errorSummary}`;
            }

            // 创建心跳
            const previousHeartbeat = await Monitor.getPreviousHeartbeat(monitorId);
            let bean = R.dispense("heartbeat");
            bean.time = R.isoDateTimeMillis(dayjs.utc());
            bean.monitor_id = monitorId;
            bean.ping = Math.round(avgLatency);
            bean.msg = msg;
            bean.downCount = previousHeartbeat?.downCount || 0;

            if (previousHeartbeat) {
                bean.duration = dayjs(bean.time).diff(dayjs(previousHeartbeat.time), "second");
            }

            // 使用 determineStatus 来处理重试逻辑
            determineStatus(status, previousHeartbeat, monitor.maxretries, monitor.isUpsideDown(), bean);

            // 更新 uptime 计算器
            let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorId);
            let endTimeDayjs = await uptimeCalculator.update(bean.status, parseFloat(bean.ping));
            bean.end_time = R.isoDateTimeMillis(endTimeDayjs);

            bean.important = Monitor.isImportantBeat(!previousHeartbeat, previousHeartbeat?.status, bean.status);

            // 保存心跳
            await R.store(bean);

            // 推送到 UI
            io.to(monitor.user_id).emit("heartbeat", bean.toJSON());

            log.debug("llm-health", `Flushed aggregator for ${monitor.model_name}: ${totalReports} reports -> 1 heartbeat (${successRate * 100}% success)`);

        } catch (error) {
            log.error("llm-health", `Failed to flush aggregator for monitor ${monitorId}: ${error.message}`);
        } finally {
            // 清理聚合器
            aggregator.reports = [];
            aggregator.timer = null;
            aggregator.lastHeartbeatTime = Date.now();
        }
    }

    /**
     * 清理指定监控器的聚合器
     * @param {number} monitorId 监控器 ID
     */
    clearAggregator(monitorId) {
        const aggregator = this.aggregators.get(monitorId);
        if (aggregator && aggregator.timer) {
            clearTimeout(aggregator.timer);
        }
        this.aggregators.delete(monitorId);
    }
}

// 全局聚合器实例
const llmReportAggregator = new LLMReportAggregator();

router.get("/api/entry-page", async (request, response) => {
    allowDevAllOrigin(response);

    let result = {};
    let hostname = request.hostname;
    if ((await Settings.get("trustProxy")) && request.headers["x-forwarded-host"]) {
        hostname = request.headers["x-forwarded-host"];
    }

    if (hostname in StatusPage.domainMappingList) {
        result.type = "statusPageMatchedDomain";
        result.statusPageSlug = StatusPage.domainMappingList[hostname];
    } else {
        result.type = "entryPage";
        result.entryPage = server.entryPage;
    }
    response.json(result);
});

router.all("/api/push/:pushToken", async (request, response) => {
    try {
        let pushToken = request.params.pushToken;
        let msg = request.query.msg || "OK";
        let ping = parseFloat(request.query.ping) || null;
        let statusString = request.query.status || "up";
        const statusFromParam = statusString === "up" ? UP : DOWN;

        // Validate ping value - max 100 billion ms (~3.17 years)
        // Fits safely in both BIGINT and FLOAT(20,2)
        const MAX_PING_MS = 100000000000;
        if (ping !== null && (ping < 0 || ping > MAX_PING_MS)) {
            throw new Error(`Invalid ping value. Must be between 0 and ${MAX_PING_MS} ms.`);
        }

        let monitor = await R.findOne("monitor", " push_token = ? AND active = 1 ", [pushToken]);

        if (!monitor) {
            throw new Error("Monitor not found or not active.");
        }

        const previousHeartbeat = await Monitor.getPreviousHeartbeat(monitor.id);

        let isFirstBeat = true;

        let bean = R.dispense("heartbeat");
        bean.time = R.isoDateTimeMillis(dayjs.utc());
        bean.monitor_id = monitor.id;
        bean.ping = ping;
        bean.msg = msg;
        bean.downCount = previousHeartbeat?.downCount || 0;

        if (previousHeartbeat) {
            isFirstBeat = false;
            bean.duration = dayjs(bean.time).diff(dayjs(previousHeartbeat.time), "second");
        }

        if (await Monitor.isUnderMaintenance(monitor.id)) {
            msg = "Monitor under maintenance";
            bean.status = MAINTENANCE;
        } else {
            determineStatus(statusFromParam, previousHeartbeat, monitor.maxretries, monitor.isUpsideDown(), bean);
        }

        // Calculate uptime
        let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitor.id);
        let endTimeDayjs = await uptimeCalculator.update(bean.status, parseFloat(bean.ping));
        bean.end_time = R.isoDateTimeMillis(endTimeDayjs);

        log.debug("router", `/api/push/ called at ${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}`);
        log.debug("router", "PreviousStatus: " + previousHeartbeat?.status);
        log.debug("router", "Current Status: " + bean.status);

        bean.important = Monitor.isImportantBeat(isFirstBeat, previousHeartbeat?.status, bean.status);

        if (Monitor.isImportantForNotification(isFirstBeat, previousHeartbeat?.status, bean.status)) {
            // Reset down count
            bean.downCount = 0;

            log.debug("monitor", `[${monitor.name}] sendNotification`);
            await Monitor.sendNotification(isFirstBeat, monitor, bean);
        } else {
            if (bean.status === DOWN && monitor.resendInterval > 0) {
                ++bean.downCount;
                if (bean.downCount >= monitor.resendInterval) {
                    // Send notification again, because we are still DOWN
                    log.debug(
                        "monitor",
                        `[${monitor.name}] sendNotification again: Down Count: ${bean.downCount} | Resend Interval: ${monitor.resendInterval}`
                    );
                    await Monitor.sendNotification(isFirstBeat, monitor, bean);

                    // Reset down count
                    bean.downCount = 0;
                }
            }
        }

        await R.store(bean);

        io.to(monitor.user_id).emit("heartbeat", bean.toJSON());

        Monitor.sendStats(io, monitor.id, monitor.user_id);

        try {
            new Prometheus(monitor, await monitor.getTags()).update(bean, undefined);
        } catch (e) {
            log.error("prometheus", "Please submit an issue to our GitHub repo. Prometheus update error: ", e.message);
        }

        response.json({
            ok: true,
        });
    } catch (e) {
        response.status(404).json({
            ok: false,
            msg: e.message,
        });
    }
});

/**
 * LLM 健康监控 - 被动数据上报 API
 * POST /api/llm-health/report
 * Body: { modelName, success, latency, errorCode, timestamp, provider }
 */
router.post("/api/llm-health/report", async (request, response) => {
    try {
        allowDevAllOrigin(response);

        const { modelName, success, latency, errorCode, timestamp, provider } = request.body;

        // 参数验证
        if (!modelName) {
            throw new Error("modelName is required");
        }

        if (typeof success !== "boolean") {
            throw new Error("success must be a boolean");
        }

        // 查找对应的 LLM 监控器
        let monitor = await R.findOne(
            "monitor",
            "type = ? AND model_name = ? AND active = 1",
            ["llm-model", modelName]
        );

        if (!monitor) {
            throw new Error(`LLM monitor not found for model: ${modelName}`);
        }

        // 获取上一次心跳
        const previousHeartbeat = await Monitor.getPreviousHeartbeat(monitor.id);
        const isFirstBeat = !previousHeartbeat;

        // 创建心跳记录
        let bean = R.dispense("heartbeat");
        bean.time = timestamp ? R.isoDateTimeMillis(dayjs.utc(timestamp)) : R.isoDateTimeMillis(dayjs.utc());
        bean.monitor_id = monitor.id;
        bean.ping = latency || 0;
        bean.downCount = previousHeartbeat?.downCount || 0;

        // 设置消息
        if (success) {
            bean.msg = `Passive report: OK - ${latency}ms`;
        } else {
            bean.msg = errorCode || "Passive report: Failed";
        }

        // 计算持续时间
        if (previousHeartbeat) {
            bean.duration = dayjs(bean.time).diff(dayjs(previousHeartbeat.time), "second");
        }

        // 确定状态
        if (await Monitor.isUnderMaintenance(monitor.id)) {
            bean.status = MAINTENANCE;
        } else {
            const statusFromParam = success ? UP : DOWN;
            determineStatus(statusFromParam, previousHeartbeat, monitor.maxretries, monitor.isUpsideDown(), bean);
        }

        // 计算 uptime
        let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitor.id);
        let endTimeDayjs = await uptimeCalculator.update(bean.status, parseFloat(bean.ping));
        bean.end_time = R.isoDateTimeMillis(endTimeDayjs);

        bean.important = Monitor.isImportantBeat(isFirstBeat, previousHeartbeat?.status, bean.status);

        // 通知处理
        if (Monitor.isImportantForNotification(isFirstBeat, previousHeartbeat?.status, bean.status)) {
            bean.downCount = 0;
            await Monitor.sendNotification(isFirstBeat, monitor, bean);
        } else {
            if (bean.status === DOWN && monitor.resendInterval > 0) {
                ++bean.downCount;
                if (bean.downCount >= monitor.resendInterval) {
                    await Monitor.sendNotification(isFirstBeat, monitor, bean);
                    bean.downCount = 0;
                }
            }
        }

        // 保存心跳
        await R.store(bean);

        // 实时推送
        io.to(monitor.user_id).emit("heartbeat", bean.toJSON());
        Monitor.sendStats(io, monitor.id, monitor.user_id);

        // 记录被动成本日志
        try {
            const costBean = R.dispense("llm_cost_log");
            costBean.monitor_id = monitor.id;
            costBean.timestamp = Date.now();
            costBean.probe_type = "passive";
            costBean.model_name = modelName;
            costBean.estimated_cost = 0; // 被动监控无成本
            costBean.tokens_used = 0;
            if (!success && errorCode) {
                costBean.error_message = errorCode;
            }
            await R.store(costBean);
        } catch (e) {
            log.error("llm-health", `Failed to log passive cost: ${e.message}`);
        }

        // 更新健康分数
        try {
            const { LLMModelMonitorType } = require("../monitor-types/llm-model");
            const monitorType = new LLMModelMonitorType();
            await monitorType.updateHealthScore(monitor.id);

            // 推送健康分数更新
            const updatedMonitor = await R.load("monitor", monitor.id);
            io.to(monitor.user_id).emit("llm-health-score", {
                monitorId: monitor.id,
                healthScore: updatedMonitor.health_score,
                modelName: modelName,
            });
        } catch (e) {
            log.error("llm-health", `Failed to update health score: ${e.message}`);
        }

        response.json({
            ok: true,
            message: "Health data reported successfully",
            healthScore: monitor.health_score,
        });

    } catch (e) {
        log.error("llm-health", `Report error: ${e.message}`);
        response.status(400).json({
            ok: false,
            msg: e.message,
        });
    }
});

/**
 * LLM 健康监控 - 批量上报 API
 * POST /api/llm-health/report-batch
 * Body: { reports: [{ modelName, success, latency, errorCode, timestamp }] }
 */
router.post("/api/llm-health/report-batch", async (request, response) => {
    try {
        allowDevAllOrigin(response);

        const { reports } = request.body;

        if (!Array.isArray(reports) || reports.length === 0) {
            throw new Error("reports must be a non-empty array");
        }

        const results = [];
        const errors = [];

        for (const report of reports) {
            try {
                const { modelName, success, latency, errorCode, timestamp } = report;

                if (!modelName || typeof success !== "boolean") {
                    errors.push({ modelName, error: "Invalid report format" });
                    continue;
                }

                // 查找监控器
                let monitor = await R.findOne(
                    "monitor",
                    "type = ? AND model_name = ? AND active = 1",
                    ["llm-model", modelName]
                );

                if (!monitor) {
                    errors.push({ modelName, error: "Monitor not found" });
                    continue;
                }

                // 添加到聚合器（按心跳间隔聚合）
                await llmReportAggregator.addReport(monitor.id, {
                    success,
                    latency: latency || 0,
                    errorCode,
                    timestamp: timestamp || Date.now()
                }, monitor);

                results.push({ modelName, success: true });

            } catch (e) {
                errors.push({ modelName: report.modelName, error: e.message });
            }
        }

        response.json({
            ok: true,
            processed: results.length,
            errors: errors.length,
            results,
            errors,
        });

    } catch (e) {
        log.error("llm-health", `Batch report error: ${e.message}`);
        response.status(400).json({
            ok: false,
            msg: e.message,
        });
    }
});

/**
 * LLM 健康监控 - 获取健康分数
 * GET /api/llm-health/score/:modelName
 */
router.get("/api/llm-health/score/:modelName", async (request, response) => {
    try {
        allowDevAllOrigin(response);

        const { modelName } = request.params;

        let monitor = await R.findOne(
            "monitor",
            "type = ? AND model_name = ? AND active = 1",
            ["llm-model", modelName]
        );

        if (!monitor) {
            throw new Error(`LLM monitor not found for model: ${modelName}`);
        }

        // 获取最近的心跳统计
        const recentBeats = await R.getAll(
            "SELECT status, ping, time FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 20",
            [monitor.id]
        );

        const successCount = recentBeats.filter(beat => beat.status === 1).length;
        const totalCount = recentBeats.length;
        const successRate = totalCount > 0 ? (successCount / totalCount * 100).toFixed(2) : 0;

        const avgLatency = recentBeats.length > 0
            ? (recentBeats.reduce((sum, beat) => sum + (beat.ping || 0), 0) / recentBeats.length).toFixed(2)
            : 0;

        response.json({
            ok: true,
            modelName: monitor.model_name,
            healthScore: monitor.health_score || 100,
            successRate: parseFloat(successRate),
            avgLatency: parseFloat(avgLatency),
            totalChecks: totalCount,
            lastProbeTime: monitor.last_probe_time,
            costLevel: monitor.cost_level,
            upstreamProvider: monitor.upstream_provider,
        });

    } catch (e) {
        response.status(404).json({
            ok: false,
            msg: e.message,
        });
    }
});

router.get("/api/badge/:id/status", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        upLabel = "Up",
        downLabel = "Down",
        pendingLabel = "Pending",
        maintenanceLabel = "Maintenance",
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        pendingColor = badgeConstants.defaultPendingColor,
        maintenanceColor = badgeConstants.defaultMaintenanceColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }
        const overrideValue = value !== undefined ? parseInt(value) : undefined;
        const publicMonitor = await isMonitorPublic(requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const heartbeat = await Monitor.getPreviousHeartbeat(requestedMonitorId);
            const state = overrideValue !== undefined ? overrideValue : heartbeat.status;

            if (label === undefined) {
                badgeValues.label = "Status";
            } else {
                badgeValues.label = label;
            }
            switch (state) {
                case DOWN:
                    badgeValues.color = downColor;
                    badgeValues.message = downLabel;
                    break;
                case UP:
                    badgeValues.color = upColor;
                    badgeValues.message = upLabel;
                    break;
                case PENDING:
                    badgeValues.color = pendingColor;
                    badgeValues.message = pendingLabel;
                    break;
                case MAINTENANCE:
                    badgeValues.color = maintenanceColor;
                    badgeValues.message = maintenanceLabel;
                    break;
                default:
                    badgeValues.color = badgeConstants.naColor;
                    badgeValues.message = "N/A";
            }
        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/uptime/:duration?", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix = badgeConstants.defaultUptimeLabelSuffix,
        prefix,
        suffix = badgeConstants.defaultUptimeValueSuffix,
        color,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }
        // if no duration is given, set value to 24 (h)
        let requestedDuration = request.params.duration !== undefined ? request.params.duration : "24h";
        const overrideValue = value && parseFloat(value);

        if (/^[0-9]+$/.test(requestedDuration)) {
            requestedDuration = `${requestedDuration}h`;
        }

        const publicMonitor = await isMonitorPublic(requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent
            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(requestedMonitorId);
            const uptime = overrideValue ?? uptimeCalculator.getDataByDuration(requestedDuration).uptime;

            // limit the displayed uptime percentage to four (two, when displayed as percent) decimal digits
            const cleanUptime = (uptime * 100).toPrecision(4);

            // use a given, custom color or calculate one based on the uptime value
            badgeValues.color = color ?? percentageToColor(uptime);
            // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
            badgeValues.labelColor = labelColor ?? "";
            // build a label string. If a custom label is given, override the default one (requestedDuration)
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Uptime (${requestedDuration.slice(0, -1)}${labelSuffix})`,
            ]);
            badgeValues.message = filterAndJoin([prefix, cleanUptime, suffix]);
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/ping/:duration?", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix = badgeConstants.defaultPingLabelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        // Default duration is 24 (h) if not defined in queryParam, limited to 720h (30d)
        let requestedDuration = request.params.duration !== undefined ? request.params.duration : "24h";
        const overrideValue = value && parseFloat(value);

        if (/^[0-9]+$/.test(requestedDuration)) {
            requestedDuration = `${requestedDuration}h`;
        }

        // Check if monitor is public
        const publicMonitor = await isMonitorPublic(requestedMonitorId);

        const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(requestedMonitorId);
        const avgPing = uptimeCalculator.getDataByDuration(requestedDuration).avgPing;

        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const avgPingValue = parseInt(overrideValue ?? avgPing);

            badgeValues.color = color;
            // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
            badgeValues.labelColor = labelColor ?? "";
            // build a lable string. If a custom label is given, override the default one (requestedDuration)
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Avg. Ping (${requestedDuration.slice(0, -1)}${labelSuffix})`,
            ]);
            badgeValues.message = filterAndJoin([prefix, avgPingValue, suffix]);
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/avg-response/:duration?", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        // Default duration is 24 (h) if not defined in queryParam, limited to 720h (30d)
        const requestedDuration = Math.min(request.params.duration ? parseInt(request.params.duration, 10) : 24, 720);
        const overrideValue = value && parseFloat(value);

        const sqlHourOffset = Database.sqlHourOffset();

        const publicAvgPing = parseInt(
            await R.getCell(
                `
            SELECT AVG(ping) FROM monitor_group, \`group\`, heartbeat
            WHERE monitor_group.group_id = \`group\`.id
            AND heartbeat.time > ${sqlHourOffset}
            AND heartbeat.ping IS NOT NULL
            AND public = 1
            AND heartbeat.monitor_id = ?
            `,
                [-requestedDuration, requestedMonitorId]
            )
        );

        const badgeValues = { style };

        if (!publicAvgPing) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const avgPing = parseInt(overrideValue ?? publicAvgPing);

            badgeValues.color = color;
            // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
            badgeValues.labelColor = labelColor ?? "";
            // build a label string. If a custom label is given, override the default one (requestedDuration)
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Avg. Response (${requestedDuration}h)`,
                labelSuffix,
            ]);
            badgeValues.message = filterAndJoin([prefix, avgPing, suffix]);
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/cert-exp", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const date = request.query.date;

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = date ? "" : badgeConstants.defaultCertExpValueSuffix,
        upColor = badgeConstants.defaultUpColor,
        warnColor = badgeConstants.defaultWarnColor,
        downColor = badgeConstants.defaultDownColor,
        warnDays = badgeConstants.defaultCertExpireWarnDays,
        downDays = badgeConstants.defaultCertExpireDownDays,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        const overrideValue = value && parseFloat(value);
        const publicMonitor = await isMonitorPublic(requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const tlsInfoBean = await R.findOne("monitor_tls_info", "monitor_id = ?", [requestedMonitorId]);

            if (!tlsInfoBean) {
                // return a "No/Bad Cert" badge in naColor (grey), if no cert saved (does not save bad certs?)
                badgeValues.message = "No/Bad Cert";
                badgeValues.color = badgeConstants.naColor;
            } else {
                const tlsInfo = JSON.parse(tlsInfoBean.info_json);

                if (!tlsInfo.valid) {
                    // return a "Bad Cert" badge in naColor (grey), when cert is not valid
                    badgeValues.message = "Bad Cert";
                    badgeValues.color = downColor;
                } else {
                    const daysRemaining = parseInt(overrideValue ?? tlsInfo.certInfo.daysRemaining);

                    if (daysRemaining > warnDays) {
                        badgeValues.color = upColor;
                    } else if (daysRemaining > downDays) {
                        badgeValues.color = warnColor;
                    } else {
                        badgeValues.color = downColor;
                    }
                    // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
                    badgeValues.labelColor = labelColor ?? "";
                    // build a label string. If a custom label is given, override the default one
                    badgeValues.label = filterAndJoin([labelPrefix, label ?? "Cert Exp.", labelSuffix]);
                    badgeValues.message = filterAndJoin([
                        prefix,
                        date ? tlsInfo.certInfo.validTo : daysRemaining,
                        suffix,
                    ]);
                }
            }
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/response", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        const overrideValue = value && parseFloat(value);
        const publicMonitor = await isMonitorPublic(requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const heartbeat = await Monitor.getPreviousHeartbeat(requestedMonitorId);

            if (!heartbeat.ping) {
                // return a "N/A" badge in naColor (grey), if previous heartbeat has no ping

                badgeValues.message = "N/A";
                badgeValues.color = badgeConstants.naColor;
            } else {
                const ping = parseInt(overrideValue ?? heartbeat.ping);

                badgeValues.color = color;
                // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
                badgeValues.labelColor = labelColor ?? "";
                // build a label string. If a custom label is given, override the default one
                badgeValues.label = filterAndJoin([labelPrefix, label ?? "Response", labelSuffix]);
                badgeValues.message = filterAndJoin([prefix, ping, suffix]);
            }
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

/**
 * Determines the status of the next beat in the push route handling.
 * @param {string} status - The reported new status.
 * @param {object} previousHeartbeat - The previous heartbeat object.
 * @param {number} maxretries - The maximum number of retries allowed.
 * @param {boolean} isUpsideDown - Indicates if the monitor is upside down.
 * @param {object} bean - The new heartbeat object.
 * @returns {void}
 */
function determineStatus(status, previousHeartbeat, maxretries, isUpsideDown, bean) {
    if (isUpsideDown) {
        status = flipStatus(status);
    }

    if (previousHeartbeat) {
        if (previousHeartbeat.status === UP && status === DOWN) {
            // Going Down
            if (maxretries > 0 && previousHeartbeat.retries < maxretries) {
                // Retries available
                bean.retries = previousHeartbeat.retries + 1;
                bean.status = PENDING;
            } else {
                // No more retries
                bean.retries = 0;
                bean.status = DOWN;
            }
        } else if (previousHeartbeat.status === PENDING && status === DOWN && previousHeartbeat.retries < maxretries) {
            // Retries available
            bean.retries = previousHeartbeat.retries + 1;
            bean.status = PENDING;
        } else {
            // No more retries or not pending
            if (status === DOWN) {
                bean.retries = previousHeartbeat.retries + 1;
                bean.status = status;
            } else {
                bean.retries = 0;
                bean.status = status;
            }
        }
    } else {
        // First beat?
        if (status === DOWN && maxretries > 0) {
            // Retries available
            bean.retries = 1;
            bean.status = PENDING;
        } else {
            // Retires not enabled
            bean.retries = 0;
            bean.status = status;
        }
    }
}

/**
 * Check whether a monitor is publc
 * @param {number} monitorID - Monitor id
 * @returns {Promise<boolean>} true if the monitor is public, otherwise false
 */
async function isMonitorPublic(monitorID) {
    let publicMonitor = await R.getRow(
        `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND monitor_group.monitor_id = ?
            AND public = 1
        `,
        [monitorID]
    );
    return !!publicMonitor;
}

module.exports = router;
