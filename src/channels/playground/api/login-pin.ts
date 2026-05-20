/**
 * HTTP handlers for the email-PIN login dance.
 *
 * Two endpoints:
 *   POST /login/pin/issue   { token } → { ok, pendingId } and emails the PIN
 *   POST /login/pin/verify  { pendingId, pin } → on success: 200 + Set-Cookie + body { ok, redirect }
 *                                                on failure: 4xx + body { error }
 *
 * Plus a static GET /login/pin handled by the server's static-file route
 * (login-pin.html). The HTML's JS calls these two endpoints in sequence.
 *
 * The actual PIN delivery (email send via Resend) is delegated to a
 * pluggable sender that the classroom-installed module wires in via
 * `registerPinSender`. Trunk doesn't know about Resend; this file only
 * cares that something delivers the PIN to the email.
 */
import {
  getPending,
  issuePin,
  verifyPin,
  type IssuePinResult,
  type VerifyPinResult,
} from '../../../class-login-pins.js';
import { log } from '../../../log.js';
import { formatSessionCookie, mintSessionForUser } from '../auth-store.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
  setCookie?: string;
}

/** Pluggable PIN sender — set by /add-classroom-pin to wire Resend. */
type PinSender = (email: string, pin: string) => Promise<void>;
let sender: PinSender = async (email, pin) => {
  // Default: just log. Useful for dev without Resend configured.
  log.warn('class-login-pins: no PIN sender registered, PIN logged instead', { email, pin });
};
export function registerPinSender(fn: PinSender): void {
  sender = fn;
}

/**
 * Look up the user_id + email from a token. Trunk doesn't know about the
 * classroom_roster table, so this function is also pluggable — the classroom
 * module wires it in.
 */
type TokenLookup = (token: string) => { userId: string; email: string } | null;
let tokenLookup: TokenLookup = () => null;
export function registerTokenLookup(fn: TokenLookup): void {
  tokenLookup = fn;
}

export async function handleIssue(body: { token?: unknown }): Promise<ApiResult<{ ok: true; pendingId: string }>> {
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return { status: 400, body: { error: 'token (string) required' } };

  const lookup = tokenLookup(token);
  if (!lookup) {
    // Anti-enumeration: same generic response whether token is real or not.
    // We DO log on the server side so debugging is possible.
    log.info('login-pin: issue called with unknown token', { tokenPrefix: token.slice(0, 8) });
    // Pretend it succeeded (the verify will fail later if the token wasn't real).
    return { status: 200, body: { ok: true, pendingId: 'pending-anti-enumeration' } };
  }

  const result: IssuePinResult = issuePin(token, lookup.userId, lookup.email);
  if (!result.ok) {
    return { status: 400, body: { error: result.reason } };
  }

  // Fire-and-forget the email send. We don't want the HTTP response to wait
  // on Resend; the user has the pendingId and a "check your email" message.
  void sender(lookup.email, result.pin).catch((err) =>
    log.error('class-login-pins: PIN sender threw', { err: String(err), email: lookup.email }),
  );

  return { status: 200, body: { ok: true, pendingId: result.pendingId } };
}

export function handleVerify(body: { pendingId?: unknown; pin?: unknown }): ApiResult<{ ok: true; redirect: string }> {
  const pendingId = typeof body.pendingId === 'string' ? body.pendingId : '';
  const pin = typeof body.pin === 'string' ? body.pin : '';
  if (!pendingId || !pin) {
    return { status: 400, body: { error: 'pendingId and pin (strings) required' } };
  }
  if (!/^\d{6}$/.test(pin)) {
    return { status: 400, body: { error: 'PIN must be 6 digits' } };
  }

  const result: VerifyPinResult = verifyPin(pendingId, pin);
  if (!result.ok) {
    const status = result.reason === 'rate-limited' ? 429 : 400;
    return { status, body: { error: result.reason } };
  }

  // PIN matched — mint the playground session and set the cookie.
  const session = mintSessionForUser(result.userId);
  return {
    status: 200,
    body: { ok: true, redirect: '/playground/' },
    setCookie: formatSessionCookie(session.cookieValue),
  };
}

/** Used by the server to render the entry page with the right pendingId in URL state. */
export function pendingExists(pendingId: string): boolean {
  return getPending(pendingId) !== null;
}
