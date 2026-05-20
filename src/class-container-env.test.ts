/**
 * Unit tests for the class feature's container-env contributor +
 * registry semantics from container-env-registry.
 *
 * gitAuthorEnvFromMetadata: pure metadata → env-pair shape, exhaustive
 * coverage of present/missing/whitespace/non-string inputs.
 *
 * Registry: contributors run in registration order; output is the
 * flat union of their results; an empty chain yields no env.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { gitAuthorEnvFromMetadata } from './class-container-env.js';
import {
  _resetContributorsForTest,
  collectContainerEnv,
  registerContainerEnvContributor,
} from './container-env-registry.js';
import type { AgentGroup } from './types.js';

const FAKE_AG: AgentGroup = {
  id: 'ag-1',
  name: 'student_01',
  folder: 'student_01',
  agent_provider: null,
  model: null,
  created_at: '2026-05-05T00:00:00Z',
};

describe('gitAuthorEnvFromMetadata', () => {
  it('emits GIT_AUTHOR + GIT_COMMITTER pairs when name and email are present', () => {
    expect(gitAuthorEnvFromMetadata({ student_name: 'Alice Chen', student_email: 'alice@school.edu' })).toEqual([
      ['GIT_AUTHOR_NAME', 'Alice Chen'],
      ['GIT_AUTHOR_EMAIL', 'alice@school.edu'],
      ['GIT_COMMITTER_NAME', 'Alice Chen'],
      ['GIT_COMMITTER_EMAIL', 'alice@school.edu'],
    ]);
  });

  it('returns empty when student_email is missing (paired-but-no-email or unpaired group)', () => {
    expect(gitAuthorEnvFromMetadata({ student_name: 'Alice Chen' })).toEqual([]);
  });

  it('returns empty when student_name is missing', () => {
    expect(gitAuthorEnvFromMetadata({ student_email: 'alice@school.edu' })).toEqual([]);
  });

  it('returns empty for an entirely empty metadata blob (non-class agent group)', () => {
    expect(gitAuthorEnvFromMetadata({})).toEqual([]);
  });

  it('treats whitespace-only values as missing', () => {
    expect(gitAuthorEnvFromMetadata({ student_name: '   ', student_email: 'alice@school.edu' })).toEqual([]);
  });

  it('trims surrounding whitespace before emitting', () => {
    expect(gitAuthorEnvFromMetadata({ student_name: '  Bob  ', student_email: '  bob@school.edu  ' })).toEqual([
      ['GIT_AUTHOR_NAME', 'Bob'],
      ['GIT_AUTHOR_EMAIL', 'bob@school.edu'],
      ['GIT_COMMITTER_NAME', 'Bob'],
      ['GIT_COMMITTER_EMAIL', 'bob@school.edu'],
    ]);
  });

  it('ignores non-string metadata values defensively', () => {
    expect(
      gitAuthorEnvFromMetadata({ student_name: 42 as unknown as string, student_email: null as unknown as string }),
    ).toEqual([]);
  });
});

describe('container-env-registry', () => {
  beforeEach(() => {
    _resetContributorsForTest();
  });

  it('returns empty when no contributors are registered', () => {
    expect(collectContainerEnv({ agentGroup: FAKE_AG })).toEqual([]);
  });

  it('runs all registered contributors and concatenates their pairs', () => {
    registerContainerEnvContributor(() => [['A', '1']]);
    registerContainerEnvContributor(() => [
      ['B', '2'],
      ['C', '3'],
    ]);
    expect(collectContainerEnv({ agentGroup: FAKE_AG })).toEqual([
      ['A', '1'],
      ['B', '2'],
      ['C', '3'],
    ]);
  });

  it('passes the agent group through to each contributor', () => {
    let received: AgentGroup | null = null;
    registerContainerEnvContributor((ctx) => {
      received = ctx.agentGroup;
      return [];
    });
    collectContainerEnv({ agentGroup: FAKE_AG });
    expect(received).toBe(FAKE_AG);
  });

  it('preserves registration order across contributors', () => {
    registerContainerEnvContributor(() => [['Z', 'first']]);
    registerContainerEnvContributor(() => [['Z', 'second']]);
    expect(collectContainerEnv({ agentGroup: FAKE_AG })).toEqual([
      ['Z', 'first'],
      ['Z', 'second'],
    ]);
  });
});
