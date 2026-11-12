#!/usr/bin/env bash
# Test, build, and deploy the static site to Cloudflare Pages (https://gradecrunch.pages.dev).
# Needs wrangler (`npm i -g wrangler`) logged in with `wrangler login`, or CLOUDFLARE_API_TOKEN set.
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
npm run build
wrangler pages deploy dist --project-name gradecrunch --branch main --commit-dirty=true
