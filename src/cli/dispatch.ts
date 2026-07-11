/**
 * Transport-agnostic dispatcher. Both the socket server (host caller) and
 * the per-session DB poller (container caller) call dispatch() with the
 * same frame and a transport-supplied CallerContext.
 *
 * Approval gating for risky calls from the container is the only branch
 * that differs by caller. Host callers and `open` commands run inline.
 */
import { getAgentGroup } from '../db/agent-groups.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getSession } from '../db/sessions.js';
import { registerApprovalHandler, requestApproval } from '../modules/approvals/index.js';
import type { CallerContext, ErrorCode, RequestFrame, ResponseFrame } from './frame.js';
import { lookup } from './registry.js';

export async function dispatch(req: RequestFrame, ctx: CallerContext): Promise<ResponseFrame> {
  const cmd = lookup(req.command);
  if (!cmd) {
    return err(req.id, 'unknown-command', `no command "${req.command}"`);
  }

  if (ctx.caller !== 'host' && cmd.access === 'approval') {
    const session = getSession(ctx.sessionId);
    if (!session) {
      return err(req.id, 'handler-error', 'Session not found.');
    }
    const agentGroup = getAgentGroup(ctx.agentGroupId);
    const agentName = agentGroup?.name ?? ctx.agentGroupId;

    const argSummary = Object.entries(req.args)
      .map(([k, v]) => `--${k} ${v}`)
      .join(' ');

    await requestApproval({
      session,
      agentName,
      action: 'cli_command',
      payload: { frame: { id: req.id, command: req.command, args: req.args } },
      title: `CLI: ${req.command}`,
      question: `Agent "${agentName}" wants to run:\n\`ncl ${req.command}${argSummary ? ' ' + argSummary : ''}\``,
    });

    return err(req.id, 'approval-pending', 'Approval request sent to admin. You will be notified of the result.');
  }

  // Resolve read scope for agent callers from container_configs.cli_scope —
  // stored and settable since migration 018, but never read until now.
  // 'group' (default) restricts list/get reads to the caller's own agent
  // group (see scopeRowsToCaller in crud.ts); 'all' is unrestricted, for a
  // future trusted admin agent. The group id driving this lookup is
  // ctx.agentGroupId, which is host-stamped from the session the request
  // arrived on (delivery-action.ts) — a container cannot forge it. Host
  // callers are always unrestricted and never consult this.
  const scopedCtx: CallerContext =
    ctx.caller === 'agent'
      ? { ...ctx, cliScope: getContainerConfig(ctx.agentGroupId)?.cli_scope === 'all' ? 'all' : 'group' }
      : ctx;

  let parsed: unknown;
  try {
    parsed = cmd.parseArgs(req.args);
  } catch (e) {
    return err(req.id, 'invalid-args', errMsg(e));
  }

  try {
    const data = await cmd.handler(parsed, scopedCtx);
    return { id: req.id, ok: true, data };
  } catch (e) {
    return err(req.id, 'handler-error', errMsg(e));
  }
}

/**
 * Commands whose results carry a bearer login URL/token (`loginUrl` from
 * `users provision`, `url` from `class-tokens issue|rotate`). The URL *is*
 * the credential — relaying it through `notify` would write it into the
 * requesting agent's chat context and session DB, undercutting the approval
 * gate. Host callers (`./bin/ncl`, caller:'host') are unaffected: dispatch()
 * returns the raw result to host stdout, which is where the operator reads
 * it.
 */
const BEARER_RESULT_COMMANDS = new Set(['users-provision', 'class-tokens-issue', 'class-tokens-rotate']);
const BEARER_RESULT_KEYS = ['loginUrl', 'url', 'token'];
const BEARER_REDACTION =
  '[redacted — bearer login URL is not relayed to agent chat; the approver can retrieve it on the host via ./bin/ncl]';

/**
 * Strip bearer login URLs/tokens from a command result before it is relayed
 * into an agent-facing message. Returns the data unchanged for commands that
 * don't mint credentials. Exported for tests.
 */
export function redactBearerResult(command: string, data: unknown): unknown {
  if (!BEARER_RESULT_COMMANDS.has(command)) return data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of BEARER_RESULT_KEYS) {
    if (key in out) out[key] = BEARER_REDACTION;
  }
  return out;
}

registerApprovalHandler('cli_command', async ({ session, payload, userId, notify }) => {
  const frame = payload.frame as RequestFrame;
  const response = await dispatch(frame, { caller: 'host' });

  if (response.ok) {
    // Agent-facing relay only — redact any bearer login URL the command
    // minted. The host-caller path never goes through this handler.
    const redacted = redactBearerResult(frame.command, response.data);
    const data = typeof redacted === 'string' ? redacted : JSON.stringify(redacted, null, 2);
    notify(`Your \`ncl ${frame.command}\` request was approved and executed.\n\n${data}`);
  } else {
    notify(`Your \`ncl ${frame.command}\` request was approved but failed: ${response.error.message}`);
  }
});

function err(id: string, code: ErrorCode, message: string): ResponseFrame {
  return { id, ok: false, error: { code, message } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
