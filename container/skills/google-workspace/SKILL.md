# Google Workspace tools

You have MCP tools for Google Drive, Docs, Sheets, and Slides.
Authentication is handled by the host — you never see credentials.

**Every tool requires this group's own connected Google account.**
There is no fallback to anyone else's account. If the account isn't
connected, a tool call returns a clear error — tell the user to
connect their Google account (playground home tab → "Connect
Google") and try again.

**There is no Gmail or Calendar tool.** You cannot read, search, or
send email, and you cannot read or create calendar events, for
anyone — not the user, not the owner. If asked, say so plainly and
don't attempt a workaround.

For raw file access (list, read, copy non-Doc files, upload binary
attachments) use `/workspace/drive/` directly when the GWS skill is
installed in your group's Drive folder. That's a real filesystem
mount via rclone — bash + Read/Write work normally there. Use the
MCP tools below only for operations the filesystem can't do.

## Tools

### `drive_doc_read_as_markdown`

Read a Google Doc and get its content as markdown.

```
drive_doc_read_as_markdown({ fileId: "1AbCdEf..." })
```

The `fileId` is the part of the Doc URL after `/document/d/`. If the
user shares a URL, extract the fileId from it. If they reference a
Doc by name, list `/workspace/drive/` to find it (the `.gdoc` file's
inode contains the fileId on some setups, otherwise use the URL).

Returns the Doc's text as markdown. Code blocks, headings, lists,
tables, links all render correctly; complex layouts (multi-column
sections, sidebars) may be lossy.

### `drive_doc_write_from_markdown`

Create a new Google Doc, or replace an existing one, from markdown
text.

Create new:
```
drive_doc_write_from_markdown({ markdown: "# My doc\n\nHello…", title: "My doc" })
```

Update existing:
```
drive_doc_write_from_markdown({ markdown: "# Updated\n\n…", fileId: "1AbCdEf..." })
```

Returns `{ fileId, webViewLink, name }`. Send the `webViewLink` so
the user can open the Doc in their browser.

### `sheet_read_range`

Read a range from a Google Sheet in A1 notation.

```
sheet_read_range({ spreadsheet_id: "1AbCdEf...", range: "Sheet1!A1:C10" })
```

Returns a 2D array of string values.

### `sheet_write_range`

Write a 2D array of values into a Google Sheet range.

```
sheet_write_range({ spreadsheet_id: "1AbCdEf...", range: "A1:B2", values: [["a", "b"], ["c", "d"]] })
```

Defaults to `value_input_option: "USER_ENTERED"` so formulas
starting with `=` evaluate; pass `"RAW"` to store literal text.

### `slides_create_deck` / `slides_append_slide` / `slides_replace_text`

Create a new Slides presentation, append a slide to an existing one,
or find-and-replace text across every slide in a deck (useful for
templating with placeholders like `{{name}}`).

## Workflow examples

### "Summarize my project notes Doc"

1. Get the fileId — ask the user for the URL or look in `/workspace/drive/`.
2. `drive_doc_read_as_markdown({ fileId })` → get the markdown.
3. Summarize. Reply with the summary in chat.

### "Make a Google Doc out of these meeting notes"

1. Format the notes as markdown (headings, bullet lists).
2. `drive_doc_write_from_markdown({ markdown, title: "Meeting notes — 2026-05-06" })`.
3. Reply with the `webViewLink`.

### "Edit my Doc to add an action items section"

1. `drive_doc_read_as_markdown({ fileId })` → current content.
2. Append the new section to the markdown.
3. `drive_doc_write_from_markdown({ markdown, fileId })` (same fileId, replaces content).
4. Confirm done.

## What's NOT available — and never will be via this skill

- **Gmail** (search, read, send) — no tool exists. Don't attempt it.
- **Calendar** (list, create events, free/busy) — no tool exists. Don't attempt it.
- **Drive file listing/search** — use `ls /workspace/drive/` instead via bash.

If the user asks for Gmail or Calendar access, say plainly that
this deployment doesn't support it — there's no workaround, and
don't suggest routing around it through another account.
