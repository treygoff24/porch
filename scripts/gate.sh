#!/usr/bin/env bash
# Porch's gate: lint and format, types, tests. Run it through testrun:
#   testrun porch gate -- scripts/gate.sh
set -euo pipefail
cd "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/.."
pnpm exec biome ci --colors=off .
pnpm exec tsc --noEmit --pretty false
pnpm exec vitest run --maxWorkers=4
