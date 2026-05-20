/**
 * Class feature — per-student git identity env contributor.
 *
 * When the agent group has student_name + student_email on its
 * metadata (set by the class pair handler), inject GIT_AUTHOR_* /
 * GIT_COMMITTER_* into the container env so wiki commits the agent
 * makes are attributed to the real student in `git log`.
 *
 * Only emits the env vars when BOTH name and email are present and
 * non-empty (whitespace-trimmed). Partial attribution would be worse
 * than git's default error, which surfaces the misconfiguration
 * loudly. No-op for non-class agent groups.
 */
import { getAgentGroupMetadata } from './db/agent-groups.js';
import { registerContainerEnvContributor } from './container-env-registry.js';

/**
 * Build GIT_AUTHOR_* / GIT_COMMITTER_* env pairs from a metadata
 * blob. Pure function — exported separately from the contributor so
 * unit tests can exercise the metadata parsing without setting up a
 * real agent group.
 */
export function gitAuthorEnvFromMetadata(metadata: Record<string, unknown>): Array<[string, string]> {
  const name = typeof metadata.student_name === 'string' ? metadata.student_name.trim() : '';
  const email = typeof metadata.student_email === 'string' ? metadata.student_email.trim() : '';
  if (!name || !email) return [];
  return [
    ['GIT_AUTHOR_NAME', name],
    ['GIT_AUTHOR_EMAIL', email],
    ['GIT_COMMITTER_NAME', name],
    ['GIT_COMMITTER_EMAIL', email],
  ];
}

registerContainerEnvContributor((ctx) => {
  return gitAuthorEnvFromMetadata(getAgentGroupMetadata(ctx.agentGroup.id));
});
