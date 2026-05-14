#!/usr/bin/env bash
# Set model tier and restart control service
# Usage: ./scripts/set-tier.sh [max|standard|economy|free]
set -e

TIER=${1:-standard}

if [ ! -f ".model-tiers.json" ]; then
  echo "Error: .model-tiers.json not found"
  exit 1
fi

# Read models from JSON
PLANNER=$(python3 -c "import json; print(json.load(open('.model-tiers.json'))['$TIER']['planner'])")
EXECUTOR=$(python3 -c "import json; print(json.load(open('.model-tiers.json'))['$TIER']['executor'])")
VISION=$(python3 -c "import json; print(json.load(open('.model-tiers.json'))['$TIER']['vision'])")

echo "Switching to tier: $TIER"
echo "  Planner:  $PLANNER"
echo "  Executor: $EXECUTOR"
echo "  Vision:   ${VISION:-none}"

# Kill existing control service
PID=$(ps aux | grep "auto-browser serve" | grep -v grep | awk '{print $2}')
if [ -n "$PID" ]; then
  echo "Stopping control service (PID: $PID)..."
  kill "$PID" 2>/dev/null
  sleep 1
fi

# Start with new config
export AUTO_BROWSER_PLANNER_MODEL="$PLANNER"
export AUTO_BROWSER_EXECUTOR_MODEL="$EXECUTOR"
if [ -n "$VISION" ]; then
  export AUTO_BROWSER_VISION_MODEL="$VISION"
else
  unset AUTO_BROWSER_VISION_MODEL
fi

auto-browser serve &
sleep 2

# Verify
curl -s http://127.0.0.1:4317/api/runtime-config
echo ""
echo "Tier $TIER active"
