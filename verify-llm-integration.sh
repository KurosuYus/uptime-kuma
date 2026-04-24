#!/bin/bash

echo "=========================================="
echo "LLM 监控系统集成验证"
echo "=========================================="
echo ""

# 1. 检查后端文件
echo "✓ 检查后端文件..."
files=(
    "server/monitor-types/llm-model.js"
    "server/socket-handlers/llm-monitor-socket-handler.js"
    "server/routers/api-router.js"
    "db/knex_migrations/2026-04-22-0000-add-llm-monitor-fields.js"
)

for file in "${files[@]}"; do
    if [ -f "$file" ]; then
        echo "  ✓ $file"
    else
        echo "  ✗ $file (缺失)"
    fi
done

echo ""

# 2. 检查数据库迁移
echo "✓ 检查数据库迁移状态..."
node check-llm-migration.js 2>&1 | grep -E "✓|✗|是否包含"

echo ""

# 3. 检查前端集成
echo "✓ 检查前端集成..."
if grep -q "llm-model" src/pages/EditMonitor.vue; then
    echo "  ✓ EditMonitor.vue 已添加 LLM 选项"
else
    echo "  ✗ EditMonitor.vue 未找到 LLM 选项"
fi

echo ""

# 4. 检查服务器集成
echo "✓ 检查服务器集成..."
if grep -q "LLMModelMonitorType" server/uptime-kuma-server.js; then
    echo "  ✓ uptime-kuma-server.js 已注册 LLM 监控类型"
else
    echo "  ✗ uptime-kuma-server.js 未注册 LLM 监控类型"
fi

if grep -q "llmMonitorSocketHandler" server/server.js; then
    echo "  ✓ server.js 已注册 Socket 处理器"
else
    echo "  ✗ server.js 未注册 Socket 处理器"
fi

echo ""
echo "=========================================="
echo "下一步操作："
echo "=========================================="
echo ""
echo "1. 重新构建前端（必须）："
echo "   npm run build"
echo ""
echo "2. 启动开发服务器："
echo "   npm run dev"
echo ""
echo "3. 访问 http://localhost:3000"
echo "   - 登录后点击 '添加新监控'"
echo "   - 在 'Specific Monitor Type' 分组中选择 'LLM Model Health Monitor'"
echo ""
echo "4. 测试被动上报 API："
echo "   curl -X POST http://localhost:3001/api/llm-health/report \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"modelName\":\"gpt-4-turbo\",\"success\":true,\"latency\":1250}'"
echo ""
echo "=========================================="
