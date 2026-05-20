import { listAllForProvider } from '../src/model-discovery.js';

const all = await listAllForProvider('codex');
console.log(`count: ${all.length}`);
for (const h of all) console.log(`  ${h.id}  (alias=${h.alias}${h.note ? `, note=${h.note}` : ''})`);
