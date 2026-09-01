'use strict';

const readline = require('readline/promises');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const TARGET_SHOP_SLUG = 'gg-beauty';
const CONFIRMATION_TEXT =
  'CREATE OWNER FOR gg-beauty';
const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 16;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_TEXT_LENGTH = 200;

class BootstrapError extends Error {
  constructor(publicMessage) {
    super(publicMessage);
    this.name = 'BootstrapError';
    this.publicMessage = publicMessage;
  }
}

const normalizeLoginIdentifier = value =>
  value.trim().toLowerCase();

const readHiddenInput = prompt =>
  new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (
      !input.isTTY ||
      !output.isTTY ||
      typeof input.setRawMode !== 'function'
    ) {
      reject(new BootstrapError(
        'A secure interactive TTY is required.'
      ));
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
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const handleData = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new BootstrapError('Bootstrap cancelled.'));
          return;
        }

        if (character === '\u0004') {
          finish(new BootstrapError('Secure input closed.'));
          return;
        }

        if (character === '\r' || character === '\n') {
          finish(null, value);
          return;
        }

        if (
          character === '\u007f' ||
          character === '\b'
        ) {
          value = Array.from(value)
            .slice(0, -1)
            .join('');
          continue;
        }

        if (
          character < ' ' ||
          character === '\u001b'
        ) {
          continue;
        }

        value += character;

        if (value.length > MAX_PASSWORD_LENGTH) {
          finish(new BootstrapError('Password is too long.'));
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

const rollbackTransaction = async client => {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch (_rollbackError) {
    return false;
  }
};

const collectInputs = async () => {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    throw new BootstrapError(
      'A secure interactive TTY is required.'
    );
  }

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let confirmation;
  let loginIdentifier;
  let displayName;

  try {
    confirmation = await terminal.question(
      `Type "${CONFIRMATION_TEXT}" to continue: `
    );

    if (confirmation !== CONFIRMATION_TEXT) {
      throw new BootstrapError('Confirmation did not match.');
    }

    loginIdentifier = (
      await terminal.question('Login identifier: ')
    ).trim();
    displayName = (
      await terminal.question('Display name: ')
    ).trim();
  } finally {
    terminal.close();
  }

  if (
    !loginIdentifier ||
    loginIdentifier.length > MAX_TEXT_LENGTH
  ) {
    throw new BootstrapError('Login identifier is invalid.');
  }

  if (
    !displayName ||
    displayName.length > MAX_TEXT_LENGTH
  ) {
    throw new BootstrapError('Display name is invalid.');
  }

  let password = await readHiddenInput('Password: ');
  let passwordConfirmation =
    await readHiddenInput('Confirm Password: ');

  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.trim() === ''
  ) {
    password = null;
    passwordConfirmation = null;
    throw new BootstrapError(
      `Password must contain at least ${MIN_PASSWORD_LENGTH} characters.`
    );
  }

  if (password !== passwordConfirmation) {
    password = null;
    passwordConfirmation = null;
    throw new BootstrapError('Passwords do not match.');
  }

  passwordConfirmation = null;

  return {
    loginIdentifier,
    loginIdentifierNormalized:
      normalizeLoginIdentifier(loginIdentifier),
    displayName,
    password
  };
};

const createOwner = async inputs => {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new BootstrapError('DATABASE_URL is not configured.');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
      rejectUnauthorized: false
    }
  });

  let client;
  let transactionActive = false;
  let discardClient = false;
  let password = inputs.password;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionActive = true;

    const shopResult = await client.query(
      `
      SELECT id
      FROM public.shops
      WHERE slug = $1
        AND status = 'active'
      FOR SHARE
      `,
      [TARGET_SHOP_SLUG]
    );

    if (shopResult.rows.length !== 1) {
      throw new BootstrapError('Target shop is unavailable.');
    }

    const existingAccountResult = await client.query(
      `
      SELECT id
      FROM public.owner_accounts
      WHERE login_identifier_normalized = $1
      LIMIT 2
      FOR SHARE
      `,
      [inputs.loginIdentifierNormalized]
    );

    if (existingAccountResult.rows.length > 0) {
      throw new BootstrapError('owner account already exists');
    }

    const passwordHash = await bcrypt.hash(
      password,
      BCRYPT_COST
    );
    password = null;
    inputs.password = null;

    const accountResult = await client.query(
      `
      INSERT INTO public.owner_accounts (
        login_identifier,
        login_identifier_normalized,
        password_hash,
        display_name,
        is_active,
        session_version,
        failed_login_attempts,
        locked_until,
        password_changed_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        TRUE,
        1,
        0,
        NULL,
        NOW(),
        NOW(),
        NOW()
      )
      RETURNING id
      `,
      [
        inputs.loginIdentifier,
        inputs.loginIdentifierNormalized,
        passwordHash,
        inputs.displayName
      ]
    );

    if (accountResult.rows.length !== 1) {
      throw new BootstrapError('Owner account creation failed.');
    }

    const membershipResult = await client.query(
      `
      INSERT INTO public.owner_shop_memberships (
        owner_account_id,
        shop_id,
        role,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, 'owner', TRUE, NOW(), NOW())
      RETURNING id
      `,
      [accountResult.rows[0].id, shopResult.rows[0].id]
    );

    if (membershipResult.rows.length !== 1) {
      throw new BootstrapError('Owner membership creation failed.');
    }

    await client.query('COMMIT');
    transactionActive = false;

    process.stdout.write(
      'Owner account created successfully.\n' +
      `Shop: ${TARGET_SHOP_SLUG}\n` +
      'Role: owner\n'
    );
  } catch (error) {
    if (client && transactionActive) {
      const rollbackSucceeded =
        await rollbackTransaction(client);
      transactionActive = false;
      discardClient = !rollbackSucceeded;
    }

    if (
      error &&
      error.code === '23505' &&
      error.constraint ===
        'owner_accounts_login_identifier_normalized_key'
    ) {
      throw new BootstrapError('owner account already exists');
    }

    throw error;
  } finally {
    password = null;
    inputs.password = null;

    if (client) {
      client.release(discardClient || undefined);
    }

    await pool.end();
  }
};

const main = async () => {
  try {
    const inputs = await collectInputs();
    await createOwner(inputs);
  } catch (error) {
    const message =
      error instanceof BootstrapError
        ? error.publicMessage
        : 'Owner bootstrap failed.';

    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
};

main();
