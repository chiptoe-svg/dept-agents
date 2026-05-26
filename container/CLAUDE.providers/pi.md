<!-- Composed at spawn — applied when the agent's container.json provider is "pi". -->

## Pi harness notes

You're running on the Pi harness (`pi-agent-core`). The harness gives you a clean tool surface; the universal CLAUDE.md base covers anti-fabrication and other behaviors all agents need. The guidance below fills harness-level gaps specific to Pi.

### One delivery channel per reply

You have the in-container `send_message` and `add_reaction` MCP tools, plus the channel's own delivery via your turn's text response. Pick ONE — don't both emit text AND call `send_message`, and don't fire `add_reaction` as a substitute for an actual reply. The reaction's payload appears in the channel as a reaction (correct) but DOES NOT belong in your text response. Don't include the reaction's JSON in what you write back to the user.

### File operations

You have dedicated file tools through both the coding-agent (`read`, `write`, `edit`, `grep`, `ls`, `find`) and the in-container MCP server (`file_read`, `file_write`, `file_edit`, `file_glob`, `file_grep`). Prefer the coding-agent tools (`read` / `write` / `edit` / etc.) — they're integrated into your turn loop and produce cleaner output. The `file_*` MCP variants exist for parity with Codex; use them only when you specifically need their behavior.

### Inbound images — just `read` the attached file

When a user sends an image (e.g., from Telegram), the host stages the bytes in `/workspace/attachments/<file>.jpg` and the formatter shows you a marker like:

```
[image: <name> — saved to /workspace/attachments/<name>]
```

To act on the image, just call `read` on that path. The `read` tool detects image content via magic bytes, base64-encodes the file, and emits it as a multimodal content block — the model sees the actual picture, not the file path. Verified end-to-end: gpt-5.4 produces accurate vision responses (captions, OCR, descriptions) from this path with no extra plumbing needed.

This is pi-ai's native multimodal support — works for `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`. Audio attachments are different: voice messages are transcribed on the host (whisper.cpp) and the transcript is injected into the prompt directly as `[transcript] ...`, so you don't need a tool call to "hear" them.

### Inbound voice — transcript is in the prompt

For audio attachments, the host runs `whisper-cli` and injects the result alongside the file marker:

```
[audio: <name> — saved to /workspace/attachments/<name>]
[transcript] <what the user said>
```

Respond to the transcript text as if it were a normal message. The audio file path is there for archive / re-listening if the agent ever gains audio-input support, but for now don't `read` it (binary audio bytes aren't useful as text). If a transcript is missing (e.g., whisper not installed on this install), you'll see only the file marker — say so and ask the user to send text.
