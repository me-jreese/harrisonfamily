#!/usr/bin/env bash
# Package lambda/hfy-check-allowed into dist/hfy-check-allowed.zip (same contents as the legacy deploy).
set -euo pipefail
root=$(pwd)
mkdir -p "$root/dist"
cd lambda/hfy-check-allowed
npm ci
zip -r "$root/dist/hfy-check-allowed.zip" index.mjs package.json package-lock.json node_modules
