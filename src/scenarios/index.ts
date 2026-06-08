// Scenario profiles barrel.
//
// The group-agent platform (everything else in src/) is scenario-agnostic.
// Each scenario is a thin profile under src/scenarios/<name>/ that registers
// its scenario-specific bits (roles, personas, pair consumers) against the
// platform's registries. See plans/group-agent-platform.md.
//
// Today only the classroom scenario exists, so it loads unconditionally. When
// a second scenario lands, gate each profile's registration on an
// ACTIVE_SCENARIO config so an install behaves as exactly one scenario.

import './classroom/index.js';
