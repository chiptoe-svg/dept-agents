# A1 — Model Benchmark: MCP Tool-Use Reliability

**Date:** 2026-07-12. Real pi agent turns driven through the live department server against a scratch bench group re-pointed at each candidate free model. Headline metric: does the model invoke a relevant MCP tool AND ground its answer in that tool's result (vs. hallucinating). Each task runs in an isolated fresh agent session (container stopped between tasks).

## Matrix (systems × tasks)

| System | class-search | section-details | room-availability | curriculum | attach-max | strict-format |
|---|---|---|---|---|---|---|
| clemson-qwen36 | tool✓ ans✓ | tool✓ ans✓ | tool✓ ans✓ | tool✓ ans✓ | ✓ | ✓ |
| clemson-qwen3-30b | ERR | ERR | tool✓ ans✓ | ERR | ERR | ERR |
| clemson-glm51 | tool✓ ans✓ | tool✓ ans✓ | tool✓ ans✓ | tool✓ ans✓ | ✓ | ✓ |
| local-qwen36 | tool✓ ans✓ | tool✓ ans✓ | tool✓ ans✓ | tool✓ ans✓ | ✓ | ✓ |
| local-gemma4 | tool✓ ans✓ | tool✓ ans✓ | tool✓ ans✓ | tool✗ ans✗ | ✓ | ✓ |

## Per-system summary

| System | MCP reliability | Overall pass | Median latency | Errors |
|---|---|---|---|---|
| clemson-qwen36 | 4/4 (100%) | 6/6 | — | 0 |
| clemson-qwen3-30b | 1/4 (25%) | 1/6 | — | 5 |
| clemson-glm51 | 4/4 (100%) | 6/6 | — | 0 |
| local-qwen36 | 4/4 (100%) | 6/6 | — | 0 |
| local-gemma4 | 3/4 (75%) | 5/6 | — | 0 |

## Computed ranking (MCP reliability, then latency)

1. **clemson-qwen36** — 100% MCP reliability
2. **clemson-glm51** — 100% MCP reliability
3. **local-qwen36** — 100% MCP reliability
4. **local-gemma4** — 75% MCP reliability
5. **clemson-qwen3-30b** — 25% MCP reliability

## Recommendation

**Keep `qwen3.6-35b-a3b-fp8` (Clemson) as the free default.** It scored a clean 4/4 on MCP tool-use and 6/6 overall — every catalog/schedule/curriculum answer was tool-grounded and factually accurate (CRN 80763, Jordan Hall G33, the GC BS course sequence), and it followed the strict-format and CSV tasks. No change to the provisioned default is warranted.

**Fallback ordering (all free):**
1. **`qwen3.6-35b-a3b-fp8` (Clemson)** — current default; keep.
2. **`glm-5.1-fp8` (Clemson)** — also 6/6, equally reliable, different model family. Best *campus* backup: if the default is degraded, this is a drop-in swap with no reliability loss and useful family diversity.
3. **`Qwen3.6-35B-A3B-UD-MLX-4bit` (local MLX, on-box)** — also 6/6. Best **fully-private** option (never leaves the box). Exemplary tool behavior: when the Banner tool returned empty data it reported the gap and offered prior-term context rather than hallucinating. Recommend as the default for any faculty member who needs on-box privacy.
4. **`gemma-4-26B-A4B-it-QAT-MLX-4bit` (local MLX)** — 5/6. Solid private option, but it *hedged* on the open-ended curriculum question (asked which catalog year instead of just looking it up) — a mild reliability gap on ambiguous prompts.
5. **`qwen3-30b-a3b-instruct-fp8` (Clemson) — do NOT use as an interactive default.** 1/6: it stalled past the 180s cap on five of six tasks. Whatever its quality ceiling, its latency makes it unviable for interactive member use.

**Is the current free default good enough?** Yes — evidence-backed. And the department now has two equally-reliable free fallbacks (one campus, one fully-private on-box), so a single-provider outage is not a single point of failure.

## Caveats (read before over-interpreting)

- **The Banner class-schedule MCP tool (`cuassistant-public`) returns inconsistent results.** On identical Fall-2026 queries, some runs got real data (CRN 80763) and others got empty ("no sections published yet") — see `local-qwen36`'s class-search/section-details replies vs. the others. This is a **tool/backend reliability issue independent of the models** and affects every agent that uses it; worth investigating separately (it can make correct agents look wrong). A model was not penalized for faithfully reporting whatever the tool returned.
- **"answer-grounded" measures grounding in the tool's output (anti-hallucination), NOT factual correctness.** A model that calls the tool and faithfully relays an empty/flaky result passes. That is the right *hallucination* signal, but do not read a 100% as "never wrong" — read it as "used the tools and didn't invent answers."
- **Latency was not captured per-turn** (the SSE `latencyMs` field wasn't populated on this path; median shows "—"). The only latency signal here is the gross 180s-timeout failures, which is sufficient to disqualify `qwen3-30b` but not to finely rank the others by speed. A follow-up could add wall-clock timing if speed ranking matters.
- **Single run, one rep per task, 4 MCP + 2 general tasks** — a focused viability screen, not a statistical benchmark. The strong/weak separation is clear enough to decide on, but marginal differences (e.g. glm51 vs qwen36) should not be over-read.
- Methodology note: an earlier run inherited `owner_01`'s "Socratic tutor" persona, which confounded `glm-5.1`/`gemma-4` (they followed the persona and refused to answer). This report is the **neutral-persona** re-run; the confound is removed.

## Appendix — replies (spot-check)

### clemson-qwen36

- **class-search** (tool✓ ans✓): In Fall 2026 (202608), there is **one section** of GC 1010: | Section | CRN | Title | Seats Available | Instructor | |---------|-------|-------------------------------------|-----------------|-----------------| | 001 | 80763 | Orientation to Graphic Communications | 10/44 | Chip Tonkin | - **Meeting time:** Fridays 11:15 AM – 12:05 PM, Jordan Hall G33
- **section-details** (tool✓ ans✓): <message to="bench-clemson-qwen36-owner-01">GC 1010 (Orientation to Graphic Communications), section 001, meets: **When:** Fridays, 11:15 AM – 12:05 PM **Where:** Jordan Hall, Room G33 **Term:** Fall 2026 (Aug 19 – Dec 11) **Instructor:** Chip Tonkin There are 10 seats available (34/44 enrolled).
- **room-availability** (tool✓ ans✓): **Jordan Hall G33** on Fridays in **Fall 2026** is mostly free in the afternoon: | Time | Status | Courses | |------|--------|---------| | 12:05 – 1:25 PM | **Free** | — | | 1:25 – 2:15 PM | Busy | MICR 4050-001, MICR 4050-300, MICR 6050-001 | | 2:15 – 6:00 PM | **Free** | — | **Summary:** It's free 12:05–1:25 PM and again 2:15–6:00 PM on Fridays. Only the 1:25–2:15 PM slot has a block (three over
- **curriculum** (tool✓ ans✓): Here are the required courses for the **Graphic Communications, BS** (2026–2027 catalog), organized by term: --- **Core GC Courses:** | Term | Course | Credits | |------|--------|---------| | Freshman 1 | GC 1010, GC 1020, GC 1050 | 5 | | Freshman 2 | GC 1040 | 4 | | Sophomore 1 | GC 2070 | 4 | | Sophomore 2 | GC 2400, GC 3460 | 6 | | Sophomore Summer | GC 3500 | 1 | | Junior 1 | GC 3400, GC 4060 
- **attach-max** (✓): Alice
- **strict-format** (✓): {"answer": 42}

### clemson-qwen3-30b

- **class-search** (ERR): Error: SSE stream timed out after 180000ms
- **section-details** (ERR): Error: SSE stream timed out after 180000ms
- **room-availability** (tool✓ ans✓): Jordan Hall G33 is available Friday afternoon in Fall 2026. The room is free from 12:05 PM to 1:25 PM and again from 2:15 PM to 6:00 PM. There is a class from 1:25 PM to 2:15 PM, so the room is not available during that time.
- **curriculum** (ERR): Error: SSE stream timed out after 180000ms
- **attach-max** (ERR): Error: SSE stream timed out after 180000ms
- **strict-format** (ERR): Error: SSE stream timed out after 180000ms

### clemson-glm51

- **class-search** (tool✓ ans✓): There is **one section** of GC 1010 (Orientation to Graphic Communications) offered in Fall 2026: | Section | CRN | |---------|-----| | 001 | 80763 | It meets Fridays 11:15–12:05 in Jordan Hall G33, taught by Chip Tonkin. 1 credit hour; 10 seats remain (34 of 44 enrolled).
- **section-details** (tool✓ ans✓): **GC 1010 – Orientation to Graphic Communications**, Section 001 (Fall 2026) meets: - **Days:** Friday (F) - **Time:** 11:15 AM – 12:05 PM - **Building:** Jordan Hall - **Room:** G33 Instructor: Chip Tonkin. The section has 10 seats remaining (34 of 44 enrolled).
- **room-availability** (tool✓ ans✓): Jordan Hall G33 is **mostly free Friday afternoons** in Fall 2026. Here's the breakdown: **Occupied:** - 1:25 PM – 2:15 PM → MICR 4050 / MICR 6050 **Free:** - 12:05 PM – 1:25 PM (80 min) - 2:15 PM – 10:00 PM (7 hr 45 min) So the only conflict is that 50-minute MICR block at 1:25. Everything after 2:15 PM is wide open. (Note: this covers scheduled classes only — ad-hoc 25Live events aren't included
- **curriculum** (tool✓ ans✓): Here are the required courses for the **Graphic Communications, BS** major based on the **2026–2027 catalog** (120 total credits): --- ### Freshman / First Semester (15 cr) | Course | Credits | |---|---| | GC 1010 | 1 | | GC 1020 | 2 | | GC 1050 | 2 | | PSYC 2010 | 3 | | Approved Lab Science (CH 1010, CH 1050, PHYS 1220+1240, PHYS 2000, or PHYS 2070+2090) | 4 | | Specialty Area Requirement | 3 | #
- **attach-max** (✓): Alice
- **strict-format** (✓): {"answer": 42}

### local-qwen36

- **class-search** (tool✓ ans✓): There are **no sections of GC 1010 (or any GC course) currently listed for Fall 2026** in the Clemson Banner class schedule. The class schedule data for Fall 2026 hasn't been populated in the system yet — this is common since Fall schedules are typically finalized closer to the semester. I checked the available terms (Fall 2026 `202608`, Spring 2026 `202601`, Summer 2026 `202605`) and all return z
- **section-details** (tool✓ ans✓): The Fall 2026 schedule hasn't been published yet — Banner shows zero sections for GC in 202608. Here's what **GC 1010 section 001** looked like last semester for reference: - **CRN:** 80794 - **Title:** Orientation to Graphic Communications - **Instructor:** Chip Tonkin - **Days:** Fridays (F) - **Time:** 10:10 AM – 11:00 AM - **Location:** Watt Family Innovation Center, Room 108 - **Term:** Aug 2
- **room-availability** (tool✓ ans✓): **Jordan G33 is mostly free Friday afternoon** in Fall 2026, with one conflict: **Busy:** - 1:25–2:15 PM — MICR4050 / MICR6050 **Free:** - 12:05–1:25 PM *(80 min)* - 2:15–5:00 PM *(165 min)* The afternoon is wide open after 2:15 PM.
- **curriculum** (tool✓ ans✓): Here are the **required courses** for the **Graphic Communications, BS** (per the 2026–2027 catalog, 120 credits total): --- ### Core GC Courses (fixed) | Course | Credits | When | |---|---|---| | GC 1010 | 1 | Freshman, Sem 1 | | GC 1020 | 2 | Freshman, Sem 1 | | GC 1040 | 4 | Freshman, Sem 2 | | GC 1050 | 2 | Freshman, Sem 1 | | GC 2070 | 4 | Sophomore, Sem 1 | | GC 2400 | 3 | Sophomore, Sem 2 |
- **attach-max** (✓): Alice
- **strict-format** (✓): {"answer": 42}

### local-gemma4

- **class-search** (tool✓ ans✓): The following section of GC 1010 is offered in Fall 2026: * **Section:** 001 (CRN: 80763)
- **section-details** (tool✓ ans✓): GC 1010 section 001 (Orientation to Graphic Communications) meets on **Fridays** from **11:15 AM to 12:05 PM** in **Jordan Hall, Room G33** during the Fall 2026 semester.
- **room-availability** (tool✓ ans✓): Jordan Hall G33 is partially occupied on Friday afternoons during the Fall 2026 term. Based on the current schedule, there is a busy block from **3:35 PM to 4:50 PM** (BIOL 4200 and BIOL 6200). It is **free after 4:50 PM**. Please note that this information is based on the daily snapshot of scheduled classes and does not include ad-hoc 25Live events.
- **curriculum** (tool✗ ans✗): To provide you with the exact required courses, I need to know which **catalog year** you are referring to (e.g., 2024-2025, 2025-2026, etc.), as requirements can change between years. If you're unsure, I can look up the most recent catalog year for the Graphic Communications, BS program. Would you like me to do that?
- **attach-max** (✓): Alice
- **strict-format** (✓): {"answer": 42}

