interface FatalListenerShutdownOptions {
  close: () => Promise<void> | void;
  log?: (message: string) => void;
  exit?: (code: number) => void;
  timeoutMs?: number;
}

const DEFAULT_FATAL_SHUTDOWN_TIMEOUT_MS = 5_000;

function fatalMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? reason.message;
  return String(reason);
}

export async function shutdownAfterFatalListenerError(
  kind: "uncaughtException" | "unhandledRejection",
  reason: unknown,
  options: FatalListenerShutdownOptions
): Promise<void> {
  const log = options.log ?? ((message: string) => process.stderr.write(message));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? DEFAULT_FATAL_SHUTDOWN_TIMEOUT_MS;

  log(`[callmux] ${kind}: ${fatalMessage(reason)}\n`);
  log("[callmux] Fatal listener error, shutting down before supervisor restart\n");

  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([
      Promise.resolve(options.close()),
      timeout,
    ]);
  } catch (error) {
    log(`[callmux] Fatal shutdown cleanup failed: ${fatalMessage(error)}\n`);
  }

  if (timedOut) {
    log(`[callmux] Fatal shutdown cleanup timed out after ${timeoutMs}ms\n`);
  }

  exit(1);
}
