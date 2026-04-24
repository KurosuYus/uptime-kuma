# LLM 主动探测 Demo 使用指南

## 两个 Demo 的区别

| Demo | 端口 | 用途 | 特点 |
|------|------|------|------|
| **被动上报 Demo** | 3003 | 模拟业务系统上报 | 200 条/秒 + 主动探测 |
| **主动探测 Demo** | 3002 | 纯主动探测 | 无被动上报，深夜场景 |

## 概述

这个 demo 模拟**深夜/淡季场景**：没有业务流量，没有被动上报，完全依赖主动探测来监控 LLM 服务健康状态。

## 特点

- ✅ **无被动上报**：模拟深夜/淡季，没有业务请求
- ✅ **纯主动探测**：完全依赖 Uptime Kuma 的定时探测
- ✅ **可配置间隔**：每个模型可以设置不同的探测间隔
- ✅ **真实 API 模拟**：支持 OpenAI、Anthropic、Google 三种 API 格式
- ✅ **动态场景**：自动切换健康/降级/严重/宕机状态
- ✅ **统计展示**：实时显示探测请求统计

## 快速开始

### 步骤 1：启动 Uptime Kuma

```bash
npm run dev
```

### 步骤 2：启动 Mock API 服务器

```bash
./start-active-probe-demo.sh
```

或者直接运行：

```bash
node demo-active-probe.js
```

Mock API 服务器会在 `http://localhost:3002` 启动。

### 步骤 3：在 UI 中创建监控器

访问 http://localhost:3000，为每个模型创建监控器：

#### 监控器 1：gpt-4-turbo

- **Monitor Type**: LLM Model Health Monitor
- **Friendly Name**: GPT-4 Turbo
- **Model Name**: `gpt-4-turbo`
- **API Endpoint**: `http://localhost:3002/v1/chat/completions`
- **API Key**: `sk-demo-gpt4turbo-abc123`
- **Upstream Provider**: openai
- **Cost Level**: high
- **Heartbeat Interval**: `60` 秒
- **Active Probe**: ✅ **启用**（重要！）
- **Probe Timeout**: 30000 ms

#### 监控器 2：claude-3-opus

- **Monitor Type**: LLM Model Health Monitor
- **Friendly Name**: Claude 3 Opus
- **Model Name**: `claude-3-opus`
- **API Endpoint**: `http://localhost:3002/v1/messages`
- **API Key**: `sk-ant-demo-opus-def456`
- **Upstream Provider**: anthropic
- **Cost Level**: high
- **Heartbeat Interval**: `90` 秒
- **Active Probe**: ✅ **启用**
- **Probe Timeout**: 30000 ms

#### 监控器 3：gemini-pro

- **Monitor Type**: LLM Model Health Monitor
- **Friendly Name**: Gemini Pro
- **Model Name**: `gemini-pro`
- **API Endpoint**: `http://localhost:3002/v1/models/gemini-pro:generateContent`
- **API Key**: `AIza-demo-gemini-ghi789`
- **Upstream Provider**: google
- **Cost Level**: medium
- **Heartbeat Interval**: `45` 秒
- **Active Probe**: ✅ **启用**
- **Probe Timeout**: 30000 ms

### 步骤 4：观察效果

**在 Mock API 控制台**：
- 每 10 秒显示一次统计信息
- 显示每个模型的请求数、成功数、失败数
- 显示当前场景状态

**在 Uptime Kuma UI**：
- 健康条按照设置的间隔更新
- 可以看到心跳历史
- 状态变化时会显示通知

## 模型配置

| 模型 | 提供商 | 探测间隔 | 成本等级 | 基准延迟 | 成功率 |
|------|--------|---------|---------|---------|--------|
| gpt-4-turbo | OpenAI | 60 秒 | high | 1200ms | 98% |
| claude-3-opus | Anthropic | 90 秒 | high | 1500ms | 97% |
| gemini-pro | Google | 45 秒 | medium | 800ms | 99% |

## 场景模拟

Demo 会自动在不同场景之间切换（每 60 秒一次）：

### 健康 (Healthy)
- 成功率：98%
- 延迟倍数：1.0x
- 错误：无

### 降级 (Degraded)
- 成功率：85%
- 延迟倍数：1.5x
- 错误：rate_limit, timeout

### 严重 (Critical)
- 成功率：60%
- 延迟倍数：2.5x
- 错误：server_error, timeout, rate_limit

### 宕机 (Down)
- 成功率：0%
- 延迟倍数：0x
- 错误：connection_refused

## 探测间隔配置

### 方式 1：使用 Heartbeat Interval（推荐）

在 UI 中创建监控器时，直接设置 **Heartbeat Interval**：

```
Heartbeat Interval: 60 秒
```

这个值会被 `LLMModelMonitorType.getProbeInterval()` 优先使用。

### 方式 2：使用 Cost Level（默认）

如果不设置 Heartbeat Interval，会根据 Cost Level 使用默认间隔：

| Cost Level | 默认间隔 | 说明 |
|-----------|---------|------|
| low | 30 秒 | 低成本模型，频繁探测 |
| medium | 120 秒 | 中等成本，2 分钟一次 |
| high | 300 秒 | 高成本模型，5 分钟一次 |
| critical | 900 秒 | 极高成本，15 分钟一次 |

### 灵活性对比

**之前**（只能用 Cost Level）：
```javascript
// 固定映射，不灵活
low → 30s
medium → 120s
high → 300s
critical → 900s
```

**现在**（可以自定义）：
```javascript
// 优先使用自定义间隔
monitor.interval = 60  // 用户设置 60 秒

// 如果没有设置，才使用 Cost Level 默认值
if (!monitor.interval) {
    interval = PROBE_INTERVALS[monitor.cost_level]
}
```

## 控制台输出示例

```
╔════════════════════════════════════════════════════════════════╗
║         LLM Active Probe Demo - Mock API Statistics           ║
╚════════════════════════════════════════════════════════════════╝

Total Requests: 45
Success: 42 | Failed: 3
Success Rate: 93.33%

┌─────────────────────┬──────────┬─────────┬─────────┬──────────┐
│ Model               │ Requests │ Success │ Failed  │ Scenario │
├─────────────────────┼──────────┼─────────┼─────────┼──────────┤
│ gpt-4-turbo         │       15 │      14 │       1 │ 健康     │
│ claude-3-opus       │       12 │      11 │       1 │ 降级     │
│ gemini-pro          │       18 │      17 │       1 │ 健康     │
└─────────────────────┴──────────┴─────────┴─────────┴──────────┘

Current Scenarios:
  gpt-4-turbo: 健康 (98% success rate)
  claude-3-opus: 降级 (85% success rate)
  gemini-pro: 健康 (98% success rate)

🔄 Scenario Changes:
  claude-3-opus: 健康 → 降级
```

## 验证方法

### 1. 检查探测频率

观察 Mock API 控制台，确认请求频率符合预期：

- gpt-4-turbo：每 60 秒一次
- claude-3-opus：每 90 秒一次
- gemini-pro：每 45 秒一次

### 2. 检查 UI 更新

在 Uptime Kuma UI 中：

- 健康条应该按照设置的间隔更新
- 点击监控器查看心跳历史
- 心跳间隔应该与设置一致

### 3. 检查状态变化

当场景切换时：

- Mock API 控制台会显示场景变化
- UI 中的健康条颜色会相应变化
- 可能会触发告警通知（如果配置了）

## 与被动上报 Demo 的对比

| 特性 | 被动上报 Demo | 主动探测 Demo |
|------|--------------|--------------|
| 场景 | 业务高峰期 | 深夜/淡季 |
| 数据来源 | 业务请求上报 | 定时主动探测 |
| 上报频率 | 200 条/秒 | 按间隔探测 |
| 心跳生成 | 聚合后生成 | 每次探测生成 |
| API 调用 | 无（只接收数据） | 有（实际调用 API） |
| 成本 | 无 | 有（按探测次数） |
| 适用场景 | 生产环境监控 | 低流量时段监控 |

## 使用场景

### 场景 1：深夜监控

```
时间：凌晨 2:00 - 6:00
业务流量：几乎为 0
监控需求：仍需确保服务可用

解决方案：
- 启用主动探测
- 设置较长的探测间隔（5-15 分钟）
- 降低探测成本
```

### 场景 2：新服务测试

```
状态：服务刚上线，还没有业务流量
监控需求：验证服务是否正常

解决方案：
- 启用主动探测
- 设置较短的探测间隔（30-60 秒）
- 快速发现问题
```

### 场景 3：混合监控

```
白天：业务高峰，使用被动上报
夜间：流量低，切换到主动探测

解决方案：
- 同时启用被动上报和主动探测
- 主动探测间隔设置较长（10-15 分钟）
- 白天主要依赖被动上报，夜间依赖主动探测
```

## 自定义配置

### 修改探测间隔

编辑 `demo-active-probe.js`：

```javascript
const MODELS = [
    {
        name: "gpt-4-turbo",
        probeInterval: 120,  // 改为 120 秒
        // ...
    }
];
```

### 修改场景切换频率

```javascript
setInterval(() => {
    const changes = changeScenarios();
    // ...
}, 120000);  // 改为 120 秒（2 分钟）
```

### 修改成功率

```javascript
const MODELS = [
    {
        name: "gpt-4-turbo",
        successRate: 0.95,  // 改为 95%
        // ...
    }
];
```

### 添加新模型

```javascript
const MODELS = [
    // ... 现有模型
    {
        name: "llama-3-70b",
        provider: "meta",
        endpoint: `http://localhost:${MOCK_API_PORT}/v1/completions`,
        apiKey: "meta-demo-llama3-jkl012",
        costLevel: "medium",
        probeInterval: 60,
        baseLatency: 900,
        latencyVariance: 300,
        successRate: 0.98,
    }
];

// 添加对应的 API 端点
app.post("/v1/completions", async (req, res) => {
    // 实现 Meta API 格式
});
```

## 故障排查

### 问题 1：Mock API 启动失败

**错误**：`Error: listen EADDRINUSE: address already in use :::3002`

**原因**：端口 3002 已被占用

**解决**：
```bash
# 查找占用端口的进程
lsof -i :3002

# 杀死进程
kill -9 <PID>

# 或者修改端口
const MOCK_API_PORT = 3003;
```

### 问题 2：探测请求失败

**错误**：UI 显示 "Connection refused"

**原因**：Mock API 服务器未启动或端点配置错误

**解决**：
1. 确认 Mock API 服务器正在运行
2. 检查端点 URL 是否正确
3. 确认端口号匹配

### 问题 3：探测频率不对

**现象**：探测间隔与设置不符

**原因**：Heartbeat Interval 设置错误

**解决**：
1. 检查 UI 中的 Heartbeat Interval 设置
2. 确认单位是秒，不是毫秒
3. 重启监控器使设置生效

## 停止 Demo

按 `Ctrl+C` 停止 Mock API 服务器。

最终统计信息会显示在控制台。

## 相关文件

- `demo-active-probe.js` - 主动探测 demo 脚本
- `start-active-probe-demo.sh` - 启动脚本
- `server/monitor-types/llm-model.js` - LLM 监控类型实现
- `DEMO_USAGE.md` - 被动上报 demo 使用指南

## 下一步

1. 运行 demo 并观察探测行为
2. 尝试修改探测间隔
3. 观察不同场景下的监控表现
4. 结合被动上报 demo，理解两种监控模式的区别
