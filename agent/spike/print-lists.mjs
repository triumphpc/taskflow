// Единый источник списков для spike: те же ALLOWED/DENIED, что у боевого демона (policy.mjs).
// usage: node print-lists.mjs allowed|denied            (режим «только чтение», прежний spike U1-U5)
//        node print-lists.mjs allowed-send|denied-send  (режим с отправкой, spike S1-S3)
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, READONLY_ALLOWED, READONLY_DISALLOWED } from '../lib/policy.mjs';
const lists = {
  allowed: READONLY_ALLOWED, denied: READONLY_DISALLOWED,
  'allowed-send': ALLOWED_TOOLS, 'denied-send': DISALLOWED_TOOLS,
};
const which = process.argv[2];
if (lists[which]) process.stdout.write(lists[which].join(','));
else { console.error('usage: print-lists.mjs allowed|denied|allowed-send|denied-send'); process.exit(64); }
