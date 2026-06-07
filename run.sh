#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Launch pi with the codemaps extension loaded
exec pi -e ./extensions/codemaps.ts "$@"
