---
name: clemson-curriculum
description: >-
  Use for Clemson GC curriculum content questions — what a specific course teaches, what skills
  or projects it includes, what assignments are used, where a topic or learning outcome is
  covered, and how courses relate to each other pedagogically. This is about course *content*,
  not degree rules or credit requirements (use gc-advisor for those).
metadata:
  version: "1.0.0"
---

# Clemson curriculum

Query the curriculum wiki (the `gc-wiki` tools).

## Tools
- **`search_wiki`** — search curriculum-wiki content by keyword.
- **`read_wiki`** — read a specific wiki page or entry.
- **`list_wiki`** — list available wiki pages / sections.
- **`prereq_chain`** — prerequisite dependency chain for a course.
- **`coverage_for_target`** — what covers a given target topic or outcome.

## Rules
- Use `prereq_chain` for "what do I need before X" / prerequisite questions.
- Use `coverage_for_target` for "where is X taught" / "what covers outcome Y".
- Ground answers in the wiki content and cite the page when useful. Don't invent curriculum.
