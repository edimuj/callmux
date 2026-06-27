import { EventEmitter } from "node:events";
import { CallmuxListener } from "./listener.js";
import { CallmuxProxy } from "./proxy.js";
import type { CallmuxConfig, ListenerRuntimeDiagnostics, ServerInfo } from "./types.js";
import type { ManagementOverlay } from "./management.js";

const STALE_PROXY_CLOSE_DELAY_MS = 30_000;

export type ListenerLifecycleState =
  | "starting"
  | "running"
  | "degraded"
  | "reloading"
  | "down"
  | "stopped";

export interface CreateListenerOptions {
  port: number;
  host?: string;
  config: CallmuxConfig;
  configPath?: string;
  managementBaseConfig?: CallmuxConfig;
  managementOverlay?: ManagementOverlay;
}

export interface ListenerHealthSnapshot {
  state: ListenerLifecycleState;
  url: string;
  mcpUrl: string;
  host: string;
  port: number;
  startedAt?: string;
  stoppedAt?: string;
  updatedAt: string;
  reason?: string;
  downstream: {
    total: number;
    connected: number;
    failed: number;
    servers: Record<string, ServerInfo | { state: "failed"; error: string }>;
  };
  runtime: ListenerRuntimeDiagnostics;
}

export interface ProgrammaticListener {
  readonly listener: CallmuxListener;
  readonly url: string;
  readonly mcpUrl: string;
  health(): ListenerHealthSnapshot;
  on(event: "status", callback: (snapshot: ListenerHealthSnapshot) => void): this;
  off(event: "status", callback: (snapshot: ListenerHealthSnapshot) => void): this;
  reload(config: CallmuxConfig, options?: {
    managementBaseConfig?: CallmuxConfig;
    managementOverlay?: ManagementOverlay;
    reason?: string;
  }): Promise<void>;
  stop(): Promise<void>;
}

function closeStaleProxyLater(proxy: CallmuxProxy): void {
  const timer = setTimeout(() => {
    proxy.close().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[callmux] Stale upstream close failed: ${message}\n`);
    });
  }, STALE_PROXY_CLOSE_DELAY_MS);
  timer.unref?.();
}

function listenerPort(listener: CallmuxListener, configuredPort: number): number {
  const address = listener.address();
  if (address && typeof address === "object") return address.port;
  return configuredPort;
}

function serverSnapshot(proxy: CallmuxProxy, config: CallmuxConfig) {
  const upstream = proxy.getUpstream();
  const servers: ListenerHealthSnapshot["downstream"]["servers"] = {};
  let connected = 0;
  let failed = 0;

  for (const name of Object.keys(config.servers)) {
    const info = upstream.getServerInfo(name);
    const failure = upstream.getFailedServers().find((item) => item.name === name);
    if (info) {
      servers[name] = info;
      if (info.state === "connected") connected += 1;
      if (info.state === "failed" || info.state === "degraded") failed += 1;
    } else if (failure) {
      servers[name] = { state: "failed", error: failure.error };
      failed += 1;
    }
  }

  return {
    total: Object.keys(config.servers).length,
    connected,
    failed,
    servers,
  };
}

class ProgrammaticCallmuxListener extends EventEmitter implements ProgrammaticListener {
  private proxy: CallmuxProxy;
  private config: CallmuxConfig;
  private state: ListenerLifecycleState = "starting";
  private startedAt: string | undefined;
  private stoppedAt: string | undefined;
  private currentReason: string | undefined;

  readonly listener: CallmuxListener;

  constructor(
    private readonly options: Required<Pick<CreateListenerOptions, "host" | "port">> &
      Omit<CreateListenerOptions, "host" | "port">,
    proxy: CallmuxProxy,
    listener: CallmuxListener
  ) {
    super();
    this.proxy = proxy;
    this.config = options.config;
    this.listener = listener;
  }

  get url(): string {
    const port = listenerPort(this.listener, this.options.port);
    return `http://${this.options.host}:${port}`;
  }

  get mcpUrl(): string {
    return `${this.url}/mcp`;
  }

  on(event: "status", callback: (snapshot: ListenerHealthSnapshot) => void): this {
    return super.on(event, callback) as this;
  }

  off(event: "status", callback: (snapshot: ListenerHealthSnapshot) => void): this {
    return super.off(event, callback) as this;
  }

  health(): ListenerHealthSnapshot {
    return {
      state: this.state,
      url: this.url,
      mcpUrl: this.mcpUrl,
      host: this.options.host,
      port: listenerPort(this.listener, this.options.port),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.stoppedAt ? { stoppedAt: this.stoppedAt } : {}),
      updatedAt: new Date().toISOString(),
      ...(this.currentReason ? { reason: this.currentReason } : {}),
      downstream: serverSnapshot(this.proxy, this.config),
      runtime: this.listener.getRuntimeDiagnostics(),
    };
  }

  async start(): Promise<void> {
    this.setState("starting");
    await this.listener.start();
    this.startedAt = new Date().toISOString();
    this.setState(this.proxy.getUpstream().getFailedServers().length > 0 ? "degraded" : "running");
  }

  async reload(config: CallmuxConfig, options?: {
    managementBaseConfig?: CallmuxConfig;
    managementOverlay?: ManagementOverlay;
    reason?: string;
  }): Promise<void> {
    const previousState = this.state;
    this.setState("reloading", options?.reason);
    let nextProxy: CallmuxProxy | undefined;
    try {
      nextProxy = new CallmuxProxy(config);
      await nextProxy.connectUpstreams();
      const previousProxy = this.proxy;
      this.listener.applyReloadedState({
        config,
        upstream: nextProxy.getUpstream(),
        cache: nextProxy.getCache(),
        allTools: nextProxy.getTools(),
        maxConcurrency: nextProxy.getMaxConcurrency(),
        managementBaseConfig: options?.managementBaseConfig ?? config,
        managementOverlay: options?.managementOverlay,
      });
      this.listener.recordConfigReload({ ok: true });
      this.proxy = nextProxy;
      this.config = config;
      nextProxy = undefined;
      closeStaleProxyLater(previousProxy);
      this.setState(
        this.proxy.getUpstream().getFailedServers().length > 0 ? "degraded" : "running",
        options?.reason
      );
    } catch (error) {
      if (nextProxy) {
        try { await nextProxy.close(); } catch {}
      }
      const message = error instanceof Error ? error.message : String(error);
      this.listener.recordConfigReload({ ok: false, error: message });
      this.setState(previousState, message);
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([
      this.listener.close(),
      this.proxy.close(),
    ]);
    this.stoppedAt = new Date().toISOString();
    this.setState("stopped");
  }

  private setState(state: ListenerLifecycleState, reason?: string): void {
    this.state = state;
    this.currentReason = reason;
    this.emit("status", this.health());
  }
}

export async function createListener(
  options: CreateListenerOptions
): Promise<ProgrammaticListener> {
  const host = options.host ?? "127.0.0.1";
  const proxy = new CallmuxProxy(options.config);
  try {
    await proxy.connectUpstreams();
    let programmatic: ProgrammaticCallmuxListener;
    const listener = new CallmuxListener({
      port: options.port,
      host,
      config: options.config,
      configPath: options.configPath,
      managementBaseConfig: options.managementBaseConfig,
      managementOverlay: options.managementOverlay,
      upstream: proxy.getUpstream(),
      cache: proxy.getCache(),
      responseStore: proxy.getResponseStore(),
      allTools: proxy.getTools(),
      maxConcurrency: proxy.getMaxConcurrency(),
      onManagementConfigChange: async (nextConfig, trigger, nextOverlay) => {
        await programmatic.reload(nextConfig, {
          reason: trigger,
          managementBaseConfig: options.managementBaseConfig ?? options.config,
          managementOverlay: nextOverlay,
        });
      },
    });
    programmatic = new ProgrammaticCallmuxListener(
      { ...options, host, port: options.port },
      proxy,
      listener
    );
    await programmatic.start();
    return programmatic;
  } catch (error) {
    await proxy.close().catch(() => undefined);
    throw error;
  }
}
