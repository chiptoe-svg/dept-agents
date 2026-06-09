// Scenario profiles barrel.
//
// The group-agent platform (everything else in src/) is scenario-agnostic.
// Each scenario is a thin profile under src/scenarios/<name>/ that registers
// its scenario-specific bits (roles, personas, pair consumers) against the
// platform's registries. See plans/group-agent-platform.md.
//
// Only the ACTIVE scenario's profile loads — so an install behaves as exactly
// one scenario (e.g. a seminar box does NOT register classroom's pair
// consumers). Loaders are dynamic so the inactive profiles' side effects never
// run. Add a line here when you add a scenario.

import { ACTIVE_SCENARIO } from '../config.js';
import { log } from '../log.js';

const loaders: Record<string, () => Promise<unknown>> = {
  classroom: () => import('./classroom/index.js'),
  industryai_seminar: () => import('./industryai_seminar/index.js'),
};

const load = loaders[ACTIVE_SCENARIO];
if (load) {
  await load();
} else {
  log.warn('No scenario profile registered for ACTIVE_SCENARIO — no scenario loaded', {
    active: ACTIVE_SCENARIO,
    known: Object.keys(loaders),
  });
}
