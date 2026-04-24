#!/bin/bash

# LLM Health Monitoring Demo - Quick Start Script
# This demo includes both passive reporting AND active probing support
# Mock API runs on port 3003

set -e

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     LLM Health Monitoring Demo - Quick Start                   ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Features:"
echo "  - Mock API server on port 3003 (supports both passive & active)"
echo "  - Passive reporting: 200 reports/sec"
echo "  - Active probing: configurable interval"
echo "  - Loop: 2min reporting → 3min silence → repeat"
echo ""

# Check if Uptime Kuma server is running
echo "🔍 Checking if Uptime Kuma is running..."
if curl -s http://localhost:3001/api/entry-page > /dev/null 2>&1; then
    echo "✅ Uptime Kuma server is running"
else
    echo "❌ Uptime Kuma server is not running!"
    echo ""
    echo "Please start the server first:"
    echo "  npm run dev"
    echo ""
    echo "The server should be accessible at:"
    echo "  Frontend: http://localhost:3000"
    echo "  Backend:  http://localhost:3001"
    echo ""
    exit 1
fi

echo ""
echo "🚀 Starting demo..."
echo ""
echo "Mock API will run on http://localhost:3003"
echo ""
echo "Press Ctrl+C to stop the demo"
echo ""

# Start the demo
node demo-llm-monitoring.js
