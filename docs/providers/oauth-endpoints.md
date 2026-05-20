# Provider OAuth Endpoints

Source-of-truth for the OAuth client IDs and URLs NanoClaw uses for each provider. All values rediscovered from vendor CLI npm packages — extracted from the shipped binaries inside the agent container image (`nanoclaw-agent` / pinned versions below).

The agents normally re-use the vendor CLI's own auth.json. The values here are what's needed when NanoClaw runs an authorization-code-with-PKCE flow itself — for example to provision per-student credentials in a classroom context without asking the student to install the vendor CLI.

## claude (Anthropic — Claude Code CLI)

- **Client ID:** `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- **Authorize URL:** `https://claude.com/cai/oauth/authorize`
  - The console flavor (`https://platform.claude.com/oauth/authorize`) is also a valid choice the CLI exposes. The CLI picks one based on the chosen login surface (Claude.ai consumer login vs. Anthropic Console). Use the `claude.com/cai/...` URL when authorizing a Claude.ai/Pro/Max account.
- **Token URL:** `https://platform.claude.com/v1/oauth/token`
- **Scopes:** `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
  - Set as space-separated string in the `scope` query param. (Derived from the deduped union of the CLI's two internal scope arrays: `[org:create_api_key, user:profile]` + `[user:profile, user:inference, user:sessions:claude_code, user:mcp_servers, user:file_upload]`.)
- **Redirect URI format:** `https://platform.claude.com/oauth/code/callback`
  - This is the CLI's `MANUAL_REDIRECT_URL`. The CLI displays the authorization code to the user post-login; the user pastes it back into the CLI. For a NanoClaw-hosted flow we would substitute our own callback URL after registering it server-side (out of scope for the current setup — manual paste-back works for the initial Phase X.7 design).
- **PKCE:** `S256` (the CLI explicitly sets `code_challenge_method=S256` when building the authorize URL)
- **Source:** `node_modules/@anthropic-ai/claude-code/` v2.1.116 (native binary at `bin/claude.exe` — Bun-compiled, strings extracted via `grep -aoE` from inside the agent container image)

## codex (OpenAI — Codex CLI)

- **Client ID:** `app_EMoamEEZ73f0CkXaXp7hrann`
  - Codex CLI accepts an experimental override via the `--client-id` flag (mapped to internal field `experimental_client_id`), but the default baked into the binary is the value above.
- **Authorize URL:** `https://auth.openai.com/oauth/authorize`
  - Issuer base URL is `https://auth.openai.com`; the CLI exposes it via `--issuer-base-url` (`experimental_issuer`) for override.
- **Token URL:** `https://auth.openai.com/oauth/token`
  - Refresh and revoke endpoints (overridable via `CODEX_REFRESH_TOKEN_URL_OVERRIDE` and `CODEX_REVOKE_TOKEN_URL_OVERRIDE` respectively): `https://auth.openai.com/oauth/token` (refresh) and `https://auth.openai.com/oauth/revoke` (revoke).
- **Scopes:** `openid profile email offline_access api.connectors.read api.connectors.invoke`
- **Redirect URI format:** `http://localhost:<port>/auth/callback`
  - The CLI binds a loopback HTTP listener at `127.0.0.1:0` (kernel-assigned ephemeral port) and uses `/auth/callback` as the path. The public openai/codex repository uses 1455 as the conventional default port, but this codebase's binary shows a dynamic-port allocation, so the redirect URI must be constructed at flow start using the actual bound port.
- **PKCE:** `S256` (inferred — the CLI uses `code_challenge` + `code_challenge_method` in the authorize request, `Sha256` is the only PKCE hash function present in the binary, and the published openai/codex CLI source uses S256. The exact literal `code_challenge_method=S256` was not directly grep-able due to how Rust's `url::Url::query_pairs_mut` interpolates values, but no alternative — `plain` — appeared either.)
- **Source:** `node_modules/@openai/codex/` v0.124.0 (platform package `@openai/codex@0.124.0-linux-arm64`, native Rust binary at `vendor/aarch64-unknown-linux-musl/codex/codex` — strings extracted via `grep -aoE` from inside the agent container image)

## Notes for maintainers

These values are **vendor-internal CLI configuration** — they are not publicly documented APIs, and the vendors make no compatibility guarantee. Both clients are first-party "native app" OAuth clients meant for the vendor's own CLI tools; NanoClaw is reusing them in the same way `aider`, `codex-clone`, `claude.nvim`, and other community tools do.

**Re-verify after vendor CLI version bumps.** Specifically, re-run the discovery procedure when bumping `CLAUDE_CODE_VERSION` or `CODEX_VERSION` in `container/Dockerfile`. To do so:

1. Spawn an ephemeral container off the freshly built image:
   ```bash
   container run --rm --entrypoint /bin/sh nanoclaw-agent-v2-<tag>:latest -c '<inspection script>'
   ```
2. For Claude Code (JS-bundled native Bun binary): `grep -aoE` for `oauth/(authorize|token)`, `client_id`, the literal client UUID, and the scope arrays (look for the array containing `user:profile`).
3. For Codex (Rust binary): `grep -aoE` for `auth\.openai\.com`, `app_` (client ID prefix), `openid profile email offline_access`, and `/auth/callback` (redirect path).

If a vendor migrates to a wholly different OAuth provider or scope set, this document and any code that consumes these constants (`src/providers/*.ts` registry entries — currently scoped under Phase X.7) need to be updated together.

**Out-of-scope items for this discovery artifact** — if Phase X.7 needs them, separate tasks will track:

- Whether the vendors accept arbitrary `redirect_uri` values (i.e., can NanoClaw register its own callback host) or strictly enforce the vendor's own redirect — initial NanoClaw integration assumes manual paste-back of the auth code for Claude, and a loopback listener for Codex.
- Token introspection / revocation flows beyond what the credential proxy already uses for token refresh.
- Device-code flow (Codex CLI exposes `--use-device-code`; not pursued here — interactive browser flow is the primary path).
