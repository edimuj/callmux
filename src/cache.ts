import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CacheEntry } from "./types.js";

export class CallCache {
  private entries = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
  }

  private key(tool: string, args?: Record<string, unknown>): string {
    return `${tool}:${args ? JSON.stringify(args, Object.keys(args).sort()) : ""}`;
  }

  get(tool: string, args?: Record<string, unknown>): CallToolResult | null {
    if (this.ttlMs <= 0) return null;

    const entry = this.entries.get(this.key(tool, args));
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(this.key(tool, args));
      return null;
    }

    return entry.result;
  }

  set(tool: string, args: Record<string, unknown> | undefined, result: CallToolResult): void {
    if (this.ttlMs <= 0) return;
    if (result.isError) return;

    this.entries.set(this.key(tool, args), {
      result,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  invalidate(tool?: string): void {
    if (!tool) {
      this.entries.clear();
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${tool}:`)) {
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
