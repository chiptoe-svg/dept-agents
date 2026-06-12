# Mode-split transcripts (Chat tab + My Agent tab)

**Goal:** Agent-mode and direct-mode (model-only) conversations no longer interleave in one
transcript. Each mode shows only its own messages and traces; switching modes swaps which
transcript is visible. History is preserved across switches (filtered, not destroyed).

**Approved approach (user picked A):** tag + CSS filter inside chat.js. No second chat
instance. Applies to BOTH the advanced Chat tab and the embedded simple ("My Agent") tab —
they share chat.js, and the simple tab's Use-agent toggle already drives the hidden
#mode-agent / #mode-direct buttons. Both the chat log AND the trace panel filter.

## Design

- **Source tagging (`from-direct` class):** any entry created by direct mode gets the class;
  agent-mode entries stay untagged (everything from SSE / /recent backfill is agent-mode by
  definition). Tag at the SOURCE, not by current view — a late agent SSE reply arriving while
  the user sits in direct view must stay agent-tagged.
  - user bubble: `appendUserBubble` gains a `direct` flag, set from `currentMode` at submit.
  - direct reply: `appendDirectReply` adds `from-direct` to its className.
  - system notes / chat notes created in direct-mode code paths: optional `direct` flag on
    `appendSystemNote` / `appendChatNote`.
  - trace: `startNewTurn(trace, direct)` adds `from-direct` to the `.trace-turn` container —
    a turn belongs wholly to the mode that started it.
- **View switching:** `setMode` toggles `direct-view` on `#chat-log` and `#trace-log`
  (node references captured at wiring time — survive the simple tab's trace re-parent),
  then scrolls both to bottom because visible content changed.
- **CSS (style.css, chat section):**
  - `.chat-log.direct-view > li:not(.from-direct)` → hidden
  - `.chat-log:not(.direct-view) > li.from-direct` → hidden
  - `.trace-log.direct-view > li:not(.from-direct):not(.trace-empty)` → hidden
    (keep the empty-state placeholder visible in both views)
  - `.trace-log:not(.direct-view) > li.from-direct` → hidden
- **Known edge (accepted):** agent trace events that arrive via SSE while a direct turn is
  the current turn land inside that direct turn (pre-existing interleave behavior) and will
  be hidden in agent view. Rare; not worth routing logic.

## Steps

- [x] Plan file (this).
- [ ] chat.js: tagging + setMode view classes.
- [ ] style.css: the four filter rules.
- [ ] Verify live (Playwright): send agent msg → toggle direct → agent msgs hidden, direct
  visible; send direct msg → toggle back → only agent msgs; trace turns filter the same way.
  Verify in BOTH the Chat tab (owner seat) and My Agent tab (student seat).
- [ ] `pnpm vitest run src/channels/playground` (312) + `pnpm run build` clean.
- [ ] Commit.
