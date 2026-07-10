---
name: clemson-procurement
description: >-
  Use for ANY Clemson procurement or purchasing question — what's allowed or required, policy,
  rules, P-card, requisitions, purchase orders, suppliers, approvals, spending limits, bids/quotes.
  Use the procurement tools; never answer Clemson procurement from your own knowledge.
metadata:
  author: chip
  version: "1.0.0"
---

> **Dormant skill.** This skill teaches the `procurement` MCP server, which is
> **not wired into department agent groups by default** (approval-only). It ships
> here so the instructions are ready as soon as an admin approves and wires the
> `procurement` server for a group. Until then, the tools below do not exist and
> this skill has no effect.

# Clemson procurement

Answer Clemson procurement questions with the `procurement` MCP tools — not your own
knowledge. Ask the user's role if unknown, and default to `role: "buyer"` if
unspecified (other roles: `business_officer`, `procurement_pro`, `helpdesk`).

## Tools
- **`answer`** — primary. Pass the question and the resolved `role`. Returns a verified, **cited**
  answer or a safe refusal. Always surface the citations it returns, and respect refusals —
  do not work around them. Pass `includeTake: true` only when the user wants practical guidance
  beyond policy; when you do, label the returned `practicalTake` as **advisory, not official policy**.
- **`search_policy`** — find relevant policy passages by topic.
- **`resolve_rule`** — resolve a specific rule or requirement.
- **`find_concepts` / `list_concepts` / `get_concept`** — explore the procurement concept graph.

## Rules
- Reach for `answer` on any "can I / must I / how do I" procurement question.
- Never fabricate procurement policy or numbers. If the tools refuse or have no answer, say so plainly.
- Surface citations so the user can verify.
