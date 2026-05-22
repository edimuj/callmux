import type { CallmuxConfig, ServerConfig } from "./types.js";

export interface ManagementClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export interface ManagementRequestOptions {
  signal?: AbortSignal;
}

export class ManagementClient {
  private baseUrl: URL;
  private fetchImpl: typeof fetch;

  constructor(private options: ManagementClientOptions) {
    this.baseUrl = new URL(options.baseUrl.replace(/\/+$/, "") + "/");
    this.fetchImpl = options.fetch ?? fetch;
  }

  status(options?: ManagementRequestOptions): Promise<unknown> {
    return this.request("status", { method: "GET", signal: options?.signal });
  }

  effectiveConfig(options?: ManagementRequestOptions): Promise<CallmuxConfig> {
    return this.request("config/effective", { method: "GET", signal: options?.signal });
  }

  servers(options?: ManagementRequestOptions): Promise<unknown> {
    return this.request("servers", { method: "GET", signal: options?.signal });
  }

  addServer(
    name: string,
    config: ServerConfig,
    options?: ManagementRequestOptions & { dryRun?: boolean }
  ): Promise<unknown> {
    return this.request("servers", {
      method: "POST",
      body: { name, config, dryRun: options?.dryRun },
      signal: options?.signal,
    });
  }

  updateServer(
    name: string,
    body: {
      config?: ServerConfig;
      tools?: string[];
      addTools?: string[];
      removeTools?: string[];
      disabled?: boolean;
      dryRun?: boolean;
    },
    options?: ManagementRequestOptions
  ): Promise<unknown> {
    return this.request(`servers/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body,
      signal: options?.signal,
    });
  }

  removeServer(
    name: string,
    options?: ManagementRequestOptions & { dryRun?: boolean }
  ): Promise<unknown> {
    const suffix = options?.dryRun ? "?dryRun=true" : "";
    return this.request(`servers/${encodeURIComponent(name)}${suffix}`, {
      method: "DELETE",
      signal: options?.signal,
    });
  }

  restartServer(name: string, options?: ManagementRequestOptions): Promise<unknown> {
    return this.request(`servers/${encodeURIComponent(name)}/restart`, {
      method: "POST",
      signal: options?.signal,
    });
  }

  clearCache(
    body: { server?: string; tool?: string } = {},
    options?: ManagementRequestOptions
  ): Promise<unknown> {
    return this.request("cache/clear", {
      method: "POST",
      body,
      signal: options?.signal,
    });
  }

  private async request<T>(
    path: string,
    options: {
      method: string;
      body?: unknown;
      signal?: AbortSignal;
    }
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetchImpl(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const message = typeof payload?.error === "string"
        ? payload.error
        : `management request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  }
}
