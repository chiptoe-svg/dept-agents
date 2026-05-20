/**
 * Tiny HTTP helpers shared between `playground/server.ts`,
 * `playground/api-routes.ts`, and `playground/google-oauth.ts`. Earlier
 * draft had `send` duplicated across two of these (the bodies were
 * almost identical); this is the one-place version.
 */
import http from 'http';

/** Write a status + body. JSON-encodes non-string bodies. */
export function send(res: http.ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Same as `send` but with a sensible default of `text/html`. */
export function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  send(res, status, html, 'text/html; charset=utf-8');
}

/**
 * Read the request body and parse as JSON. Empty body → empty object.
 * Optional `maxBytes` caps the accumulated body size; the connection is
 * destroyed and the promise rejects when the cap is exceeded. Default
 * cap is 1 MB — endpoints that accept inline attachments (the chat
 * messages POST, with base64 files) bump this explicitly to ~35 MB.
 */
export async function readJsonBody(
  req: http.IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? 1_048_576;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Pull a single cookie value from the `Cookie:` header. */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/** Escape a string for safe insertion into HTML body text or attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}
