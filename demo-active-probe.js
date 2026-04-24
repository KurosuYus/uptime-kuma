/**
 * LLM Active Probe Demo
 *
 * 模拟深夜/淡季场景：没有被动上报，完全依赖主动探测
 * - 不发送被动报告
 * - 只依赖 Uptime Kuma 的主动探测
 * - 可配置探测间隔
 * - 模拟真实 LLM API 响应
 */

const express = require("express");
const bodyParser = require("body-parser");

// ============================================================================
// Configuration
// ============================================================================

const MOCK_API_PORT = 3002;
const UPTIME_KUMA_URL = process.env.UPTIME_KUMA_URL || "http://localhost:3001";

// 模拟的 LLM 模型配置
const MODELS = [
    {
        name: "gpt-4-turbo",
        provider: "openai",
        endpoint: `http://localhost:${MOCK_API_PORT}/v1/chat/completions`,
        apiKey: "sk-demo-gpt4turbo-abc123",
        costLevel: "high",
        probeInterval: 60,  // 60 秒探测一次
        // 健康状态配置
        baseLatency: 1200,
        latencyVariance: 400,
        successRate: 0.98,
    },
    {
        name: "claude-3-opus",
        provider: "anthropic",
        endpoint: `http://localhost:${MOCK_API_PORT}/v1/messages`,
        apiKey: "sk-ant-demo-opus-def456",
        costLevel: "high",
        probeInterval: 90,  // 90 秒探测一次
        baseLatency: 1500,
        latencyVariance: 500,
        successRate: 0.97,
    },
    {
        name: "gemini-pro",
        provider: "google",
        endpoint: `http://localhost:${MOCK_API_PORT}/v1/models/gemini-pro:generateContent`,
        apiKey: "AIza-demo-gemini-ghi789",
        costLevel: "medium",
        probeInterval: 45,  // 45 秒探测一次
        baseLatency: 800,
        latencyVariance: 300,
        successRate: 0.99,
    }
];

// 模拟场景配置
const SCENARIOS = {
    healthy: {
        label: "健康",
        successRate: 0.98,
        latencyMultiplier: 1.0,
        errors: []
    },
    degraded: {
        label: "降级",
        successRate: 0.85,
        latencyMultiplier: 1.5,
        errors: ["rate_limit", "timeout"]
    },
    critical: {
        label: "严重",
        successRate: 0.60,
        latencyMultiplier: 2.5,
        errors: ["server_error", "timeout", "rate_limit"]
    },
    down: {
        label: "宕机",
        successRate: 0.0,
        latencyMultiplier: 0,
        errors: ["connection_refused"]
    }
};

// 当前场景状态
let currentScenarios = {};
MODELS.forEach(model => {
    currentScenarios[model.name] = "healthy";
});

// ============================================================================
// Mock LLM API Server
// ============================================================================

const app = express();
app.use(bodyParser.json());

// 统计信息
const stats = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    requestsByModel: {}
};

MODELS.forEach(model => {
    stats.requestsByModel[model.name] = {
        total: 0,
        success: 0,
        failed: 0
    };
});

/**
 * 生成模拟延迟
 */
function generateLatency(model, scenario) {
    const scenarioConfig = SCENARIOS[scenario];
    const base = model.baseLatency * scenarioConfig.latencyMultiplier;
    const variance = model.latencyVariance * scenarioConfig.latencyMultiplier;
    const latency = base + (Math.random() * variance * 2 - variance);
    return Math.max(100, Math.round(latency));
}

/**
 * 判断是否成功
 */
function shouldSucceed(model, scenario) {
    const scenarioConfig = SCENARIOS[scenario];
    const modelSuccessRate = model.successRate;
    const scenarioSuccessRate = scenarioConfig.successRate;
    const finalSuccessRate = modelSuccessRate * scenarioSuccessRate;
    return Math.random() < finalSuccessRate;
}

/**
 * 生成错误响应
 */
function generateError(scenario) {
    const scenarioConfig = SCENARIOS[scenario];
    const errors = scenarioConfig.errors;

    if (errors.length === 0) {
        return {
            status: 500,
            body: {
                error: {
                    message: "Unknown error",
                    type: "server_error",
                    code: "unknown_error"
                }
            }
        };
    }
    const errorType = errors[Math.floor(Math.random() * errors.length)];

    const errorResponses = {
        rate_limit: {
            status: 429,
            body: {
                error: {
                    message: "Rate limit exceeded. Please try again later.",
                    type: "rate_limit_error",
                    code: "rate_limit_exceeded"
                }
            }
        },
        timeout: {
            status: 504,
            body: {
                error: {
                    message: "Request timeout",
                    type: "timeout_error",
                    code: "request_timeout"
                }
            }
        },
        server_error: {
            status: 500,
            body: {
                error: {
                    message: "Internal server error",
                    type: "server_error",
                    code: "internal_error"
                }
            }
        },
        connection_refused: {
            status: 503,
            body: {
                error: {
                    message: "Service unavailable",
                    type: "service_unavailable",
                    code: "connection_refused"
                }
            }
        }
    };

    return errorResponses[errorType];
}

/**
 * OpenAI 格式 API (gpt-4-turbo)
 */
app.post("/v1/chat/completions", async (req, res) => {
    const model = MODELS.find(m => m.provider === "openai");
    const scenario = currentScenarios[model.name];
    const latency = generateLatency(model, scenario);

    stats.totalRequests++;
    stats.requestsByModel[model.name].total++;

    // 模拟延迟
    await new Promise(resolve => setTimeout(resolve, latency));

    // 判断是否成功
    if (shouldSucceed(model, scenario)) {
        stats.successRequests++;
        stats.requestsByModel[model.name].success++;

        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model.name,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: "Hello! How can I help you today?"
                    },
                    finish_reason: "stop"
                }
            ],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 8,
                total_tokens: 18
            }
        });
    } else {
        stats.failedRequests++;
        stats.requestsByModel[model.name].failed++;

        const error = generateError(scenario);
        res.status(error.status).json(error.body);
    }
});

/**
 * Anthropic 格式 API (claude-3-opus)
 */
app.post("/v1/messages", async (req, res) => {
    const model = MODELS.find(m => m.provider === "anthropic");
    const scenario = currentScenarios[model.name];
    const latency = generateLatency(model, scenario);

    stats.totalRequests++;
    stats.requestsByModel[model.name].total++;

    await new Promise(resolve => setTimeout(resolve, latency));

    if (shouldSucceed(model, scenario)) {
        stats.successRequests++;
        stats.requestsByModel[model.name].success++;

        res.json({
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [
                {
                    type: "text",
                    text: "Hello! How can I assist you today?"
                }
            ],
            model: model.name,
            stop_reason: "end_turn",
            usage: {
                input_tokens: 10,
                output_tokens: 8
            }
        });
    } else {
        stats.failedRequests++;
        stats.requestsByModel[model.name].failed++;

        const error = generateError(scenario);
        res.status(error.status).json(error.body);
    }
});

/**
 * Google 格式 API (gemini-pro)
 */
app.post("/v1/models/gemini-pro:generateContent", async (req, res) => {
    const model = MODELS.find(m => m.provider === "google");
    const scenario = currentScenarios[model.name];
    const latency = generateLatency(model, scenario);

    stats.totalRequests++;
    stats.requestsByModel[model.name].total++;

    await new Promise(resolve => setTimeout(resolve, latency));

    if (shouldSucceed(model, scenario)) {
        stats.successRequests++;
        stats.requestsByModel[model.name].success++;

        res.json({
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                text: "Hello! How can I help you today?"
                            }
                        ],
                        role: "model"
                    },
                    finishReason: "STOP",
                    index: 0
                }
            ],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 8,
                totalTokenCount: 18
            }
        });
    } else {
        stats.failedRequests++;
        stats.requestsByModel[model.name].failed++;

        const error = generateError(scenario);
        res.status(error.status).json(error.body);
    }
});

// ============================================================================
// Scenario Control
// ============================================================================

/**
 * 随机改变场景
 */
function changeScenarios() {
    const scenarioKeys = Object.keys(SCENARIOS);
    const changes = [];

    MODELS.forEach(model => {
        // 30% 概率改变场景
        if (Math.random() < 0.3) {
            const oldScenario = currentScenarios[model.name];
            let newScenario;

            // 根据当前状态决定转换概率
            if (oldScenario === "healthy") {
                const rand = Math.random();
                if (rand < 0.7) newScenario = "healthy";  // 70% 保持健康
                else if (rand < 0.95) newScenario = "degraded";  // 25% 降级
                else newScenario = "critical";  // 5% 严重
            } else if (oldScenario === "degraded") {
                const rand = Math.random();
                if (rand < 0.5) newScenario = "healthy";  // 50% 恢复
                else if (rand < 0.8) newScenario = "degraded";  // 30% 保持
                else newScenario = "critical";  // 20% 恶化
            } else if (oldScenario === "critical") {
                const rand = Math.random();
                if (rand < 0.4) newScenario = "degraded";  // 40% 好转
                else if (rand < 0.7) newScenario = "critical";  // 30% 保持
                else newScenario = "down";  // 30% 宕机
            } else if (oldScenario === "down") {
                const rand = Math.random();
                if (rand < 0.6) newScenario = "critical";  // 60% 恢复到严重
                else newScenario = "down";  // 40% 保持宕机
            }

            if (newScenario !== oldScenario) {
                currentScenarios[model.name] = newScenario;
                changes.push({
                    model: model.name,
                    from: SCENARIOS[oldScenario].label,
                    to: SCENARIOS[newScenario].label
                });
            }
        }
    });

    return changes;
}

// ============================================================================
// Display Functions
// ============================================================================

function displayStats() {
    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║         LLM Active Probe Demo - Mock API Statistics           ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log();

    const successRate = stats.totalRequests > 0
        ? ((stats.successRequests / stats.totalRequests) * 100).toFixed(2)
        : 0;

    console.log(`Total Requests: ${stats.totalRequests}`);
    console.log(`Success: ${stats.successRequests} | Failed: ${stats.failedRequests}`);
    console.log(`Success Rate: ${successRate}%`);
    console.log();

    console.log("┌─────────────────────┬──────────┬─────────┬─────────┬──────────┐");
    console.log("│ Model               │ Requests │ Success │ Failed  │ Scenario │");
    console.log("├─────────────────────┼──────────┼─────────┼─────────┼──────────┤");

    MODELS.forEach(model => {
        const modelStats = stats.requestsByModel[model.name];
        const scenario = currentScenarios[model.name];
        const scenarioLabel = SCENARIOS[scenario].label;

        const scenarioColor =
            scenario === "healthy" ? "\x1b[32m" :
            scenario === "degraded" ? "\x1b[33m" :
            scenario === "critical" ? "\x1b[31m" :
            "\x1b[35m";  // down = magenta

        console.log(`│ ${model.name.padEnd(19)} │ ${String(modelStats.total).padStart(8)} │ ${String(modelStats.success).padStart(7)} │ ${String(modelStats.failed).padStart(7)} │ ${scenarioColor}${scenarioLabel.padEnd(8)}\x1b[0m│`);
    });

    console.log("└─────────────────────┴──────────┴─────────┴─────────┴──────────┘");
    console.log();

    console.log("Current Scenarios:");
    MODELS.forEach(model => {
        const scenario = currentScenarios[model.name];
        const scenarioConfig = SCENARIOS[scenario];
        console.log(`  ${model.name}: ${scenarioConfig.label} (${(scenarioConfig.successRate * 100).toFixed(0)}% success rate)`);
    });
}

// ============================================================================
// Main
// ============================================================================

async function startDemo() {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║           LLM Active Probe Demo - Mock API Server             ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log();
    console.log("This demo simulates a deep night / low season scenario:");
    console.log("  - No passive reports");
    console.log("  - Only active probes from Uptime Kuma");
    console.log("  - Configurable probe intervals");
    console.log();
    console.log("Mock API Configuration:");
    console.log(`  - Port: ${MOCK_API_PORT}`);
    console.log(`  - Models: ${MODELS.length}`);
    console.log();
    console.log("Models:");
    MODELS.forEach(model => {
        console.log(`  - ${model.name} (${model.provider})`);
        console.log(`    Endpoint: ${model.endpoint}`);
        console.log(`    API Key: ${model.apiKey}`);
        console.log(`    Probe Interval: ${model.probeInterval}s`);
        console.log(`    Cost Level: ${model.costLevel}`);
    });
    console.log();
    console.log("════════════════════════════════════════════════════════════════");
    console.log();

    // 启动 Mock API 服务器
    app.listen(MOCK_API_PORT, () => {
        console.log(`✅ Mock API server started on http://localhost:${MOCK_API_PORT}`);
        console.log();
        console.log("Next steps:");
        console.log("  1. Create monitors in Uptime Kuma UI:");
        console.log("     - Type: LLM Model Health Monitor");
        console.log("     - Enable 'Active Probe'");
        console.log("     - Set 'Heartbeat Interval' to match probe interval");
        console.log("     - Use the endpoints and API keys shown above");
        console.log();
        console.log("  2. Watch the statistics below");
        console.log("  3. Scenarios will change every 60 seconds");
        console.log();
        console.log("Press Ctrl+C to stop");
        console.log();
        console.log("════════════════════════════════════════════════════════════════");
    });

    // 定期显示统计
    setInterval(() => {
        displayStats();
    }, 10000);  // 每 10 秒显示一次

    // 定期改变场景
    setInterval(() => {
        const changes = changeScenarios();
        if (changes.length > 0) {
            console.log("\n🔄 Scenario Changes:");
            changes.forEach(change => {
                console.log(`  ${change.model}: ${change.from} → ${change.to}`);
            });
        }
    }, 60000);  // 每 60 秒改变一次

    // 初始显示
    setTimeout(() => {
        displayStats();
    }, 3000);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
    console.log("\n\n👋 Demo stopped. Final statistics:\n");
    displayStats();
    process.exit(0);
});

// Start
startDemo().catch(error => {
    console.error("❌ Demo failed:", error);
    process.exit(1);
});

