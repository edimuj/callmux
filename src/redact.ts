const SECRET_KEY_PATTERN =
  /(?:^|[-_])(token|secret|password|passwd|api[-_]?key|authorization|credential|auth)(?:$|[-_])/i;

function isSecretKey(value: string): boolean {
  return SECRET_KEY_PATTERN.test(value);
}

function redactInlineAssignment(value: string): string {
  const equals = value.indexOf("=");
  if (equals <= 0) return value;

  const key = value.slice(0, equals);
  if (!isSecretKey(key.replace(/^--?/, ""))) return value;
  return `${key}=[redacted]`;
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSecretKey(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function redactCommandParts(parts: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;

  for (const part of parts) {
    if (redactNext) {
      redacted.push("[redacted]");
      redactNext = false;
      continue;
    }

    if (part.startsWith("--") && part.includes("=")) {
      redacted.push(redactInlineAssignment(part));
      continue;
    }

    redacted.push(redactInlineAssignment(part));

    if (part.startsWith("-") && isSecretKey(part.replace(/^-+/, ""))) {
      redactNext = true;
    }
  }

  return redacted;
}

export function formatCommandForDisplay(
  command: string,
  args: string[] = []
): string {
  return redactCommandParts([command, ...args]).join(" ");
}
