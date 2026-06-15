#!/usr/bin/env bash
#
# ACCEPTANCE ALL — run every milestone gate (M0→M5) in order and print the
# aggregate sentinel only if all pass.
#
# IMMUTABLE (docs/ACCEPTANCE.md #3): never edit this script to force a pass.
set -euo pipefail
cd "$(dirname "$0")/.."

for m in 0 1 2 3 4 5; do
  echo "=== verify:m${m} ==="
  bash "scripts/verify-m${m}.sh" || { echo "ACCEPTANCE ALL (M0-M5) FAIL: M${m} did not pass"; exit 1; }
done

echo "ACCEPTANCE ALL (M0-M5) PASS"
