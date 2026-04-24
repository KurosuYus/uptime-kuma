exports.up = function (knex) {
    return knex.schema
        .alterTable("monitor", function (table) {
            // LLM 模型标识
            table.string("model_name", 255);
            // 上游平台 (openrouter, n1n, etc.)
            table.string("upstream_provider", 255);
            // 成本等级 (low, medium, high, critical)
            table.string("cost_level", 50).defaultTo("medium");
            // 当前健康分数 (0-100)
            table.float("health_score").defaultTo(100);
            // 最后探测时间戳
            table.bigInteger("last_probe_time");
            // 自定义探测请求体 (JSON 字符串)
            table.text("probe_payload");
            // 是否启用主动探测
            table.boolean("active_probe").defaultTo(true);
            // LLM API 端点
            table.text("llm_api_endpoint");
            // LLM API 密钥 (加密存储)
            table.text("llm_api_key");
            // 探测请求超时时间 (毫秒)
            table.integer("probe_timeout").defaultTo(30000);
            // 主动探测间隔 (秒) - 独立于心跳间隔
            table.integer("probe_interval");
        })
        .createTable("llm_cost_log", function (table) {
            table.increments("id").primary();
            table.integer("monitor_id").unsigned().notNullable();
            table.bigInteger("timestamp").notNullable();
            table.float("estimated_cost").defaultTo(0);
            table.string("probe_type", 50).notNullable(); // active, passive
            table.integer("tokens_used").defaultTo(0);
            table.string("model_name", 255);
            table.text("error_message");

            // 索引
            table.index("monitor_id");
            table.index("timestamp");
            table.index(["monitor_id", "timestamp"]);
        });
};

exports.down = function (knex) {
    return knex.schema
        .alterTable("monitor", function (table) {
            table.dropColumn("model_name");
            table.dropColumn("upstream_provider");
            table.dropColumn("cost_level");
            table.dropColumn("health_score");
            table.dropColumn("last_probe_time");
            table.dropColumn("probe_payload");
            table.dropColumn("active_probe");
            table.dropColumn("llm_api_endpoint");
            table.dropColumn("llm_api_key");
            table.dropColumn("probe_timeout");
            table.dropColumn("probe_interval");
        })
        .dropTableIfExists("llm_cost_log");
};
