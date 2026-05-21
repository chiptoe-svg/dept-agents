# PR #4 review fixes

Addressing the code review on PR #4 (`feat/playground-add-student`). Work
lands on `claude/review-nanoclaw-pr-tPyEm` (fast-forwarded onto the PR head).

Scope decision: address everything (High + Medium + Low/nits). IDOR fix:
gate all `/api/drafts/:folder` GET routes.

## Phases

- [x] **#1 IDOR** — new `src/channels/playground/draft-read-gate.ts`
  exporting `canReadDraft(folder, userId)` (`canAccessAgentGroup` check).
  Wire into every `/api/drafts/:folder` GET route in `api-routes.ts`
  (persona, persona-layers, skills, custom-skills ×3, models, stream).
- [x] **#2 tunnel race** — `class-tunnel.ts`: synchronous in-flight
  `Promise` slot so concurrent `startGuestTunnel()` calls share one spawn.
- [x] **#3 FS scaffold transaction** — `class-student-provision.ts`: wrap
  the FS scaffold in try/catch; roll back the 4 committed DB rows on
  failure so a retry reissues the same `student_NN`.
- [x] **#4 JSON.parse guard** — `codex.ts`: try/catch around
  `container.json` parse (mid-write TOCTOU).
- [x] **#5 effectiveModel comment** — `codex.ts`: make per-query (not
  per-turn) granularity explicit.
- [x] **#6 skills.js re-entrancy** — selection token; bail in async tails
  of `loadEditor` / `loadPreview` when selection changed.
- [x] **#7 'all'-expansion drops skills** — `skills.js`: track library
  load success; block `'all'` expansion + surface failure when it failed.
- [x] **#8 unbounded file size** — `custom-skills.ts`: per-file byte cap +
  per-skill file-count cap; tighten the PUT route body cap.
- [x] **Nits** — tunnel security comment; name/email caps + control-char
  strip; `studentProviderCredsPath` sanitize; `toggleActive` save
  serialization + filter re-apply; partial multi-file save reporting;
  codex dedup on cumulative `total` instead of `last`.
- [x] **Tests** — `draft-read-gate.test.ts`; `provisionStudent` happy +
  rollback; tunnel concurrency; codex per-turn token accumulation + dedup.
- [x] **Verify** — host `tsc`, container `tsc`, `pnpm test`, `bun test`,
  `format:check`.

## Out of scope

- Pre-existing container test failure (`integration.test.ts:129`) — fails
  on `main` too; reviewer recommended a separate branch. Noted, not fixed.
</content>
</invoke>
