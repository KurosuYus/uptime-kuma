# LLM 健康监控 Demo 使用指南

## 概述

这个 demo 展示了 LLM 健康监控系统的完整功能，包括：
- ✅ **被动上报**：模拟业务系统上报 LLM 调用结果（200 条/秒）
- ✅ **主动探测**：支持 Uptime Kuma 主动探测 LLM API
- ✅ **本地 Mock API**：在 3003 端口运行，无需真实 API 密钥
- ✅ **动态场景**：自动切换健康/降级/严重状态
- ✅ **循环运行**：2 分钟上报 → 3 分钟静默 → 循环

## 快速开始

### 步骤 1：启动 Uptime Kuma

```bash
npm run dev
```

### 步骤 2：启动 Demo

```bash
./start-demo.sh
```

或者直接运行：

```bash
node demo-llm-monitoring.js
```

Demo 会自动启动 Mock API 服务器在 `http://localhost:3003`。

### 步骤 3：在 UI 中创建监控器

访问 http://localhost:3000，为每个模型创建监控器：

#### 监控器 1：ZhipuAI/GLM5.1

- **Monitor Type**: LLM Model Health Monitor
- **Friendly Name**: ZhipuAI GLM5.1
- **Model Name**: `ZhipuAI/GLM5.1`
- **API Endpoint**: `http://localhost:3003/api/paas/v4/chat/completions`
- **API Key**: `zhipu_api_key_demo_abc123xyz789`
- **Upstream Provider**: zhipuai
- **Cost Level**: medium
- **Heartbeat Interval**: `60` 秒（被动上报聚合间隔）
- **Active Probe**: ✅ 启用（可选，用于测试主动探测）
- **Probe Interval**: `120` 秒（主动探测间隔，仅在启用主动探测时需要）

#### 监控器 2：ltx-2.3-dev

- **Monitor Type**: LLM Model Health Monitor
- **Friendly Name**: Lightricks LTX 2.3
- **Model Name**: `ltx-2.3-dev`
- **API Endpoint**: `http://localhost:3003/v1/ltx/generate`
- **API Key**: `ltx_sk_demo_def456uvw012`
- **Upstream Provider**: lightricks
- **Cost Level**: high
- **Heartbeat Interval**: `60` 秒
- **Active Probe**: ✅ 启用（可选）
- **Probe Interval**: `180` 秒

#### 监控器 3：Minimax/M2.7

- **Monitor Type**: LLM Model Health Monitor
- **Friendly Name**: Minimax M2.7
- **Model Name**: `Minimax/M2.7`
- **API Endpoint**: `http://localhost:3003/v1/text/chatcompletion_v2`
- **API Key**: `minimax_api_demo_ghi789rst345`
- **Upstream Provider**: minimax
- **Cost Level**: low
- **Heartbeat Interval**: `60` 秒
- **Active Probe**: ✅ 启用（可选）
- **Probe Interval**: `90` 秒

## 模型配置

| 模型 | 提供商 | 端点 | 基准延迟 | 成功率 |
|------|--------|------|---------|--------|
| ZhipuAI/GLM5.1 | zhipuai | /api/paas/v4/chat/completions | 800ms | 97% |
| ltx-2.3-dev | lightricks | /v1/ltx/generate | 1200ms | 97% |
| Minimax/M2.7 | minimax | /v1/text/chatcompletion_v2 | 600ms | 97% |

## 场景模拟

Demo 会自动在不同场景之间切换（每 30 秒一次）：

### 健康 (Healthy)
- 成功率：97%
- 延迟倍数：1.0x

### 降级 (Degraded)
- 成功率：75%
- 延迟倍数：1.8x

### 严重 (Critical)
- 成功率：50%
- 延迟倍数：3.0x

## 运行模式

### 模式 1：纯被动上报
- 不启用 "Enable active health probes"
- 只依赖 demo 脚本的被动上报
- 每 60 秒聚合一次，生成一个心跳

### 模式 2：纯主动探测
- 启用 "Enable active health probes"
- 设置 "Probe Interval"
- 停止 demo 脚本的被动上报

### 模式 3：混合模式（推荐）
- 启用 "Enable active health probes"
- 设置较长的 "Probe Interval"
- 同时运行 demo 脚本的被动上报
- 白天依赖被动上报，深夜依赖主动探测

## 循环流程

```
启动 Mock API (3003 端口)
    ↓
显示初始配置
    ↓
┌─────────────────────────────────┐
│  Phase 1: 被动上报 (2 分钟)      │
│  - 200 条/秒                     │
│  - 每 30 秒切换状态              │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│  Phase 2: 静默期 (3 分钟)        │
│  - 停止被动上报                  │
│  - 主动探测继续工作（如果启用）   │
└─────────────────────────────────┘
    ↓
循环回到 Phase 1
```

## 控制台输出示例

```
╔════════════════════════════════════════════════════════════════╗
║           LLM Health Monitoring Demo                           ║
╚════════════════════════════════════════════════════════════════╝

✅ Mock API server started on http://localhost:3003

Configuration:
  - Mock API Port: 3003
  - Models: 3
  - Reports per second: 200
  - Reporting duration: 120s
  - Silence duration: 180s
  - Status change interval: 30s

Models:
  - ZhipuAI/GLM5.1 (zhipuai)
    Endpoint: http://localhost:3003/api/paas/v4/chat/completions
    API Key: zhipu_api_key_demo_abc123xyz789
  - ltx-2.3-dev (lightricks)
    Endpoint: http://localhost:3003/v1/ltx/generate
    API Key: ltx_sk_demo_def456uvw012
  - Minimax/M2.7 (minimax)
    Endpoint: http://localhost:3003/v1/text/chatcompletion_v2
    API Key: minimax_api_demo_ghi789rst345
```

## 相关文件

- `demo-llm-monitoring.js` - 被动上报 + Mock API demo (端口 3003)
- `demo-active-probe.js` - 纯主动探测 demo (端口 3002)
- `start-demo.sh` - 被动上报 demo 启动脚本
- `start-active-probe-demo.sh` - 主动探测 demo 启动脚本

## 故障排查

### 问题：端口被占用

**错误**：`Error: listen EADDRINUSE: address already in use :::3003`

**解决**：
```bash
# 查找占用端口的进程
lsof -i :3003

# 杀死进程
kill -9 <PID>

# 或者修改端口（需要同时修改代码）
const MOCK_API_PORT = 3004;
```
