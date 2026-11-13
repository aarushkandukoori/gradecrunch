#!/usr/bin/env bash
# Test, build, and deploy to Cloudflare Pages (https://grades.aarushkandukoori.com): the static site in dist/ plus the
# AI advisor chat function in ./functions, which wrangler bundles because this runs from the project root. The function
# reads the OPENAI_API_KEY secret set in the Pages dashboard.
# Needs wrangler (`npm i -g wrangler`) logged in with `wrangler login`, or CLOUDFLARE_API_TOKEN set.
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
npm run build
wrangler pages deploy dist --project-name gradecrunch --branch main --commit-dirty=true
