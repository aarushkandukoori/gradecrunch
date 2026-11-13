import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    target: 'es2022',
    rolldownOptions: {
      output: {
        // The pdf.js worker ships as a .mjs file. The site sends "nosniff", so the browser runs the worker only if
        // the host labels it JavaScript. Every host labels .js correctly, so publish it as .js to be safe.
        assetFileNames: (asset) =>
          asset.names.some((n) => n.endsWith('.mjs')) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
})
