// Единый источник списков для spike: те же ALLOWED/DENIED, что у боевого демона (policy.mjs).
// usage: node print-lists.mjs allowed|denied
import { ALLOWED_TOOLS, DISALLOWED_TOOLS } from '../lib/policy.mjs';
const which = process.argv[2];
if (which === 'allowed') process.stdout.write(ALLOWED_TOOLS.join(','));
else if (which === 'denied') process.stdout.write(DISALLOWED_TOOLS.join(','));
else { console.error('usage: print-lists.mjs allowed|denied'); process.exit(64); }
