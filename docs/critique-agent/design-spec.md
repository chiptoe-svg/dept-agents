# Build-Your-Own Photo-Critique Agent — Design Spec

**Date:** 2026-06-06
**Author:** Course design draft
**For:** an upper-level photography course
**Status:** Draft for review

---

## 1. Context

An upper-level photography course is adding an AI-forward strand that pairs manual photography with
AI-assisted critique. Two source assignments drive this work:

- **`03a Take Your Best Shot.md`** — Assignment 3. Manual photojournalism on a
  randomly-drawn campus building: shoot 50, cull to 10 in Lightroom Classic,
  critique with an agent, reshoot the top 4. Currently has gaps: a
  `"DIRECTIONS HERE"` placeholder for the agent step, missing JPG export
  settings, and no agent definition.
- **`05_Reshoot Plan.md`** — Assignment 5 (studio reshoot). Students upload
  **inspiration photos** and want an agent to help **reverse-engineer** the gear
  and lighting setup to achieve that look. Currently points only to Adobe
  Firefly for image generation; no setup-planning agent exists.

The vehicle is **NanoClaw** (this classroom fork,
`nanoclaw_gccourse`): a container-isolated, multi-role classroom
agent platform. Each student gets their own agent group with an **editable
persona**, edited through the **Agent Playground** (a five-tab web workbench:
Home, Chat, Persona, Skills, Models). The classroom skill already provides a
**role-layered persona model** and an instructor-controlled shared file that
propagates to every student.

## 2. Goal

Give the instructor a teaching package in which **students build and control their own
photo-critique agent** (not just consume a finished one), use it to critique
their own field photos, and learn core agent concepts (persona, skills,
chatbot-vs-agent) along the way — all inside a single week (2 labs) in week 2 of
the semester.

A second, sibling agent (studio lighting reverse-engineer for Assignment 5) is
sketched here and specced in full later.

## 3. Pedagogical foundation (from the NanoClaw vision)

The platform's stated philosophy is **learning-by-contrast**: *"the difference
between asking a chatbot and running an agent is visible, not abstract."*
Students learn by adjusting one layer and watching behavior (and the trace)
change. Three customization layers are surfaced side by side:

- **Persona** — instructions that shape behavior (the thing students author).
- **Skills** — capabilities toggled on/off; *"students don't install them
  directly but see their effects immediately."*
- (Sources/Retrieval/Models exist but are **out of scope** for week 2.)

This design leans entirely on that philosophy: the student's deliverable is an
**agent they authored**, and the learning comes from the build → test → iterate
loop plus a light skills toggle-and-observe moment.

## 4. Scope

**In scope (build now):** the shared foundation + **Assignment 3 / Critique-Bot**
in full.

**Sibling (spec + build next):** Assignment 5 / Lighting Reverse-Engineer —
reuses the same scaffold pattern; sketched in §12.

**Platform capability (separate workstream):** **instructor-owned improvement**
(§14) — the instructor owns the instance and evolves it via **Claude Code/Codex + git Pull
Requests** (a chat-driven bridge is an optional later add-on). Small, independent
setup; does not block Assignment 3.

**Out of scope (YAGNI):** see §15.

## 5. Architecture — three persona layers per student

Maps onto NanoClaw's existing role-layered model (`global → role → per-agent`):

1. **Instructor-locked floor** — `data/class-shared-students.md` (the instructor edits
   once; symlinked into every student folder; propagates automatically). Holds
   the **non-negotiables**:
   - Socratic stance: ask the question that leads the student to the fix; do not
     hand them the f-stop.
   - Critique tone/safety floor (constructive, specific, never demeaning).
   - **Photojournalism ethics rule** (from the MD): critique honors that the
     scene was not manipulated and cannot be edited in post.
   - Required **submission output format** (see §11).
   - Scope guardrails: this agent critiques the student's 10 photos; it does not
     generate or edit images.

   A weak student-built persona still inherits this floor, which de-risks the
   "build from scaffold" choice.

2. **Student-built persona** — their own agent group's persona, edited in the
   Playground **Persona tab**. *This is the artifact they build.* Starts as a
   **scaffold** (§6) filled in via a **worksheet** (§7).

3. **Assignment handouts** (§11) — the finished student-facing docs that wrap
   the experience.

**Runtime + portability:** Primary runtime is the NanoClaw classroom +
Playground. Every artifact is plain markdown, so if the stack is not deployed,
the scaffold + worksheet work verbatim as a "build your own Claude Project"
exercise. No rework either way — this de-risks the still-open deployment
decision (§13).

## 6. Component A — Critique-Bot persona scaffold

A persona markdown file with NanoClaw frontmatter and **guided `TODO` blocks**.
The build is *writing*, not coding — appropriate for art students and matching
the Playground's persona-only edit surface. Seven slots:

1. **Identity** — agent name, emoji, one-line "vibe," 1–2 sentences of
   personality. (Their agent, their voice.)
2. **Critique stance** — within the locked floor, dial tone (gentle ↔ blunt) and
   how far to push Socratically before offering a nudge.
3. **Opening move** — how it greets, and the required **"technical or creative
   critique first?"** fork (from the MD).
4. **Dimensions it weights** — choose and **define in their own words** which
   elements matter (composition, focus/DoF, exposure & light, framing,
   moment/storytelling, background control) and **rank** them. Ranking forces a
   point of view.
5. **Question bank (centerpiece)** — for each chosen dimension, write **2–3
   Socratic questions** (e.g., *"What did you want the viewer to feel here?"* —
   not *"lower your f-stop"*). This is where students internalize
   critique-as-inquiry.
6. **Reshoot coaching** — how it helps the student decide which photos to
   reshoot and offers the **concise feedback chart** (from the MD).
7. **Handoff** — how it produces the end-of-session **submission block** the
   student saves (low-tech export, §11).

## 7. Component B — Decision worksheet

A student worksheet that mirrors the seven slots with reflective prompts that
**produce the content** for each. Examples:

- *"Recall the best critique you ever received. Was it a statement or a question?
  Write the question version."* → feeds the question bank.
- *"Rank these six elements for the kind of photographer you want to be. Why is
  your #1 first?"* → feeds dimensions.
- *"In one sentence, what's your agent's personality? Encouraging coach? Blunt
  editor?"* → feeds identity + stance.

Flow: **fill worksheet → paste into scaffold (Persona tab) → test on practice
photos (Chat tab) → iterate.** The iteration loop is the learning.

## 8. Component C — Instructor-locked floor file

Concrete content for `data/class-shared-students.md` (the four non-negotiables
in §5.1), written so the instructor can adjust tone/strictness in one place and have it
propagate to all students.

## 9. Component D — Instructor materials

- **Exemplar "strong" persona** — a fully-built reference Critique-Bot. Serves as
  the instructor's north star and grading-calibration key. Released to students *after*
  the build (or instructor-only) to avoid copying.
- **Instructor setup guide** — provision via `add-classroom`; place scaffold +
  worksheet in student folders; set the locked floor file; pre-install the
  toggle-and-observe skill(s) (§10); plus the **standalone fallback** (same files
  as a Claude Project) for the not-yet-decided deployment.
- **Rubric** — grades both (a) the *agent they built* (clear dimensions,
  genuine Socratic questions, evidence of iteration) and (b) the *photography
  deliverables* (shot list, contact sheets, reshoots, reflection).

## 10. Component E — Skills toggle-and-observe module

Skills are **not authored** by students. Instead:

- The instructor pre-installs 1–2 relevant skills at the class level (e.g., **web
  search**, so the critique agent can pull a reference photographer or example
  image).
- Students use the **Skills tab** to flip a skill **on/off** and observe the
  **trace** and how the critique changes — making the chatbot-vs-agent
  distinction concrete (per the vision).
- A short handout step frames the observation ("Turn the skill off and ask the
  same question. What changed in the answer and in the trace?").

**Implementation check (open):** confirm the classroom "persona-only edits"
lockdown still permits students to **toggle** instructor-installed skills. If it
blocks the Skills tab entirely, a small lockdown-config tweak is needed
(allow toggling instructor-installed skills; keep skill-file editing locked).

## 11. Component F — Assignment handout rewrite (`03a`) + low-tech export

Finish `03a Take Your Best Shot.md`:

- Replace the `"DIRECTIONS HERE"` block with **build-and-run-your-agent** steps.
- Weave in the **Lab A / Lab B** rhythm:
  - **Lab A:** draw building → intro the Playground → build & test your critique
    agent on practice shots → write shot list. *(Shoot the 50 between labs.)*
  - **Lab B:** import + cull to 10 in Lightroom → run your agent on the 10 →
    produce feedback chart + submission block → plan the 4 reshoots. *(Reshoot
    after.)*
- Add the **Skills toggle-and-observe** step (§10).
- Keep the existing reflection-questionnaire link and the bundled-PDF submission
  list.

**Low-tech export (no skill built):** the agent ends the session by emitting a
clean, printable **submission block** in the Chat transcript:

- Per photo: dimension critiqued, the distilled Socratic exchange, reshoot
  (yes/no).
- The **concise feedback chart** for the reshoot candidates.

The student pastes this into their PDF bundle alongside the Lightroom contact
sheets. No NanoClaw skill is built for this (deferred — see §15; the instructor can add it
later via Claude Code + a PR, §14).

⚠️ **Gap only the instructor can fill:** the MD says export the 10 JPGs *"WITH THESE
SETTINGS"* but the settings are missing (color space? long-edge px? quality?).
The rewrite will leave a clearly-marked placeholder rather than invent values.

## 12. Sibling sketch — Lighting Reverse-Engineer (Assignment 5)

Same scaffold pattern, different job. Students build an agent that takes
**inspiration images** and reverse-engineers a **lighting diagram** (key/fill/rim,
modifiers, ratios), camera settings, lens, framing, and posing — the agent plans
the *real* studio setup the student will execute, and hands off a ready-to-use
generation prompt to an image generator (below). Specced in full after Assignment
3 ships. Lighting diagrams are genuinely visual, so the visual companion will be
offered when that module is specced.

### 12a. Image generation for previsualization (revises the original Firefly-only plan)

The original `05_Reshoot Plan.md` specified Adobe Firefly. Given that the university
holds an **OpenAI license with student credits**, three approaches are now
compared (full treatment + comparison table in the HTML brief, §6):

- **Primary — ChatGPT Images 2.0 (GPT Image 2, OpenAI).** Institutional access +
  current top-rated photorealism + reasoning/reference-image input that pairs
  directly with the Lighting agent's prompt handoff. *(Post-dates the author's
  training cutoff; capability claims sourced and flagged for verification —
  §18.)*
- **Alternative — Adobe Firefly.** Retained for its commercially-safe /
  licensed-training-data story and Photoshop integration (already taught).
- **Advanced demo — IC-Light + ControlNet on Stable Diffusion.** The option that
  actually *teaches lighting control*: hold the subject fixed and vary only the
  illumination (key direction, ratio, rim, color temp), comparing canonical
  patterns on the same face. Run as an instructor-led / shared-station resource
  on a dedicated diffusion machine (see §13), not a per-student tool.

The three are complementary; the recommendation does not depend on any single
vendor staying ahead on image quality.

## 13. Deployment — open item

Where students interact with the agent is **not yet decided**. This design is
built portable so the decision can come later:

- **NanoClaw classroom + Playground** (primary target): full per-student
  isolation, trace visibility, the three-tab experience.
- **Standalone Claude Projects** (fallback): same scaffold + worksheet files;
  students build their own Project; loses isolation/trace/automated toggling but
  needs zero infra.

**Host:** the classroom runs on a **Mac Studio (M1 Ultra, 32 GB)**. NanoClaw
spins up a **short-lived Docker container per chat message**, and the heavy
model compute is **cloud-side (Claude via the Anthropic API)**, not local — so
the Mac orchestrates ephemeral containers rather than running models itself.
For a ~16-student class this is comfortable: containers are ephemeral and only a
few run concurrently. Implication: **do not plan on a local LLM** (Ollama-class
models would strain 32 GB and contend with container memory); keep the provider
cloud-side. Watch concurrency during a full-class live lab (everyone hitting the
agent at once) and stagger if container spin-up backs up.

**Diffusion stations (for §12a IC-Light + ControlNet only):** two optional
machines separate from the classroom host — an **NVIDIA DGX Spark (GB10,
128 GB)** and a **Mac Studio (M4 Max, 64 GB)**. The DGX Spark is **CUDA-native**
(the open-source ComfyUI/ControlNet/IC-Light stack installs cleanly, no
Apple-Silicon gaps) with 128 GB of headroom for larger models and batching;
however its memory bandwidth (273 GB/s) is the limiting factor for single-image
latency, so the M4 Max (~2× the bandwidth) may render an individual SD 1.5 frame
as fast or faster. Recommendation: run the diffusion stack on the **DGX Spark**
(compatibility + headroom; batch-serve the class), keep the **M4 Max** as a fast
second station, and leave the **M1 Ultra** dedicated to the classroom. This is a
shared/small-group resource, not a per-student service.

## 14. Instructor-owned improvement — evolving the tool (git + Pull Requests)

**Premise.** The instructor **owns this instance** (NanoClaw admin/owner role) and can
evolve it. **Decision:** the primary mechanism is using **Claude Code (or Codex)
directly** against the fork, with every change landing through git —
**branch → commit → push → Pull Request → merge.** Git history is the change log,
GitHub is where the changes live, and the **PR is the diff-review-and-approval
surface.** A chat-driven "dev-bridge" is an **optional later convenience**
(§14a), not built now.

**Why this over a custom chat bridge.** It's the native, supported v2 path
("tell your AI-coding-CLI what you want"), needs almost no custom engineering,
and is far more capable (full repo access, runs tests, explains itself,
iterates). Crucially, the **logging and "in GitHub" requirements come for free**
from git, and reviewing real diffs in a **GitHub PR beats an in-chat diff card** —
the PR is also a natural approval gate. Building a chat bridge first would
largely reinvent a worse PR review.

**Setup (small, one-time).**
- **Operator CLI on the Mac Studio** — Claude Code (or Codex). The **Claude Code
  desktop app** makes this approachable for a non-developer, without a raw
  terminal.
- **Guardrail `CLAUDE.md`** at the fork root encoding the rules: always work on a
  branch; open a PR (never push to `main` directly); run build + tests before
  proposing; and **do not modify security-critical paths** (credential / OneCLI
  config, the mount allowlist, sandbox / isolation code, auth) without explicit
  confirmation.
- **GitHub remote + branch protection** — protect `main` (require a PR; use
  `CODEOWNERS` to require a maintainer's review on security-relevant paths). This makes
  the audit trail and the approval gate *structural*, not just convention.

**The workflow.**
1. Ask in plain language: *"Add a skill that exports the critique chat + the 10
   thumbnails as a submission PDF."*
2. The CLI works on a **branch**, runs build/tests, and opens a **PR** with a
   summary + diff.
3. **Review and approve/merge the PR** (the instructor for routine changes; a maintainer for
   security-relevant ones via `CODEOWNERS`).
4. **Deploy:** pull `main` on the host, rebuild, restart affected
   services/containers — a one-line `update` script or a CI-on-merge action can
   automate this.
5. **Rollback** is `git revert` + redeploy.

**Examples the instructor could ask the CLI for:**
- *"Add a skill that exports a student's critique conversation and their 10 photo
  thumbnails as a single submission PDF."* (builds the deferred export skill, §15)
- *"Add a new persona to the class library: a studio-lighting reverse-engineer
  for the reshoot unit."* (the §12 sibling)
- *"Let the lighting agent call GPT Image 2 to generate a previsualization from
  its setup prompt."* (integration)
- *"Tighten the Class base: never state exact camera settings — only ask the
  question that leads there."* (policy / persona floor)
- *"Add a `/gallery` command that posts a student's final four to a shared class
  page."* (feature)
- *"Add a scheduled reminder nudging each student to submit by Friday 5 pm."*
  (scheduled task)
- *"Students on Safari can't open the playground link — please fix."* (bug fix)
- *"Raise the per-student rate limit during the live lab, then put it back."*
  (config)
- *"Let students toggle skills but hide ones marked incompatible."* (UI / behavior)

**Relationship to the rest of this design.** This is a **platform capability**
independent of the Assignment-3 materials (Components A–F), which do not depend on
it. The setup is small (guardrail `CLAUDE.md` + branch protection). Once in place,
the "deferred" items (PDF-export skill, lighting persona, integrations) become
things the instructor can add via Claude Code + a PR rather than work a maintainer must hand-build.

### 14a. Optional later — chat dev-bridge

If the instructor later wants to drive changes from **chat/phone** without the desktop
app, a gated chat bridge can be layered on the **same** git/PR pipeline: an
**owner-only** host action (`request_improvement`, never on `student_*`/`ta_*`)
→ a **background Claude Code** on the host works on a branch and opens a PR →
approved on GitHub (or summarized back in chat). Same log, same GitHub record,
same approval gate — only the *trigger* differs. It reuses v2's existing
"agent requests, host decides" action protocol and never gives the chat agent
write access. Build only if the desktop-app path proves a barrier; it is a
security-sensitive add-on (owner-only, branch-only, build/test gate, audit log).

## 15. Out of scope (YAGNI)

- **PDF-export skill** (chat + thumbnails → submission PDF) — deferred; export
  stays low-tech. (the instructor can add it later via the §14 improvement workflow.)
- **Students authoring skills** — they toggle-and-observe only.
- **Sources / Retrieval (RAG), deep Models/Bench work** — exist in the platform
  but not used in week 2.
- **Lighting agent full spec** — sketched only (§12).

## 16. Deliverables & file layout

Authored into the the project working directory (final home: a NanoClaw fork
and/or the instructor's course materials):

- `critique-bot-scaffold.md` — Component A (student-filled persona scaffold).
- `critique-bot-worksheet.md` — Component B (decision worksheet).
- `class-shared-students.md` — Component C (instructor-locked floor).
- `critique-bot-exemplar.md` — Component D (instructor reference persona).
- `instructor-setup-guide.md` — Component D (setup + standalone fallback).
- `critique-bot-rubric.md` — Component D (grading rubric).
- `03a Take Your Best Shot.md` — Component F (rewritten handout; existing file).

## 17. Implementation sequencing

1. Instructor-locked floor (Component C) — defines the contract everything else
   builds on.
2. Critique-Bot scaffold + worksheet (Components A, B).
3. Exemplar persona + rubric (Component D) — validates the scaffold can yield a
   strong result and is gradable.
4. Handout rewrite + low-tech export (Component F).
5. Instructor setup guide incl. skills toggle-and-observe + standalone fallback
   (Components D, E).
6. (Later) Lighting Reverse-Engineer full spec + build (§12).
7. (Separate workstream) Instructor-owned improvement setup (§14) — guardrail
   `CLAUDE.md`, GitHub remote + branch protection + `CODEOWNERS`, and a deploy
   (`update`) script. Small; independent of Components A–F. The optional chat
   dev-bridge (§14a) is deferred until/unless wanted.

## 18. Open questions for the instructor / maintainer

1. **JPG export settings** for the 10-image export (§11) — exact values.
2. **Skills lockdown** — confirm students can toggle instructor-installed skills
   (§10).
3. **Which skill(s)** to pre-install for the toggle-and-observe moment (web
   search assumed).
4. **Deployment** — NanoClaw classroom vs standalone fallback (§13); affects
   only the setup guide, not the core IP. Host is a Mac Studio M1 Ultra / 32 GB;
   plan cloud-side models, not a local LLM.
5. **Image-model claims (§12a)** — confirm current ChatGPT Images 2.0
   capabilities, access terms, and standing; these post-date the author's
   training cutoff.
6. **Lab timing** — confirm the two-session A/B sequence matches actual lab
   scheduling.
7. **Improvement ownership & review policy (§14)** — confirm the instructor is the
   instance owner/admin and comfortable with the Claude Code desktop app + PR
   approval; agree the `CODEOWNERS` rules (which paths require a maintainer's review) and
   the protected-paths list.
8. **Deploy & staging (§14)** — automate deploy-on-merge or keep it a manual
   `update` step; decide whether changes run against a staging instance before
   the live classroom.
9. **Chat dev-bridge (§14a)** — whether/when to build it (only if the desktop-app
   path proves a barrier for the instructor).
