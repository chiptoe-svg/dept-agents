# Member Setup Restructure — live verification

**Date:** 2026-07-12. Setup-restructure plan, Task 3. Executed live on the running department server (`com.nanoclaw-v2-581fefa4`, playground at `http://gcworkflow.clemson.edu:8088`, local bind `127.0.0.1:3002`).

## Result: PASS — the member top nav is now two tabs (Setup + MyAgent); Persona/Skills live under Setup > Advanced.

Rebuilt + restarted, provisioned a throwaway member `playground:setup_canary`.

## 1. Served assets

- `tab-gating.js` → `MEMBER_NAV_TABS = ['home', 'chat']` (nav bar) and `MEMBER_TABS = ['home', 'chat', 'persona', 'skills']` (reachable via `showTab`).
- `member-home.js` → carries the Advanced section (`data-advanced`, `edit-persona`, `edit-skills`); the go-to button (`goto-chat` / "Go to MyAgent") is **gone**.

## 2. Browser (Playwright, member session)

- **Top nav shows exactly `Setup` and `MyAgent`** — no Persona/Skills buttons in the bar.
- **Setup** page renders the dashboard (Connect-your-ChatGPT hero, "Running on: Clemson campus model (free)" indicator, Telegram + Google-"Available soon" cards) and an **Advanced** disclosure. Expanding Advanced reveals **Edit persona** and **Edit skills**. There is **no** "Go to MyAgent" button (removed as redundant with the nav tab).
- **Edit persona** → opens the member's own Persona editor (page title → "Persona — Setup Canary"). The **Setup** nav button returns to the dashboard. (Edit skills opens the Skills editor the same way.)
- **MyAgent** → opens the A3 file-capable chat (the "Running on" indicator, the empty-state prompt, the 📎 attach + compose + Send bar, and the slides hint).

## Notes

- Minor cosmetic (pre-existing, not introduced here): opening the Persona/Skills editor sets `document.title` to "Persona …"/"Skills …" and switching back to Setup doesn't reset it. Harmless; the visible nav + content are correct.

## Standing state

- Member top nav = **Setup + MyAgent**. Persona/Skills are reachable from **Setup > Advanced** (they open the existing full editors). Owner/TA tab set unchanged. Tab ids (`home`/`chat`/`persona`/`skills`) unchanged.
- The `setup_canary` throwaway identity was fully removed after verification (token revoked, group + fs deleted, container stopped). Remaining groups: `owner_01` + the provisioning template.
