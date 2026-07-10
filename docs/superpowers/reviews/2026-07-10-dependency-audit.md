# Dependency audit — host (pnpm) and container agent-runner (Bun)

**Date:** 2026-07-10. Plan 2, Task 10 (final task). Audit only — no dependency,
lockfile, or policy file was changed. Recommendations below require operator
sign-off before applying.

## Step 1 — Host audit (`pnpm audit --prod`)

Ran to completion. **1 vulnerability found, severity moderate.** No high/critical.

| Package | Path | Vulnerable range | Patched | Advisory |
|---|---|---|---|---|
| `qs` | `.>@googleapis/calendar>googleapis-common>qs` (also reached via `@googleapis/docs`, `@googleapis/drive`, `@googleapis/gmail`, `@googleapis/sheets`, `@googleapis/slides` — all six share the same `googleapis-common@8.0.1>qs@6.15.1`) | `>=6.11.1 <=6.15.1` | `>=6.15.2` | [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) |

**Reachability analysis.** `qs@6.15.1` is a real prod dependency — it's pulled by
`googleapis-common`, which every `@googleapis/*` package (Calendar, Docs, Drive,
Gmail, Sheets, Slides) uses under the hood, and those packages are actively
imported in `src/gmail-send.ts`, `src/gws-auth.ts`, `src/gws-token.ts`,
`src/gws-mcp-tools.ts`, `src/channels/playground/google-oauth.ts`, and others. So
the package itself is loaded and exercised on every GWS API call — this is not a
dev-only or dead-code advisory.

However, the advisory's crash condition is specific: `qs.stringify` throws only
when `arrayFormat: 'comma'` **and** `encodeValuesOnly: true` are both set and an
array contains `null`/`undefined` entries. Checked both call sites in
`googleapis-common@8.0.1`:
- `apirequest.js:139` → `qs.stringify(params, { arrayFormat: 'repeat' })` — wrong array format, never triggers.
- `http2.js:54` → `config.paramsSerializer || qs.stringify` — no serializer override found anywhere in `googleapis-common`'s own code, and `grep -rn "paramsSerializer\|arrayFormat\|encodeValuesOnly" src/` in this repo returns nothing, so nanoclaw never sets those options either.

**Verdict: reachable package, unreachable vulnerable code path.** Neither
`googleapis-common` nor nanoclaw's own code ever calls `qs.stringify` with the
`comma` + `encodeValuesOnly` combination the advisory requires, so this DoS is
not exploitable through nanoclaw's current Google Workspace integration. It is
still worth clearing because it's a one-line, well-aged fix and a future code
path (or a `googleapis-common` update) could start using `paramsSerializer`.

**Fix.** `qs` is transitive (all 6 `@googleapis/*` packages pin
`googleapis-common@8.0.1`, whose own `package.json` requires `qs: ^6.7.0` — a
range that already permits 6.15.3). No need to bump `googleapis-common` or any
`@googleapis/*` package; a `pnpm.overrides` entry pinning `qs` to `6.15.3` is
sufficient. Both patched versions clear the 3-day `minimumReleaseAge` gate
comfortably (`6.15.2` published 2026-05-16, `6.15.3` published 2026-06-24 — over
6 weeks old as of this audit).

## Step 2 — Container dep audit (`container/agent-runner/package.json`, Bun)

`bun install --frozen-lockfile` is what `container/Dockerfile` actually runs
(line 96, after `COPY agent-runner/package.json agent-runner/bun.lock`) — so
**production container builds resolve from the committed `bun.lock`, not from
re-resolving the semver ranges against the npm registry.** The live supply-chain
exposure the task brief describes (a freshly-published/malicious version being
pulled with zero aging, since Bun has no `minimumReleaseAge` equivalent) opens at
a different moment than "every container build": it opens the moment a developer
runs `bun install` or `bun update` (no `--frozen-lockfile`) to add or bump a
dependency and commits the resulting `bun.lock`. That is still a real, unmitigated
gap — just narrower than "every build."

| Dependency | Version spec | Pinned? | Resolved (bun.lock) | npm latest (as of audit) | Risk note |
|---|---|---|---|---|---|
| `@earendil-works/pi-agent-core` | `0.75.4` | Yes (exact) | 0.75.4 | 0.80.6 | Org created 2026-05-07 (~2 months old at audit time), 29 versions in that span (~1 release/2 days) — high release velocity for a young org. MIT, GitHub-linked (`earendil-works/pi`). No typosquat concerns (distinct scoped name). Already exact-pinned, so no *range* exposure — flagging for awareness only since this is the least-established dependency in the tree and it's the sole agent harness per project history. |
| `@earendil-works/pi-ai` | `0.75.4` | Yes (exact) | 0.75.4 | 0.80.6 | Same org/provenance note as above. Exact-pinned. |
| `@earendil-works/pi-coding-agent` | `0.75.4` | Yes (exact) | 0.75.4 | 0.80.6 | Same org/provenance note as above. Exact-pinned. |
| `@modelcontextprotocol/sdk` | `^1.12.1` | **No (range)** | 1.29.0 | 1.29.0 | Official MCP org package (Anthropic-affiliated), high adoption, no provenance concerns. Range is live exposure at next `bun install`/`bun update` — recommend exact pin regardless of low risk, per policy intent. |
| `cron-parser` | `^5.0.0` | **No (range)** | 5.5.0 | 5.6.1 | Long-established package (harrisiirak/cron-parser), no provenance concerns. Lockfile (5.5.0, published 2026-01-16) is already behind npm latest (5.6.1, published 2026-06-24) — next unpinned `bun install` would silently jump 2 minor versions with zero aging. Recommend exact pin. |
| `zod` | `^4.0.0` | **No (range)** | 4.3.6 | 4.4.3 | Extremely high-adoption package, no provenance concerns. Same staleness pattern as cron-parser — lockfile trails npm latest. Recommend exact pin. |

**Dev dependencies** (`@types/bun`, `@types/node`, `typescript`) are all on ranges
too, but they never ship in the runtime image and carry no request-time attack
surface — out of scope per the task's "runtime dependency" framing; not included
in the table above.

**Summary: 3 of 6 runtime deps on a range** (`@modelcontextprotocol/sdk`,
`cron-parser`, `zod`). The three `@earendil-works/*` packages are already exact
pins. No typosquat-adjacent names, no suspicious maintainer changes found on any
of the six.

## Step 3 — Supply-chain policy check (`pnpm-workspace.yaml`)

```
onlyBuiltDependencies:
  - better-sqlite3
  - esbuild
  - protobufjs
  - sharp

pnpm:
  minimumReleaseAge: 4320
```

- **`minimumReleaseAgeExclude`: not present.** No entries to check for range vs.
  exact-version violations — nothing to report, nothing to flag.
- **`onlyBuiltDependencies`: 4 entries**, all mainstream native-build packages
  (`better-sqlite3`, `esbuild`, `protobufjs`, `sharp`) already expected by this
  project's stack (SQLite bindings, bundler, protobuf codegen, image processing —
  `sharp` matches the `onlyBuiltDependencies` list in `pnpm-workspace.yaml:1-4`).
  No range syntax appears in this list (it's not a version list, so the
  range-vs-exact rule doesn't apply here) and no entry looks unvetted or
  unexplained by the codebase's known dependencies.
- **No policy violations found.** This audit did not add or remove any entries.

## Ranked recommendations (not applied — require operator sign-off)

Each command is what the operator would run after sign-off. None have been run.

1. **Highest priority — pin the transitive `qs` DoS fix.** Even though the
   vulnerable code path isn't reachable today, it's a one-line override with a
   well-aged patch and closes the audit finding outright.
   ```bash
   # Add to pnpm-workspace.yaml under a new top-level `overrides:` key (or pnpm's
   # equivalent `pnpm.overrides` in package.json, per your existing convention):
   #   overrides:
   #     qs: 6.15.3
   pnpm install   # after adding the override, to regenerate pnpm-lock.yaml
   ```
   Recommend `qs` `6.15.1` → `6.15.3` because it clears the published advisory
   and is 46 days past the `minimumReleaseAge` gate as of this audit.

2. **Pin `@modelcontextprotocol/sdk`, `cron-parser`, `zod` to exact versions** in
   `container/agent-runner/package.json`, matching the exact-pin discipline
   already used for the three `@earendil-works/*` packages. This doesn't change
   current behavior (bun.lock already resolves close to these versions) — it
   just removes the range so a future `bun install`/`bun update` can't silently
   pull an unaged, unvetted patch/minor release into the container image.
   ```bash
   cd container/agent-runner
   # Edit package.json: "@modelcontextprotocol/sdk": "1.29.0", "cron-parser": "5.6.1", "zod": "4.4.3"
   bun install   # regenerates bun.lock with the exact pins
   bun run typecheck && bun test
   ```
   Recommend `@modelcontextprotocol/sdk` `^1.12.1` → `1.29.0`,
   `cron-parser` `^5.0.0` → `5.6.1`, `zod` `^4.0.0` → `4.4.3` because ranges
   on runtime deps in a tree with no `minimumReleaseAge` gate are the exact
   exposure this task exists to close — an exact pin means every version bump is
   a reviewed, deliberate diff instead of an automatic `bun install` pickup.

3. **No action needed on `@earendil-works/pi-*` packages or `onlyBuiltDependencies`.**
   The three `pi-*` packages are already exact-pinned (good practice given the
   young/high-velocity org) and `onlyBuiltDependencies` contains only expected,
   mainstream native-build packages. Flagging the org's youth for awareness only
   — no version-spec change is needed since there's no range to close.
