#!/usr/bin/env node
// Copy the built single-file dashboard bundle into assets/, where the listener
// reads it at runtime (src/dashboard.ts -> loadDashboardHtml). Run after
// `npm --prefix dashboard run build`.
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "dashboard", "dist", "index.html");
const destDir = join(root, "assets");
const dest = join(destDir, "dashboard.html");

try {
  const info = await stat(src);
  await mkdir(destDir, { recursive: true });
  await copyFile(src, dest);
  console.error(`dashboard asset -> assets/dashboard.html (${(info.size / 1024).toFixed(0)} kB)`);
} catch (error) {
  console.error(`Failed to copy dashboard asset from ${src}: ${error.message}`);
  console.error("Did the dashboard build run? Try: npm --prefix dashboard run build");
  process.exit(1);
}
