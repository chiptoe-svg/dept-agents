/**
 * Reproduce getPiAuthApiKey() against an arbitrary session's auth.json
 * to figure out which branch is returning null when pi reports
 * "No credentials available for Pi model provider: openai-codex".
 *
 * Usage:
 *   pnpm exec tsx scripts/debug-pi-auth.ts <providerId> <auth.json-path>
 */
import { getPiAuthApiKey } from '../container/agent-runner/src/providers/pi-auth.ts';

const [providerId, authPath] = process.argv.slice(2);
if (!providerId || !authPath) {
  console.error('Usage: pnpm exec tsx scripts/debug-pi-auth.ts <providerId> <auth.json-path>');
  process.exit(1);
}

try {
  const r = await getPiAuthApiKey(providerId, authPath);
  console.log('result:', r ? `apiKey len ${r.apiKey.length}` : 'NULL');
} catch (e) {
  console.log('threw:', e instanceof Error ? e.message : String(e));
}
