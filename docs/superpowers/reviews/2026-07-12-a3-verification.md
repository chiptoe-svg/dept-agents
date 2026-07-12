# A3 File-Centric Member Chat — live verification

**Date:** 2026-07-12. A3 plan, Task 4. Executed live on the running department server (`com.nanoclaw-v2-581fefa4`, playground at `http://gcworkflow.clemson.edu:8088`, local bind `127.0.0.1:3002`).

## Result: PASS — members get a real file-capable chat; attach → agent-reads and produce → download both work on the free Clemson default.

Rebuilt + restarted, provisioned a throwaway member `playground:a3_canary` (group `ag-1783863065950-r7zar0`).

## 1. Member tab set + wiring

- `GET /api/me/agent` → `{user:{id:"playground:a3_canary",role:"member",displayName:"A3 Canary"}, agent:{folder:"a3_canary", modelProvider:"clemson"}}`.
- Served `tab-gating.js` → `MEMBER_TABS = ['home', 'chat', 'persona', 'skills']` (`simple` dropped, `chat` added).
- Served `app.js` → `mounters.chat` is role-based (`chat: (tabEl) => …`) and imports `mountMemberChat`.
- Served `member-chat.js` carries the "Running on", "Clemson campus model", "Send", size-exceed note, and the "share via Google or attach a PDF export" slides hint.
- Live browser (Playwright, member session): nav shows **Home / Chat / Persona / Skills**; the Chat tab renders the "Running on: Clemson campus model (free)" indicator, the conversation, an inline **📎 greeting.txt** download card, and the attach (📎) + compose + Send bar with the slides hint.

## 2. Blocked file type is rejected server-side

`POST /messages` with `evil.exe` → `{ok:true, attachmentErrors:["file[0]: blocked file type (evil.exe)"]}`, and **no `evil.exe` was written** to `groups/a3_canary/attachments/`. The allowlist is the gate.

## 3. Attach a typical file → the agent reads it (the headline)

Attached `scores.csv` (`name,score / Alice,91 / Bob,77`) with the prompt "read the attached CSV and tell me who has the higher score." The file saved to `attachments/scores.csv`, and the agent replied:

```
provider=clemson  model=qwen3.6-35b-a3b-fp8
"Alice has the higher score (91 vs 77). DONE."
```

Correct answer, on the free campus default, from an attached document — the generalized attach path + `[File: …]` marker works end-to-end, and an open Clemson model read a CSV and reasoned over it.

## 4. Receive a file

Asked the agent to "create a file named greeting.txt containing 'hello from your agent' and send it." The agent's message carried the produced file; the reconstructed download URL `GET /api/drafts/a3_canary/files/msg-1783863140440-luldk5/greeting.txt` returned exactly `hello from your agent`, and the chat rendered it as a 📎 download card.

## Standing state

- Members now land on the new lean chat (`member-chat.js`); the owner Chat tab (`chat.js`) is unchanged.
- Attach accepts the typical-files allowlist (docs/sheets/slides/images/data, 25 MB); executables are rejected. No document *conversion* in A3 — PDFs read via the `pdf-reader` skill (`pdftotext`), images inline, Office files land raw; rich doc intelligence (docling text + the picture-description/DGX-vision workflow) is a later phase as installable skills.
- The `a3_canary` throwaway identity was fully removed after verification (token revoked, group + fs deleted, container stopped). Remaining groups: `owner_01` + the provisioning template.
