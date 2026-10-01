'use strict';

const { Pool } = require('pg');
const {
  createMerchantInvitation,
  MerchantInvitationError,
  DEFAULT_INVITATION_TTL_DAYS,
  MIN_TTL_DAYS,
  MAX_TTL_DAYS
} = require('../lib/merchant-invitation');

const parseArgs = argv => {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      args[key] = true;
    }
  }
  return args;
};

const printHelp = () => {
  process.stdout.write(
    'Usage: node scripts/generate-merchant-invitation.js [options]\n\n' +
    'Generates a single-use merchant onboarding invitation and prints the onboarding URL.\n' +
    'The database stores ONLY the SHA-256 token hash. The raw token is displayed once.\n' +
    'No merchant or Owner record is created by generating an invitation.\n\n' +
    'Options:\n' +
    '  --name-hint <name>     Optional expected business name\n' +
    '  --email <email>        Optional contact email for the invitee\n' +
    '  --phone <phone>        Optional contact phone for the invitee\n' +
    `  --ttl-days <days>      Invitation validity in days (${MIN_TTL_DAYS}-${MAX_TTL_DAYS}, default: ${DEFAULT_INVITATION_TTL_DAYS})\n` +
    '  --base-url <url>       Base application URL (default: PUBLIC_BASE_URL env or http://localhost:3000)\n' +
    '  --created-by <name>    Operator / audit creator identifier (default: platform_cli)\n' +
    '  --help, -h             Show this help message\n'
  );
};

const run = async () => {
  const args = parseArgs(process.argv);

  if (args.help || args.h) {
    printHelp();
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('Error: DATABASE_URL environment variable is required.\n');
    process.exitCode = 1;
    return;
  }

  const nameHint = args['name-hint'] || args.nameHint;
  const email = args.email;
  const phone = args.phone;
  const ttlDaysRaw = args['ttl-days'] || args.ttlDays;
  const baseUrl = args['base-url'] || args.baseUrl || process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
  const createdBy = args['created-by'] || args.createdBy || 'platform_cli';

  let ttlDays = DEFAULT_INVITATION_TTL_DAYS;
  if (ttlDaysRaw !== undefined) {
    const parsed = Number(ttlDaysRaw);
    if (!Number.isInteger(parsed) || parsed < MIN_TTL_DAYS || parsed > MAX_TTL_DAYS) {
      process.stderr.write(
        `Error: --ttl-days must be an integer between ${MIN_TTL_DAYS} and ${MAX_TTL_DAYS}.\n`
      );
      process.exitCode = 1;
      return;
    }
    ttlDays = parsed;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    const invitation = await createMerchantInvitation(pool, {
      merchantNameHint: nameHint,
      contactEmail: email,
      contactPhone: phone,
      ttlDays,
      baseUrl,
      createdBy
    });

    process.stdout.write(
      '\n==================================================\n' +
      'MERCHANT ONBOARDING INVITATION CREATED\n' +
      '==================================================\n\n' +
      `Invitation ID:  ${invitation.invitationId}\n` +
      `Status:         ${invitation.status}\n` +
      `Expires At:     ${new Date(invitation.expiresAt).toISOString()} (${ttlDays} days)\n` +
      `Name Hint:      ${invitation.merchantNameHint || '(none)'}\n` +
      `Contact Email:  ${invitation.contactEmail || '(none)'}\n` +
      `Contact Phone:  ${invitation.contactPhone || '(none)'}\n` +
      `Created By:     ${invitation.createdBy}\n\n` +
      'ONE-TIME ONBOARDING URL (share securely with merchant):\n' +
      `  ${invitation.onboardingUrl}\n\n` +
      'SECURITY NOTE:\n' +
      '• The database stores ONLY the SHA-256 token hash.\n' +
      '• The raw token cannot be recovered from the database.\n' +
      '• No merchant or owner record has been provisioned.\n' +
      '==================================================\n\n'
    );
  } catch (error) {
    if (error instanceof MerchantInvitationError) {
      process.stderr.write(`Invitation error [${error.code}]: ${error.message}\n`);
    } else {
      process.stderr.write(`Unexpected error: ${error.message}\n`);
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

if (require.main === module) {
  run();
}

module.exports = { parseArgs, run };
