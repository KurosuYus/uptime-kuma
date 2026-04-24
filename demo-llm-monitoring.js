/**
 * LLM Health Monitoring Demo
 *
 * Simulates 3 LLM models with both passive reporting and active probing
 * - Mock API server on port 3003
 * - 200 passive reports per second
 * - Status changes every 30 seconds
 * - Supports active probe testing
 * - Continuous loop: 2 minutes reporting → 3 minutes silence → repeat
 */

const axios = require("axios");
const { io } = require("socket.io-client");
const express = require("express");
const bodyParser = require("body-parser");

// ============================================================================
// Configuration
// ============================================================================

const UPTIME_KUMA_URL = process.env.UPTIME_KUMA_URL || "http://localhost:3001";
const API_BASE = `${UPTIME_KUMA_URL}/api/llm-health`;
const MOCK_API_PORT = 3003;

const MODELS = [
    {
        name: "ZhipuAI/GLM5.1",
        endpoint: `http://localhost:${MOCK_API_PORT}/api/paas/v4/chat/completions`,
        apiKey: "zhipu_api_key_demo_abc123xyz789",
        provider: "zhipuai",
        baseLatency: 800,
        latencyVariance: 400
    },
    {
        name: "ltx-2.3-dev",
        endpoint: `http://localhost:${MOCK_API_PORT}/v1/ltx/generate`,
        apiKey: "ltx_sk_demo_def456uvw012",
        provider: "lightricks",
        baseLatency: 1200,
        latencyVariance: 600
    },
    {
        name: "Minimax/M2.7",
        endpoint: `http://localhost:${MOCK_API_PORT}/v1/text/chatcompletion_v2`,
        apiKey: "minimax_api_demo_ghi789rst345",
        provider: "minimax",
        baseLatency: 600,
        latencyVariance: 300
    }
];

const STATUS_MODES = {
    healthy: { successRate: 0.97, latencyMultiplier: 1.0, label: "HEALTHY" },
    degraded: { successRate: 0.75, latencyMultiplier: 1.8, label: "DEGRADED" },
    critical: { successRate: 0.50, latencyMultiplier: 3.0, label: "CRITICAL" }
};

const ERROR_CODES = ["timeout", "rate_limit", "server_error", "empty_response"];

// Timing configuration
const REPORTS_PER_SECOND = 200;
const REPORT_INTERVAL = 100; // Send batch every 100ms
const REPORTS_PER_BATCH = Math.ceil((REPORTS_PER_SECOND * REPORT_INTERVAL) / 1000);
const STATUS_CHANGE_INTERVAL = 30000; // 30 seconds
const REPORTING_DURATION = 120000;    // 2 minutes
const SILENCE_DURATION = 180000;      // 3 minutes
const STATS_DISPLAY_INTERVAL = 5000;  // 5 seconds

// ============================================================================
// Statistics Tracking
// ============================================================================

class Statistics {
    constructor() {
        this.models = {};
        MODELS.forEach(model => {
            this.models[model.name] = {
                totalReports: 0,
                successCount: 0,
                failureCount: 0,
                totalLatency: 0,
                healthScore: 100,
                currentStatus: "healthy"
            };
        });
        this.startTime = Date.now();
    }

    recordReport(modelName, success, latency) {
        const stats = this.models[modelName];
        stats.totalReports++;
        if (success) {
            stats.successCount++;
        } else {
            stats.failureCount++;
        }
        stats.totalLatency += latency;
    }

    getSuccessRate(modelName) {
        const stats = this.models[modelName];
        if (stats.totalReports === 0) return 0;
        return (stats.successCount / stats.totalReports) * 100;
    }

    getAvgLatency(modelName) {
        const stats = this.models[modelName];
        if (stats.totalReports === 0) return 0;
        return Math.round(stats.totalLatency / stats.totalReports);
    }

    updateHealthScore(modelName, score) {
        this.models[modelName].healthScore = score;
    }

    updateStatus(modelName, status) {
        this.models[modelName].currentStatus = status;
    }

    getElapsedTime() {
        return Math.floor((Date.now() - this.startTime) / 1000);
    }
}

// ============================================================================
// Status Controller
// ============================================================================

class StatusController {
    constructor() {
        this.modelStatuses = {};
        MODELS.forEach(model => {
            this.modelStatuses[model.name] = "healthy";
        });
    }

    changeStatus() {
        const changes = [];

        MODELS.forEach(model => {
            const currentStatus = this.modelStatuses[model.name];
            const rand = Math.random();

            let newStatus = currentStatus;

            // Status transition logic
            if (currentStatus === "healthy") {
                if (rand < 0.15) newStatus = "degraded";  // 15% chance to degrade
                else if (rand < 0.20) newStatus = "critical"; // 5% chance to go critical
            } else if (currentStatus === "degraded") {
                if (rand < 0.30) newStatus = "healthy";   // 30% chance to recover
                else if (rand < 0.45) newStatus = "critical"; // 15% chance to go critical
            } else if (currentStatus === "critical") {
                if (rand < 0.40) newStatus = "degraded";  // 40% chance to improve
                else if (rand < 0.50) newStatus = "healthy"; // 10% chance to fully recover
            }

            if (newStatus !== currentStatus) {
                changes.push({ model: model.name, from: currentStatus, to: newStatus });
            }

            this.modelStatuses[model.name] = newStatus;
        });

        return changes;
    }

    getStatus(modelName) {
        return this.modelStatuses[modelName];
    }
}

// ============================================================================
// Report Generator
// ============================================================================

function generateLatency(model, statusMode) {
    const base = model.baseLatency * statusMode.latencyMultiplier;
    const variance = model.latencyVariance * statusMode.latencyMultiplier;
    let latency = base + (Math.random() * variance * 2 - variance);

    // Add occasional spikes (5% chance)
    if (Math.random() < 0.05) {
        latency *= 2.5;
    }

    return Math.max(100, Math.round(latency));
}

function generateReport(model, statusMode) {
    const success = Math.random() < statusMode.successRate;
    const latency = generateLatency(model, statusMode);

    const report = {
        modelName: model.name,
        success: success,
        latency: latency,
        timestamp: Date.now()
    };

    // Add error code if failed
    if (!success) {
        report.errorCode = ERROR_CODES[Math.floor(Math.random() * ERROR_CODES.length)];
    }

    return report;
}

// ============================================================================
// API Communication
// ============================================================================

async function sendReportBatch(reports, retries = 3) {
    try {
        const response = await axios.post(`${API_BASE}/report-batch`, {
            reports: reports
        }, {
            timeout: 5000
        });

        return response.data;
    } catch (error) {
        if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
            return sendReportBatch(reports, retries - 1);
        }
        console.error(`Failed to send batch after retries: ${error.message}`);
        return null;
    }
}

async function fetchHealthScore(modelName) {
    try {
        const encodedName = encodeURIComponent(modelName);
        const response = await axios.get(`${API_BASE}/score/${encodedName}`, {
            timeout: 3000
        });

        if (response.data.ok) {
            return response.data.healthScore;
        }
    } catch (error) {
        // Silently fail - monitor might not exist yet
    }
    return null;
}

// ============================================================================
// Display Functions
// ============================================================================

function clearConsole() {
    // 不清屏，保留初始配置信息
    // console.log("\x1Bc");
}

function formatNumber(num) {
    return num.toLocaleString("en-US");
}

function getHealthColor(score) {
    if (score >= 90) return "\x1b[32m"; // Green
    if (score >= 70) return "\x1b[33m"; // Yellow
    return "\x1b[31m"; // Red
}

function getStatusColor(status) {
    if (status === "healthy") return "\x1b[32m";
    if (status === "degraded") return "\x1b[33m";
    return "\x1b[31m";
}

const RESET = "\x1b[0m";

async function displayStats(stats, statusController) {
    clearConsole();

    const elapsed = stats.getElapsedTime();
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║           LLM Health Monitoring Demo - Running                 ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log();
    console.log(`[${timeStr}] Elapsed Time`);
    console.log();

    // Fetch latest health scores
    for (const model of MODELS) {
        const score = await fetchHealthScore(model.name);
        if (score !== null) {
            stats.updateHealthScore(model.name, score);
        }
    }

    console.log("┌─────────────────────┬──────────┬─────────┬──────────┬────────┐");
    console.log("│ Model               │ Reports  │ Success │ Avg Lat  │ Health │");
    console.log("├─────────────────────┼──────────┼─────────┼──────────┼────────┤");

    MODELS.forEach(model => {
        const modelStats = stats.models[model.name];
        const successRate = stats.getSuccessRate(model.name);
        const avgLatency = stats.getAvgLatency(model.name);
        const healthScore = modelStats.healthScore;
        const status = statusController.getStatus(model.name);

        const healthColor = getHealthColor(healthScore);
        const statusColor = getStatusColor(status);

        const modelName = model.name.padEnd(19);
        const reports = formatNumber(modelStats.totalReports).padStart(8);
        const success = `${successRate.toFixed(1)}%`.padStart(7);
        const latency = `${avgLatency}ms`.padStart(8);
        const health = `${healthColor}${healthScore.toFixed(1)}${RESET}`.padStart(6 + 9); // +9 for color codes

        console.log(`│ ${modelName} │ ${reports} │ ${success} │ ${latency} │ ${health} │`);
    });

    console.log("└─────────────────────┴──────────┴─────────┴──────────┴────────┘");
    console.log();

    // Show current statuses
    console.log("Current Status:");
    MODELS.forEach(model => {
        const status = statusController.getStatus(model.name);
        const statusMode = STATUS_MODES[status];
        const color = getStatusColor(status);
        console.log(`  ${model.name}: ${color}${statusMode.label}${RESET}`);
    });
}

function logStatusChanges(changes, elapsed) {
    if (changes.length === 0) return;

    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    console.log();
    console.log(`[${timeStr}] Status Changes:`);
    changes.forEach(change => {
        const fromColor = getStatusColor(change.from);
        const toColor = getStatusColor(change.to);
        console.log(`  ${change.model}: ${fromColor}${STATUS_MODES[change.from].label}${RESET} → ${toColor}${STATUS_MODES[change.to].label}${RESET}`);
    });
}

// ============================================================================
// Main Demo Logic
// ============================================================================

async function runReportingPhase(stats, statusController) {
    console.log("\n🚀 Starting reporting phase (2 minutes)...\n");

    let reportInterval;
    let statusInterval;
    let displayInterval;

    return new Promise((resolve) => {
        // Report generation interval
        reportInterval = setInterval(async () => {
            const reports = [];

            // Generate reports for each model
            MODELS.forEach(model => {
                const status = statusController.getStatus(model.name);
                const statusMode = STATUS_MODES[status];

                // Generate multiple reports per batch to reach target RPS
                const reportsPerModel = Math.ceil(REPORTS_PER_BATCH / MODELS.length);
                for (let i = 0; i < reportsPerModel; i++) {
                    const report = generateReport(model, statusMode);
                    reports.push(report);
                    stats.recordReport(model.name, report.success, report.latency);
                }
            });

            // Send batch
            await sendReportBatch(reports);
        }, REPORT_INTERVAL);

        // Status change interval
        statusInterval = setInterval(() => {
            const changes = statusController.changeStatus();
            changes.forEach(change => {
                stats.updateStatus(change.model, change.to);
            });
            if (changes.length > 0) {
                logStatusChanges(changes, stats.getElapsedTime());
            }
        }, STATUS_CHANGE_INTERVAL);

        // Display update interval
        displayInterval = setInterval(async () => {
            await displayStats(stats, statusController);
        }, STATS_DISPLAY_INTERVAL);

        // Initial display
        displayStats(stats, statusController);

        // Stop after reporting duration
        setTimeout(() => {
            clearInterval(reportInterval);
            clearInterval(statusInterval);
            clearInterval(displayInterval);
            resolve();
        }, REPORTING_DURATION);
    });
}

async function runSilencePhase(stats, statusController) {
    console.log("\n⏸️  Stopping reports... (3 minute silence)\n");

    const silenceStart = Date.now();

    return new Promise((resolve) => {
        const displayInterval = setInterval(async () => {
            const elapsed = Math.floor((Date.now() - silenceStart) / 1000);
            const remaining = Math.floor((SILENCE_DURATION - (Date.now() - silenceStart)) / 1000);

            console.log("\n╔════════════════════════════════════════════════════════════════╗");
            console.log("║           LLM Health Monitoring Demo - Silence Phase           ║");
            console.log("╚════════════════════════════════════════════════════════════════╝");
            console.log();
            console.log(`⏸️  Reports stopped. Waiting ${remaining}s before restart...`);
            console.log();

            await displayStats(stats, statusController);
        }, STATS_DISPLAY_INTERVAL);

        setTimeout(() => {
            clearInterval(displayInterval);
            resolve();
        }, SILENCE_DURATION);
    });
}

// ============================================================================
// Mock API Server
// ============================================================================

const app = express();
app.use(bodyParser.json());

// Mock API statistics
const mockApiStats = {
    totalRequests: 0,
    requestsByModel: {}
};

MODELS.forEach(model => {
    mockApiStats.requestsByModel[model.name] = {
        total: 0,
        success: 0,
        failed: 0
    };
});

// Current scenario for each model
const currentScenarios = {};
MODELS.forEach(model => {
    currentScenarios[model.name] = "healthy";
});

/**
 * Generic handler for all LLM API endpoints
 */
async function handleMockApiRequest(req, res, modelName) {
    const model = MODELS.find(m => m.name === modelName);
    if (!model) {
        return res.status(404).json({ error: { message: "Model not found" } });
    }

    const scenario = currentScenarios[modelName];
    const statusMode = STATUS_MODES[scenario];

    mockApiStats.totalRequests++;
    mockApiStats.requestsByModel[modelName].total++;

    // Simulate latency
    const latency = generateLatency(model, statusMode);
    await new Promise(resolve => setTimeout(resolve, latency));

    // Determine success
    const success = Math.random() < statusMode.successRate;

    if (success) {
        mockApiStats.requestsByModel[modelName].success++;

        // Return success response based on provider
        if (model.provider === "zhipuai") {
            res.json({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{
                    index: 0,
                    message: { role: "assistant", content: "你好！有什么可以帮助你的吗？" },
                    finish_reason: "stop"
                }],
                usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
            });
        } else if (model.provider === "lightricks") {
            res.json({
                id: `ltx-${Date.now()}`,
                status: "completed",
                result: { text: "Hello! How can I help you?" },
                usage: { input_tokens: 10, output_tokens: 8 }
            });
        } else if (model.provider === "minimax") {
            res.json({
                base_resp: { status_code: 0, status_msg: "success" },
                reply: "你好！我是 Minimax 助手。",
                usage: { total_tokens: 18 }
            });
        }
    } else {
        mockApiStats.requestsByModel[modelName].failed++;

        // Return error response
        const errorCode = ERROR_CODES[Math.floor(Math.random() * ERROR_CODES.length)];
        const errorResponses = {
            timeout: { status: 504, body: { error: { message: "Request timeout", type: "timeout_error" } } },
            rate_limit: { status: 429, body: { error: { message: "Rate limit exceeded", type: "rate_limit_error" } } },
            server_error: { status: 500, body: { error: { message: "Internal server error", type: "server_error" } } },
            empty_response: { status: 502, body: { error: { message: "Empty response", type: "bad_gateway" } } }
        };

        const error = errorResponses[errorCode];
        res.status(error.status).json(error.body);
    }
}

// ZhipuAI endpoint
app.post("/api/paas/v4/chat/completions", (req, res) => handleMockApiRequest(req, res, "ZhipuAI/GLM5.1"));

// Lightricks endpoint
app.post("/v1/ltx/generate", (req, res) => handleMockApiRequest(req, res, "ltx-2.3-dev"));

// Minimax endpoint
app.post("/v1/text/chatcompletion_v2", (req, res) => handleMockApiRequest(req, res, "Minimax/M2.7"));

// Start Mock API server
function startMockApiServer() {
    return new Promise((resolve) => {
        app.listen(MOCK_API_PORT, () => {
            console.log(`✅ Mock API server started on http://localhost:${MOCK_API_PORT}`);
            console.log();
            resolve();
        });
    });
}

// ============================================================================
// Entry Point
// ============================================================================

async function runDemo() {
    // Start Mock API server first
    await startMockApiServer();

    // 显示初始配置（只显示一次，不会被清除）
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║           LLM Health Monitoring Demo                           ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log();
    console.log("Configuration:");
    console.log(`  - Mock API Port: ${MOCK_API_PORT}`);
    console.log(`  - Models: ${MODELS.length}`);
    console.log(`  - Reports per second: ${REPORTS_PER_SECOND}`);
    console.log(`  - Reporting duration: ${REPORTING_DURATION / 1000}s`);
    console.log(`  - Silence duration: ${SILENCE_DURATION / 1000}s`);
    console.log(`  - Status change interval: ${STATUS_CHANGE_INTERVAL / 1000}s`);
    console.log();
    console.log("Models:");
    MODELS.forEach(model => {
        console.log(`  - ${model.name} (${model.provider})`);
        console.log(`    Endpoint: ${model.endpoint}`);
        console.log(`    API Key: ${model.apiKey}`);
    });
    console.log();
    console.log("Press Ctrl+C to stop the demo");
    console.log();
    console.log("════════════════════════════════════════════════════════════════");
    console.log();

    await new Promise(resolve => setTimeout(resolve, 3000));

    let cycleCount = 0;
    // 全局统计（不重置）
    const globalStats = new Statistics();

    while (true) {
        cycleCount++;
        console.log(`\n🔄 Starting cycle #${cycleCount}\n`);

        // 每个循环使用全局统计和新的状态控制器
        const statusController = new StatusController();

        // Phase 1: Reporting (2 minutes)
        await runReportingPhase(globalStats, statusController);

        // Phase 2: Silence (3 minutes)
        await runSilencePhase(globalStats, statusController);

        console.log("\n✅ Cycle complete. Restarting...\n");
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

// ============================================================================
// Entry Point
// ============================================================================

// Handle graceful shutdown
process.on("SIGINT", () => {
    console.log("\n\n👋 Demo stopped by user.");
    console.log("\nFinal Mock API Statistics:");
    console.log(`  Total Requests: ${mockApiStats.totalRequests}`);
    MODELS.forEach(model => {
        const stats = mockApiStats.requestsByModel[model.name];
        console.log(`  ${model.name}: ${stats.total} requests (${stats.success} success, ${stats.failed} failed)`);
    });
    console.log("\nGoodbye!\n");
    process.exit(0);
});

// Start demo
runDemo().catch(error => {
    console.error("❌ Demo failed:", error);
    process.exit(1);
});
