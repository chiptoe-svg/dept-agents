# Per-Student Provider Auth — Design Spec

**Status:** Design approved 2026-05-17, ready for plan
**Phase:** credential-proxy Phase X.7
**Related:** `plans/credential-proxy-per-call-attribution.md`,
`docs/superpowers/plans/2026-05-15-classroom-per-person-mode.md`
(Phase 14 sets the resolver pattern this generalizes)

## Goal

Let each student authenticate against LLM providers (Anthropic,
OpenAI) with their own account — pasted API key OR OAuth via the
vendor's existing OAuth client — so the credential proxy attributes
calls to the student, not the instructor pool. Instructor retains
authority over which providers are available and whether the host
`.env` credential serves as a default for unconnected students.
Students who connect both auth methods (subscription + API key) for
the same provider explicitly toggle which one is active; the proxy
never selects haphazardly.

Designed as the LLM-side parallel to Phase 14's per-student Google
auth, with three additions: (a) per-provider Class Controls toggles,
(b) explicit `active` method selection, (c) a `class_id` seam for
future multi-class support without code rework.

## Non-Goals

- Time-bounded grants (`ncl temp-creds grant --hours 24`).
- Class-scoped credentials separate from host `.env` (the
  multi-class seam is built — the per-class paste-API-key UI is the
  deferred feature).
- Backporting per-provider toggles to Google (Phase 14 stays as-is;
  cleanup tracked in Follow-up tech debt).
- Server-side encryption of student credentials at rest (matches
  Phase 14's plaintext-on-disk pattern; single-host single-operator
  install).

## Distribution

NanoClaw's small-trunk-with-skills philosophy: only generic
infrastructure ships to trunk; classroom-specific code lives on the
`classroom` branch and installs via a new skill.

**Trunk** (every install gets it, solo or classroom):
- `src/providers/auth-registry.ts` — provider metadata + registration
  API. Generic; useful for any future auth concern.
- `src/credential-proxy.ts` — small extension: a per-request
  `studentCredsHook` callback with a no-op default. Solo installs see
  zero behavior change.

**`origin/classroom` branch** (installed by new
`/add-classroom-provider-auth` skill):
- `src/student-provider-auth.ts` — storage writer/reader.
- `src/classroom-provider-resolver.ts` — implements the trunk hook by
  resolving `(agentGroupId) → (userId, classId)` via
  `classroom_roster`, then loading per-student creds.
- `src/channels/playground/api/provider-auth.ts` — OAuth `start` +
  `callback` HTTP routes, plus `/api/me/providers/:id` CRUD.
- `src/channels/playground/api/class-controls.ts` — patch to extend
  Class Controls schema with per-provider toggles (skill applies as
  diff or full replacement, depending on file ownership).
- `src/channels/playground/public/tabs/home.js` — patch to add Home
  Providers card and per-provider Class Controls table.
- `src/channels/playground/public/tabs/models.js` — patch to add
  status pills.
- Skill `SKILL.md` documents the install steps (git fetch → file
  copies → barrel registration → pnpm install → build), idempotent,
  same pattern as `add-classroom-gws` / `add-classroom-pin`.

## Architecture

Per-call flow (existing proxy + trunk hook + classroom resolver):

```
container → proxy (with X-NanoClaw-Agent-Group: <gid>)
           ↓
   studentCredsHook(agentGroupId, providerId)         [trunk hook]
           ↓ (classroom branch impl)
   resolveAgentToUser(agentGroupId) → (userId, classId)
   loadStudentProviderCreds(userId, providerId)
       ↓
   if creds.active='oauth' → refresh-if-expired → inject Bearer
   if creds.active='apiKey' → inject API key header
   if null → fall back per ClassControls.classes[classId].providers[providerId]:
       provideDefault=true  → use host .env  (current behavior)
       provideDefault=false → return 402 connect_required envelope
```

Solo install (no classroom skill): `studentCredsHook` is the trunk
no-op default → resolver returns null → host `.env` is used. Zero
behavior change from today.

**Multi-class seam.** `classId` is threaded through everywhere in
v1 but always resolves to the literal `"default"`. Future multi-class
(separate phase) populates real class IDs from `classroom_roster`
without touching the resolver or storage code:

- Class Controls is wrapped: `{ classes: { "default": {...} } }`.
- Resolver lookup signature is `(agentGroupId) → (userId, classId)`.
- Class-pool credentials looked up via
  `getClassPoolCredsForProvider(classId, providerId)` — v1 ignores
  `classId` and reads host `.env`. Future per-class paste-API-key
  config slots into this helper without changing call sites.
- Per-student creds are NOT keyed by class — a student's personal
  account is theirs regardless of which class they're in.

## Components

### Trunk

#### 1. Provider auth registry — `src/providers/auth-registry.ts`

Source of truth for "what providers does NanoClaw understand auth
for." Each entry:

```ts
type ProviderAuthSpec = {
  id: string;                   // 'claude' | 'codex' | …
  displayName: string;          // "Anthropic" | "OpenAI" | …
  oauth?: {
    clientId: string;           // vendor's CLI client ID
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    refreshGrantBody: (refresh: string, clientId: string) => string;
    pkce: 'S256';
  };
  apiKey?: {
    placeholder: string;
    validatePrefix?: string;
  };
  credentialFileShape: 'oauth-token' | 'api-key' | 'mixed';
  proxyRoutePrefix: string;     // '/openai/' | '' (anthropic default) | …
};

registerProvider(spec: ProviderAuthSpec): void;
getProviderSpec(id: string): ProviderAuthSpec | null;
listProviderSpecs(): ProviderAuthSpec[];
```

V1 trunk-registered providers: `claude`, `codex`. Local is
registry-less (no auth to manage). Display names ("Anthropic",
"OpenAI") come from the `displayName` field; internal IDs stay
aligned with today's `ProviderId` (`claude` | `codex` | `local`) in
`class-controls.ts:23`.

Adding Gemini later = one new registry entry + a new proxy route
handler + (for OAuth) discovery of Gemini CLI's OAuth config.

#### 2. Credential proxy hook — `src/credential-proxy.ts`

Existing resolver code is unchanged. Add ONE extension point:

```ts
// trunk default — no-op
export let studentCredsHook: (
  agentGroupId: string,
  providerId: string,
) => Promise<ResolvedCreds | null> = async () => null;

export function setStudentCredsHook(fn: typeof studentCredsHook): void;
```

The classroom skill calls `setStudentCredsHook` at startup to install
its resolver. In every per-request path that needs creds, the proxy
calls `studentCredsHook(gid, providerId)` first. Solo installs get
`null` → existing chain runs unchanged.

For `connect_required` 402 envelopes: the trunk proxy doesn't return
these by itself (no concept of "should require connection" in solo
mode). The classroom skill's resolver returns a sentinel value
(`{ kind: 'connect_required', provider, connect_url }`) that the
trunk proxy serializes to HTTP 402. The serialization logic itself
is trunk (it's just JSON), but the *decision* to require connection
is classroom-only.

### Classroom branch (installed by `/add-classroom-provider-auth`)

#### 3. Student credential storage — `src/student-provider-auth.ts`

Mirrors `src/student-google-auth.ts` shape. Path:
`data/student-provider-creds/<sanitized_user_id>/<providerId>.json`.
File mode `0o600`, dir mode `0o700` (chmod after mkdir for
existing-dir case — Phase 14 lesson). Atomic tmp+rename writes.

```ts
type StudentProviderCreds = {
  apiKey?:  { value: string, addedAt: number };
  oauth?:   { accessToken: string, refreshToken: string,
              expiresAt: number, account?: string, addedAt: number };
  active:   'apiKey' | 'oauth';   // proxy uses only this method
};

writeStudentProviderCreds(userId, providerId, creds): void
addApiKey(userId, providerId, apiKey): void   // also bumps active='apiKey' if no oauth
addOAuth(userId, providerId, tokens): void    // also bumps active='oauth' if no apiKey
setActiveMethod(userId, providerId, active): void
clearMethod(userId, providerId, which: 'apiKey'|'oauth'): void  // also clears file if that was the only method
hasStudentProviderCreds(userId, providerId): boolean
loadStudentProviderCreds(userId, providerId): StudentProviderCreds | null
```

When one method is added while neither exists, `active` is auto-set
to that method. When a method is cleared and the other still exists,
`active` auto-flips to the remaining one. When both are cleared, the
file is removed.

#### 4. Classroom provider resolver — `src/classroom-provider-resolver.ts`

Implements the trunk `studentCredsHook`:

```ts
async function resolveStudentCreds(agentGroupId, providerId) {
  const { userId, classId } = resolveAgentToUser(agentGroupId);
  // v1: classId is always "default"
  const creds = loadStudentProviderCreds(userId, providerId);
  if (creds) {
    if (creds.active === 'oauth') {
      return refreshOAuthIfNeeded(creds.oauth, providerId);
    }
    return { kind: 'apiKey', value: creds.apiKey.value };
  }
  const controls = readClassControls();
  const policy = controls.classes[classId].providers[providerId];
  if (policy?.provideDefault) {
    return getClassPoolCredsForProvider(classId, providerId);
  }
  if (policy?.allowByo) {
    return { kind: 'connect_required', provider: providerId,
             connect_url: `/provider-auth/${providerId}/start` };
  }
  return { kind: 'forbidden' };  // provider not allowed at all
}

// v1 implementation
function getClassPoolCredsForProvider(classId, providerId) {
  // classId is ignored in v1; future per-class config slots here
  return readHostEnvCredsForProvider(providerId);
}
```

Registered via `setStudentCredsHook(resolveStudentCreds)` from the
classroom skill's entry point.

#### 5. OAuth HTTP routes — `src/channels/playground/api/provider-auth.ts`

Registry-driven, paste-back flow (vendor redirect URIs cannot be
overridden — see §Open Questions § OAuth endpoint discovery):

- `GET /provider-auth/:provider/start` — session-guard, mint state +
  PKCE verifier (TtlMap, single-use via `take()`). Returns JSON
  `{ authorizeUrl, state }` rather than a 302; the frontend opens
  `authorizeUrl` in a new tab and renders an inline paste form keyed
  by `state`. The vendor's own `redirect_uri` (read from
  `spec.oauth.redirectUri`) is included in the authorize URL.
- `POST /provider-auth/:provider/exchange` — body `{ code, state }`.
  Verify state (single-use, bound to session user_id + providerId),
  POST to `spec.oauth.tokenUrl` with `authorization_code` grant +
  PKCE verifier, call `addOAuth(userId, provider, ...)`. Returns
  `{ ok: true, account? }`.

CRUD:
- `GET /api/me/providers/:id` → `{ hasApiKey, hasOAuth, active,
  oauth?: { account }, addedAt }`
- `POST /api/me/providers/:id/api-key` → `addApiKey(...)`
- `POST /api/me/providers/:id/active` body `{ active: 'apiKey'|'oauth' }`
  → `setActiveMethod(...)`
- `DELETE /api/me/providers/:id?which=apiKey|oauth` →
  `clearMethod(...)`

State token shape mirrors `src/channels/playground/api/google-auth.ts`
but is consumed by the exchange POST instead of a GET callback.

#### 6. Class Controls schema extension

Today's `config/class-controls.json` is flat. Skill installs a new
loader that wraps in a `classes` map and adds per-provider toggles:

```ts
type ClassControlsRoot = {
  classes: {
    [classId: string]: {
      tabsVisibleToStudents: TabId[];
      authModesAvailable: AuthModeId[];
      providers: {
        [providerId: string]: {
          allow: boolean;
          provideDefault: boolean;
          allowByo: boolean;
        };
      };
    };
  };
};
```

**Backwards-compat load:** if existing file is flat shape (no
`classes` key), hydrate into `{ classes: { default: <wrapped> } }`
and populate `providers` with permissive defaults from the previous
`providersAvailable` array. Lazy migration on first read — write
back on next save.

**Defaults when file is missing:**
- `codex` (OpenAI): `allow=true, provideDefault=true, allowByo=true`
- `claude` (Anthropic): `allow=true, provideDefault=false, allowByo=true`
- `local`: `allow=true, provideDefault=true, allowByo=false`

`DEFAULT_CLASS_ID = "default"`. v1 reads/writes only `classes[DEFAULT_CLASS_ID]`.

#### 7. Home Providers card — `home.js` patch

New `renderProvidersCard(body)` section. Iterates
`ClassControls.classes[DEFAULT_CLASS_ID].providers` in registry
order, renders one row per provider where `allow=true`. State
per row:

```
✅ <name> · Connected as <account>     [Disconnect]
   (oauth only)

✅ <name> · API key set                [Disconnect]
   (apikey only)

✅ <name>
   Active: ( ) Subscription  (•) API key
                                       [Add API key] / [Add subscription]
                                       [Disconnect <active>]
   (both methods present — radio toggles `active` via PUT)

✅ <name> · Provided by instructor     [Use my own]
   (no creds, provideDefault=true, allowByo=true)

✅ <name> · Provided by instructor
   (no creds, provideDefault=true, allowByo=false)

⚠ <name> · Not connected               [Connect]
   (no creds, provideDefault=false, allowByo=true)

(hidden)
   (allow=false OR provideDefault=false AND allowByo=false)
```

Click "Connect" / "Add API key" / "Add subscription" → modal with
the relevant input (OAuth start or paste-key form). OAuth tab
navigates to `/provider-auth/<id>/start`. API-key tab POSTs to
`/api/me/providers/<id>/api-key`.

Transient banner on `?provider_connected=<id>` query param, cleaned
via `history.replaceState` (same pattern as Phase 14's Google).

#### 8. Class Controls per-provider UI — `home.js` patch

Extend `renderClassControlsForm` with a per-provider table:

```
Providers
─────────────────────────────────────────────────────────────────
                  Allow?   Provide default?   Let students BYO?
  OpenAI         [✓]           [✓]                  [✓]
  Anthropic      [✓]           [ ]                  [✓]
  Local          [✓]           [✓]                  [ ]
```

`PUT /api/class-controls` accepts the new shape. Body validation
ensures `classes` map is well-formed; rejects writes to non-default
class IDs in v1 (forward-compat: future multi-class enables them).

#### 9. Models tab status pill — `models.js` patch

Each provider section header gains a status pill reflecting the
caller's resolved credential source, computed client-side from
`GET /api/me/providers/:id`:
- `Your subscription` (green)
- `Your API key` (green)
- `Provided by instructor` (subtle)
- `Connect to use` (amber, with `→ Home` link)

Provider section hidden iff: `allow=false` OR (`provideDefault=false`
AND `allowByo=false` AND student has no creds) — literally unusable.

## Data flow

### OAuth happy path (Anthropic, first connect, no API key) — paste-back

1. Student clicks "Sign in with Anthropic" in Home → Providers.
2. Browser fetches `GET /provider-auth/claude/start`.
3. Server: session check → mint `{state, pkceVerifier}` keyed by
   `state`, store in TtlMap (10 min, single-use). Returns JSON
   `{ authorizeUrl: "https://claude.com/cai/oauth/authorize?client_id=9d1c…&response_type=code&code_challenge=<S256>&code_challenge_method=S256&state=<state>&redirect_uri=https://platform.claude.com/oauth/code/callback&scope=…", state: "…" }`.
4. Browser opens `authorizeUrl` in a new tab and renders an inline
   paste form (still on the original Home tab) bound to `state`:
   "Paste the code Anthropic displayed: [______] [Submit]".
5. In the new tab, student authenticates with Anthropic and consents.
6. Anthropic redirects to its own `platform.claude.com/oauth/code/callback`
   page which displays the auth code to the student.
7. Student copies the code, switches back to the original Home tab,
   pastes into the form, clicks Submit.
8. Browser POSTs `{code, state}` to `/provider-auth/claude/exchange`.
9. Server: `take(state)`, verify `userId` matches session, POST to
   `<spec.oauth.tokenUrl>` with `grant_type=authorization_code`,
   `code`, `code_verifier`, `client_id`, `redirect_uri` (the vendor's
   own URI).
10. Vendor returns `{access_token, refresh_token, expires_in, id_token?}`.
11. `addOAuth(userId, 'claude', {accessToken, refreshToken,
    expiresAt, account: <from id_token>, addedAt: now()})` — since
    no creds existed, `active='oauth'` is auto-set.
12. Server returns `{ok: true}`; browser re-renders the Providers card.

### API-key paste path

1. Student clicks "Add API key" in Home → Providers (for a provider
   that already has OAuth, or starts fresh).
2. Modal renders paste form.
3. POST `/api/me/providers/claude/api-key` with `{ apiKey: '...' }`.
4. Server: `addApiKey(userId, 'claude', apiKey)`. If no other method
   exists, `active='apiKey'` is auto-set. If OAuth also exists,
   `active` is unchanged; UI shows the radio toggle.
5. Response: updated `{ hasApiKey:true, hasOAuth:?, active, ... }`.
6. Home re-renders the card without page reload.

### Active-method switch (both connected)

1. Student clicks the radio for "API key" in Home → Providers.
2. PUT `/api/me/providers/claude/active` body `{ active: 'apiKey' }`.
3. Server: `setActiveMethod(userId, 'claude', 'apiKey')`.
4. Pill in Home + Models tab updates on next render. Existing
   container sessions hot-swap on their next API call (proxy reads
   the file fresh per request).

### Per-call resolution

1. Container → proxy with `X-NanoClaw-Agent-Group: <gid>`.
2. Proxy calls `studentCredsHook(gid, 'claude')` (trunk hook).
3. Classroom resolver runs:
   - `(userId, classId='default') = resolveAgentToUser(gid)`.
   - `creds = loadStudentProviderCreds(userId, 'claude')`.
   - Branches per `creds.active`. For `oauth`, refresh if
     `expiresAt - now() < 5min`, persist refreshed token back.
   - Returns `{ kind: 'oauth', accessToken: <fresh> }` (or apiKey).
4. Proxy injects `Authorization: Bearer <token>` (or `x-api-key`).
5. Per-call attribution log: `principal=student:<userId>:oauth`.

### Fallback (no student creds, provideDefault=true)

1. `loadStudentProviderCreds(...)` → null.
2. `controls.classes.default.providers.codex.provideDefault` → true.
3. `getClassPoolCredsForProvider('default', 'codex')` → host `.env`
   value (existing read path).
4. Per-call attribution log: `principal=class-pool:default`.

### Error (no creds, no default)

1. `loadStudentProviderCreds(...)` → null.
2. `provideDefault=false`, `allowByo=true`.
3. Resolver returns `{ kind: 'connect_required', provider: 'claude',
   connect_url: '/provider-auth/claude/start' }`.
4. Trunk proxy serializes to HTTP 402 with body:

```json
{ "type": "connect_required",
  "provider": "claude",
  "message": "Connect your Anthropic account to use this model.",
  "connect_url": "/provider-auth/claude/start" }
```

5. Container surfaces it as a tool-result error in chat.

## Security

- Same threat model as Phase 14: single-host, single-operator,
  plaintext-on-disk creds, OS-level file permissions (0o600).
- OAuth client ID is the vendor's own public CLI client ID (already
  used by NanoClaw's refresh code today). PKCE prevents code
  interception. State tokens are TtlMap single-use, bound to session
  user_id (defense-in-depth against cross-user attack).
- API-key paste UI: `type=password` input, never logged. Trim
  whitespace; optional prefix sanity check.
- `/api/me/providers/:id` endpoints require valid session and
  enforce mutation only on the session's own user_id.
- Active-method switch only flips the `active` field; never
  exfiltrates either credential value.

## Open Questions / Risks

- **OAuth client-ID legitimacy.** NanoClaw already uses Claude
  Code's hardcoded client ID for refresh-grant. Extending to
  auth-code-grant is technically the same flow. Anthropic could
  theoretically detect server-side usage patterns and rate-limit
  or restrict; empirically this hasn't been an issue in months of
  refresh-grant use. Mitigation: paste-API-key tab always available
  as fallback.

- **OAuth endpoint discovery — RESOLVED 2026-05-17.** Discovered values
  documented in `docs/providers/oauth-endpoints.md`. Critical finding:
  both vendor OAuth clients pin their redirect URIs to vendor-controlled
  URLs (Claude: `https://platform.claude.com/oauth/code/callback`, a
  vendor page that displays the code to the user; Codex: `http://localhost:<ephemeral>/auth/callback`,
  loopback only). This rules out the original NanoClaw-hosted GET
  callback design. **Flow chosen: paste-back.** Same shape `claude login`
  / `codex login` use in headless mode — NanoClaw opens the vendor
  authorize URL in a new tab, vendor displays the auth code on the
  vendor's page, user copies the code and pastes into a NanoClaw form,
  NanoClaw exchanges code → tokens server-side. PKCE security unchanged.

- **Token refresh failures.** If a refresh_token is revoked
  server-side, the proxy currently silently falls back. New
  behavior: on 401 from refresh, clear the OAuth method from the
  creds file (active flips to apiKey if present, else null and
  fallback chain runs). Student sees `⚠ Not connected` or "API key
  active" on Home, prompted to reconnect.

- **Cross-user attribution leak.** A bug in user_id resolution
  could route Student A's call to Student B's creds. Mitigation:
  per-call attribution test verifies the resolved principal
  matches the agent_group's roster lookup.

- **Hot-swap correctness.** Active-method switch takes effect on
  the next API call from the running container. If a long-running
  tool call is in-flight when the switch happens, the in-flight
  call completes with the prior active method. Acceptable per-call
  granularity for v1.

## Testing

Unit (classroom branch):
- Provider registry round-trip.
- Class Controls schema migration (old flat → new wrapped).
- Storage round-trip for all credential shapes (oauth-only,
  apikey-only, both, active toggles, clear-one auto-flips).
- Resolver decision matrix: 4 cred states × 3 Class-Controls combos
  × `active` setting → resolved principal.
- Refresh-on-401 → clear OAuth → active auto-flips → fallback chain.
- 402 envelope shape.
- TtlMap single-use enforcement.

Unit (trunk):
- `studentCredsHook` no-op default returns null.
- `setStudentCredsHook` replaces the hook globally.
- Trunk-side 402 serialization given a `connect_required` sentinel.

Integration:
- Mock OAuth provider (Express stub) → start → callback → creds on
  disk → proxy uses them.
- Refresh dance with expired token.
- Class Controls `provideDefault=false` → 402 envelope on
  unconnected student.
- Class Controls `provideDefault=true` → host `.env` wins.
- Two students, two OAuth flows, cross-attribution check.

Smoke (deferred — needs real OAuth clients live):
- Real Anthropic login → API call against `api.anthropic.com`.
- Real OpenAI login → API call against `api.openai.com`.

Skill install verification:
- `/add-classroom-provider-auth` is idempotent.
- After install, build is clean and tests pass.
- After install, solo-mode behavior (no `classroom_roster` entries)
  still resolves to host `.env`.

## Out of Scope (explicit deferrals)

- Time-bounded class-pool grants.
- Per-class paste-API-key UI (seam built; UI deferred).
- Multiple-class management UI (seam built; UI deferred).
- Gemini / Mistral / other providers (registry-ready).
- Encrypted-at-rest creds.
- Backporting per-provider toggles to Google.

## Follow-up Tech Debt

- **Phase 14 asymmetry.** Today `src/student-google-auth.ts`,
  `src/channels/playground/api/google-auth.ts`, and the
  Home/Models UI patches for Google all live in trunk despite being
  classroom-specific. The clean state would mirror X.7: move to the
  `classroom` branch and install via a new `/add-classroom-google-auth`
  skill. Out of scope for X.7 but tracked here.

## Success Criteria

- Instructor flips toggles per provider in Class Controls; student
  Home Providers card reflects the change on next reload.
- Student clicks "Sign in with Anthropic" → completes consent →
  Home shows `✅ Connected as <account>` with no other method →
  next chat message routes through their token (verified via
  per-call attribution log).
- Student with both methods sees a radio toggle on Home and Models
  tab pill; switching active flips behavior on the next call.
- Student with `provideDefault=true` for codex sees `✅ Provided by
  instructor` on Home; chat works without action.
- Student without creds AND `provideDefault=false` sees `⚠ Not
  connected` on Home AND `Connect to use` pill on Models AND gets
  `connect_required` envelope from chat.
- Solo install with no classroom skill installed shows zero
  behavior change — host `.env` flow continues to work as before.
- Adding Gemini in a future phase requires zero changes to Class
  Controls schema, Home card, Models tab, or trunk proxy — only a
  new registry entry + proxy route + (for OAuth) endpoint discovery.
- Multi-class feature, when added later, requires no changes to the
  resolver, storage paths, or proxy code — only `classroom_roster`
  schema and a class-picker UI.
