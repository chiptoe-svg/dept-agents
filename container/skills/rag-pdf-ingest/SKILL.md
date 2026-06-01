# RAG PDF Ingest

Convert a complex PDF into structured markdown via a dedicated remote RAG
ingestion service. Use when `pdf-reader` returns low-quality text (image-heavy
PDFs, scanned pages, multi-column layouts with figures and tables) or when the
user wants a clean markdown rendering of the original document.

## Usage

```bash
/app/skills/rag-pdf-ingest/rag-ingest <pdf-path>
```

The script POSTs the PDF to the configured RAG ingestion endpoint and writes
the returned markdown to `/workspace/agent/<basename>.md`. It prints the
output path on stdout — read that path with the `Read` tool to analyze, or
hand it back to the user with `send_file path=<path>`.

## Configuration

Two environment variables, set per agent group via `ncl groups update
<group-id> --env`:

- `RAG_INGEST_URL` — base URL of the ingestion service (no trailing slash).
  The script POSTs to `${RAG_INGEST_URL}/ingest`.
- `RAG_INGEST_TOKEN` — bearer token for `Authorization: Bearer …`. Omit the
  flag if the endpoint is unauthenticated.

If either variable is unset the script exits non-zero with a message
identifying the missing variable.

## When to use

- The PDF contains charts, diagrams, or figures the user expects to reason
  about. `pdf-reader` strips images; this service keeps structural context.
- `pdf-reader extract` returned mostly empty text (scanned/image-based PDF).
- The user explicitly asks for a markdown version of the PDF, not just an
  analysis.

## When NOT to use

- Plain text-based PDFs where `pdf-reader extract` works — that's local,
  faster, and free.
- PDFs larger than 20 MB — split first or use a different workflow.

## Examples

```bash
# Convert a resume the user attached
/app/skills/rag-pdf-ingest/rag-ingest /workspace/agent/attachments/resume.pdf
# → prints /workspace/agent/resume.md

# Convert and send back to the user as a downloadable file
out=$(/app/skills/rag-pdf-ingest/rag-ingest "$PDF")
# then: send_file path="$out"
```
