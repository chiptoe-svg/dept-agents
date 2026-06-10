// Industry-AI-seminar scenario — a skin over the canonical roles for a
// professional/industry seminar. Uses all four roles (unlike classroom, which
// skips it_admin). Role detection is folder-prefix based — members are
// provisioned into owner_NN / it_admin_NN / assistant_NN / user_NN folders.

import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { registerScenario } from '../registry.js';
import type { CanonicalRole, Scenario } from '../types.js';
import { FACILITATOR_PERSONA, IT_ADMIN_PERSONA, ORGANIZER_PERSONA, PARTICIPANT_PERSONA } from './personas.js';

const seminar: Scenario = {
  name: 'industryai_seminar',
  roles: {
    owner: {
      label: 'Organizer',
      permission: 'global-admin',
      persona: ORGANIZER_PERSONA,
      greeting: (name) =>
        `Hi ${name}! You're set up as the seminar organizer — global admin over every agent. Send /playground any time to customize.`,
    },
    it_admin: {
      label: 'IT Admin',
      permission: 'global-admin',
      persona: IT_ADMIN_PERSONA,
      greeting: (name) =>
        `Hi ${name}! You're set up as IT admin for the seminar. You have admin access to manage technical setup and help participants.`,
    },
    assistant: {
      label: 'Facilitator',
      permission: 'scoped-admin',
      persona: FACILITATOR_PERSONA,
      greeting: (name) =>
        `Hi ${name}! You're set up as a facilitator. You can assist participants directly. Send /playground to customize your agent.`,
    },
    user: {
      label: 'Participant',
      permission: 'member',
      persona: PARTICIPANT_PERSONA,
      greeting: (name) =>
        `Hi ${name}! Welcome to the seminar. Send /playground any time to customize your agent's style.`,
    },
  },
  // Seminar has no roster — use the agent group's stored name; null if absent.
  memberName: (folder): string | null => getAgentGroupByFolder(folder)?.name ?? null,
  folderPrefix: { owner: 'owner_', it_admin: 'it_admin_', assistant: 'assistant_', user: 'user_' },
  roleForFolder: (folder): CanonicalRole | null => {
    if (folder.startsWith('owner_')) return 'owner';
    if (folder.startsWith('it_admin_')) return 'it_admin';
    if (folder.startsWith('assistant_')) return 'assistant';
    if (folder.startsWith('user_')) return 'user';
    return null;
  },
};

registerScenario(seminar);
