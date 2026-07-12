# A3 — File-Centric Member Chat — Design

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-07-12.

## Where this sits (program context)

Third and final part of the department member-experience program. **A2 (onboarding) shipped; this is A3.** A1 (model benchmark + local/DGX) is separate and later.

- **A1 · Model foundation (later).** Benchmark agent-capable models across Clemson / local MLX / DGX Spark.
- **A2 · Onboarding (shipped).** Member Home dashboard; free Clemson default; connecting ChatGPT switches the agent onto it.
- **A3 · File-centric member chat (THIS SPEC).** A clean, purpose-built member chat focused on agent communication with first-class arbitrary-file attach and receive, replacing the reused `simple` tab.

## Goal

Give members a real chat: an inline, ChatGPT-style conversation with their agent where attaching files (any type) and receiving agent-produced files are first-class and effortless. The member currently has no file-capable chat — `simple.js` is the persona/model "My Agent" surface with no attach/receive. A3 fills that gap with a new lean component that reuses the existing send/stream/download plumbing.

## Decisions (settled in brainstorming)

- **Arbitrary file types** — members can attach and receive any file type (up to a size cap), passed through to the agent's workspace.
- **Inline layout** — files live in the message stream (attach chips in the composer; agent-produced files as inline download cards). No files sidebar/gallery.
- **New lean component** — a purpose-built member chat, NOT the reused `simple` tab and NOT the 1752-line owner `chat.js`. It reuses the same endpoints and reads `chat.js` for the SSE/attach/file-render patterns, but presents a clean minimal UI.
- **No in-chat model picker** — the chat runs on whatever the member's Home/connect choice set (free Clemson default, or their ChatGPT once connected). A small "Running on: …" indicator only.

## Tab structure change

Today (after A2): `MEMBER_TABS = ['home', 'simple', 'persona', 'skills']`, where `simple` is the member's chat.

After A3: **`MEMBER_TABS = ['home', 'chat', 'persona', 'skills']`**, landing on `home`. The `chat` tab mounts a **new `tabs/member-chat.js`** for members and the existing `chat.js` for owners/TAs — a role-based mount, exactly like `home` → `member-home.js` (member) vs `home.js` (owner), wired in `app.js`'s `mounters.chat`. The `simple` tab drops out of the member set (its inline persona/skills editing is already covered by the dedicated Persona/Skills tabs; its chat is superseded). Owner/TA tab set is unchanged; `chat.js` and `simple.js` are not modified.

## The chat UI (inline, clean)

New component `src/channels/playground/public/tabs/member-chat.js`:

1. **Message stream** — user and agent messages in order; agent replies markdown-rendered; **SSE streaming** of live agent output via the existing `GET /api/drafts/<folder>/stream`; conversation history on load from `GET /api/drafts/<folder>/recent`.
2. **Composer** — text input + **attach button (📎)** + Send. Selected files show as removable **chips** above the input. Accepts **any** file type (the `<input type="file">` has no `accept` restriction). Enter sends; Shift+Enter newlines.
3. **Received files** — agent-produced files render as inline **download cards** inside the agent's message, linking to the existing `GET /api/drafts/<folder>/files/<messageId>/<filename>` route (URL reconstructed from `content.files` + message id, the same way `chat.js` does).
4. **Model indicator** — a small "Running on: Clemson campus model (free)" / "Your ChatGPT" line, from `/api/me/agent`'s `agent.modelProvider` (added in A2). No switching.
5. **Empty state** — a friendly prompt when there's no history.

Folder is the member's own `window.__pg.agent.folder`.

## Backend — arbitrary-file attach (the one real backend change)

`POST /api/drafts/:folder/messages` (`src/channels/playground/api-routes.ts`) today processes attachments in a per-file loop: `image/*` → `processImage` → inline `content.images[]` with a `containerPath`; `application/pdf` → save to `groups/<folder>/attachments/<safeName>` + push a `[PDF: attachments/<safeName>]` text marker; everything else is currently ignored.

**Change:** replace the PDF-only branch with a **general non-image branch** — any non-image file is saved to `groups/<folder>/attachments/<safeName>` (same `isSafeAttachmentName` sanitization + safe-fallback-name logic already used for PDFs) and referenced by a `[File: attachments/<safeName>]` text marker (PDFs may keep `[PDF: …]` or unify to `[File: …]` — a plan detail). Images keep their existing inline/vision path unchanged. The existing 25 MB total-size cap and per-file error collection are preserved.

**Why this is enough:** the agent group folder mounts at `/workspace/agent`, so `attachments/<name>` is readable by the agent at `/workspace/agent/attachments/<name>`; the marker is plain text the agent reads with its file tools (exactly how `[PDF: …]` already works). **No container / agent-runner change.** The receive/download side already serves any type (`contentTypeFor` falls back to `application/octet-stream`).

## Isolation & safety

- **Attach** writes only to the member's **own** group folder — `POST /messages` is `requireGroupAccess`-gated by folder; **download** is `canReadDraft`-gated. A member uploading arbitrary files into their *own* agent's workspace is not a cross-tenant surface.
- **Filename sanitization** (`isSafeAttachmentName`, strip to a safe single segment, fall back to a generated name) prevents path traversal; the **25 MB cap** guards against DoS. These are the existing guards, now applied to all file types.

## Data flow

- **Send:** composer → `POST /api/drafts/<folder>/messages` `{ text, files: [{ name, mimeType, base64 }] }` → `{ messageId }`. (base64-encode files client-side, same as `chat.js`.)
- **Receive/stream:** `GET /api/drafts/<folder>/stream` (SSE) for live agent output including produced-file references; `GET /api/drafts/<folder>/recent` for history on mount.
- **Model indicator:** `GET /api/me/agent` → `agent.modelProvider` → label.

## Error handling

- Per-file attach errors are collected and surfaced (a file that fails doesn't kill the send) — existing behavior, preserved.
- Oversize (>25 MB total) → the send is accepted with the offending files reported, per existing behavior.
- SSE disconnect → reconnect/poll fallback (mirror `chat.js`'s handling).
- Send failure → surfaced in the composer; the message isn't lost silently.

## Testing

- **Backend (vitest):** the generalized attach handler — an arbitrary file (`.csv`/`.docx`/`.zip`) is saved to `attachments/` with a `[File: attachments/<name>]` marker; an image still takes the inline path; an oversize batch is rejected/reported; a path-traversal filename (`../../etc/x`) is sanitized to a safe name.
- **Frontend (happy-dom):** pure render pieces of `member-chat.js` — the message stream renders user/agent turns, attach chips add/remove, a message with `content.files` renders download cards, the model indicator reflects `modelProvider`.
- **Tab gating:** `MEMBER_TABS === ['home','chat','persona','skills']`; the member `chat` tab mounts `member-chat.js` (owner still gets `chat.js`).
- **Live:** a member sends a `.csv` → the agent reads it and responds; the agent produces a file → the member downloads it; streaming renders incrementally.

## Out of scope

- Owner `chat.js` and `simple.js` — unchanged.
- Files sidebar/gallery (inline only), in-chat model picker.
- A1 (model benchmark), the `class`-vocabulary sweep, live Google connect.
- Raising the 25 MB cap — kept as-is for the pilot (revisit if document workflows need more).

## Open items to confirm during planning

- The exact SSE event shape emitted by `GET /api/drafts/<folder>/stream` (event names + message/file payload), so `member-chat.js` consumes it correctly — read the current stream handler + how `chat.js` consumes it.
- Whether PDFs keep their `[PDF: …]` marker or unify under `[File: …]` (either works; agent reads both as text).
- Confirm `content.files` shape on stored/streamed messages for reconstructing download URLs (mirror `chat.js` lines ~320-330).
