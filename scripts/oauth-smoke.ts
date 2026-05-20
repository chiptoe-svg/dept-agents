#!/usr/bin/env tsx
/**
 * One-off smoke test for vendor OAuth values.
 *
 * Walks the auth-code-with-PKCE flow against the real vendor servers
 * (Anthropic / OpenAI) using the spec values from
 * src/providers/auth-registry.ts. Confirms that our discovered OAuth
 * config (client_id, authorize URL, token URL, scopes, redirect_uri)
 * actually works before we invest in the rest of Phase X.7.
 *
 * No persistence — prints redacted tokens and exits. Safe to run
 * with a real test student account.
 *
 * Usage:
 *   pnpm exec tsx scripts/oauth-smoke.ts claude
 *   pnpm exec tsx scripts/oauth-smoke.ts codex
 */

import crypto from 'crypto';
import readline from 'readline';
import { request as httpsRequest } from 'https';

import '../src/providers/claude-spec.js';
import '../src/providers/codex-spec.js';
import { getProviderSpec, type ProviderAuthSpec } from '../src/providers/auth-registry.js';

function randomBase64Url(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function redactToken(value: string | undefined): string | undefined {
  if (!value) return value;
  return `${value.slice(0, 12)}…(${value.length} chars)`;
}

interface TokenResponse {
  status: number;
  body: string;
}

async function postTokenExchange(
  spec: ProviderAuthSpec,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  if (!spec.oauth) throw new Error('no oauth config');
  const payload = {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: spec.oauth.clientId,
    redirect_uri: spec.oauth.redirectUri,
  };
  const isJson = spec.oauth.authCodeBodyFormat === 'json';
  const body = isJson ? JSON.stringify(payload) : new URLSearchParams(payload).toString();
  const url = new URL(spec.oauth.tokenUrl);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const providerId = process.argv[2];
  if (!providerId) {
    console.error('Usage: pnpm exec tsx scripts/oauth-smoke.ts <claude|codex>');
    process.exit(1);
  }
  const spec = getProviderSpec(providerId);
  if (!spec) {
    console.error(`Unknown provider: ${providerId}. Known: claude, codex`);
    process.exit(1);
  }
  if (!spec.oauth) {
    console.error(`Provider ${providerId} has no OAuth config`);
    process.exit(1);
  }

  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const challenge = s256(verifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: spec.oauth.clientId,
    redirect_uri: spec.oauth.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: spec.oauth.scopes.join(' '),
  });
  const authorizeUrl = `${spec.oauth.authorizeUrl}?${params.toString()}`;

  console.log('\n=== NanoClaw OAuth smoke test ===');
  console.log(`Provider: ${providerId} (${spec.displayName})`);
  console.log(`Client ID: ${spec.oauth.clientId}`);
  console.log(`Redirect URI: ${spec.oauth.redirectUri}`);
  console.log(`Scopes: ${spec.oauth.scopes.join(' ')}`);
  console.log(`Token body format: ${spec.oauth.authCodeBodyFormat}`);
  console.log(`\nStep 1: Open this URL in your browser:\n`);
  console.log(authorizeUrl);
  console.log(`\nWalkthrough:\n${spec.oauth.connectInstructions}\n`);

  const rawPaste = await prompt('Paste here: ');
  if (!rawPaste) {
    console.error('No input provided.');
    process.exit(1);
  }
  // Lenient parse — accept raw code, code#state, or full URL with ?code=
  let code = rawPaste;
  try {
    const url = new URL(rawPaste);
    const c = url.searchParams.get('code');
    if (c) code = c;
  } catch {
    if (rawPaste.includes('#')) code = rawPaste.split('#')[0];
  }

  console.log(`\nExchanging code for tokens (POST ${spec.oauth.tokenUrl})...`);
  const result = await postTokenExchange(spec, code, verifier);
  console.log(`\nResponse status: ${result.status}`);
  try {
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    const redacted = { ...parsed };
    if (typeof redacted.access_token === 'string') redacted.access_token = redactToken(redacted.access_token);
    if (typeof redacted.refresh_token === 'string') redacted.refresh_token = redactToken(redacted.refresh_token);
    if (typeof redacted.id_token === 'string') redacted.id_token = redactToken(redacted.id_token);
    console.log('Response body (tokens redacted):');
    console.log(JSON.stringify(redacted, null, 2));
  } catch {
    console.log('Response body (non-JSON):');
    console.log(result.body);
  }

  if (result.status === 200) {
    console.log('\n✅ SUCCESS — OAuth values are correct. Phase X.7 can proceed.');
  } else {
    console.log('\n❌ FAILURE — vendor rejected the exchange. See response body above for the reason.');
    console.log('Common causes:');
    console.log('  - Wrong scope (try removing scopes one at a time and re-running)');
    console.log('  - Wrong redirect URI (must match exactly what the vendor has registered for this client_id)');
    console.log('  - Code already used (auth codes are single-use; re-run from Step 1)');
    console.log('  - Code expired (typically 10 min)');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
