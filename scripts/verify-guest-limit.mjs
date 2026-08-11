// Does the guest rate limit actually engage against the deployed service?
//
// This exists because it did not, twice, while passing every unit test. The
// key depends on a proxy chain that only exists in production, so production
// is the only place the question can be asked. Both wrong versions read as
// airtight.
//
// Usage: node scripts/verify-guest-limit.mjs https://api.mustard.watch

const base = (process.argv[2] ?? 'https://api.mustard.watch').replace(/\/$/, '');
const url = `${base}/api/auth/guest`;

// Capacity is 10 per caller. Anything at or below that proves nothing - an
// earlier run of this sent six, saw six 201s, and concluded nothing while
// looking like a pass.
const CAPACITY = 10;
const REQUESTS = 15;

const hit = async (headers = {}) => {
  const res = await fetch(url, { method: 'POST', headers });
  return res.status;
};

const run = async (label, headersFor) => {
  const codes = [];
  for (let i = 0; i < REQUESTS; i++) codes.push(await hit(headersFor(i)));
  const allowed = codes.filter((c) => c === 201).length;
  const refused = codes.filter((c) => c === 429).length;
  console.log(`${label}\n  ${codes.join(' ')}\n  ${allowed} allowed, ${refused} refused`);
  return { allowed, refused };
};

// An honest caller. If this does not start refusing, the limiter is not
// engaging at all - which is exactly what production was doing while the
// code looked correct.
const honest = await run('Honest caller, no forged header:', () => ({}));

// A caller inventing a different address every time. They can only ever
// PREPEND to the chain, so the address the edge saw is still theirs.
const forged = await run('Same caller, a different forged address each time:', (i) => ({
  'x-forwarded-for': `203.0.113.${i + 1}`,
}));

let failed = false;
for (const [label, result] of [
  ['honest caller', honest],
  ['forged header', forged],
]) {
  if (result.allowed > CAPACITY) {
    console.log(`\nFAIL  ${label}: ${result.allowed} allowed, capacity is ${CAPACITY}`);
    failed = true;
  }
  if (result.refused === 0) {
    console.log(`\nFAIL  ${label}: nothing was refused`);
    failed = true;
  }
}

// Note the cost, rather than leaving it to be discovered: a passing run
// creates about twenty guest rows. They have no rooms, no messages and no
// password, so the nightly sweeper removes them after seven days.
console.log(
  failed
    ? '\nThe limit is NOT holding in production.'
    : `\nThe limit holds. (~${honest.allowed + forged.allowed} guest rows created; the sweeper takes them in 7 days.)`,
);
process.exit(failed ? 1 : 0);
