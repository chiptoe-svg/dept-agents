/**
 * /codex-auth Telegram command — switch between ChatGPT OAuth and API-key modes.
 *
 *   /codex-auth         show current mode + credential status
 *   /codex-auth chatgpt switch to ChatGPT subscription (OAuth)
 *   /codex-auth api     switch to API key mode (key injected by credential proxy)
 *
 * Self-registers on import. No service restart needed — auth.json is copied
 * at container spawn time, so the next agent message picks up the new mode.
 */
import { log } from '../log.js';
import { registerTelegramCommand } from '../channels/telegram-commands.js';

async function handleCodexAuthCommand(token: string, platformId: string, text: string): Promise<boolean> {
  if (!text.startsWith('/codex-auth')) return false;

  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return false;

  const { getCodexAuthStatus, switchCodexAuthMode } = await import('../codex-auth-switch.js');

  const parts = text.trim().split(/\s+/);
  const subcommand = parts[1]?.toLowerCase();

  let reply: string;

  if (!subcommand) {
    const { mode, hasOAuthTokens, hasApiKey, lastRefresh } = getCodexAuthStatus();
    const modeLabel = mode === 'chatgpt' ? 'ChatGPT subscription (OAuth)' : mode === 'apikey' ? 'API key' : 'unknown';
    const credStatus =
      mode === 'chatgpt'
        ? hasOAuthTokens
          ? '✅ OAuth tokens present'
          : '❌ No OAuth tokens found'
        : mode === 'apikey'
          ? '✅ Key injected by credential proxy'
          : '⚠️ auth.json missing or unreadable';
    const refreshLine = lastRefresh
      ? `Last token refresh: ${new Date(lastRefresh).toUTCString()}`
      : 'Last token refresh: never';
    reply =
      `Codex auth mode: *${modeLabel}*\n${credStatus}\n${refreshLine}\n\n` +
      `Use \`/codex-auth chatgpt\` or \`/codex-auth api\` to switch.\n` +
      `Changes take effect on the next agent message (no restart needed).`;
  } else if (subcommand === 'chatgpt') {
    try {
      switchCodexAuthMode('chatgpt');
      reply =
        '✅ Switched to ChatGPT subscription mode.\nSend a message to your agent to test it — the next container spawn will use the OAuth tokens.';
    } catch (err) {
      reply = `❌ ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (subcommand === 'api') {
    try {
      switchCodexAuthMode('apikey');
      reply =
        '✅ Switched to API key mode.\nThe credential proxy will inject OPENAI_API_KEY on the next container spawn.';
    } catch (err) {
      reply = `❌ ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    reply = `Unknown subcommand: \`${subcommand}\`\nUsage: /codex-auth | /codex-auth chatgpt | /codex-auth api`;
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    log.warn('Failed to send /codex-auth reply', { platformId, err });
  }

  return true;
}

registerTelegramCommand('/codex-auth', (ctx) => handleCodexAuthCommand(ctx.token, ctx.platformId, ctx.text));
