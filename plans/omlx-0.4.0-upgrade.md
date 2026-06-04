# OMLX v0.4.0 upgrade plan

**Status:** Drafted 2026-06-03. Do NOT execute before the in-class deployment is complete.

**Why:** OMLX shipped v0.4.0 on 2026-06-02 — first official native Swift macOS app, plus runtime stability fixes (predictive prefill throttling, per-engine MLX threads, memory guard tuning, paged-cache hardening). See release notes: https://github.com/jundot/omlx/releases/tag/v0.4.0.

**Class Controls today** (`config/class-controls.json`): `omlx: { allow: true, provideDefault: true }`. OMLX is a class-pool fallback path for the agents — a regression here would surface as "instructor hasn't connected omlx" or 502s. So this upgrade has user-visible blast radius and must be smoke-tested before students hit it.

**Why not now (2026-06-03):** class runs in two days; the release is ~24h old; the macOS app entirely changed shape (PyObjC → Swift). Wait until after class.

---

## Pre-flight (don't skip)

- [ ] **Pin the rollback target.** Note the current OMLX version: open the menubar app → About, or `curl $OMLX_BASE_URL/version` (if exposed). Record the DMG filename for v0.3.x in case rollback is needed.
- [ ] **Capture baseline behavior.** Send 5 messages through a NanoClaw agent group wired to omlx (`bench_cc11a34b7777` is a good probe — owner-only, no student impact). Confirm:
  - Token counts populate in `messages_out`.
  - Latency is in the expected range.
  - No errors in `logs/nanoclaw.log` for the omlx path.
- [ ] **Snapshot the model list.** `curl -s $OMLX_BASE_URL/v1/models | jq -r '.data[].id' > /tmp/omlx-models-pre.txt`. After upgrade, diff against `omlx-models-post.txt` to catch silent model availability changes.
- [ ] **Check disk free.** Native Swift app DMG + retained venvstacks: budget ~3–5 GB headroom. `df -h ~/Library/Application\ Support/`.

## Install

- [ ] Download the right DMG for the host OS:
  - macOS 15 Sequoia → `oMLX-0.4.0-macos15-sequoia.dmg`
  - macOS 26 Tahoe → `oMLX-0.4.0-macos26-tahoe.dmg`
- [ ] Quit the running OMLX menubar app cleanly (let in-flight requests drain — watch the menubar request counter if visible).
- [ ] Move the new `.app` into `/Applications/`, replacing the old PyObjC bundle.
- [ ] Launch. New onboarding flow will appear (per release notes). Walk through it without changing model directories — point it at the existing HuggingFace cache so model downloads are reused.
- [ ] Confirm the menubar shows port/status (Swift app's new live status surface). Note the bound port and confirm it matches `OMLX_BASE_URL` in `.env`.
- [ ] If the port differs, update `.env` and `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4`.

## Smoke tests (run all before reopening to students)

- [ ] **Model list.** `curl -s $OMLX_BASE_URL/v1/models | jq -r '.data[].id'`. Diff against `omlx-models-pre.txt`. Investigate any drops; new entries are fine.
- [ ] **Direct chat.** In the playground chat tab (owner login), pick an omlx model, send "Hello, reply with the model name and the current time." Confirm:
  - Response arrives.
  - Trace pane shows tokens + latency.
  - `messages_out.provider` row says `omlx` (or whatever the resolver tags it).
- [ ] **Agent chat.** Switch the bench agent group to an omlx model via the chat dropdown. Send a multi-turn conversation (3 turns minimum). Confirm continuation works (no "model state" errors).
- [ ] **Concurrency probe.** Open two browser tabs in two different incognito sessions; send simultaneous turns to two different agent groups, both omlx-routed. The v0.4.0 release notes specifically call out per-engine MLX threads + predictive prefill throttling — this is the bullet that protects multi-student inference. Watch for mid-stream stalls.
- [ ] **OOM regression check.** Send a long-prompt turn (5K+ input tokens) to confirm the new memory guard tuning isn't more aggressive than 0.3.x. If the agent gets evicted, dial Custom tier thresholds in the new Swift settings UI.
- [ ] **File-tool path.** Send a PDF attachment to an omlx-routed agent and ask for a summary. Confirms the existing `pdf-reader` + `send_file` flow still works against the new OMLX surface.
- [ ] **NanoClaw logs.** `tail -200 logs/nanoclaw.log | grep -iE "omlx|provider" | grep -iE "warn|error"`. Should be empty.

## Sign-off

- [ ] All smoke tests green.
- [ ] No errors in NanoClaw logs for >15 minutes of normal use.
- [ ] OMLX menubar shows steady status (no flicker between running/stopped).
- [ ] Commit a state.md decision-log entry: "OMLX upgraded 0.3.x → 0.4.0 on `<date>`. Smoke-tested. Native Swift app replaces PyObjC menubar."

## Rollback plan (if something breaks)

1. Quit the v0.4.0 Swift app.
2. Reinstall the previous v0.3.x DMG (asset filenames in the v0.3.x release page).
3. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4`.
4. Verify smoke-test 1 (model list) — confirms NanoClaw can reach OMLX again.
5. File a GitHub issue at jundot/omlx with the reproducing input + NanoClaw log excerpt.

## Optional follow-ups (only after upgrade is stable for a week)

- [ ] Try the new **guided grammar** model setting for structured output. Useful if we want the agent to produce JSON-shaped resume sections instead of freeform markdown. Wire would touch `container/agent-runner/src/providers/pi-model.ts` if exposed via OpenAI-compat or stay in skill-level prompts otherwise.
- [ ] Audit which OMLX models we list in NanoClaw's catalog (`config/model-catalog-local.json`?) against the v0.4.0 model availability. Drop any retired entries.
- [ ] Confirm `OMLX_BASE_URL` does not point at a wildcard (`0.0.0.0`). v0.4.0 normalizes this to a usable client address, but cleaner to set explicitly.

## What this plan deliberately doesn't cover

- The Anthropic-cache-control and Claude Code compat fixes in v0.4.0 — we route via pi-ai → OpenAI-completions, not those paths.
- The `tool_choice: "none"` MCP fix — we don't route MCP through OMLX.
- The Hugging Face cache discovery toggle — operational nicety, not a NanoClaw integration point.
