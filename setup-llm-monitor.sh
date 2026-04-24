#!/bin/bash

# LLM 监控系统快速部署脚本
# 用法: ./setup-llm-monitor.sh

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查依赖
check_dependencies() {
    log_info "Checking dependencies..."

    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js first."
        exit 1
    fi

    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed. Please install npm first."
        exit 1
    fi

    log_success "All dependencies are installed"
}

# 检查 Uptime Kuma 是否运行
check_uptime_kuma() {
    log_info "Checking if Uptime Kuma is running..."

    if pgrep -f "uptime-kuma" > /dev/null; then
        log_warn "Uptime Kuma is currently running. It will be stopped for migration."
        read -p "Continue? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_error "Aborted by user"
            exit 1
        fi

        # 停止 Uptime Kuma
        log_info "Stopping Uptime Kuma..."
        if command -v pm2 &> /dev/null; then
            pm2 stop uptime-kuma || true
        else
            pkill -f "uptime-kuma" || true
        fi
        sleep 2
        log_success "Uptime Kuma stopped"
    else
        log_info "Uptime Kuma is not running"
    fi
}

# 备份数据库
backup_database() {
    log_info "Backing up database..."

    DB_PATH="./db/kuma.db"
    if [ -f "$DB_PATH" ]; then
        BACKUP_PATH="./db/kuma.db.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$DB_PATH" "$BACKUP_PATH"
        log_success "Database backed up to $BACKUP_PATH"
    else
        log_warn "Database file not found, skipping backup"
    fi
}

# 运行数据库迁移
run_migration() {
    log_info "Running database migration..."

    if [ ! -f "./db/knex_migrations/2026-04-22-0000-add-llm-monitor-fields.js" ]; then
        log_error "Migration file not found. Please ensure all files are in place."
        exit 1
    fi

    npm run migrate
    log_success "Database migration completed"
}

# 验证文件
verify_files() {
    log_info "Verifying LLM monitor files..."

    FILES=(
        "./server/monitor-types/llm-model.js"
        "./server/socket-handlers/llm-monitor-socket-handler.js"
        "./db/knex_migrations/2026-04-22-0000-add-llm-monitor-fields.js"
    )

    MISSING=0
    for file in "${FILES[@]}"; do
        if [ ! -f "$file" ]; then
            log_error "Missing file: $file"
            MISSING=1
        fi
    done

    if [ $MISSING -eq 1 ]; then
        log_error "Some required files are missing. Please check the installation."
        exit 1
    fi

    log_success "All required files are present"
}

# 检查代码注册
verify_registration() {
    log_info "Verifying code registration..."

    # 检查 uptime-kuma-server.js
    if grep -q "LLMModelMonitorType" ./server/uptime-kuma-server.js; then
        log_success "LLM monitor type registered in uptime-kuma-server.js"
    else
        log_error "LLM monitor type not registered in uptime-kuma-server.js"
        exit 1
    fi

    # 检查 server.js
    if grep -q "llmMonitorSocketHandler" ./server/server.js; then
        log_success "LLM socket handler registered in server.js"
    else
        log_error "LLM socket handler not registered in server.js"
        exit 1
    fi

    # 检查 api-router.js
    if grep -q "/api/llm-health/report" ./server/routers/api-router.js; then
        log_success "LLM health API registered in api-router.js"
    else
        log_error "LLM health API not registered in api-router.js"
        exit 1
    fi
}

# 启动 Uptime Kuma
start_uptime_kuma() {
    log_info "Starting Uptime Kuma..."

    if command -v pm2 &> /dev/null; then
        pm2 start server/server.js --name uptime-kuma
        log_success "Uptime Kuma started with PM2"
    else
        log_warn "PM2 not found. Starting in background..."
        nohup node server/server.js > uptime-kuma.log 2>&1 &
        log_success "Uptime Kuma started in background (PID: $!)"
        log_info "Logs: tail -f uptime-kuma.log"
    fi

    sleep 3
}

# 测试安装
test_installation() {
    log_info "Testing installation..."

    # 等待服务启动
    sleep 5

    # 测试 API 端点
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/entry-page | grep -q "200"; then
        log_success "Uptime Kuma is responding"
    else
        log_error "Uptime Kuma is not responding. Check logs for errors."
        exit 1
    fi

    log_success "Installation test passed"
}

# 显示后续步骤
show_next_steps() {
    echo
    echo "=========================================="
    log_success "LLM Monitor Setup Complete!"
    echo "=========================================="
    echo
    echo "Next steps:"
    echo
    echo "1. Access Uptime Kuma at: http://localhost:3001"
    echo
    echo "2. Create a new monitor:"
    echo "   - Type: LLM Model"
    echo "   - Configure model name, API endpoint, and API key"
    echo
    echo "3. Integrate with your backend:"
    echo "   - See LLM_MONITOR_GUIDE.md for integration examples"
    echo "   - Use POST /api/llm-health/report to report health data"
    echo
    echo "4. Run tests:"
    echo "   - node test-llm-monitor.js"
    echo
    echo "Documentation:"
    echo "   - Full guide: LLM_MONITOR_GUIDE.md"
    echo "   - Frontend examples: LLM_MONITOR_FRONTEND_EXAMPLE.js"
    echo
    echo "=========================================="
    echo
}

# 主流程
main() {
    echo
    echo "=========================================="
    echo "  LLM Monitor Setup Script"
    echo "=========================================="
    echo

    check_dependencies
    verify_files
    verify_registration
    check_uptime_kuma
    backup_database
    run_migration
    start_uptime_kuma
    test_installation
    show_next_steps
}

# 错误处理
trap 'log_error "Setup failed. Check the error messages above."; exit 1' ERR

# 运行主流程
main
