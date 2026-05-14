#!/usr/bin/env bash
# Auto-Browser MCP Server — loads .env then starts the MCP server
set -a
source "$(dirname "$0")/.env"
set +a
exec node "$(dirname "$0")/dist/auto-browser/mcp-server.js"
