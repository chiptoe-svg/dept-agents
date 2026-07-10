/**
 * Expand ${VAR} references in MCP header values from the container env at
 * connect time, so persisted config holds only a reference, never a secret.
 * A header that references a missing/empty env var is dropped (with a warning)
 * rather than sent with an unexpanded literal ${...}.
 */
export function resolveHeaders(
  headers: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (!headers) return {};
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    let missing = false;
    const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, varName: string) => {
      const v = env[varName];
      if (v === undefined || v === '') {
        missing = true;
        return '';
      }
      return v;
    });
    if (missing) {
      console.error(`[mcp-headers] dropping header "${name}": unresolved env reference`);
      continue;
    }
    resolved[name] = expanded;
  }
  return resolved;
}
