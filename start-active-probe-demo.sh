#!/bin/bash

# LLM Active Probe Demo - Quick Start Script
# This demo focuses on ACTIVE PROBING only (no passive reporting)
# Mock API runs on port 3002

set -e

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     LLM Active Probe Demo - Quick Start                         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Features:"
echo "  - Mock API server on port 3002"
echo "  - Active probing only (no passive reporting)"
echo "  - Pure deep night / low season simulation"
echo "  - Dynamic scenarios: healthy → degraded → critical → down"
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
echo "🚀 Starting Mock API server..."
echo ""
echo "This will start a mock LLM API server on port 3002"
echo "that simulates OpenAI, Anthropic, and Google APIs."
echo ""
echo "Press Ctrl+C to stop the demo"
echo ""

# Start the demo
node demo-active-probe.js
