#!/bin/sh
set -e

# Default model — used if OPENCODE_MODEL env var is not set
# This is the model the container's OpenCode will use to execute tasks.
DEFAULT_MODEL="anthropic/claude-sonnet-4-20250514"
MODEL="${OPENCODE_MODEL:-$DEFAULT_MODEL}"

# Parse provider and model ID from "provider/model-id" format
PROVIDER="${MODEL%%/*}"
MODEL_ID="${MODEL#*/}"

echo "=== OpenCode MCP Container ==="
echo "Model: $MODEL"

# Validate API key is set for the chosen provider
case "$PROVIDER" in
  anthropic)
    if [ -z "$ANTHROPIC_API_KEY" ]; then
      echo "FATAL: ANTHROPIC_API_KEY is not set. OpenCode cannot use $MODEL without it."
      echo "Set it via environment variable in docker-compose.yml or .env file."
      exit 1
    fi
    echo "API key: OK"
    ;;
  openai)
    if [ -z "$OPENAI_API_KEY" ]; then
      echo "FATAL: OPENAI_API_KEY is not set. OpenCode cannot use $MODEL without it."
      echo "Set it via environment variable in docker-compose.yml or .env file."
      exit 1
    fi
    echo "API key: OK"
    ;;
  google)
    if [ -z "$GOOGLE_API_KEY" ]; then
      echo "FATAL: GOOGLE_API_KEY is not set. OpenCode cannot use $MODEL without it."
      echo "Set it via environment variable in docker-compose.yml or .env file."
      exit 1
    fi
    echo "API key: OK"
    ;;
  *)
    echo "Warning: Unknown provider '$PROVIDER'. Ensure the appropriate API key is set."
    ;;
esac

# Create OpenCode state directory with the configured model
# This tells OpenCode which model provider to use.
mkdir -p /root/.local/state/opencode
cat > /root/.local/state/opencode/model.json <<EOF
{
  "recent": [
    { "providerID": "$PROVIDER", "modelID": "$MODEL_ID" }
  ],
  "favorite": [
    { "providerID": "$PROVIDER", "modelID": "$MODEL_ID" }
  ]
}
EOF

# Create MCP server config file (so model resolution works)
mkdir -p /root/.config/opencode-mcp
cat > /root/.config/opencode-mcp/config.json <<EOF
{
  "model": "$MODEL",
  "pool": {
    "maxConcurrent": 3
  }
}
EOF

echo "OpenCode config: provider=$PROVIDER model=$MODEL_ID"
echo "MCP server starting on http://0.0.0.0:3100/mcp"
echo ""

# Start the MCP server
exec node /app/dist/index.js --http --host 0.0.0.0 --model "$MODEL"
