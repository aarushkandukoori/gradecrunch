// Builds the GradeCrunch Chrome extension.
//
//   dist-extension/            dev build: load it at chrome://extensions with "Load unpacked". Its manifest keeps the
//                              "key" (so the extension id matches KNOWN_EXTENSION_IDS in extension/protocol.ts) and the
//                              http://localhost match (so `npm run dev` can talk to it). It also honors the website's
//                              { type: 'reload' } request, so a rebuilt extension can take effect without clicking
//                              Reload at chrome://extensions.
//   dist-extension-store/      store build: the same files, but the manifest has no "key" (the Web Store assigns the id)
//   gradecrunch-extension.zip  and no localhost match, and the scripts ignore 'reload'. The zip is what gets uploaded to
//                              the Chrome Web Store.
//
// The scripts are bundled with esbuild into plain (classic, non-module) scripts and NOT minified, so Web Store
// reviewers can read them. Each build gets its own bundle because of one build-time switch: __DEV_BUILD__ is true in
// the dev build and false in the store build (see isDevBuild in extension/src/background.ts). Any build error stops
// the script with a non-zero exit code.
//
// Usage: node scripts/build-extension.mjs
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'extension')
const devDir = join(root, 'dist-extension')
const storeDir = join(root, 'dist-extension-store')
const zipFile = join(root, 'gradecrunch-extension.zip')
const SCRIPTS = ['background.js', 'offscreen.js', 'welcome.js']

// Start clean so files deleted from extension/ do not linger in the output.
rmSync(devDir, { recursive: true, force: true })
rmSync(storeDir, { recursive: true, force: true })
rmSync(zipFile, { force: true })

/** Bundle the three scripts into `outDir` and copy the static files next to them. */
async function buildInto(outDir, devBuild) {
  mkdirSync(outDir, { recursive: true })
  // 1. Each script becomes a single self-contained file (background.js, offscreen.js, welcome.js).
  await build({
    entryPoints: {
      background: join(src, 'src/background.ts'),
      offscreen: join(src, 'src/offscreen.ts'),
      welcome: join(src, 'src/welcome.ts'),
    },
    outdir: outDir,
    bundle: true,
    format: 'iife', // a classic script: service workers declared without "type": "module" cannot use import/export
    target: 'chrome116', // matches minimum_chrome_version in the manifest
    platform: 'browser',
    minify: false, // readable code makes Web Store review faster
    charset: 'utf8',
    logLevel: 'warning',
    define: { __DEV_BUILD__: String(devBuild) },
  })

  for (const name of SCRIPTS) {
    const code = readFileSync(join(outDir, name), 'utf8')
    // MV3 forbids eval and other ways of running code from strings. Catch it here instead of in review.
    if (/\beval\(|new Function\(/.test(code)) {
      console.error(`${name} contains eval or new Function, which Manifest V3 does not allow.`)
      process.exit(1)
    }
    // The switch must be filled in, or the 'reload' request would silently stay off in the dev build.
    if (code.includes('__DEV_BUILD__')) {
      console.error(`${name} still mentions __DEV_BUILD__: the build-time switch was not applied.`)
      process.exit(1)
    }
  }

  // 2. Copy the static files.
  for (const file of ['offscreen.html', 'welcome.html', 'welcome.css']) cpSync(join(src, file), join(outDir, file))
  cpSync(join(src, 'icons'), join(outDir, 'icons'), { recursive: true })
}

await buildInto(devDir, true)
await buildInto(storeDir, false)

// 3. Manifests. The dev one is the source file as-is.
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'))
writeFileSync(join(devDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const storeManifest = structuredClone(manifest)
delete storeManifest.key
storeManifest.externally_connectable.matches = storeManifest.externally_connectable.matches.filter(
  (pattern) => !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(pattern),
)
writeFileSync(join(storeDir, 'manifest.json'), JSON.stringify(storeManifest, null, 2) + '\n')

// 4. Zip the store build. The system zip tool (built into macOS and most Linux setups) keeps this script free of extra
// dependencies. -X leaves out macOS extra attributes; running inside storeDir puts manifest.json at the zip's top level.
execFileSync('zip', ['-r', '-X', '-q', zipFile, '.'], { cwd: storeDir, stdio: 'inherit' })

const files = readdirSync(devDir, { recursive: true }).filter((f) => !String(f).endsWith('icons'))
console.log(`Extension v${manifest.version}: ${files.length} files in dist-extension/ (dev) and dist-extension-store/ (store)`)
console.log(`Store zip: gradecrunch-extension.zip (${(readFileSync(zipFile).length / 1024).toFixed(1)} KB)`)
