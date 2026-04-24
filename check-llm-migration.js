// 检查 LLM 迁移状态的脚本
const { R } = require("redbean-node");
const Database = require("./server/database");

(async () => {
    try {
        // 使用正确的参数初始化数据库
        Database.dataDir = "./data/";
        Database.sqlitePath = Database.dataDir + "kuma.db";

        await Database.connect(false, false, false);

        console.log("=== 检查 Knex 迁移状态 ===\n");

        // 检查迁移表
        const migrations = await R.knex("knex_migrations")
            .select("name")
            .orderBy("id", "desc")
            .limit(10);

        console.log("最近的 10 个迁移:");
        migrations.forEach(m => console.log("  -", m.name));

        const hasLLM = migrations.some(m => m.name.includes("2026-04-22-0000"));
        console.log("\n✓ 是否包含 LLM 迁移 (2026-04-22-0000):", hasLLM ? "是" : "否");

        // 检查 monitor 表结构
        console.log("\n=== 检查 monitor 表字段 ===\n");
        const columns = await R.knex.raw("PRAGMA table_info(monitor)");

        const llmFields = ["model_name", "upstream_provider", "cost_level", "health_score", "llm_api_endpoint"];
        llmFields.forEach(field => {
            const exists = columns.some(c => c.name === field);
            console.log(`  ${exists ? "✓" : "✗"} ${field}: ${exists ? "存在" : "不存在"}`);
        });

        // 检查 llm_cost_log 表
        console.log("\n=== 检查 llm_cost_log 表 ===\n");
        const tables = await R.knex.raw("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_cost_log'");
        const hasTable = tables.length > 0;
        console.log(`  ${hasTable ? "✓" : "✗"} llm_cost_log 表: ${hasTable ? "存在" : "不存在"}`);

        await Database.close();

        if (!hasLLM) {
            console.log("\n⚠️  LLM 迁移尚未执行！");
            console.log("解决方案：重启服务器，Knex 会自动运行迁移。");
        } else {
            console.log("\n✓ LLM 监控系统已成功集成！");
        }

    } catch(e) {
        console.error("错误:", e.message);
        console.error(e.stack);
        process.exit(1);
    }
})();
