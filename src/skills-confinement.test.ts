/**
 * Confirms `self-customize` (container/skills/self-customize) — which lets an
 * agent write its own skill files — is confined to its own group folder.
 *
 * A self-authored skill lands at `groups/<folder>/custom-skills/<name>/`
 * (src/channels/playground/custom-skills.ts). That path is writable inside
 * the container only because `groups/<folder>/` itself is mounted RW at
 * `/workspace/agent` by `buildMounts()` (src/container-runner.ts). So the
 * confinement guarantee this test pins is: `buildMounts(groupA, ...)` must
 * never produce a mount whose host path resolves inside a *different*
 * group's folder — especially not via a naive prefix match, where
 * `groups/user_a` is a string-prefix of `groups/user_ab` even though they
 * are unrelated groups.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above top-level const declarations, so the
// paths must be computed inside vi.hoisted() and re-derived below for the
// rest of the test file to reference the same values.
const { TMP, GROUPS, DATA, DEFAULT_MCP_SERVERS_PATH, SITES } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-confinement-'));
  return {
    TMP: tmp,
    GROUPS: path.join(tmp, 'groups'),
    DATA: path.join(tmp, 'data'),
    DEFAULT_MCP_SERVERS_PATH: path.join(tmp, 'config', 'default-mcp-servers.json'),
    // Sandbox for the make-website mount (SITES_DIR) — real Homebrew path
    // is never touched by this test; existence of this dir is what turns
    // the sites mount on in buildMounts(), same as the real fs.existsSync
    // check against SITES_DIR in production.
    SITES: path.join(tmp, 'sites'),
  };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    GROUPS_DIR: GROUPS,
    DATA_DIR: DATA,
    DEFAULT_MCP_SERVERS_PATH,
    SITES_DIR: SITES,
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from './db/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { buildMounts } from './container-runner.js';
import { emptyConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

function makeGroup(id: string, folder: string): AgentGroup {
  const group: AgentGroup = { id, name: id, folder, agent_provider: 'claude', created_at: '2026-01-01' };
  createAgentGroup(group);
  return group;
}

function makeSession(agentGroupId: string, id: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: '2026-01-01',
  };
}

/**
 * Correct containment check — trailing separator so `groups/user_ab` is
 * never mistaken for a descendant of `groups/user_a`. This is the check
 * the task brief warns a naive `startsWith(base)` will get wrong.
 */
function isConfinedTo(base: string, target: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  fs.mkdirSync(path.dirname(DEFAULT_MCP_SERVERS_PATH), { recursive: true });
  fs.mkdirSync(SITES, { recursive: true });
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('prefix trap: user_a vs user_ab', () => {
  it('a naive startsWith prefix check is fooled; the trailing-separator check is not', () => {
    const a = path.resolve(GROUPS, 'user_a');
    const ab = path.resolve(GROUPS, 'user_ab');

    // This is the bug the task brief calls out: a bare `startsWith` matches
    // a sibling folder that merely shares a name prefix.
    expect(ab.startsWith(a)).toBe(true);

    // The correct check (trailing separator, or exact match) rejects it.
    expect(isConfinedTo(a, ab)).toBe(false);
    expect(isConfinedTo(a, a)).toBe(true);
    expect(isConfinedTo(a, path.join(a, 'custom-skills', 'my-skill'))).toBe(true);
  });
});

describe('buildMounts confinement', () => {
  it("every mount for group A that falls under GROUPS_DIR resolves inside group A's own folder", () => {
    const groupA = makeGroup('ag_user_a', 'user_a');
    const groupB = makeGroup('ag_user_ab', 'user_ab');
    // groupB's folder must exist on disk to make the prefix trap concrete —
    // if buildMounts(A) ever produced a mount resolving into it, that would
    // be a real cross-group leak.
    fs.mkdirSync(path.resolve(GROUPS, groupB.folder), { recursive: true });

    const sessionA = makeSession(groupA.id, 'sess_a');
    const mounts = buildMounts(groupA, sessionA, emptyConfig(), {});

    const groupADir = path.resolve(GROUPS, groupA.folder);
    const groupBDir = path.resolve(GROUPS, groupB.folder);

    expect(mounts.length).toBeGreaterThan(0);

    for (const m of mounts) {
      const resolved = path.resolve(m.hostPath);
      // Never resolve into group B's folder — this is the assertion that
      // would have caught a `custom-skills` mount pointed at the wrong group.
      expect(isConfinedTo(groupBDir, resolved)).toBe(false);

      // Any mount that falls under the GROUPS_DIR tree at all must be
      // confined to group A's own folder (the shared `groups/global`
      // read-only memory mount is the one intentional exception).
      if (isConfinedTo(path.resolve(GROUPS), resolved) && resolved !== path.resolve(GROUPS, 'global')) {
        expect(isConfinedTo(groupADir, resolved)).toBe(true);
      }
    }
  });

  it('the writable custom-skills-enabling mount resolves exactly under groups/<A>/ and is RW', () => {
    const groupA = makeGroup('ag_user_a2', 'user_a2');
    const sessionA = makeSession(groupA.id, 'sess_a2');
    const mounts = buildMounts(groupA, sessionA, emptyConfig(), {});

    const groupADir = path.resolve(GROUPS, groupA.folder);
    // Self-authored skills land at groups/<folder>/custom-skills/<name>/,
    // which is writable in-container only via the /workspace/agent mount of
    // the whole group folder (custom-skills.ts, container-runner.ts:333).
    const agentMount = mounts.find((m) => m.containerPath === '/workspace/agent');
    expect(agentMount).toBeDefined();
    expect(path.resolve(agentMount!.hostPath)).toBe(groupADir);
    expect(agentMount!.readonly).toBe(false);

    // A self-authored skill file would land here:
    const selfAuthoredSkillPath = path.join(groupADir, 'custom-skills', 'my-skill', 'SKILL.md');
    expect(isConfinedTo(groupADir, selfAuthoredSkillPath)).toBe(true);
  });

  it('the shared skills mount (/app/skills) is present and read-only, not absent', () => {
    const groupA = makeGroup('ag_user_a3', 'user_a3');
    const sessionA = makeSession(groupA.id, 'sess_a3');
    const mounts = buildMounts(groupA, sessionA, emptyConfig(), {});

    // The shared container/skills tree (16 built-in skills) is intentionally
    // mounted once, read-only, for every group — it's not per-group state,
    // so sharing it across groups is correct. Confinement only matters for
    // the RW custom-skills-enabling mount asserted above.
    const sharedSkillsMount = mounts.find((m) => m.containerPath === '/app/skills');
    expect(sharedSkillsMount).toBeDefined();
    expect(sharedSkillsMount!.readonly).toBe(true);
  });

  it("group A and group B mounts never cross into each other's folder", () => {
    const groupA = makeGroup('ag_cross_a', 'cross_a');
    const groupB = makeGroup('ag_cross_b', 'cross_b');
    const sessionA = makeSession(groupA.id, 'sess_cross_a');
    const sessionB = makeSession(groupB.id, 'sess_cross_b');

    const mountsA = buildMounts(groupA, sessionA, emptyConfig(), {});
    const mountsB = buildMounts(groupB, sessionB, emptyConfig(), {});

    const dirA = path.resolve(GROUPS, groupA.folder);
    const dirB = path.resolve(GROUPS, groupB.folder);

    for (const m of mountsA) {
      expect(isConfinedTo(dirB, path.resolve(m.hostPath))).toBe(false);
    }
    for (const m of mountsB) {
      expect(isConfinedTo(dirA, path.resolve(m.hostPath))).toBe(false);
    }
  });
});

// task-p2-9 Step 6: /var/www/sites (the make-website skill's publish
// target, mounted RW) was previously the SAME host directory for every
// group's container, with isolation resting only on the skill's own
// "don't write outside your folder" instruction — a real cross-tenant
// write channel (one group could read/overwrite/delete another group's
// published site files). buildMounts() now scopes the host source to
// SITES_DIR/<folder>, one subtree per group — keyed by the DB-unique
// `folder`, NOT the display `name`, which is user-settable to duplicates
// (playground rename route does not check collisions).
describe('web-hosting (make-website) mount confinement', () => {
  function siteMountOf(mounts: ReturnType<typeof buildMounts>) {
    return mounts.find((m) => m.containerPath.startsWith('/var/www/sites'));
  }

  it("mounts only this group's own SITES_DIR subtree, RW, at /var/www/sites/<folder>", () => {
    const groupA = makeGroup('ag_sites_a', 'sites_a');
    const sessionA = makeSession(groupA.id, 'sess_sites_a');

    const mounts = buildMounts(groupA, sessionA, emptyConfig(), {});
    const siteMount = siteMountOf(mounts);

    expect(siteMount).toBeDefined();
    // Keyed by folder (DB-unique, path-safe) — makeGroup() sets name=id,
    // which differs from folder, so this assertion also proves the mount
    // is NOT keyed by the display name.
    expect(path.resolve(siteMount!.hostPath)).toBe(path.resolve(SITES, groupA.folder));
    expect(siteMount!.containerPath).toBe(`/var/www/sites/${groupA.folder}`);
    expect(siteMount!.readonly).toBe(false);
  });

  it('two groups with the SAME display name but different folders get different writable host paths', () => {
    // `name` is not unique — the DB enforces uniqueness only on `folder`
    // (001-initial.ts), and the playground rename route sets `name` to
    // arbitrary duplicates without a collision check. If the mount were
    // keyed by name, both these groups would resolve SITES_DIR/Marketing
    // and share an RW host dir — the exact cross-tenant channel Step 6
    // set out to close.
    const groupA = makeGroup('ag_sites_dup_a', 'sites_dup_alice');
    const groupB = makeGroup('ag_sites_dup_b', 'sites_dup_bob');
    (groupA as { name: string }).name = 'Marketing';
    (groupB as { name: string }).name = 'Marketing';

    const sessionA = makeSession(groupA.id, 'sess_sites_dup_a');
    const sessionB = makeSession(groupB.id, 'sess_sites_dup_b');

    const siteMountA = siteMountOf(buildMounts(groupA, sessionA, emptyConfig(), {}));
    const siteMountB = siteMountOf(buildMounts(groupB, sessionB, emptyConfig(), {}));
    expect(siteMountA).toBeDefined();
    expect(siteMountB).toBeDefined();

    const hostA = path.resolve(siteMountA!.hostPath);
    const hostB = path.resolve(siteMountB!.hostPath);
    expect(hostA).not.toBe(hostB);
    expect(isConfinedTo(hostB, hostA)).toBe(false);
    expect(isConfinedTo(hostA, hostB)).toBe(false);
  });

  it('group A and group B site mounts never resolve to the same, or a nested, writable host path — the fix under test', () => {
    const groupA = makeGroup('ag_sites_cross_a', 'sites_cross_a');
    const groupB = makeGroup('ag_sites_cross_b', 'sites_cross_b');
    const sessionA = makeSession(groupA.id, 'sess_sites_cross_a');
    const sessionB = makeSession(groupB.id, 'sess_sites_cross_b');

    const mountsA = buildMounts(groupA, sessionA, emptyConfig(), {});
    const mountsB = buildMounts(groupB, sessionB, emptyConfig(), {});

    const siteMountA = siteMountOf(mountsA);
    const siteMountB = siteMountOf(mountsB);
    expect(siteMountA).toBeDefined();
    expect(siteMountB).toBeDefined();

    const hostA = path.resolve(siteMountA!.hostPath);
    const hostB = path.resolve(siteMountB!.hostPath);

    // The core confinement guarantee: no two groups' containers may share a
    // writable host path — not identical, and not one nested inside the
    // other (which would let A traverse into B's subtree via `../<groupB>`
    // starting from a shared parent mount).
    expect(hostA).not.toBe(hostB);
    expect(isConfinedTo(hostB, hostA)).toBe(false);
    expect(isConfinedTo(hostA, hostB)).toBe(false);
    expect(siteMountA!.readonly).toBe(false);
    expect(siteMountB!.readonly).toBe(false);
  });

  it('rejects a group folder that would escape the per-group subtree (path traversal guard)', () => {
    const groupA = makeGroup('ag_sites_traversal', 'sites_traversal');
    const sessionA = makeSession(groupA.id, 'sess_sites_traversal');
    // Folders are created sanitized, so this is defense in depth: force an
    // unsafe folder to exercise the guard directly — it must fail loud
    // rather than silently mounting outside SITES_DIR. One level of "../"
    // only: buildMounts scaffolds the group dir (initGroupFilesystem)
    // before the sites guard runs, and GROUPS/../escaped resolves to
    // TMP/escaped — still inside the sandbox afterEach removes.
    (groupA as { folder: string }).folder = '../escaped';

    expect(() => buildMounts(groupA, sessionA, emptyConfig(), {})).toThrow(/not a safe path segment/);
  });
});
