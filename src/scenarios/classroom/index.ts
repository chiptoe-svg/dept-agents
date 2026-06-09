// Classroom scenario profile.
//
// The teaching-specific layer on top of the group-agent platform: the
// classroom Scenario definition (roles, personas, greetings, roster-based
// role detection + member-name lookup). Pairing itself is handled by the
// platform's generic contract-driven consumer (src/scenario-pairing.ts).
//
// Everything else classroom uses (onboarding/auth, provisioning, credentials,
// member policy) is platform code in src/, shared by
// every scenario. See plans/group-agent-platform.md.

import './scenario.js'; // registers the classroom scenario (roles, personas, greetings)
