/**
 * Host-side Gmail send helper.
 *
 * Sends transactional email via the Gmail API using the instructor's OAuth
 * token from `~/.config/gws/credentials.json` (the same credentials read by
 * the credential proxy and the GWS MCP tools). The `gmail.modify` scope —
 * which the default GWS scope set already requests — is sufficient for
 * sending.
 *
 * Used by:
 *   - `scripts/email-class-tokens.ts` (bulk class-token URL distribution)
 *   - The PIN sender registered by `/add-classroom-pin` (per-login emails)
 *
 * Why host-side rather than agent-driven: the PIN sender fires from the
 * login endpoint before any container is spawned, so there's no agent
 * available to delegate to. Bulk token distribution is also faster as a
 * tight host loop than rotating through agent prompts.
 */
import { log } from './log.js';
import { getInstructorGoogleAccessToken } from './gws-token.js';

export interface GmailSendOpts {
  to: string;
  subject: string;
  /** Plain-text body. HTML is not supported here — keep classroom email simple. */
  body: string;
  /**
   * Optional From header. If omitted, Gmail uses the authenticated user's
   * address (the instructor's, since we authenticate as them).
   */
  from?: string;
  /** Optional Reply-To header. */
  replyTo?: string;
}

export interface GmailSendResult {
  messageId: string;
}

/**
 * Send one email via the Gmail API.
 * Throws on send failure with the upstream status + body for diagnosis.
 */
export async function sendGmailMessage(opts: GmailSendOpts): Promise<GmailSendResult> {
  const token = await getInstructorGoogleAccessToken();
  if (!token) {
    throw new Error(
      'Gmail send: no GWS access token available. ' +
        'Ensure ~/.config/gws/credentials.json exists with the gmail.modify scope ' +
        '(re-authorize via the GWS OAuth flow if missing).',
    );
  }

  const raw = encodeGmailRaw(opts);

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '<unreadable>');
    throw new Error(`Gmail send failed: ${res.status} ${errBody.slice(0, 400)}`);
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new Error(`Gmail send: response missing message id`);
  }

  log.debug('Gmail send OK', { to: opts.to, subject: opts.subject, messageId: data.id });
  return { messageId: data.id };
}

/**
 * Build the RFC 2822 message and base64url-encode it for the Gmail API.
 * Exported separately so it can be unit-tested without mocking fetch.
 *
 * The Gmail API's `raw` field is documented as URL-safe base64 of an
 * RFC 2822 message. Buffer's 'base64url' encoder produces exactly that.
 */
export function encodeGmailRaw(opts: GmailSendOpts): string {
  const headers: string[] = [];
  if (opts.from) headers.push(`From: ${opts.from}`);
  headers.push(`To: ${opts.to}`);
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);
  headers.push(`Subject: ${encodeSubject(opts.subject)}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset=UTF-8');
  headers.push('Content-Transfer-Encoding: 7bit');

  const message = headers.join('\r\n') + '\r\n\r\n' + opts.body;
  return Buffer.from(message, 'utf-8').toString('base64url');
}

/**
 * Encode non-ASCII subjects per RFC 2047 (encoded-word). Pure-ASCII
 * subjects pass through unchanged so headers stay readable. Without
 * this, Gmail rejects non-ASCII subjects or mangles them.
 */
function encodeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  const b64 = Buffer.from(subject, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}
