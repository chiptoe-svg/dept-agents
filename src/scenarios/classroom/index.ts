// Classroom scenario profile.
//
// The teaching-specific layer on top of the group-agent platform: the
// instructor/TA pair consumers (role detection by folder prefix, role grants,
// greetings). Imported for side effects — each module self-registers into the
// platform's pair-consumer registry.
//
// Everything else classroom uses (onboarding/auth, provisioning, credentials,
// member policy, base pairing/greeting) is platform code in src/, shared by
// every scenario. See plans/group-agent-platform.md.

import './scenario.js'; // registers the classroom scenario (roles, personas, greetings)
import './pair-instructor.js';
import './pair-ta.js';
