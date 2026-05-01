/**
 * Creates the 5 missing Torque recurring incentives for PhysioLoop.
 * Uses curl (IPv4) to avoid WSL2 IPv6 timeout issues.
 * Run: node scripts/create-incentives.mjs
 */

import { execSync } from 'child_process';

const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJjbW9lMWhrNHAwMG0zancxaDcxa29ycWQ1IiwidHlwZSI6Im1jcCIsImlhdCI6MTc3NzEwMzQxOCwiZXhwIjoxNzgyMjg3NDE4fQ.qmEBAkBwrCQ8OzF7KsBuz8Mr4bsOYSrCf1QQteJY0zk';
const PROJECT_ID = 'cmoe1q32100m9jw1hz7eu8rky';
const BASE = 'https://server.torque.so';
const PUSD_MINT = 'D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s';
const PUSD_DECIMALS = 6;

// Registered Torque custom event IDs
const EVENT = {
  SESSION_COMPLETED: 'cmoe1rbmy00mqjw1hepliv67d',
  PLAN_STARTED:      'cmoe1rc3q00mujw1hzyok2lrs',
  PLAN_COMPLETED:    'cmoe1rclw00myjw1hbp5otmun',
  STREAK_MILESTONE:  'cmoe1rd6u00n2jw1hlkd6ndif',
  CAREGIVER_CHECKIN: 'cmoe1rdt700n6jw1hjj1luj6t',
  PHYSIO_REGISTERED: 'cmoe1re9s00najw1h6jjncp51',
};

const CURL_RESOLVE = '--resolve "server.torque.so:443:104.26.14.182"';

function curlPost(path, body) {
  const json = JSON.stringify(body);
  const tmpFile = `/tmp/torque_payload_${Date.now()}.json`;
  execSync(`cat > ${tmpFile}`, { input: json });
  try {
    const out = execSync(
      `curl -s --max-time 30 ${CURL_RESOLVE} -X POST "${BASE}${path}" ` +
      `-H "Authorization: Bearer ${API_KEY}" ` +
      `-H "Content-Type: application/json" ` +
      `-d @${tmpFile}`,
      { encoding: 'utf8' }
    );
    execSync(`rm -f ${tmpFile}`);
    return JSON.parse(out);
  } catch (err) {
    execSync(`rm -f ${tmpFile}`);
    throw err;
  }
}

function createQuery(name, sql) {
  console.log(`  Creating query: ${name.slice(0, 60)}…`);
  const res = curlPost(`/project/${PROJECT_ID}/query`, {
    name,
    query: sql,
    // Required so Torque validates the template params for recurring queries
    paramMap: { startDate: 'DATE', endDate: 'DATE' },
  });
  if ((res?.statusCode ?? 0) >= 400 || res?.error) {
    console.error(`  ✗ Query failed:`, JSON.stringify(res).slice(0, 300));
    return null;
  }
  const id = res?.data?.id ?? res?.id;
  if (!id) {
    console.error(`  ✗ No ID in response:`, JSON.stringify(res).slice(0, 300));
    return null;
  }
  console.log(`  ✓ Query created: ${id}`);
  return id;
}

function createOffer(payload) {
  console.log(`  Creating offer: ${payload.name}`);
  const res = curlPost(`/project/${PROJECT_ID}/recurring-offer`, payload);
  if ((res?.statusCode ?? 0) >= 400 || res?.error) {
    console.error(`  ✗ Offer failed:`, JSON.stringify(res).slice(0, 500));
    return null;
  }
  const id = res?.data?.id ?? res?.id;
  if (!id) {
    console.error(`  ✗ No ID in response:`, JSON.stringify(res).slice(0, 300));
    return null;
  }
  console.log(`  ✓ Offer created: ${id}`);
  return id;
}

// ─── Campaign definitions ────────────────────────────────────────────────────

// Note: {{startDate}} and {{endDate}} are Torque template params — must be literal double-braces
const TSTART = '{{startDate}}';
const TEND   = '{{endDate}}';

const campaigns = [
  {
    name: 'STREAK_REBATE',
    offerName: 'PhysioLoop — Patient 7-Session Streak Rebate',
    description: 'Patients who complete 7 consecutive sessions earn a $0.50 PUSD rebate distributed via Torque CLAIM each epoch.',
    type: 'LEADERBOARD',
    startDate: '2026-04-29T00:00:00.000Z',
    evalDurationDays: 7,
    // streak_milestone fires with num_val_1 = streak_length (7 for session 7)
    sql: [
      `SELECT "userPubkey" AS address, COUNT(*) AS value`,
      `FROM customevent_partitioned`,
      `WHERE "eventId" = '${EVENT.STREAK_MILESTONE}'`,
      `  AND "receivedAt" BETWEEN ${TSTART} AND ${TEND}`,
      `  AND num_val_1 = 7`,
      `GROUP BY "userPubkey"`,
      `ORDER BY value DESC`,
    ].join('\n'),
    dist: {
      emissionType: 'TOKENS',
      tokenAddress: PUSD_MINT,
      tokenDecimals: PUSD_DECIMALS,
      totalFundAmount: 5_000_000,
      customFormula: '500000',
      maxPerParticipant: 500_000,
      distributionType: 'FORMULA',
      distributionMethod: 'CLAIM',
      claimWindowStart: '2026-05-06T00:00:00.000Z',
      claimWindowDuration: 604800,
    },
  },
  {
    name: 'PLAN_RAFFLE',
    offerName: 'PhysioLoop — Plan Completion Raffle',
    description: 'Every patient who completes a treatment plan enters a monthly raffle. Prizes: $5 / $2 / $1 PUSD.',
    type: 'RAFFLE',
    startDate: '2026-04-29T00:00:00.000Z',
    evalDurationDays: 30,
    sql: [
      `SELECT "userPubkey" AS address, COUNT(*) AS value`,
      `FROM customevent_partitioned`,
      `WHERE "eventId" = '${EVENT.PLAN_COMPLETED}'`,
      `  AND "receivedAt" BETWEEN ${TSTART} AND ${TEND}`,
      `GROUP BY "userPubkey"`,
      `ORDER BY value DESC`,
    ].join('\n'),
    dist: {
      emissionType: 'TOKENS',
      tokenAddress: PUSD_MINT,
      tokenDecimals: PUSD_DECIMALS,
      totalFundAmount: 8_000_000,
      distributionType: 'RAFFLE',
      distributionMethod: 'CLAIM',
      prizeBuckets: [
        { amount: 5_000_000, count: 1 },
        { amount: 2_000_000, count: 1 },
        { amount: 1_000_000, count: 1 },
      ],
      selectionLogic: 'WEIGHTED_BY_METRIC',
      claimWindowStart: '2026-05-29T00:00:00.000Z',
      claimWindowDuration: 604800,
    },
  },
  {
    name: 'CG_STREAK_7',
    offerName: 'PhysioLoop — Caregiver 7-Day Streak Bonus',
    description: 'Caregivers who check in 7 days in a row earn a $1.00 PUSD streak bonus via Torque CLAIM.',
    type: 'LEADERBOARD',
    startDate: '2026-04-29T00:00:00.000Z',
    evalDurationDays: 7,
    // caregiver_checkin: num_val_1 = streak_count
    sql: [
      `SELECT "userPubkey" AS address, MAX(num_val_1) AS value`,
      `FROM customevent_partitioned`,
      `WHERE "eventId" = '${EVENT.CAREGIVER_CHECKIN}'`,
      `  AND "receivedAt" BETWEEN ${TSTART} AND ${TEND}`,
      `GROUP BY "userPubkey"`,
      `HAVING MAX(num_val_1) >= 7`,
      `ORDER BY value DESC`,
    ].join('\n'),
    dist: {
      emissionType: 'TOKENS',
      tokenAddress: PUSD_MINT,
      tokenDecimals: PUSD_DECIMALS,
      totalFundAmount: 10_000_000,
      customFormula: '1000000',
      maxPerParticipant: 1_000_000,
      distributionType: 'FORMULA',
      distributionMethod: 'CLAIM',
      claimWindowStart: '2026-05-06T00:00:00.000Z',
      claimWindowDuration: 604800,
    },
  },
  {
    name: 'CG_RESCUE',
    offerName: 'PhysioLoop — Caregiver Rescue Bonus',
    description: 'Caregivers who check in after a patient misses a session earn $0.50 PUSD per rescue — rewarding proactive recovery.',
    type: 'LEADERBOARD',
    startDate: '2026-04-29T00:00:00.000Z',
    evalDurationDays: 7,
    // caregiver_checkin: num_val_2 = patient_missed_session (1 = true)
    sql: [
      `SELECT "userPubkey" AS address, COUNT(*) AS value`,
      `FROM customevent_partitioned`,
      `WHERE "eventId" = '${EVENT.CAREGIVER_CHECKIN}'`,
      `  AND "receivedAt" BETWEEN ${TSTART} AND ${TEND}`,
      `  AND num_val_2 = 1`,
      `GROUP BY "userPubkey"`,
      `ORDER BY value DESC`,
    ].join('\n'),
    dist: {
      emissionType: 'TOKENS',
      tokenAddress: PUSD_MINT,
      tokenDecimals: PUSD_DECIMALS,
      totalFundAmount: 5_000_000,
      customFormula: 'VALUE * 500000',
      maxPerParticipant: 2_000_000,
      distributionType: 'FORMULA',
      distributionMethod: 'CLAIM',
      claimWindowStart: '2026-05-06T00:00:00.000Z',
      claimWindowDuration: 604800,
    },
  },
  {
    name: 'CG_COMPLETION',
    offerName: 'PhysioLoop — Caregiver Plan Completion Bonus',
    description: 'Caregivers who support a patient through a full treatment programme earn a $2.00 PUSD completion bonus via Torque CLAIM.',
    type: 'LEADERBOARD',
    startDate: '2026-04-29T00:00:00.000Z',
    evalDurationDays: 30,
    // plan_completed fires with num_val_1 = has_caregiver (1 = true)
    // The caregiver's pubkey is emitted in a second plan_completed event (role: physio for physio, caregiver for caregiver)
    // We use the caregiver_checkin events as proxy: users with any checkin whose plan completed this epoch
    // Better: count plan_completed events where has_caregiver = 1 — these fire for caregiver wallet pubkey
    sql: [
      `SELECT "userPubkey" AS address, COUNT(*) AS value`,
      `FROM customevent_partitioned`,
      `WHERE "eventId" = '${EVENT.PLAN_COMPLETED}'`,
      `  AND "receivedAt" BETWEEN ${TSTART} AND ${TEND}`,
      `  AND num_val_1 = 1`,
      `GROUP BY "userPubkey"`,
      `ORDER BY value DESC`,
    ].join('\n'),
    dist: {
      emissionType: 'TOKENS',
      tokenAddress: PUSD_MINT,
      tokenDecimals: PUSD_DECIMALS,
      totalFundAmount: 20_000_000,
      customFormula: '2000000',
      maxPerParticipant: 2_000_000,
      distributionType: 'FORMULA',
      distributionMethod: 'CLAIM',
      claimWindowStart: '2026-05-29T00:00:00.000Z',
      claimWindowDuration: 604800,
    },
  },
];

// ─── Main ────────────────────────────────────────────────────────────────────

const results = {};

for (const c of campaigns) {
  console.log(`\n──── ${c.name} ────`);

  const queryId = createQuery(
    `PL — ${c.offerName} - ${Date.now()}`,
    c.sql,
  );
  if (!queryId) { console.error(`  ✗ Skipping ${c.name}`); continue; }

  const offerPayload = {
    name: c.offerName,
    description: c.description,
    type: c.type,
    startDate: c.startDate,
    evalDurationDays: c.evalDurationDays,
    sqlQueryId: queryId,
    addressColumn: 'address',
    metricColumn: 'value',
    distributionConfig: c.dist,
    offerMetadata: {
      title: c.offerName,
      primitive: { type: 'COMPETITION' },
      description: c.description,
    },
    evalQueryFrequency: 300,
  };

  const offerId = createOffer(offerPayload);
  if (!offerId) continue;

  results[c.name] = offerId;
}

console.log('\n\n═══ RESULTS ═══');
console.log(JSON.stringify(results, null, 2));

console.log('\n\n═══ .env.local updates ═══');
const ENV_KEYS = {
  STREAK_REBATE: 'NEXT_PUBLIC_TORQUE_CAMPAIGN_STREAK',
  PLAN_RAFFLE:   'NEXT_PUBLIC_TORQUE_CAMPAIGN_RAFFLE',
  CG_STREAK_7:   'NEXT_PUBLIC_TORQUE_CAMPAIGN_CG_STREAK7',
  CG_RESCUE:     'NEXT_PUBLIC_TORQUE_CAMPAIGN_CG_RESCUE',
  CG_COMPLETION: 'NEXT_PUBLIC_TORQUE_CAMPAIGN_CG_COMPLETION',
};
for (const [name, id] of Object.entries(results)) {
  if (ENV_KEYS[name]) console.log(`${ENV_KEYS[name]}=${id}`);
}
