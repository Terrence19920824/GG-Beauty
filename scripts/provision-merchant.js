'use strict';

const readline = require('readline/promises');
const { Pool } = require('pg');
const {
  provisionMerchant,
  MerchantProvisioningError
} = require('../lib/merchant-provisioning');

const MIN_PASSWORD_LENGTH = 16;
const MAX_PASSWORD_LENGTH = 1024;

const readHiddenInput = prompt =>
  new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('A secure interactive TTY is required for password entry.'));
      return;
    }

    let value = '';
    let settled = false;
    const previousRawMode = input.isRaw === true;

    const cleanup = () => {
      input.off('data', handleData);
      input.setRawMode(previousRawMode);
      input.pause();
      output.write('\n');
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    const handleData = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('Input cancelled.'));
          return;
        }
        if (character === '\u0004') {
          finish(new Error('Secure input closed.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(null, value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character < ' ' || character === '\u001b') continue;
        value += character;
        if (value.length > MAX_PASSWORD_LENGTH) {
          finish(new Error('Password is too long.'));
          return;
        }
      }
    };

    output.write(prompt);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', handleData);
  });

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
    }
  }
  return args;
};

const run = async () => {
  const cliArgs = parseArgs(process.argv);

  if (cliArgs.help || cliArgs.h) {
    process.stdout.write(
      'Usage: node scripts/provision-merchant.js [options]\n\n' +
      'Options:\n' +
      '  --name <name>                     Merchant business name\n' +
      '  --slug <slug>                     Merchant slug (lowercase alphanumeric and hyphens)\n' +
      '  --tenant-mode <mode>              Tenant mode: live | demo | test (default: live)\n' +
      '  --location-name <name>            Primary location name (default: Main Branch)\n' +
      '  --timezone <iana-tz>              Location timezone (default: Asia/Singapore)\n' +
      '  --categories-json <json-array>    JSON array of { name, description }\n' +
      '  --owner-login <login>             Initial owner login identifier\n' +
      '  --owner-name <display-name>       Initial owner display name\n' +
      '  --help, -h                        Show this help message\n'
    );
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is not configured.\n');
    process.exitCode = 1;
    return;
  }

  let name = cliArgs.name;
  let slug = cliArgs.slug;
  let tenantMode = cliArgs['tenant-mode'] || cliArgs.tenantMode || 'live';
  let locationName = cliArgs['location-name'] || cliArgs.locationName || 'Main Branch';
  let timezone = cliArgs.timezone || 'Asia/Singapore';
  let categoriesJson = cliArgs['categories-json'] || cliArgs.categoriesJson;
  let ownerLogin = cliArgs['owner-login'] || cliArgs.ownerLogin;
  let ownerName = cliArgs['owner-name'] || cliArgs.ownerName;

  let categories = [];
  if (categoriesJson) {
    try {
      categories = JSON.parse(categoriesJson);
    } catch (_) {
      process.stderr.write('Invalid categories-json: must be valid JSON array\n');
      process.exitCode = 1;
      return;
    }
  }

  // Interactive prompts if missing in TTY
  if ((!name || !slug) && process.stdin.isTTY) {
    const terminal = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    try {
      if (!name) name = (await terminal.question('Merchant name: ')).trim();
      if (!slug) slug = (await terminal.question('Merchant slug: ')).trim();
      if (!cliArgs['tenant-mode'] && !cliArgs.tenantMode) {
        const modeInput = (await terminal.question('Tenant mode [live/demo/test] (default: live): ')).trim();
        if (modeInput) tenantMode = modeInput;
      }
    } finally {
      terminal.close();
    }
  }

  let owner = null;
  if (ownerLogin) {
    if (!ownerName && process.stdin.isTTY) {
      const terminal = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      try {
        ownerName = (await terminal.question('Owner display name: ')).trim();
      } finally {
        terminal.close();
      }
    }

    let password = cliArgs['owner-password'] || cliArgs.ownerPassword;
    if (!password) {
      password = await readHiddenInput('Owner password: ');
      const confirm = await readHiddenInput('Confirm owner password: ');
      if (password !== confirm) {
        password = null;
        process.stderr.write('Passwords do not match.\n');
        process.exitCode = 1;
        return;
      }
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      process.stderr.write(`Password must contain at least ${MIN_PASSWORD_LENGTH} characters.\n`);
      process.exitCode = 1;
      return;
    }

    owner = {
      loginIdentifier: ownerLogin,
      displayName: ownerName || ownerLogin,
      password
    };
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const result = await provisionMerchant(pool, {
      name,
      slug,
      tenantMode,
      location: {
        name: locationName,
        timezone
      },
      categories,
      owner
    });

    process.stdout.write(
      'Merchant provisioned successfully.\n' +
      `Shop ID:     ${result.shop.id}\n` +
      `Slug:        ${result.shop.slug}\n` +
      `Name:        ${result.shop.name}\n` +
      `Tenant Mode: ${result.shop.tenantMode}\n` +
      `Status:      ${result.shop.status}\n` +
      `Location ID: ${result.location.id} (${result.location.name}, ${result.location.timezone})\n` +
      `Categories:  ${result.categories.length}\n` +
      (result.owner ? `Owner:       ${result.owner.loginIdentifier} (${result.owner.displayName})\n` : 'Owner:       None (provision separately via bootstrap-owner.js)\n')
    );
  } catch (error) {
    const message = error instanceof MerchantProvisioningError
      ? error.publicMessage
      : error.message || 'Merchant provisioning failed.';
    process.stderr.write(`Provisioning failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

if (require.main === module) {
  run().catch(err => {
    process.stderr.write(`Unexpected error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run };
