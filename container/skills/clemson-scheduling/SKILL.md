---
name: clemson-scheduling
description: >-
  Use for Clemson class schedules and instructor scheduling — finding course sections, what an
  instructor is teaching, section details (time/seats/location), room availability, and academic
  terms. Use these tools, not your own knowledge.
metadata:
  version: "1.0.0"
---

# Clemson class & instructor scheduling

Read-only lookups against Clemson's class schedule (the `cuassistant-public` tools).

## Tools
- **`list-clemson-terms`** — valid terms (e.g. Fall 2026). Use first when a term is needed and unknown.
- **`search-clemson-classes`** — find sections by subject / course / keywords (+ term).
- **`find-clemson-instructor-classes`** — what a given instructor is teaching.
- **`get-clemson-section-details`** — full detail for a section (time, seats, location, instructor).
- **`get-clemson-room-availability`** — when / whether a room is free.

## Rules
- These are read-only data lookups — no writes.
- Present results clearly: course/section, instructor, days/time, room, seats.
- If the term is ambiguous, confirm it (or resolve the current/most relevant via `list-clemson-terms`).
