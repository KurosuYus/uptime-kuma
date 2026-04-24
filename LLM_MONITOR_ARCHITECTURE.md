# LLM 模型健康监控系统 - 技术架构文档

## 一、系统架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                         业务服务器集群                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Service 1│  │ Service 2│  │ Service 3│  │ Service N│           │
│  │  (Node)  │  │ (Python) │  │  (Java)  │  │   (Go)   │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │             │             │             │                   │
│       └─────────────┴─────────────┴─────────────┘                   │
│                     │ 被动上报                                       │
│                     │ POST /api/llm-health/report                   │
└─────────────────────┼─────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Uptime Kuma + LLM 监控扩展                        │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      REST API Layer                          │   │
│  │  ┌──────────────────┐  ┌──────────────────┐                │   │
│  │  │ /api/llm-health/ │  │ /api/llm-health/ │                │   │
│  │  │     report       │  │   report-batch   │                │   │
│  │  └──────────────────┘  └──────────────────┘                │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   Socket.IO Layer                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │   │
│  │  │getLLMMonitor │  │updateLLMConfig│  │getLLMCostStats│     │   │
│  │  │    List      │  │              │  │              │     │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   Monitor Type Layer                         │   │
│  │  ┌──────────────────────────────────────────────────────┐  │   │
│  │  │         LLMModelMonitorType                          │  │   │
│  │  │  - check(): 主动探测                                 │  │   │
│  │  │  - updateHealthScore(): 计算健康分数                │  │   │
│  │  │  - logCost(): 记录成本                               │  │   │
│  │  └──────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   Data Layer (SQLite)                        │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │   │
│  │  │   monitor    │  │  heartbeat   │  │llm_cost_log  │     │   │
│  │  │   (扩展)     │  │   (复用)     │  │   (新增)     │     │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘     │   │
│  └─────────────────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────────────────┘
                        │ 主动探测
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         LLM API 提供商                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │  OpenAI  │  │Anthropic │  │OpenRouter│  │   xAI    │           │
│  │  GPT-4   │  │  Claude  │  │  Grok    │  │   Sora   │           │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

## 二、核心组件说明

### 2.1 监控类型 (LLMModelMonitorType)

**文件**: `server/monitor-types/llm-model.js`

**职责**:
- 执行主动探测（发送最小化请求）
- 分析 LLM API 响应
- 计算健康分数
- 记录成本日志

**关键方法**:
```javascript
async check(monitor, heartbeat, server)
  ├─ buildProbePayload()      // 构建探测请求
  ├─ analyzeResponse()        // 分析响应
  ├─ parseError()             // 解析错误
  ├─ logCost()                // 记录成本
  └─ updateHealthScore()      // 更新健康分数
      └─ calculateHealthScore() // 计算算法
```

**探测频率控制**:
```javascript
PROBE_INTERVALS = {
    low: 30s,      // 免费/低成本模型
    medium: 120s,  // 标准模型
    high: 300s,    // 高成本模型
    critical: 900s // 极高成本模型
}
```

### 2.2 Socket.IO 处理器 (llmMonitorSocketHandler)

**文件**: `server/socket-handlers/llm-monitor-socket-handler.js`

**事件处理**:
- `getLLMMonitorList`: 获取所有 LLM 监控列表
- `getLLMMonitorDetail`: 获取单个监控详情
- `updateLLMMonitorConfig`: 更新监控配置
- `recalculateLLMHealthScore`: 手动重新计算健康分数
- `getLLMCostStats`: 获取成本统计
- `getLLMHealthOverview`: 获取健康概览

**实时推送**:
- `llm-health-score`: 健康分数更新事件
- `llm-monitor-config-updated`: 配置更新事件

### 2.3 REST API 端点

**文件**: `server/routers/api-router.js`

**端点列表**:

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/llm-health/report` | 单个健康数据上报 |
| POST | `/api/llm-health/report-batch` | 批量健康数据上报 |
| GET | `/api/llm-health/score/:modelName` | 查询健康分数 |

**请求流程**:
```
业务服务器
    │
    ├─ 调用 LLM API
    │   ├─ 成功 → 记录延迟
    │   └─ 失败 → 记录错误
    │
    └─ POST /api/llm-health/report
        ├─ 验证参数
        ├─ 查找监控器
        ├─ 创建心跳记录
        ├─ 计算 uptime
        ├─ 记录成本日志
        ├─ 更新健康分数
        └─ 实时推送更新
```

### 2.4 数据库设计

#### monitor 表扩展字段

```sql
ALTER TABLE monitor ADD COLUMN model_name VARCHAR(255);
ALTER TABLE monitor ADD COLUMN upstream_provider VARCHAR(255);
ALTER TABLE monitor ADD COLUMN cost_level VARCHAR(50) DEFAULT 'medium';
ALTER TABLE monitor ADD COLUMN health_score FLOAT DEFAULT 100;
ALTER TABLE monitor ADD COLUMN last_probe_time BIGINT;
ALTER TABLE monitor ADD COLUMN probe_payload TEXT;
ALTER TABLE monitor ADD COLUMN active_probe BOOLEAN DEFAULT 1;
ALTER TABLE monitor ADD COLUMN llm_api_endpoint TEXT;
ALTER TABLE monitor ADD COLUMN llm_api_key TEXT;
ALTER TABLE monitor ADD COLUMN probe_timeout INTEGER DEFAULT 30000;
```

#### llm_cost_log 表

```sql
CREATE TABLE llm_cost_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    estimated_cost FLOAT DEFAULT 0,
    probe_type VARCHAR(50) NOT NULL,  -- 'active' or 'passive'
    tokens_used INTEGER DEFAULT 0,
    model_name VARCHAR(255),
    error_message TEXT,
    INDEX idx_monitor_id (monitor_id),
    INDEX idx_timestamp (timestamp),
    INDEX idx_monitor_time (monitor_id, timestamp)
);
```

## 三、健康分数算法详解

### 3.1 算法公式

```
健康分数 = (加权成功率 × 70%) + (延迟分数 × 30%)
```

### 3.2 加权成功率计算

使用指数衰减权重，最近的记录权重更高：

```javascript
// 权重函数
weight(i) = e^(-i × 0.1)

// 加权成功率
weightedSuccessRate = Σ(成功记录的权重) / Σ(所有记录的权重)
```

**示例**:
```
最近 5 次心跳: [成功, 成功, 失败, 成功, 成功]
权重: [1.0, 0.905, 0.819, 0.741, 0.670]

加权成功率 = (1.0 + 0.905 + 0 + 0.741 + 0.670) / (1.0 + 0.905 + 0.819 + 0.741 + 0.670)
           = 3.316 / 4.135
           = 0.802 (80.2%)
```

### 3.3 延迟分数映射

```javascript
if (avgLatency < 1000ms)  → latencyScore = 1.0 (100%)
if (avgLatency < 3000ms)  → latencyScore = 0.9 (90%)
if (avgLatency < 5000ms)  → latencyScore = 0.7 (70%)
if (avgLatency < 10000ms) → latencyScore = 0.5 (50%)
if (avgLatency >= 10000ms)→ latencyScore = 0.3 (30%)
```

### 3.4 完整示例

**输入数据**:
- 最近 20 次心跳
- 成功 18 次，失败 2 次（最近一次失败在第 5 次）
- 成功请求平均延迟: 2500ms

**计算过程**:
```
1. 加权成功率计算:
   weightedSuccessRate ≈ 0.92 (考虑时间衰减)

2. 延迟分数:
   avgLatency = 2500ms < 3000ms
   latencyScore = 0.9

3. 健康分数:
   healthScore = 0.92 × 0.7 + 0.9 × 0.3
               = 0.644 + 0.27
               = 0.914
               = 91 (四舍五入)
```

## 四、成本控制策略

### 4.1 探测频率矩阵

| 成本等级 | 探测间隔 | 每日探测次数 | 每日成本估算 (GPT-4) |
|---------|---------|-------------|---------------------|
| low | 30s | 2,880 | $0.58 |
| medium | 2min | 720 | $0.14 |
| high | 5min | 288 | $0.06 |
| critical | 15min | 96 | $0.02 |

**成本计算假设**:
- 输入: 5 tokens
- 输出: 1 token
- GPT-4 定价: $0.03/1K input, $0.06/1K output
- 单次成本: (5 × 0.03 + 1 × 0.06) / 1000 = $0.0002

### 4.2 最小化探测请求

**默认探测负载**:
```json
{
  "model": "gpt-4",
  "messages": [
    {
      "role": "user",
      "content": "Hi"
    }
  ],
  "max_tokens": 1,
  "temperature": 0
}
```

**优化点**:
- 最短的输入内容 ("Hi")
- 最小的输出限制 (1 token)
- 零温度 (确定性输出，避免浪费)

### 4.3 仅被动监控模式

对于极高成本模型（如 Sora 视频生成），可以完全关闭主动探测：

```javascript
{
  "active_probe": false,
  "cost_level": "critical"
}
```

此时系统只依赖业务服务器的被动上报，**零额外成本**。

## 五、性能优化

### 5.1 数据库索引

```sql
-- 心跳查询优化
CREATE INDEX idx_heartbeat_monitor_time 
ON heartbeat(monitor_id, time DESC);

-- 成本日志查询优化
CREATE INDEX idx_llm_cost_monitor_time 
ON llm_cost_log(monitor_id, timestamp DESC);

-- 模型名称查询优化
CREATE INDEX idx_monitor_model_name 
ON monitor(model_name, type);
```

### 5.2 批量上报优化

**高并发场景**:
```javascript
// 客户端缓冲队列
const reportQueue = [];
const BATCH_SIZE = 50;
const BATCH_INTERVAL = 10000; // 10 秒

setInterval(() => {
    if (reportQueue.length >= BATCH_SIZE) {
        sendBatch(reportQueue.splice(0, BATCH_SIZE));
    }
}, BATCH_INTERVAL);
```

**性能指标**:
- 单次上报: ~50ms
- 批量上报 (50 条): ~100ms
- 吞吐量提升: ~25x

### 5.3 健康分数缓存

```javascript
// 在业务服务器端缓存健康分数
const healthScoreCache = new Map();
const CACHE_TTL = 60000; // 1 分钟

async function getHealthScore(modelName) {
    const cached = healthScoreCache.get(modelName);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.score;
    }
    
    const score = await fetchHealthScore(modelName);
    healthScoreCache.set(modelName, {
        score: score,
        timestamp: Date.now()
    });
    return score;
}
```

## 六、安全考虑

### 6.1 API 密钥保护

**存储**:
- 数据库中加密存储（建议使用 AES-256）
- 环境变量注入
- 密钥管理服务（如 AWS Secrets Manager）

**传输**:
- HTTPS 强制加密
- 不在日志中记录完整密钥

### 6.2 访问控制

**认证**:
- Uptime Kuma 内置身份验证
- API 端点需要验证用户权限

**授权**:
- 用户只能访问自己创建的监控
- Socket.IO 事件需要 `checkLogin(socket)`

### 6.3 速率限制

```javascript
// 在 api-router.js 中添加
const rateLimit = require("express-rate-limit");

const llmHealthLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 分钟
    max: 100, // 最多 100 次请求
    message: "Too many requests from this IP"
});

router.post("/api/llm-health/report", llmHealthLimiter, async (req, res) => {
    // ...
});
```

## 七、监控和告警

### 7.1 健康分数阈值

| 分数范围 | 状态 | 告警级别 |
|---------|------|---------|
| 80-100 | 健康 | 无 |
| 50-79 | 警告 | 低 |
| 20-49 | 严重 | 中 |
| 0-19 | 危急 | 高 |

### 7.2 告警规则示例

```javascript
// 在 Uptime Kuma 中配置通知
{
    "type": "webhook",
    "url": "https://your-webhook.com/alert",
    "conditions": [
        {
            "variable": "health_score",
            "operator": "<",
            "value": 50
        }
    ]
}
```

### 7.3 成本异常检测

```javascript
// 检测成本突增
async function detectCostAnomaly(monitorId) {
    const last24h = await getCostLogs(monitorId, "24h");
    const previous24h = await getCostLogs(monitorId, "48h", "24h");
    
    const currentCost = sum(last24h);
    const previousCost = sum(previous24h);
    
    if (currentCost > previousCost * 2) {
        sendAlert("Cost anomaly detected", {
            model: monitorId,
            current: currentCost,
            previous: previousCost,
            increase: ((currentCost / previousCost - 1) * 100).toFixed(2) + "%"
        });
    }
}
```

## 八、扩展性设计

### 8.1 支持新的 LLM 提供商

只需在探测负载中适配不同的 API 格式：

```javascript
// OpenAI 格式
{
    "model": "gpt-4",
    "messages": [...]
}

// Anthropic 格式
{
    "model": "claude-3-opus",
    "messages": [...],
    "max_tokens": 1
}

// 自定义格式
{
    "prompt": "Hi",
    "max_length": 1
}
```

### 8.2 多区域部署

```javascript
// 在 monitor 表中添加 region 字段
ALTER TABLE monitor ADD COLUMN region VARCHAR(50);

// 按区域分组监控
SELECT region, AVG(health_score) as avg_score
FROM monitor
WHERE type = 'llm-model'
GROUP BY region;
```

### 8.3 自定义健康分数算法

```javascript
// 允许用户自定义权重
monitor.health_weights = {
    successRate: 0.8,  // 80%
    latency: 0.2       // 20%
};

// 或添加更多维度
monitor.health_weights = {
    successRate: 0.5,
    latency: 0.3,
    cost: 0.2
};
```

## 九、故障恢复

### 9.1 数据库损坏恢复

```bash
# 从备份恢复
cp db/kuma.db.backup.YYYYMMDD_HHMMSS db/kuma.db

# 重新运行迁移
npm run migrate
```

### 9.2 健康分数重置

```javascript
// 手动重置所有 LLM 监控的健康分数
socket.emit('recalculateLLMHealthScore', monitorId);

// 或通过 SQL
UPDATE monitor 
SET health_score = 100 
WHERE type = 'llm-model';
```

### 9.3 成本日志清理

```sql
-- 删除 30 天前的日志
DELETE FROM llm_cost_log 
WHERE timestamp < (strftime('%s', 'now') - 2592000) * 1000;

-- 保留最近 1000 条记录
DELETE FROM llm_cost_log 
WHERE id NOT IN (
    SELECT id FROM llm_cost_log 
    ORDER BY timestamp DESC 
    LIMIT 1000
);
```

## 十、总结

### 10.1 系统特点

✅ **灵活**: 支持主动探测和被动上报两种模式  
✅ **智能**: 基于时间衰减的加权健康分数算法  
✅ **经济**: 根据模型成本动态调整探测频率  
✅ **可靠**: 完整的错误处理和故障恢复机制  
✅ **可扩展**: 易于添加新的 LLM 提供商和自定义算法  

### 10.2 适用场景

- **多模型管理**: 同时监控多个 LLM 模型的健康状态
- **成本优化**: 识别高成本、低性能的模型
- **故障预警**: 及时发现模型服务异常
- **性能分析**: 对比不同模型的响应时间和成功率
- **合规审计**: 记录所有 API 调用的成本和状态

### 10.3 未来改进方向

1. **机器学习预测**: 基于历史数据预测模型故障
2. **自动切换**: 根据健康分数自动切换到备用模型
3. **成本优化建议**: 分析使用模式，推荐更经济的方案
4. **多维度评分**: 增加响应质量、token 效率等维度
5. **可视化增强**: 更丰富的图表和仪表盘

---

**文档版本**: 1.0  
**最后更新**: 2026-04-22  
**维护者**: Uptime Kuma LLM Monitor Team
