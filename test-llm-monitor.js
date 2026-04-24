#!/usr/bin/env node

/**
 * LLM 监控系统测试脚本
 *
 * 用法：
 *   node test-llm-monitor.js
 *
 * 功能：
 *   1. 测试被动数据上报 API
 *   2. 测试批量上报 API
 *   3. 测试健康分数查询 API
 *   4. 模拟多个模型的并发上报
 */

const axios = require("axios");

// 配置
const UPTIME_KUMA_URL = process.env.UPTIME_KUMA_URL || "http://localhost:3001";
const TEST_MODELS = [
    { name: "gpt-4-turbo", provider: "openai" },
    { name: "claude-3-opus", provider: "anthropic" },
    { name: "grok-2", provider: "openrouter" },
];

// 颜色输出
const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
};

function log(message, color = "reset") {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message) {
    log(`✓ ${message}`, "green");
}

function error(message) {
    log(`✗ ${message}`, "red");
}

function info(message) {
    log(`ℹ ${message}`, "blue");
}

function warn(message) {
    log(`⚠ ${message}`, "yellow");
}

// 测试函数

/**
 * 测试单个被动数据上报
 */
async function testSingleReport() {
    info("Testing single passive report...");

    try {
        const response = await axios.post(`${UPTIME_KUMA_URL}/api/llm-health/report`, {
            modelName: "gpt-4-turbo",
            success: true,
            latency: 1250,
            errorCode: null,
            timestamp: Date.now(),
            provider: "openai",
        });

        if (response.data.ok) {
            success(`Single report successful. Health score: ${response.data.healthScore}`);
            return true;
        } else {
            error(`Single report failed: ${response.data.msg}`);
            return false;
        }
    } catch (err) {
        error(`Single report error: ${err.message}`);
        if (err.response) {
            error(`Response: ${JSON.stringify(err.response.data)}`);
        }
        return false;
    }
}

/**
 * 测试批量上报
 */
async function testBatchReport() {
    info("Testing batch report...");

    const reports = [];
    for (let i = 0; i < 10; i++) {
        reports.push({
            modelName: TEST_MODELS[i % TEST_MODELS.length].name,
            success: Math.random() > 0.1, // 90% 成功率
            latency: Math.floor(Math.random() * 3000) + 500,
            timestamp: Date.now() - i * 1000,
        });
    }

    try {
        const response = await axios.post(`${UPTIME_KUMA_URL}/api/llm-health/report-batch`, {
            reports: reports,
        });

        if (response.data.ok) {
            success(`Batch report successful. Processed: ${response.data.processed}, Errors: ${response.data.errors}`);
            if (response.data.errors > 0) {
                warn(`Errors: ${JSON.stringify(response.data.errors)}`);
            }
            return true;
        } else {
            error(`Batch report failed: ${response.data.msg}`);
            return false;
        }
    } catch (err) {
        error(`Batch report error: ${err.message}`);
        return false;
    }
}

/**
 * 测试健康分数查询
 */
async function testHealthScoreQuery() {
    info("Testing health score query...");

    try {
        const response = await axios.get(`${UPTIME_KUMA_URL}/api/llm-health/score/gpt-4-turbo`);

        if (response.data.ok) {
            success(`Health score query successful`);
            console.log(`  Model: ${response.data.modelName}`);
            console.log(`  Health Score: ${response.data.healthScore}`);
            console.log(`  Success Rate: ${response.data.successRate}%`);
            console.log(`  Avg Latency: ${response.data.avgLatency}ms`);
            console.log(`  Total Checks: ${response.data.totalChecks}`);
            console.log(`  Cost Level: ${response.data.costLevel}`);
            return true;
        } else {
            error(`Health score query failed: ${response.data.msg}`);
            return false;
        }
    } catch (err) {
        error(`Health score query error: ${err.message}`);
        return false;
    }
}

/**
 * 模拟真实场景：多个模型并发上报
 */
async function simulateRealScenario(duration = 30) {
    info(`Simulating real scenario for ${duration} seconds...`);

    const startTime = Date.now();
    let reportCount = 0;
    let successCount = 0;
    let errorCount = 0;

    const interval = setInterval(async () => {
        const model = TEST_MODELS[Math.floor(Math.random() * TEST_MODELS.length)];
        const success = Math.random() > 0.05; // 95% 成功率
        const latency = Math.floor(Math.random() * 5000) + 200;

        try {
            await axios.post(`${UPTIME_KUMA_URL}/api/llm-health/report`, {
                modelName: model.name,
                success: success,
                latency: latency,
                errorCode: success ? null : "Simulated error",
                timestamp: Date.now(),
                provider: model.provider,
            });
            reportCount++;
            successCount++;
        } catch (err) {
            reportCount++;
            errorCount++;
        }

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        process.stdout.write(`\r  Reports: ${reportCount}, Success: ${successCount}, Errors: ${errorCount}, Elapsed: ${elapsed}s`);

    }, 1000); // 每秒上报一次

    return new Promise((resolve) => {
        setTimeout(() => {
            clearInterval(interval);
            console.log(); // 换行
            success(`Simulation completed. Total reports: ${reportCount}`);
            resolve(true);
        }, duration * 1000);
    });
}

/**
 * 测试错误处理
 */
async function testErrorHandling() {
    info("Testing error handling...");

    const tests = [
        {
            name: "Missing modelName",
            data: { success: true, latency: 1000 },
            shouldFail: true,
        },
        {
            name: "Invalid success type",
            data: { modelName: "test", success: "yes", latency: 1000 },
            shouldFail: true,
        },
        {
            name: "Non-existent model",
            data: { modelName: "non-existent-model-xyz", success: true, latency: 1000 },
            shouldFail: true,
        },
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        try {
            const response = await axios.post(`${UPTIME_KUMA_URL}/api/llm-health/report`, test.data);

            if (test.shouldFail) {
                if (!response.data.ok) {
                    success(`  ${test.name}: Correctly rejected`);
                    passed++;
                } else {
                    error(`  ${test.name}: Should have failed but succeeded`);
                    failed++;
                }
            } else {
                if (response.data.ok) {
                    success(`  ${test.name}: Passed`);
                    passed++;
                } else {
                    error(`  ${test.name}: Failed unexpectedly`);
                    failed++;
                }
            }
        } catch (err) {
            if (test.shouldFail) {
                success(`  ${test.name}: Correctly rejected with error`);
                passed++;
            } else {
                error(`  ${test.name}: Failed with error: ${err.message}`);
                failed++;
            }
        }
    }

    info(`Error handling tests: ${passed} passed, ${failed} failed`);
    return failed === 0;
}

/**
 * 性能测试：批量并发上报
 */
async function testPerformance() {
    info("Testing performance with concurrent requests...");

    const concurrency = 10;
    const requestsPerClient = 10;
    const startTime = Date.now();

    const promises = [];
    for (let i = 0; i < concurrency; i++) {
        const promise = (async () => {
            for (let j = 0; j < requestsPerClient; j++) {
                const model = TEST_MODELS[j % TEST_MODELS.length];
                await axios.post(`${UPTIME_KUMA_URL}/api/llm-health/report`, {
                    modelName: model.name,
                    success: true,
                    latency: Math.floor(Math.random() * 2000) + 500,
                    timestamp: Date.now(),
                });
            }
        })();
        promises.push(promise);
    }

    try {
        await Promise.all(promises);
        const duration = Date.now() - startTime;
        const totalRequests = concurrency * requestsPerClient;
        const rps = (totalRequests / (duration / 1000)).toFixed(2);

        success(`Performance test completed`);
        console.log(`  Total requests: ${totalRequests}`);
        console.log(`  Duration: ${duration}ms`);
        console.log(`  Requests per second: ${rps}`);
        return true;
    } catch (err) {
        error(`Performance test failed: ${err.message}`);
        return false;
    }
}

/**
 * 主测试流程
 */
async function runTests() {
    console.log("\n" + "=".repeat(60));
    log("LLM Monitor System Test Suite", "blue");
    console.log("=".repeat(60) + "\n");

    info(`Testing against: ${UPTIME_KUMA_URL}`);
    console.log();

    const results = {
        singleReport: false,
        batchReport: false,
        healthScoreQuery: false,
        errorHandling: false,
        performance: false,
        simulation: false,
    };

    // 运行测试
    results.singleReport = await testSingleReport();
    console.log();

    results.batchReport = await testBatchReport();
    console.log();

    results.healthScoreQuery = await testHealthScoreQuery();
    console.log();

    results.errorHandling = await testErrorHandling();
    console.log();

    results.performance = await testPerformance();
    console.log();

    // 询问是否运行模拟
    const readline = require("readline");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.question("Run real scenario simulation? (y/n): ", async (answer) => {
        if (answer.toLowerCase() === "y") {
            results.simulation = await simulateRealScenario(30);
            console.log();
        }

        // 输出总结
        console.log("\n" + "=".repeat(60));
        log("Test Results Summary", "blue");
        console.log("=".repeat(60) + "\n");

        const testNames = {
            singleReport: "Single Report",
            batchReport: "Batch Report",
            healthScoreQuery: "Health Score Query",
            errorHandling: "Error Handling",
            performance: "Performance Test",
            simulation: "Real Scenario Simulation",
        };

        let passed = 0;
        let total = 0;

        for (const [key, value] of Object.entries(results)) {
            if (key === "simulation" && !value && answer.toLowerCase() !== "y") {
                continue; // 跳过未运行的模拟
            }
            total++;
            if (value) {
                success(`${testNames[key]}: PASSED`);
                passed++;
            } else {
                error(`${testNames[key]}: FAILED`);
            }
        }

        console.log();
        if (passed === total) {
            success(`All tests passed! (${passed}/${total})`);
        } else {
            warn(`Some tests failed. (${passed}/${total} passed)`);
        }

        console.log("\n" + "=".repeat(60) + "\n");
        rl.close();
        process.exit(passed === total ? 0 : 1);
    });
}

// 运行测试
runTests().catch((err) => {
    error(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
});
