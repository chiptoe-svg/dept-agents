# Class Controls — provider grouping (hybrid model)

**Goal.** Fix the broken Class Controls form on the instructor Home tab and
reshape it around a small, user-facing list of providers, while keeping the
underlying multi-spec architecture intact.

**User-facing providers (hard-coded, 4):** OpenAI, Anthropic, Local, Clemson.

**Underlying specs (registered in auth-registry, 5):** `codex`,
`openai-platform`, `claude` (= anthropic), `omlx` (= local), `clemson`.

**Mapping (single source of truth, lives in one helper):**

| Display | Underlying specs | Notes |
|---|---|---|
| OpenAI | `codex`, `openai-platform` | Two specs; auth mode (subscription OAuth vs Platform API key) chosen inside the credential card, not as a class-level toggle |
| Anthropic | `claude` | |
| Local | `omlx` | |
| Clemson | `clemson` | |

**Columns (rename current `allow`/`provideDefault`/`allowByo`):**

- **Visible** — provider appears in the student's UI. (= current `allow`)
- **Provided** — class supplies the credential. The auth-mode for the
  provided credential is chosen in the LLM credential card on the same Home
  tab. (= current `provideDefault`)
- **Let students auth themselves** — student can paste/connect their own
  credential. (= current `allowByo`)

**Out of the bottom of the form:** drop the "Auth modes available" block
entirely. In the post-mptab spec model, auth methods are per-provider /
per-credential and a class-wide toggle no longer describes anything real.

---

## Why a written plan

Multi-file UI refactor with a couple of subtle invariants:

- Underlying `class-controls.providers[<specId>]` policy must stay
  per-spec, not per-group, because the credential-proxy + Models tab +
  per-student creds all key by spec id. The grouping is purely a UI fold
  on top.
- Writes: toggling a column on the "OpenAI" row writes the same value to
  both `codex.<col>` and `openai-platform.<col>`.
- Reads: the "OpenAI" row's checkbox is `true` iff *all members of the
  group* have the field `true` — anything else would let a half-configured
  policy display as fully on.

---

## Phase 1 — Class Controls form (this work)

### Files

| Path | Change |
|---|---|
| `src/channels/playground/public/tabs/home.js` | Rewrite `renderClassControlsForm` to use the grouping helper, 4 fixed rows, 3 renamed columns. Update the `#cc-save` handler to expand each group toggle to its underlying spec ids. Drop the "Auth modes available" block (UI only — leave the API field alone for now). |
| `src/channels/playground/public/provider-groups.js` *(new)* | Tiny module exporting `PROVIDER_GROUPS` — the 4-entry hard-coded list with `{ id, displayName, specIds }`. Single source of truth for grouping. |

### Tasks

- [ ] **1.1** Create `provider-groups.js`. Hard-coded 4-entry array; no
  function calls, no fetch — UI-side constant.
- [ ] **1.2** In `home.js`, import `PROVIDER_GROUPS`. Replace the broken
  `PROVIDERS`-referencing block in `renderClassControlsForm` with a fold:
  for each group, read each underlying spec's policy and compute the
  group-level checkbox state as the AND of `policy[specId].<col>` across
  members. If a member is missing entirely, treat as `false`.
- [ ] **1.3** In the `#cc-save` click handler, replace the
  `PROVIDERS.concat([{ id: 'local' }])` loop with: for each group, read
  the group-level checkbox, write that value to `providers[specId].<col>`
  for every `specId` in the group. Preserve any pre-existing entries for
  other specs (don't accidentally clobber `clemson` etc. if grouping is
  ever partial).
- [ ] **1.4** Delete the "Auth modes available" block from the form
  template + save handler (kept entry is `authModesAvailable` in the
  payload — leave that field as `[]` to avoid a server-side schema break
  until we audit consumers).
- [ ] **1.5** Manual verify: open Home tab → instructor sees 4 rows,
  toggling "OpenAI / Provided" writes `codex.provideDefault=true` AND
  `openai-platform.provideDefault=true`; saving + reload round-trips
  cleanly; chat dropdown picks up the change.

### Verification

- `pnpm run build` clean.
- `pnpm test` passes (no host code changed; tests should be unaffected).
- Live: load Home tab as instructor (`/` on the playground), confirm the
  4 rows render, toggle a few cells, save, reload, confirm the state
  persists.

---

## Phase 2 — Home Providers card grouping (this work)

The Home tab's Providers card (the "LLM credential card" the user
referenced) renders one row per spec via `renderProvidersCard` →
`renderProviderRow`. With grouping, the two OpenAI rows should fold into
one row whose credential dialog offers both auth methods.

### Files

| Path | Change |
|---|---|
| `src/channels/playground/public/tabs/home.js` | In `renderProvidersCard`, group the `/api/me/models-tab-state` `providers` array by `PROVIDER_GROUPS` membership; render one row per group. Row state aggregates from members: `state` = AVAILABLE if *any* member is AVAILABLE; `creds.hasApiKey/hasOAuth` = OR across members. |
| `src/channels/playground/public/tabs/home.js` | `wireProviderRow` for an OpenAI group row opens a cred dialog that maps "Subscription OAuth" → `codex` spec, "API key" → `openai-platform` spec. Reuse existing `buildMixedVariant` shape. |

### Tasks

- [ ] **2.1** Add `groupProvidersTabState(providers)` helper that folds
  the flat spec list into the 4 user-facing groups.
- [ ] **2.2** Update `renderProviderRow` to accept either a single-spec
  row or a group row, with a small `members:[]` field on the group.
- [ ] **2.3** Update `wireProviderRow` to handle the OpenAI group: API-key
  paste → `/api/me/providers/openai-platform`, OAuth connect → `/api/me/providers/codex`.
  Disconnect: removes from whichever member it was set on.
- [ ] **2.4** Verify on live: instructor + a test student both see one
  "OpenAI" row; pasting an API key persists under `openai-platform` and
  the row shows as connected; OAuth flow stays on `codex`.

### Verification

- Same as Phase 1 plus: in the Home Providers card after save, the row
  state matches what the Models tab shows (no inconsistency).

---

## Out of scope (deferred)

- **Models tab catalog grouping.** Currently shows two "OpenAI" sections
  (one per spec) with mirrored catalogs. Folding requires deciding what
  `modelProvider` tag to write into `container_configs.model_provider`
  when the student picks a model from the grouped section — that tag
  drives credential-proxy routing. Real change; separate plan.
- **Cred dialog "Subscription vs API key" tab.** Today: cred dialog is
  per-spec. After Phase 2 the OpenAI group row will call cred dialog
  with one of two specs depending on which connect path the user takes,
  which is good enough for now. A unified tabbed dialog is nicer UX but
  not required.
- **`authModesAvailable` field cleanup.** Leaving the payload field
  populated as `[]` (instead of removing it from the schema) until a
  separate audit pass confirms no host code reads it.

---

## Risks / invariants

- **Don't merge spec ids underneath.** Credential-proxy routing keys by
  spec id (`/openai/` vs `/openai-platform/`), per-student creds are
  stored by spec id, models-tab-state derives availability per spec id.
  Grouping is a UI concept; underlying namespaces stay split.
- **Reads use AND, writes use the same value to all members.** The
  asymmetry (AND on read, broadcast on write) prevents a half-configured
  policy from displaying as fully on but also means a manual edit of
  `class-controls.json` setting one member but not the other will show
  the group as off.
- **Default-class semantics unchanged.** Still `DEFAULT_CLASS_ID =
  'default'`. Multi-class is out of scope (existing TODO across the
  codebase).
