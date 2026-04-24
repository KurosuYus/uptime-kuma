# LLM 模型健康监控系统 - 部署和集成指南

## 系统概述

这是一个基于 Uptime Kuma 的 LLM 模型健康监控扩展，提供以下功能：

1. **被动接收**：后端业务服务器上报真实请求的响应数据
2. **主动探测**：定期发送最小化请求探测模型健康状态
3. **健康分析**：计算每个模型的健康分数（0-100）
4. **可视化展示**：在仪表盘中展示模型状态和历史趋势
5. **成本控制**：根据模型成本等级动态调整探测频率

**重要约束**：本系统不拦截用户流量，不做熔断、降级、切流等操作，只负责监控和展示。

---

## 一、数据库设计

### 1.1 扩展的 monitor 表字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `model_name` | VARCHAR(255) | 模型标识（如 grok, sora, gpt-4） |
| `upstream_provider` | VARCHAR(255) | 上游平台（如 openrouter, n1n） |
| `cost_level` | VARCHAR(50) | 成本等级（low, medium, high, critical） |
| `health_score` | FLOAT | 当前健康分数（0-100） |
| `last_probe_time` | BIGINT | 最后探测时间戳（毫秒） |
| `probe_payload` | TEXT | 自定义探测请求体（JSON 字符串） |
| `active_probe` | BOOLEAN | 是否启用主动探测 |
| `llm_api_endpoint` | TEXT | LLM API 端点 URL |
| `llm_api_key` | TEXT | LLM API 密钥（加密存储） |
| `probe_timeout` | INTEGER | 探测请求超时时间（毫秒，默认 30000） |

### 1.2 新增的 llm_cost_log 表

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `id` | INTEGER | 主键 |
| `monitor_id` | INTEGER | 关联的监控 ID |
| `timestamp` | BIGINT | 时间戳（毫秒） |
| `estimated_cost` | FLOAT | 估算成本（美元） |
| `probe_type` | VARCHAR(50) | 探测类型（active/passive） |
| `tokens_used` | INTEGER | 使用的 token 数量 |
| `model_name` | VARCHAR(255) | 模型名称 |
| `error_message` | TEXT | 错误信息（如果有） |

**索引**：
- `monitor_id`
- `timestamp`
- `(monitor_id, timestamp)` 复合索引

---

## 二、部署步骤

### 2.1 数据库迁移

1. 确保 Uptime Kuma 已停止运行
2. 运行数据库迁移：

```bash
cd /path/to/uptime-kuma
npm run migrate
```

迁移脚本会自动执行：
- 扩展 `monitor` 表，添加 LLM 相关字段
- 创建 `llm_cost_log` 表

### 2.2 启动服务

```bash
npm run start-server
```

或使用 PM2：

```bash
pm2 restart uptime-kuma
```

### 2.3 验证安装

1. 登录 Uptime Kuma 管理界面
2. 创建新监控时，应该能看到 "LLM Model" 类型
3. 检查日志中是否有 LLM 监控类型注册成功的信息

---

## 三、创建 LLM 监控

### 3.1 通过 UI 创建（推荐）

1. 点击 "Add New Monitor"
2. 选择 Monitor Type: **LLM Model**
3. 填写配置：
   - **Friendly Name**: 显示名称（如 "GPT-4 Turbo"）
   - **Model Name**: 模型标识（如 "gpt-4-turbo"）
   - **Upstream Provider**: 上游平台（如 "openai", "openrouter"）
   - **Cost Level**: 成本等级
     - `low`: 每 30 秒探测一次
     - `medium`: 每 2 分钟探测一次
     - `high`: 每 5 分钟探测一次
     - `critical`: 每 15 分钟探测一次
   - **API Endpoint**: LLM API 端点（如 `https://api.openai.com/v1/chat/completions`）
   - **API Key**: 你的 API 密钥
   - **Active Probe**: 是否启用主动探测（默认开启）
   - **Probe Timeout**: 探测超时时间（毫秒，默认 30000）

4. **自定义探测负载**（可选）：

```json
{
  "model": "gpt-4-turbo",
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

### 3.2 通过 API 创建

```bash
curl -X POST http://localhost:3001/api/monitor \
  -H "Content-Type: application/json" \
  -d '{
    "type": "llm-model",
    "name": "GPT-4 Turbo",
    "model_name": "gpt-4-turbo",
    "upstream_provider": "openai",
    "cost_level": "high",
    "llm_api_endpoint": "https://api.openai.com/v1/chat/completions",
    "llm_api_key": "sk-xxx",
    "active_probe": true,
    "probe_timeout": 30000,
    "interval": 300
  }'
```

---

## 四、后端业务服务器集成

### 4.1 被动数据上报

在你的后端业务服务器中，每次调用 LLM API 后，上报请求结果：

#### Node.js 示例

```javascript
const axios = require('axios');

async function reportLLMHealth(modelName, success, latency, errorCode = null) {
    try {
        await axios.post('http://uptime-kuma-host:3001/api/llm-health/report', {
            modelName: modelName,
            success: success,
            latency: latency,
            errorCode: errorCode,
            timestamp: Date.now(),
            provider: 'openrouter' // 可选
        }, {
            timeout: 5000
        });
    } catch (error) {
        console.error('Failed to report LLM health:', error.message);
    }
}

// 使用示例
async function callLLM() {
    const startTime = Date.now();
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4-turbo',
            messages: [{ role: 'user', content: 'Hello' }]
        });
        
        const latency = Date.now() - startTime;
        await reportLLMHealth('gpt-4-turbo', true, latency);
        
        return response.data;
    } catch (error) {
        const latency = Date.now() - startTime;
        await reportLLMHealth('gpt-4-turbo', false, latency, error.message);
        throw error;
    }
}
```

#### Python 示例

```python
import requests
import time

def report_llm_health(model_name, success, latency, error_code=None):
    try:
        requests.post(
            'http://uptime-kuma-host:3001/api/llm-health/report',
            json={
                'modelName': model_name,
                'success': success,
                'latency': latency,
                'errorCode': error_code,
                'timestamp': int(time.time() * 1000)
            },
            timeout=5
        )
    except Exception as e:
        print(f'Failed to report LLM health: {e}')

# 使用示例
def call_llm():
    start_time = time.time()
    try:
        response = requests.post(
            'https://api.openai.com/v1/chat/completions',
            json={
                'model': 'gpt-4-turbo',
                'messages': [{'role': 'user', 'content': 'Hello'}]
            }
        )
        latency = int((time.time() - start_time) * 1000)
        report_llm_health('gpt-4-turbo', True, latency)
        return response.json()
    except Exception as e:
        latency = int((time.time() - start_time) * 1000)
        report_llm_health('gpt-4-turbo', False, latency, str(e))
        raise
```

#### Java (Spring Boot) 示例

```java
import org.springframework.web.client.RestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;

public class LLMHealthReporter {
    private final RestTemplate restTemplate = new RestTemplate();
    private final String uptimeKumaUrl = "http://uptime-kuma-host:3001/api/llm-health/report";
    
    public void reportHealth(String modelName, boolean success, long latency, String errorCode) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            Map<String, Object> body = new HashMap<>();
            body.put("modelName", modelName);
            body.put("success", success);
            body.put("latency", latency);
            body.put("errorCode", errorCode);
            body.put("timestamp", System.currentTimeMillis());
            
            HttpEntity<Map<String, Object>> request = new HttpEntity<>(body, headers);
            restTemplate.postForEntity(uptimeKumaUrl, request, String.class);
        } catch (Exception e) {
            System.err.println("Failed to report LLM health: " + e.getMessage());
        }
    }
    
    // 使用示例
    public String callLLM() {
        long startTime = System.currentTimeMillis();
        try {
            // 调用 LLM API
            String response = llmClient.chat("gpt-4-turbo", "Hello");
            long latency = System.currentTimeMillis() - startTime;
            reportHealth("gpt-4-turbo", true, latency, null);
            return response;
        } catch (Exception e) {
            long latency = System.currentTimeMillis() - startTime;
            reportHealth("gpt-4-turbo", false, latency, e.getMessage());
            throw e;
        }
    }
}
```

### 4.2 批量上报（高并发场景）

如果你的服务器每秒有大量 LLM 请求，建议使用批量上报：

```javascript
const reportQueue = [];

function queueLLMReport(modelName, success, latency, errorCode) {
    reportQueue.push({ modelName, success, latency, errorCode, timestamp: Date.now() });
}

// 每 10 秒批量上报一次
setInterval(async () => {
    if (reportQueue.length === 0) return;
    
    const reports = reportQueue.splice(0, reportQueue.length);
    
    try {
        await axios.post('http://uptime-kuma-host:3001/api/llm-health/report-batch', {
            reports: reports
        });
    } catch (error) {
        console.error('Failed to batch report:', error.message);
    }
}, 10000);
```

---

## 五、健康分数算法

### 5.1 计算公式

```
健康分数 = (加权成功率 × 70%) + (延迟分数 × 30%)
```

### 5.2 加权成功率

使用指数衰减权重，最近的记录权重更高：

```
权重(i) = e^(-i × 0.1)
加权成功率 = Σ(成功记录的权重) / Σ(所有记录的权重)
```

### 5.3 延迟分数

根据平均延迟计算：

| 平均延迟 | 延迟分数 |
|---------|---------|
| < 1s | 1.0 (100%) |
| < 3s | 0.9 (90%) |
| < 5s | 0.7 (70%) |
| < 10s | 0.5 (50%) |
| ≥ 10s | 0.3 (30%) |

### 5.4 示例

假设最近 20 次心跳：
- 成功 18 次，失败 2 次
- 平均延迟 2.5 秒

计算：
1. 加权成功率 ≈ 0.92（考虑时间衰减）
2. 延迟分数 = 0.9（< 3s）
3. 健康分数 = 0.92 × 0.7 + 0.9 × 0.3 = 0.644 + 0.27 = 0.914
4. 最终分数 = 91

---

## 六、成本控制策略

### 6.1 探测频率

| 成本等级 | 探测间隔 | 适用场景 |
|---------|---------|---------|
| `low` | 30 秒 | 免费模型、低成本模型 |
| `medium` | 2 分钟 | 标准 GPT-3.5 等 |
| `high` | 5 分钟 | GPT-4、Claude 等 |
| `critical` | 15 分钟 | Sora、Veo、Grok 等高成本模型 |

### 6.2 最小化探测请求

默认探测请求只生成 1 个 token：

```json
{
  "model": "gpt-4",
  "messages": [{"role": "user", "content": "Hi"}],
  "max_tokens": 1,
  "temperature": 0
}
```

估算成本（以 GPT-4 为例）：
- 输入：~5 tokens
- 输出：1 token
- 总成本：约 $0.0002 / 次

每天成本（high 级别，每 5 分钟一次）：
- 288 次 / 天 × $0.0002 = $0.058 / 天

### 6.3 仅被动监控

对于极高成本模型（如 Sora 视频生成），可以关闭主动探测：

```javascript
// 创建监控时设置
{
  "active_probe": false,
  "cost_level": "critical"
}
```

此时只依赖业务服务器的被动上报，无额外成本。

---

## 七、API 参考

### 7.1 被动数据上报

**端点**: `POST /api/llm-health/report`

**请求体**:
```json
{
  "modelName": "gpt-4-turbo",
  "success": true,
  "latency": 1250,
  "errorCode": null,
  "timestamp": 1714636800000,
  "provider": "openai"
}
```

**响应**:
```json
{
  "ok": true,
  "message": "Health data reported successfully",
  "healthScore": 95
}
```

### 7.2 批量上报

**端点**: `POST /api/llm-health/report-batch`

**请求体**:
```json
{
  "reports": [
    {
      "modelName": "gpt-4-turbo",
      "success": true,
      "latency": 1250,
      "timestamp": 1714636800000
    },
    {
      "modelName": "claude-3-opus",
      "success": false,
      "latency": 5000,
      "errorCode": "Rate limit exceeded",
      "timestamp": 1714636801000
    }
  ]
}
```

### 7.3 获取健康分数

**端点**: `GET /api/llm-health/score/:modelName`

**响应**:
```json
{
  "ok": true,
  "modelName": "gpt-4-turbo",
  "healthScore": 95,
  "successRate": 98.5,
  "avgLatency": 1250,
  "totalChecks": 288,
  "lastProbeTime": 1714636800000,
  "costLevel": "high",
  "upstreamProvider": "openai"
}
```

---

## 八、Socket.IO 事件

### 8.1 获取 LLM 监控列表

```javascript
socket.emit('getLLMMonitorList', (response) => {
    console.log(response.monitors);
});
```

### 8.2 获取监控详情

```javascript
socket.emit('getLLMMonitorDetail', monitorId, (response) => {
    console.log(response.monitor);
    console.log(response.stats);
});
```

### 8.3 更新监控配置

```javascript
socket.emit('updateLLMMonitorConfig', monitorId, {
    costLevel: 'high',
    activeProbe: true,
    probeTimeout: 30000
}, (response) => {
    console.log(response.ok);
});
```

### 8.4 监听健康分数更新

```javascript
socket.on('llm-health-score', (data) => {
    console.log(`Model ${data.modelName} health score: ${data.healthScore}`);
});
```

---

## 九、故障排查

### 9.1 监控类型未显示

**问题**: 创建监控时看不到 "LLM Model" 类型

**解决**:
1. 检查服务器日志，确认 LLM 监控类型已注册
2. 清除浏览器缓存
3. 重启 Uptime Kuma 服务

### 9.2 主动探测失败

**问题**: 健康分数一直为 0，日志显示探测失败

**解决**:
1. 检查 API 端点是否正确
2. 验证 API 密钥是否有效
3. 检查网络连接和防火墙设置
4. 查看错误消息：`SELECT msg FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 1`

### 9.3 被动上报无响应

**问题**: 业务服务器上报数据，但监控无更新

**解决**:
1. 检查 `model_name` 是否与监控配置一致（大小写敏感）
2. 确认监控状态为 active
3. 检查 Uptime Kuma 日志中的错误信息
4. 验证网络连通性

### 9.4 健康分数不准确

**问题**: 健康分数与实际情况不符

**解决**:
1. 手动重新计算：`socket.emit('recalculateLLMHealthScore', monitorId)`
2. 检查最近的心跳记录：`SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 20`
3. 确认探测间隔设置合理

---

## 十、最佳实践

### 10.1 监控命名规范

建议使用清晰的命名：
- `GPT-4 Turbo (OpenAI)`
- `Claude 3 Opus (Anthropic)`
- `Grok-2 (xAI via OpenRouter)`

### 10.2 成本等级设置

| 模型类型 | 建议等级 |
|---------|---------|
| 免费模型（如 Llama 3） | low |
| GPT-3.5, Claude Haiku | medium |
| GPT-4, Claude Opus | high |
| Sora, Veo, Grok | critical |

### 10.3 告警配置

在 Uptime Kuma 中配置告警：
1. 健康分数 < 50：发送警告通知
2. 连续 3 次探测失败：发送紧急通知
3. 成本异常增长：发送成本告警

### 10.4 数据保留策略

定期清理旧的成本日志：

```sql
-- 删除 30 天前的成本日志
DELETE FROM llm_cost_log WHERE timestamp < (strftime('%s', 'now') - 2592000) * 1000;
```

建议设置定时任务（cron）每周执行一次。

---

## 十一、安全建议

### 11.1 API 密钥保护

- 使用环境变量存储 API 密钥
- 定期轮换密钥
- 限制 API 密钥权限（只读或最小权限）

### 11.2 网络隔离

- 将 Uptime Kuma 部署在内网
- 使用 VPN 或专线连接业务服务器
- 配置防火墙规则，只允许特定 IP 访问

### 11.3 访问控制

- 启用 Uptime Kuma 身份验证
- 使用强密码
- 定期审计访问日志

---

## 十二、性能优化

### 12.1 数据库优化

```sql
-- 为常用查询添加索引
CREATE INDEX idx_heartbeat_monitor_time ON heartbeat(monitor_id, time DESC);
CREATE INDEX idx_llm_cost_monitor_time ON llm_cost_log(monitor_id, timestamp DESC);
```

### 12.2 批量上报优化

高并发场景下，使用批量上报并设置合理的批次大小：
- 批次大小：50-100 条
- 上报间隔：10-30 秒

### 12.3 缓存策略

对于健康分数查询，可以在业务服务器端缓存 1-5 分钟。

---

## 十三、监控示例配置

### 13.1 OpenAI GPT-4

```json
{
  "type": "llm-model",
  "name": "GPT-4 Turbo",
  "model_name": "gpt-4-turbo",
  "upstream_provider": "openai",
  "cost_level": "high",
  "llm_api_endpoint": "https://api.openai.com/v1/chat/completions",
  "llm_api_key": "sk-xxx",
  "active_probe": true,
  "probe_timeout": 30000,
  "interval": 300
}
```

### 13.2 Anthropic Claude

```json
{
  "type": "llm-model",
  "name": "Claude 3 Opus",
  "model_name": "claude-3-opus-20240229",
  "upstream_provider": "anthropic",
  "cost_level": "high",
  "llm_api_endpoint": "https://api.anthropic.com/v1/messages",
  "llm_api_key": "sk-ant-xxx",
  "active_probe": true,
  "probe_payload": "{\"model\":\"claude-3-opus-20240229\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":1}",
  "interval": 300
}
```

### 13.3 OpenRouter (多模型)

```json
{
  "type": "llm-model",
  "name": "Grok-2 via OpenRouter",
  "model_name": "x-ai/grok-2",
  "upstream_provider": "openrouter",
  "cost_level": "critical",
  "llm_api_endpoint": "https://openrouter.ai/api/v1/chat/completions",
  "llm_api_key": "sk-or-xxx",
  "active_probe": false,
  "interval": 900
}
```

---

## 十四、总结

这个 LLM 健康监控系统提供了：

✅ **灵活的监控方式**：主动探测 + 被动上报  
✅ **智能的健康评分**：基于成功率和延迟的加权算法  
✅ **精细的成本控制**：根据模型成本动态调整探测频率  
✅ **完整的可观测性**：实时状态、历史趋势、成本统计  
✅ **易于集成**：简单的 REST API 和 Socket.IO 接口  

如有问题，请查看日志或提交 Issue。
