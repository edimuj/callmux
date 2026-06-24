import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'

// callmux's listener serves the dashboard as ONE self-contained HTML doc (no
// CDN, no sibling asset requests) — vite-plugin-singlefile inlines every JS/CSS
// chunk into dist/index.html, which a root build step copies to
// assets/dashboard.html for the runtime to read.
//
// The dev proxy forwards the dashboard's data endpoints to a running callmux
// instance (default port 4860). Run callmux with `dashboard.path: "/"` so its
// JSON lives at /data, /events, /series, /drilldown to match the dev mount.
const DEV_TARGET = process.env.CALLMUX_DASHBOARD_TARGET || 'http://localhost:4860'

export default defineConfig({
  base: './',
  plugins: [
    react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } }),
    tailwindcss(),
    viteSingleFile(),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000,
    reportCompressedSize: false,
  },
  server: {
    proxy: {
      '/data': DEV_TARGET,
      '/events': DEV_TARGET,
      '/series': DEV_TARGET,
      '/drilldown': DEV_TARGET,
      '/management': DEV_TARGET,
    },
  },
})
