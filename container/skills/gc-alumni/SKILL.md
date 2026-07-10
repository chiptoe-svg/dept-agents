---
name: gc-alumni
description: >-
  Use for questions about Clemson Graphic Communications alumni outcomes — where
  graduates work now, first-job placement, career trajectories, AI exposure of
  GC occupations, industry/occupation distribution, grad-school rates, and
  outcome trends by graduation cohort. Data comes from the gc-alumni MCP server
  (read-only SQLite). For degree rules or course content use gc-advisor or
  clemson-curriculum instead.
metadata:
  version: "1.0.0"
---

# GC Alumni Outcomes

Query the Clemson GC alumni database via the `gc-alumni` MCP server (read-only).
Never answer from memory — pull from the DB.

## Tools

| Tool | Use for |
|---|---|
| `search_alumni` | Look up a specific graduate by name → grad year, first job, current job, AI trajectory |
| `get_alumni_photo` | Return a graduate's LinkedIn profile photo — see **Photos** below |
| `outcomes_by_year` | Post-grad outcome mix (employed / grad school / seeking) and first-job AI exposure by cohort |
| `occupation_distribution` | First-job SOC occupations ranked by count, with AI exposure score and BLS trajectory |
| `industry_distribution` | First-job NAICS industries ranked by count |
| `review_inbox` | Quick count: open student requests + flagged records awaiting admin attention |
| `pending_requests` | Full list of open student bug/feature/data requests with AI triage (category, summary, severity, effort) |
| `query` | Any ad-hoc read-only SQL (SELECT / WITH only); results capped at 200 rows by default |
| `get_schema` | Inspect a table's CREATE SQL before writing a query (`table=""` returns all) |
| `list_tables` | See all available tables and views |

## Key tables and views

**Start here for most questions:**
- `v_alumni` — denormalized view: person + current job + first job with AI exposure and trajectory. Best for browsing or filtering alumni.
- `v_ai_quadrant` — trajectory label per SOC occupation: *Opportunity*, *Adapt*, *Extinction risk*, *Resilient*, *Stable*, or *Declining*.

**Core tables:**
- `person` — one row per graduate: `grad_year`, `grad_term`, `post_grad_outcome` (`employed` | `grad_school` | `seeking` | `unknown`), `current_company`, `current_title`, `current_location`, `went_to_grad_school`
- `position` — full job history: `is_first_job`, `is_current`, `soc_code`, `naics_code`, `ai_impact` (1–10), `future_difficulty` (1–10)
- `ai_exposure` — per SOC code: `exposure_score` (0–10, higher = more AI-exposed), `outlook` (BLS OOH growth text), `median_pay`
- `education` — `is_graduate=1` flags post-bachelor degrees (Master's, PhD, MBA)
- `market_segment` — sector label on each person (Print & Packaging, Agency, CPG, …)

**Useful joins:**
```sql
-- Alumni with first job and AI exposure
SELECT full_name, grad_year, first_job_title, first_job_company,
       first_job_ai_exposure, first_job_ai_trajectory, current_title, current_company
FROM v_alumni
WHERE grad_year BETWEEN 2020 AND 2024
ORDER BY grad_year, full_name;

-- Occupations by AI risk
SELECT occupation, exposure_score, outlook, trajectory
FROM v_ai_quadrant
ORDER BY exposure_score DESC;
```

## Photos

`get_alumni_photo` returns two things: an inline image (you see it visually) and a text block with a `photo_url` and `filename`. Use those to deliver the photo:

1. Call `get_alumni_photo(who)` — note the `photo_url` and `filename` from the text response.
2. Call `fetch_url_to_workspace(url, filename)` — downloads and saves the photo to `/workspace/agent/`.
3. Call `send_file(path=filename, text="Here's [name]'s photo")` — delivers it to the user.

Do NOT say "I've sent you the photo" until after `send_file` succeeds.

## Rules

- **`search_alumni` first** for name lookups — it's faster and avoids SQL for simple queries.
- **`outcomes_by_year` / `occupation_distribution` / `industry_distribution` first** for aggregate/trend questions before writing a custom query.
- **`get_schema` before complex queries** — confirm column names, especially for `position` (many flags) and `v_alumni` (rich join).
- The `query` tool is SELECT/WITH only; writes are blocked at the DB level.
- `post_grad_outcome` on `person` is normalized (`employed` | `grad_school` | `seeking` | `unknown`). The raw `status` column holds the original text from the grad-seniors survey.
- `is_first_job=1` on `position` marks the first post-graduation job; `is_current=1` marks the current role. A person can have multiple positions — filter by flag, don't assume one row per person.
- AI exposure scores come from the Karpathy/ONET OOH→SOC crosswalk; `v_ai_quadrant` combines exposure + BLS growth outlook into the trajectory label.
- Default `limit` for `query` is 200 rows. Pass a higher value if aggregates might be truncated.
