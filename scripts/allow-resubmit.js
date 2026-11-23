// Let someone submit again: removes their mobile number or email from the "already submitted" list.
// Their old PDF stays in storage/.
// Usage: npm run allow-resubmit -- 9876543210
//        npm run allow-resubmit -- name@example.com
const path = require('path');
const { loadEnv } = require('../lib/env');
loadEnv();
const { createRegistry } = require('../lib/registry');

const value = process.argv[2];
if (!value) {
  console.log('Usage: npm run allow-resubmit -- <mobile number or email>');
  process.exit(1);
}
const storage = path.resolve(__dirname, '..', process.env.STORAGE_DIR || 'storage');
const removed = createRegistry(storage).remove(value);
console.log(removed ? `Done. ${value} can submit again (${removed} record removed).` : `No submission found for ${value}.`);
