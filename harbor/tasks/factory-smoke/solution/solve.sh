#!/bin/bash
set -euo pipefail

mkdir -p /app/artifacts
cat > /app/artifacts/factory-quality-summary.json <<'EOF'
{
  "repo": "pi-factory",
  "task": "factory-smoke",
  "status": "ok",
  "notes": "Harbor wiring is ready for richer Factory evals."
}
EOF
