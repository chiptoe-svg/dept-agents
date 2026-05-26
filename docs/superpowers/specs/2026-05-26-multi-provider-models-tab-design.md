# Multi-Provider Models Tab — Design Spec

**Date:** 2026-05-26
**Status:** Brainstorm complete, awaiting user review before writing-plans handoff.

---

## Goal

Extend the playground's Models tab and per-student credential system so it cleanly handles the broader set of upstream LLM providers pi-ai can route to — currently Anthropic, OpenAI-codex (ChatGPT subscription), OpenAI Platform (direct API), and OMLX (local) — and is architected to accept future providers (Google, OpenRouter) by adding a single TypeScript module per provider with no UI rework.

Students see a Models tab where each upstream provider is a section. Sections are `AVAILABLE`, `GREYED`, or `HIDDEN` based on (a) whether the instructor has allowed the provider for the class and (b) whether the student has personal credentials OR the class is providing pool credentials. Greyed sections still display their models so students see what they'd unlock. Hidden providers collapse to a single footer line.

## Context

**Where we're starting from (already shipped, do not rebuild):**

- Per-student provider auth (paste-API-key OR vendor OAuth) for `claude` (Anthropic OAuth + API key) and `codex` (ChatGPT OAuth) — folded into trunk on 2026-05-19 via commit `e0ef45a`. 37 tests passing.
- `ProviderPolicy` shape in `Class Controls v2` JSON: `{ allow: boolean, provideDefault: boolean, allowByo: boolean }` per provider per class. Read by `src/channels/playground/api/class-controls.ts`.
- `auth-registry.ts` + `claude-spec.ts` + `codex-spec.ts` — the per-provider TypeScript-module-with-side-effect-import pattern. Kept post-Phase-D as an independent namespace from harness names (see `src/credential-proxy.ts:419` namespacing comment).
- `model-catalog.ts` with a hardcoded `BUILTIN_ENTRIES` array containing entries for `anthropic`, `openai-codex`, and `local` (Qwen3.6).
- `credential-proxy.ts` already implements the `/omlx/*` path that substitutes `OMLX_API_KEY` env var on outbound requests. OMLX discovery adapter (`src/model-providers/omlx.ts`) also shipped. The plan-step "smoke test 2 students end-to-end" remains open.
- Phase D (2026-05-26): pi is the sole agent harness; `container_configs.model_provider` column drives upstream routing.

**Why now:** Phase D made pi the sole harness and proved the model-provider column can route to any upstream pi-ai supports. The catalog and credential UI haven't caught up — gpt-4o family is invisible (no `openai-platform` provider), OMLX is in the catalog but the smoke test never closed out, and the existing 2-provider cred UI doesn't generalize. This spec catches those up and bakes in extensibility for Google/OpenRouter next.

## Scope

### In scope

- Convert `claude-spec.ts` and `codex-spec.ts` (existing) to own their catalog entries (move from `model-catalog.ts`).
- Add `openai-platform-spec.ts` (new) — API-key-only auth, ships with `gpt-4o`, `gpt-4o-mini`, `o3-mini` catalog entries.
- Add `omlx-spec.ts` (new) — `none`-kind auth + reachability probe; owns the Qwen3.6 catalog entry; uses host-level `OMLX_API_KEY` (defaulting to `'godfrey'`) on the proxy substitution.
- Refactor `model-catalog.ts` to assemble `BUILTIN_ENTRIES` from each provider module's `catalogModels` export instead of hardcoded array.
- Extend `ProviderSpec` discriminated union to support all three `AuthMethod` kinds (`oauth | apiKey | none`) and optional reachability probe.
- Models tab v2 layout: thin per-provider header rows, model cards get the real estate, greyed sections still display models, hidden providers collapse to one footer line.
- Add inline "manage" link per provider section on Models tab, opens the same credential dialog as Home Providers card (the dialog component is shared).
- Extend the cred dialog: tabs for multi-method providers (Anthropic OAuth + API key); active-method radio when both are set; OMLX special-case with URL + reachability instead of credentials.
- New endpoint `GET /api/me/models-tab-state` returning the formal `{state, source, actionLabel, catalogModels}` triple per provider — server-side greying-rule evaluation, frontend renders verbatim.
- Backend extensibility: any future provider (Google, OpenRouter) ships as one TypeScript module under `src/providers/<id>-spec.ts` + one barrel-import line, with no other files touched.
- Close out the OMLX smoke test as part of validation.

### Out of scope

- Adding Google, OpenRouter, Deepseek, Groq providers in this round (the extensibility is in scope; the implementations are deferred).
- Per-model instructor allowance (e.g. "claude-haiku yes, claude-sonnet no"). Today's per-agent `allowed_models` whitelist handles fine-grained per-agent cases; class-level allowance stays provider-grain.
- Migrating away from the Home Providers card. It stays unchanged; Models tab adds a second entry point to the SAME dialog component.
- Auto-discovering OpenAI Platform models from the `/v1/models` endpoint (a static catalog ships first; auto-discovery is a future polish).
- Class-pool cred health monitoring beyond a single optional banner on the instructor's Home tab — full observability for instructor's pool spend/quota is a separate effort.

## Architectural decisions (locked in via brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Cred management surface | **B — both Home Providers card + inline Manage on Models tab; shared dialog component** | Lowest disruption; either surface works; the underlying dialog is one component. |
| Provider scope this round | **5 auth paths spanning 4 upstreams + extensible** | Anthropic OAuth + Anthropic API key + ChatGPT OAuth + OpenAI Platform API key + OMLX local. Plug-in design for future Google + OpenRouter. |
| Availability rule | **Greyed unless instructor-allowed-and-shared OR student has personal creds** | Matches existing `ProviderPolicy` shape (`allow`, `provideDefault`, `allowByo`). |
| Allowance granularity | **Provider only (today's grain)** | Per-agent `allowed_models` handles fine-grained cases. Ship faster. |
| Provider packaging | **A — one TypeScript module per provider; each module owns its auth + catalog + proxy route** | Matches existing `claude-spec.ts` / `codex-spec.ts` pattern; type-safe end-to-end; provider DEFINITIONS are code (not DB-driven) because they don't change at runtime. |

## 1. Provider module contract

Each upstream provider becomes one file at `src/providers/<id>-spec.ts` exporting and registering a `ProviderSpec`:

```typescript
export interface ProviderSpec {
  id: string;                              // 'anthropic' | 'openai-codex' | 'openai-platform' | 'omlx' | future
  displayName: string;                     // 'Anthropic', 'ChatGPT (subscription)', 'OpenAI Platform', 'OMLX (local)'
  authMethods: AuthMethod[];               // 1 or more
  catalogModels: ModelEntry[];             // this provider's slice of the catalog
  proxyRoute: ProxyRouteConfig;            // how credential-proxy substitutes creds
  reachability?: () => Promise<boolean>;   // optional — OMLX uses it; cloud providers skip
}

type AuthMethod =
  | {
      kind: 'oauth';
      clientId: string;
      authUrl: string;
      tokenUrl: string;
      scopes: string[];
      pkce?: { method: 'S256' };
      refreshGrantBody?: (refreshToken: string) => Record<string, string>;
    }
  | {
      kind: 'apiKey';
      format?: RegExp;                     // optional pattern check before save
      helpUrl?: string;                    // "where do I get one?" link in the dialog
    }
  | { kind: 'none' };                       // local — no per-student auth

interface ProxyRouteConfig {
  pathPrefix: string;                      // '/anthropic', '/openai', '/openai-platform', '/omlx'
  upstreamBaseUrl: string;                 // 'https://api.anthropic.com', etc.
  authHeader: 'Authorization' | 'x-api-key';
  credResolver: (ctx: ResolverContext) => Promise<string | null>;
}
```

### What each module owns

| Module | Auth methods | Catalog entries | Reachability |
|---|---|---|---|
| `claude-spec.ts` (existing, extends) | `oauth` (Claude Code subscription) + `apiKey` (Anthropic API) | `claude-sonnet-4-6`, `claude-haiku-4-5` (moved from `model-catalog.ts`) | n/a |
| `codex-spec.ts` (existing, extends) | `oauth` (ChatGPT subscription) | 5 codex entries (moved from `model-catalog.ts`) | n/a |
| `openai-platform-spec.ts` (new) | `apiKey` only | `gpt-4o`, `gpt-4o-mini`, `o3-mini` initially | n/a |
| `omlx-spec.ts` (new) | `none` | Qwen3.6 + local-config-file overrides | yes (`fetch(host + '/v1/models', timeout=1500)`) |

### `model-catalog.ts` after refactor

```typescript
import { claudeSpec } from './providers/claude-spec.js';
import { codexSpec } from './providers/codex-spec.js';
import { openaiPlatformSpec } from './providers/openai-platform-spec.js';
import { omlxSpec } from './providers/omlx-spec.js';

const BUILTIN_ENTRIES: ModelEntry[] = [
  ...claudeSpec.catalogModels,
  ...codexSpec.catalogModels,
  ...openaiPlatformSpec.catalogModels,
  ...omlxSpec.catalogModels,
];

// Local overrides + codex auto-discovery glue stays as-is.
```

Adding Google later = `src/providers/google-spec.ts` exporting `{id: 'google', authMethods: [{ kind: 'oauth', ... }, { kind: 'apiKey', ... }], catalogModels: [...gemini entries], proxyRoute: {...}}` + one barrel-import line in `model-catalog.ts` and `src/providers/index.ts`. No other files touched.

## 2. Models tab UI (v2 layout)

Per-provider sections, top to bottom. Each section is:

```
<heading row>           [thin, hairline-bottom]
  • <provider name>     [bold, 14px]
  • <status dot+phrase> [colored dot + small text — green/purple/grey]
  • <manage link>       [text link, right-aligned]
<model grid>            [auto-fill 180px minmax; each model card shows name + cost/latency + chips]
```

**Status dots:**
- `●` green — `your subscription` / `your API key` / `reachable · localhost:8000`
- `●` purple — `class pool (shared by instructor)`
- `○` grey hollow — `no API key set` / `not connected`
- `●` red — `unreachable` (local only)

**Action link** (right side of header row, text not button):
- `manage` — provider configured with own creds
- `use my own` — currently using class pool, can switch to personal
- `add api key` — greyed, BYO allowed, no creds yet
- `connect` — greyed, OAuth method available
- `settings` — local providers (OMLX)
- `ask instructor` — greyed because `allow && !provideDefault && !allowByo` (rare, "show but block" config)

**Greyed sections** still show their models at 55% opacity so students see what they'd unlock.

**Hidden providers** (`!allow`) collapse to a single italic line at the page footer: `"1 provider hidden — Deepseek not enabled by instructor."` (count + names dynamic).

## 3. Shared credential dialog

One component used from both surfaces. Anchored at top-right of the page (modal overlay).

**Frame:**
- Header: `Manage credentials · <provider displayName>` + close ×
- Body: variant per provider (see below)
- Footer: provider-specific actions

**Variants:**

| Provider shape | Body | Footer |
|---|---|---|
| **OAuth + API key** (Anthropic) | Tabs at top (`Subscription (OAuth)` / `API key`). Tab body: status + account + expiry (OAuth) or paste box (API key). Below tabs: `Active method` radio when both configured. | `Disconnect <method>` (left, danger color) + `Done` (right) |
| **OAuth only** (ChatGPT) | Single section (no tabs). Status + account + token expiry. | `Disconnect` + `Done` |
| **API key only** (OpenAI Platform) | Single section. Paste box + `helpUrl` link ("where do I get a key?"). | `Disconnect` (if set) + `Save` |
| **None / local** (OMLX) | Info callout: "no credentials needed — local server". Server URL input. Reachability state ("✓ /v1/models 200 · 1 model", last-checked time). | `Re-test` + `Save` |

The component reads `ProviderSpec.authMethods` to decide which variant to render. No per-provider switch statement in the UI code — the spec drives it.

**Backwards-compatible API:** The dialog uses the existing `/provider-auth/:id/{start,exchange}` and `/api/me/providers/:id/{api-key,active,*}` routes. New `kind: 'none'` triggers a new endpoint `POST /api/me/providers/:id/reachability` for the OMLX URL/probe workflow.

## 4. Data model + flow

### Greying-state derivation (server-side, in new `models-tab-state.ts`)

```
let policy = classControls.classes[classId].providers[providerId];  // ProviderPolicy
let credState = perStudent.providers[providerId];                    // { hasOAuth, hasApiKey, activeMethod }
let hasReachabilityProbe = !!provider.reachability;                  // true for OMLX, false for cloud
let reachable = hasReachabilityProbe ? await provider.reachability() : true;
let isLocalOnly =                                                    // provider has no real auth methods
  provider.authMethods.length === 1 && provider.authMethods[0].kind === 'none';

if (!policy.allow)                                       → HIDDEN
if (hasReachabilityProbe && !reachable)                  → GREYED  (source: null, actionLabel: 'test connection')
if (isLocalOnly && reachable)                            → AVAILABLE (source: 'local')
if (policy.provideDefault)                               → AVAILABLE (source: 'class-pool')
if (credState.hasOAuth || credState.hasApiKey)           → AVAILABLE (source: 'personal-oauth' | 'personal-key')
if (policy.allowByo)                                     → GREYED   (actionLabel: 'add api key' | 'connect')
otherwise                                                → GREYED   (actionLabel: 'ask instructor')
```

For local-only providers (OMLX — `authMethods` contains only `{ kind: 'none' }`), the rule short-circuits at the `isLocalOnly && reachable` check above: HIDDEN if `!allow`, else GREYED if reachability probe fails, else AVAILABLE.

### `GET /api/me/models-tab-state`

```typescript
// Response
{
  providers: Array<{
    id: string;
    displayName: string;
    state: 'AVAILABLE' | 'GREYED' | 'HIDDEN';
    source: 'personal-oauth' | 'personal-key' | 'class-pool' | 'local' | null;
    actionLabel: string | null;             // 'manage' | 'use my own' | 'add api key' | 'connect' | 'settings' | 'ask instructor'
    catalogModels: ModelEntry[];            // [] for HIDDEN providers
  }>;
}
```

Frontend renders this directly — no client-side policy logic. Backward compat: keep `/api/drafts/<folder>/models` working with its existing shape so nothing breaks mid-deploy; the new endpoint is additive.

### Reachability cache

OMLX (and any future `kind: 'none'` provider) probes are cached server-side for 30 seconds per provider to keep page renders cheap. Cache invalidates on dialog "Re-test" click.

### Request flow (no changes vs today)

```
1. Student selects gpt-4o on Models tab
   └─ PUT /api/drafts/<folder>/active-model {modelProvider:'openai-platform', model:'gpt-4o'}
       └─ writes container_configs.{model_provider, model}, kills container

2. Next inbound message routed; container respawns with new container.json
   └─ pi.ts routes via modelProvider='openai-platform'
       └─ pi-ai sends to https://api.openai.com/v1/... with Authorization: Bearer placeholder
           └─ credential-proxy /openai-platform/* route intercepts
               └─ openaiPlatformSpec.proxyRoute.credResolver({studentId, agentGroupId})
                  → student.providers['openai-platform']?.apiKey
                  → fallback to policy.provideDefault ? process.env.OPENAI_PLATFORM_API_KEY : null
                  → returns null → upstream receives the placeholder → 401 surfaces in trace
```

## 5. Error handling

| Failure | Behavior |
|---|---|
| OAuth start fails | Modal stays open, inline error banner; existing `claude-spec` pattern. |
| OAuth exchange fails | Same banner + log; cred state remains "not configured". |
| OAuth refresh fails | `credResolver` returns null → 401 surfaces in trace. Provider state transitions AVAILABLE → GREYED on next page refresh. |
| API key paste — invalid format | Server-side regex check (`AuthMethod.format`). Inline "key doesn't match expected pattern", no save. |
| API key — wrong key, valid format | Save succeeds; first request 401; trace shows it. **No pre-flight validation** (would require a real billable call). |
| OMLX reachability fails | State = GREYED, action = "test connection" (re-runs probe). Background re-probe every 60s while Models tab is open. |
| Class-pool cred missing despite `provideDefault: true` (instructor's key expired, `OMLX_API_KEY` unset, etc.) | First request 401 surfaces in trace; students see AVAILABLE until that mismatch. **Optional**: a startup-time health check writes a banner on the instructor's Home tab when class-pool creds are missing for any `allow && provideDefault` provider. |
| Provider plugin module fails to load at host startup | Host hard-fails with the exception. Loud beats silent. |
| Two providers register the same `id` | Registry throws at registration time; second import fails loudly. |

## 6. Testing strategy

| Layer | Tests |
|---|---|
| Per provider module (`*-spec.ts`) | Smoke: registers without error, exports valid `ProviderSpec`, catalog entries pass schema. One file per provider. |
| Catalog assembly | Concat preserves order; no duplicate `(modelProvider, id)` across providers; local-overrides path merges in last. |
| Greying rule (`models-tab-state.ts`) | Truth-table unit test covering ~15 cases: `allow × provideDefault × allowByo × hasOwnCreds × kind=cloud/none × reachable`. Pure-data inputs, pure-data outputs. |
| `/api/me/models-tab-state` endpoint | Integration test: seed Class Controls + per-student creds, hit endpoint, assert response shape per provider. |
| Cred dialog frontend | Vitest + happy-dom: render component in `oauth-only` / `apikey-only` / `both-methods` / `local` modes; assert tab visibility, active-method selector visibility, footer button labels. |
| OMLX live | The plan's open smoke test step closes out here: 2 students end-to-end, send message to a `local`-configured agent, verify response + reachability state. |
| Migration | Existing `ProviderPolicy` shape unchanged; new providers added to Class Controls defaults via additive keys; missing keys default to `allow: false`. Confirm via integration test that a pre-existing install boots and Models tab renders without manual config changes. |

## 7. Acceptance criteria

This is "done" when:

1. A student on a fresh classroom install opens the Models tab and sees 4 sections (Anthropic, ChatGPT, OpenAI Platform, OMLX) plus a possible "hidden providers" footer line.
2. With instructor `provideDefault: true` for Anthropic + ChatGPT, those sections render `AVAILABLE` with `● class pool` badges. Models in those sections are clickable.
3. With instructor `allowByo: true` for OpenAI Platform but no student API key, the section renders greyed with an `add api key` link. Clicking opens the cred dialog. Pasting a valid key + Save closes the dialog and the section ungreyed within 1 page reload.
4. OMLX section renders `AVAILABLE · ● reachable · localhost:8000` when the local server is up; transitions to GREYED + `test connection` when stopped, and back when restarted (within the 60s re-probe window).
5. A provider with `allow: false` is HIDDEN — visible only in the footer counter.
6. The Home Providers card (existing) continues to function identically. The cred dialog opened from there is the same component as the one opened from Models.
7. Sending a chat message with `gpt-4o` selected hits the OpenAI Platform endpoint via the credential proxy, substitutes the student's API key (or class-pool fallback), and records cost in `messages_out.{tokens_in, tokens_out, provider, model}`.
8. Adding a hypothetical `google-spec.ts` (proof-of-concept, not shipped) requires only the one new file + one barrel-import line; no other files touched; the section appears in the Models tab.

## 8. Migration notes

- **No DB migration.** All new state lives in existing tables/files: `Class Controls v2` JSON (new provider entries added to the same `providers` map), per-student credential storage (existing path, new `providerId` values).
- **`.env` addition.** Optional `OPENAI_PLATFORM_API_KEY` for the class-pool fallback. `OMLX_API_KEY` defaults to `'godfrey'` if unset (was `'local'`).
- **No breaking changes to existing endpoints.** `/api/drafts/<folder>/models` keeps working with its current shape. `/api/me/models-tab-state` is additive.
- **Existing per-student auth flow preserved.** New providers register via the same `auth-registry.ts` mechanism; the new `kind: 'none'` AuthMethod variant requires a small registry extension but no removal of existing methods.

## 9. Open questions

These came up during brainstorm and were resolved or deferred — captured here for the implementer's reference:

- **"Ask instructor" action label** — used when `allow && !provideDefault && !allowByo`. Unusual config ("show but block"); kept the case live in case instructor wants the visibility-without-access pattern (e.g. "students can see what gpt-5.5 costs but can't run it yet").
- **Pre-flight API key validation** — explicitly skipped. Validating a key requires a real billable call. First chat surfaces 401, student re-pastes.
- **Class-pool cred health banner on Home** — optional, not in this round. Can ship as a 1-task follow-up.
- **OMLX URL per-student vs host-level** — host-level. Per-student local servers (each student running OMLX on their machine) is out of scope; classroom case is one OMLX on the Mac Studio.

## 10. References

- Existing per-student auth spec: `docs/superpowers/specs/2026-05-17-per-student-provider-auth-design.md`
- Existing per-student auth plan: `docs/superpowers/plans/2026-05-17-per-student-provider-auth.md` (shipped, status table at top)
- OMLX integration plan: `docs/superpowers/plans/2026-05-14-omlx-local-model-integration.md` (smoke test step open)
- Phase D spec/plan: `docs/superpowers/plans/2026-05-25-phase-d-pi-sole-harness.md` (modelProvider column shipped)
- Compass: `state.md` (current arc, invariants, decision log)
- Memory: `reference-pi-ai-codex-usage-gap.md` (cross-process MCP tool gap, fixed in `b204567`)
