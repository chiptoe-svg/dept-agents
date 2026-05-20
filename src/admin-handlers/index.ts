/**
 * Admin-handler barrel.
 *
 * Empty by default. Each admin tool installed via /add-admintools appends an
 * `import './<name>.js';` line below — those handler files self-register via
 * `registerTelegramCommand()` at module scope. Trunk's `src/channels/telegram.ts`
 * imports this barrel once near startup, so no admin tools = no-op import.
 */
import './auth.js';
import './codex-auth.js';
import './model.js';
import './provider.js';
