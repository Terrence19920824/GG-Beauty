'use strict';

const OWNER_SESSION_COOKIE =
  'gg_beauty_owner_session';
const OWNER_SESSION_MAX_AGE_MS =
  12 * 60 * 60 * 1000;
const OWNER_LOGIN_RATE_LIMIT_WINDOW_MS =
  15 * 60 * 1000;
const OWNER_LOGIN_RATE_LIMIT_MAX_REQUESTS = 10;
const OWNER_LOGIN_RATE_LIMIT_MAX_KEYS = 10000;
const OWNER_LOGIN_LOCK_THRESHOLD = 5;
const OWNER_ROLE_ALLOWLIST = [
  'owner',
  'manager',
  'admin'
];
const OWNER_LOGIN_BODY_FIELDS = new Set([
  'loginIdentifier',
  'password',
  'shopSlug'
]);

const normalizeIdentifier = value =>
  typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';

const parseCookies = request => {
  const cookies = {};
  const cookieHeader = request.headers.cookie || '';

  cookieHeader.split(';').forEach(part => {
    const separatorIndex = part.indexOf('=');

    if (separatorIndex < 0) {
      return;
    }

    const name = part.slice(0, separatorIndex).trim();

    if (!name) {
      return;
    }

    const encodedValue =
      part.slice(separatorIndex + 1).trim();

    try {
      cookies[name] = decodeURIComponent(encodedValue);
    } catch (_error) {
      cookies[name] = '';
    }
  });

  return cookies;
};

const setNoStore = response => {
  response.setHeader('Cache-Control', 'no-store');
};

const ownerCookieOptions = () => [
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  `Max-Age=${Math.floor(
    OWNER_SESSION_MAX_AGE_MS / 1000
  )}`,
  ...(process.env.NODE_ENV === 'production'
    ? ['Secure']
    : [])
];

const setOwnerSessionCookie = (response, token) => {
  response.setHeader(
    'Set-Cookie',
    `${OWNER_SESSION_COOKIE}=${encodeURIComponent(token)}; ${ownerCookieOptions().join('; ')}`
  );
};

const clearOwnerSessionCookie = response => {
  const options = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(process.env.NODE_ENV === 'production'
      ? ['Secure']
      : [])
  ];

  response.setHeader(
    'Set-Cookie',
    `${OWNER_SESSION_COOKIE}=; ${options.join('; ')}`
  );
};

const createOwnerAuth = ({
  pool,
  bcrypt,
  crypto,
  isSameOriginRequest,
  safeErrorCode
}) => {
  const loginRateLimits = new Map();
  const dummyPasswordHash = bcrypt.hashSync(
    'invalid-owner-login-password',
    12
  );

  const hashSessionToken = token =>
    crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

  const loginRateLimitKey = identifier =>
    crypto
      .createHash('sha256')
      .update(identifier)
      .digest('hex');

  const consumeLoginAttempt = key => {
    const now = Date.now();

    if (
      loginRateLimits.size >=
      OWNER_LOGIN_RATE_LIMIT_MAX_KEYS
    ) {
      for (const [storedKey, entry]
        of loginRateLimits) {
        if (entry.windowEndsAt <= now) {
          loginRateLimits.delete(storedKey);
        }
      }

      if (
        loginRateLimits.size >=
        OWNER_LOGIN_RATE_LIMIT_MAX_KEYS
      ) {
        loginRateLimits.delete(
          loginRateLimits.keys().next().value
        );
      }
    }

    let entry = loginRateLimits.get(key);

    if (!entry || entry.windowEndsAt <= now) {
      entry = {
        requestCount: 0,
        windowEndsAt:
          now + OWNER_LOGIN_RATE_LIMIT_WINDOW_MS
      };
    }

    if (
      entry.requestCount >=
      OWNER_LOGIN_RATE_LIMIT_MAX_REQUESTS
    ) {
      loginRateLimits.set(key, entry);
      return false;
    }

    entry.requestCount += 1;
    loginRateLimits.set(key, entry);
    return true;
  };

  const rollbackTransaction = async client => {
    try {
      await client.query('ROLLBACK');
      return true;
    } catch (_rollbackError) {
      console.error('Owner auth rollback failed');
      return false;
    }
  };

  const requireOwnerAuth = async (
    request,
    response,
    next
  ) => {
    setNoStore(response);

    const token =
      parseCookies(request)[OWNER_SESSION_COOKIE];

    if (!token) {
      return response.status(401).json({
        success: false,
        message: '请先登录老板账号'
      });
    }

    try {
      const result = await pool.query(
        `
        SELECT
          session.owner_account_id,
          session.membership_id,
          session.shop_id,
          account.login_identifier,
          account.display_name,
          membership.role,
          shop.slug AS shop_slug,
          shop.name AS shop_name
        FROM owner_sessions session
        JOIN owner_shop_memberships membership
          ON membership.id = session.membership_id
         AND membership.owner_account_id =
           session.owner_account_id
         AND membership.shop_id = session.shop_id
        JOIN owner_accounts account
          ON account.id = session.owner_account_id
        JOIN shops shop
          ON shop.id = session.shop_id
        WHERE session.token_hash = $1
          AND session.revoked_at IS NULL
          AND session.expires_at > NOW()
          AND session.session_version =
            account.session_version
          AND account.is_active = TRUE
          AND membership.is_active = TRUE
          AND membership.role = ANY($2::TEXT[])
          AND shop.status = 'active'
        LIMIT 1
        `,
        [hashSessionToken(token), OWNER_ROLE_ALLOWLIST]
      );

      if (result.rows.length !== 1) {
        clearOwnerSessionCookie(response);

        return response.status(401).json({
          success: false,
          message: '老板登录已失效，请重新登录'
        });
      }

      const identity = result.rows[0];

      request.ownerAuth = {
        ownerAccountId: identity.owner_account_id,
        membershipId: identity.membership_id,
        shopId: identity.shop_id,
        role: identity.role,
        loginIdentifier: identity.login_identifier,
        displayName: identity.display_name,
        shopSlug: identity.shop_slug,
        shopName: identity.shop_name
      };

      next();
    } catch (error) {
      console.error(
        'Owner authentication error:',
        safeErrorCode(error)
      );

      response.status(500).json({
        success: false,
        message: '老板认证暂时不可用'
      });
    }
  };

  const login = async (request, response) => {
    setNoStore(response);

    if (!isSameOriginRequest(request)) {
      return response.status(403).json({
        success: false,
        message: '请求来源不允许'
      });
    }

    const body =
      request.body &&
      typeof request.body === 'object' &&
      !Array.isArray(request.body)
        ? request.body
        : null;
    const bodyKeys = body ? Object.keys(body) : [];

    if (
      !body ||
      bodyKeys.some(key =>
        !OWNER_LOGIN_BODY_FIELDS.has(key)
      )
    ) {
      return response.status(400).json({
        success: false,
        message: '登录请求格式不正确'
      });
    }

    const loginIdentifier =
      normalizeIdentifier(body.loginIdentifier);
    const password =
      typeof body.password === 'string'
        ? body.password
        : '';
    const shopSlug =
      body.shopSlug === undefined
        ? ''
        : normalizeIdentifier(body.shopSlug);

    if (
      !loginIdentifier ||
      !password ||
      loginIdentifier.length > 200 ||
      password.length > 1024 ||
      shopSlug.length > 200 ||
      (body.shopSlug !== undefined && !shopSlug)
    ) {
      return response.status(400).json({
        success: false,
        message: '请输入登录账号和密码'
      });
    }

    const rateLimitKey =
      loginRateLimitKey(loginIdentifier);

    if (!consumeLoginAttempt(rateLimitKey)) {
      return response.status(429).json({
        success: false,
        message: '登录请求过多，请稍后再试'
      });
    }

    let client;
    let transactionActive = false;
    let transactionCommitted = false;
    let discardClient = false;

    try {
      client = await pool.connect();
      await client.query('BEGIN');
      transactionActive = true;

      const accountResult = await client.query(
        `
        SELECT
          id,
          login_identifier,
          password_hash,
          display_name,
          is_active,
          session_version,
          failed_login_attempts,
          locked_until,
          locked_until IS NOT NULL
            AND locked_until > NOW() AS is_locked,
          locked_until IS NOT NULL
            AND locked_until <= NOW()
            AS previous_lock_expired
        FROM owner_accounts
        WHERE login_identifier_normalized = $1
        LIMIT 1
        FOR UPDATE
        `,
        [loginIdentifier]
      );

      const account = accountResult.rows[0];
      const passwordMatches = await bcrypt.compare(
        password,
        account && account.is_locked !== true
          ? account.password_hash
          : dummyPasswordHash
      );
      const accountCanLogin =
        account &&
        account.is_locked !== true &&
        account.is_active === true &&
        passwordMatches;

      if (!accountCanLogin) {
        const shouldRecordFailure =
          account &&
          account.is_locked !== true &&
          account.is_active === true &&
          !passwordMatches;

        if (shouldRecordFailure) {
          const previousFailures =
            account.previous_lock_expired === true
              ? 0
              : Number(account.failed_login_attempts || 0);
          const nextFailureCount = previousFailures + 1;

          await client.query(
            `
            UPDATE owner_accounts
            SET
              failed_login_attempts = $1::INTEGER,
              locked_until = CASE
                WHEN $1::INTEGER >= $2::INTEGER
                THEN NOW() + INTERVAL '15 minutes'
                ELSE NULL
              END,
              updated_at = NOW()
            WHERE id = $3
            `,
            [
              nextFailureCount,
              OWNER_LOGIN_LOCK_THRESHOLD,
              account.id
            ]
          );
        }

        await client.query('COMMIT');
        transactionActive = false;
        transactionCommitted = true;

        return response.status(401).json({
          success: false,
          message: '老板账号或密码不正确'
        });
      }

      const membershipResult = await client.query(
        `
        SELECT
          membership.id AS membership_id,
          membership.owner_account_id,
          membership.shop_id,
          membership.role,
          shop.slug AS shop_slug,
          shop.name AS shop_name
        FROM owner_shop_memberships membership
        JOIN shops shop
          ON shop.id = membership.shop_id
        WHERE membership.owner_account_id = $1
          AND membership.is_active = TRUE
          AND membership.role = ANY($2::TEXT[])
          AND shop.status = 'active'
        ORDER BY shop.slug ASC, membership.id ASC
        FOR SHARE OF membership, shop
        `,
        [account.id, OWNER_ROLE_ALLOWLIST]
      );

      const memberships = membershipResult.rows;

      if (memberships.length === 0) {
        await client.query('COMMIT');
        transactionActive = false;
        transactionCommitted = true;

        return response.status(403).json({
          success: false,
          message: '老板账号暂时不可用'
        });
      }

      let selectedMembership;

      if (memberships.length === 1) {
        selectedMembership = memberships[0];

        if (
          shopSlug &&
          selectedMembership.shop_slug.toLowerCase() !==
            shopSlug
        ) {
          await client.query('COMMIT');
          transactionActive = false;
          transactionCommitted = true;

          return response.status(403).json({
            success: false,
            message: '老板账号暂时不可用'
          });
        }
      } else if (!shopSlug) {
        await client.query('COMMIT');
        transactionActive = false;
        transactionCommitted = true;

        return response.status(409).json({
          success: false,
          code: 'SHOP_SELECTION_REQUIRED',
          message: '请选择店铺',
          shops: memberships.map(membership => ({
            shopSlug: membership.shop_slug,
            shopName: membership.shop_name,
            role: membership.role
          }))
        });
      } else {
        selectedMembership = memberships.find(
          membership =>
            membership.shop_slug.toLowerCase() ===
              shopSlug
        );

        if (!selectedMembership) {
          await client.query('COMMIT');
          transactionActive = false;
          transactionCommitted = true;

          return response.status(403).json({
            success: false,
            message: '老板账号暂时不可用'
          });
        }
      }

      const sessionToken =
        crypto.randomBytes(32).toString('base64url');
      const tokenHash = hashSessionToken(sessionToken);

      const sessionResult = await client.query(
        `
        INSERT INTO owner_sessions (
          token_hash,
          membership_id,
          owner_account_id,
          shop_id,
          session_version,
          expires_at,
          last_seen_at
        )
        VALUES (
          $1, $2, $3, $4, $5,
          NOW() + INTERVAL '12 hours',
          NOW()
        )
        RETURNING id
        `,
        [
          tokenHash,
          selectedMembership.membership_id,
          account.id,
          selectedMembership.shop_id,
          account.session_version
        ]
      );

      if (sessionResult.rows.length !== 1) {
        throw new Error('owner_session_insert_mismatch');
      }

      await client.query(
        `
        UPDATE owner_accounts
        SET
          last_login_at = NOW(),
          failed_login_attempts = 0,
          locked_until = NULL,
          updated_at = NOW()
        WHERE id = $1
        `,
        [account.id]
      );

      await client.query('COMMIT');
      transactionActive = false;
      transactionCommitted = true;

      loginRateLimits.delete(rateLimitKey);
      setOwnerSessionCookie(response, sessionToken);

      return response.json({
        success: true,
        data: {
          account: {
            id: account.id,
            loginIdentifier: account.login_identifier,
            displayName: account.display_name
          },
          activeShop: {
            id: selectedMembership.shop_id,
            slug: selectedMembership.shop_slug,
            name: selectedMembership.shop_name
          },
          membership: {
            id: selectedMembership.membership_id,
            role: selectedMembership.role
          }
        }
      });
    } catch (error) {
      if (
        client &&
        transactionActive &&
        !transactionCommitted
      ) {
        const rollbackSucceeded =
          await rollbackTransaction(client);

        transactionActive = false;

        if (!rollbackSucceeded) {
          discardClient = true;
        }
      }

      console.error(
        'Owner login error:',
        safeErrorCode(error)
      );

      return response.status(500).json({
        success: false,
        message: '老板登录暂时不可用'
      });
    } finally {
      if (client) {
        client.release(discardClient || undefined);
      }
    }
  };

  const me = (request, response) => {
    setNoStore(response);

    response.json({
      success: true,
      data: {
        account: {
          id: request.ownerAuth.ownerAccountId,
          loginIdentifier:
            request.ownerAuth.loginIdentifier,
          displayName: request.ownerAuth.displayName
        },
        activeShop: {
          id: request.ownerAuth.shopId,
          slug: request.ownerAuth.shopSlug,
          name: request.ownerAuth.shopName
        },
        membership: {
          id: request.ownerAuth.membershipId,
          role: request.ownerAuth.role
        }
      }
    });
  };

  const logout = async (request, response) => {
    setNoStore(response);

    if (!isSameOriginRequest(request)) {
      return response.status(403).json({
        success: false,
        message: '请求来源不允许'
      });
    }

    const token =
      parseCookies(request)[OWNER_SESSION_COOKIE];

    try {
      if (token) {
        await pool.query(
          `
          UPDATE owner_sessions
          SET
            revoked_at = COALESCE(revoked_at, NOW()),
            revoke_reason = COALESCE(
              revoke_reason,
              'logout'
            )
          WHERE token_hash = $1
          `,
          [hashSessionToken(token)]
        );
      }

      clearOwnerSessionCookie(response);

      return response.json({ success: true });
    } catch (error) {
      console.error(
        'Owner logout error:',
        safeErrorCode(error)
      );

      return response.status(500).json({
        success: false,
        message: '老板退出暂时不可用'
      });
    }
  };

  return {
    login,
    logout,
    me,
    requireOwnerAuth
  };
};

module.exports = {
  createOwnerAuth
};
