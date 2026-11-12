// Entry point of the Sync bookmarklet. scripts/build-bookmarklet.mjs bundles this (and everything it
// imports) into one minified script. '__SITE_ORIGIN__' is a placeholder: the app swaps in its own
// origin (e.g. https://tartangrades.pages.dev) when it builds the javascript: link, so the same
// bundle works on the live site and on localhost.
import { realDeps, runSync } from './run'

const SITE = '__SITE_ORIGIN__'

void runSync(realDeps(SITE))
