'use strict';

const crypto = require('crypto');
const { buildAutoMapUrl } = require('./merchant-contact');

const TIMEZONE = 'Asia/Singapore';
const CALENDAR_TOKEN_TTL_SECONDS = 90 * 86400; // 90 days
const MIN_SECRET_BYTES = 32;

function getSigningSecret(customSecret) {
  const candidate = (customSecret !== undefined) ? customSecret : process.env.CALENDAR_TOKEN_SECRET;
  if (!candidate) return null;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (Buffer.byteLength(trimmed, 'utf8') < MIN_SECRET_BYTES) {
      return null;
    }
    return trimmed;
  }
  if (Buffer.isBuffer(candidate)) {
    if (candidate.length < MIN_SECRET_BYTES) {
      return null;
    }
    return candidate;
  }
  return null;
}

function generateCalendarToken({ appointmentId, shopId, secret, ttlSeconds = CALENDAR_TOKEN_TTL_SECONDS }) {
  if (!appointmentId || !shopId) {
    return null;
  }
  const signingSecret = getSigningSecret(secret);
  if (!signingSecret) {
    return null;
  }
  const effectiveTtl = (typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds))
    ? Math.floor(ttlSeconds)
    : CALENDAR_TOKEN_TTL_SECONDS;

  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    aid: String(appointmentId),
    sid: String(shopId),
    iat: nowSec,
    exp: nowSec + effectiveTtl
  };
  const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', signingSecret)
    .update(payloadEncoded)
    .digest('base64url');
  return `${payloadEncoded}.${signature}`;
}

function verifyCalendarToken(token, secret) {
  const signingSecret = getSigningSecret(secret);
  if (!signingSecret) return null;

  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadEncoded, signature] = parts;
  if (!payloadEncoded || !signature) return null;

  const expectedSig = crypto
    .createHmac('sha256', signingSecret)
    .update(payloadEncoded)
    .digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSig);
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.aid !== 'string' || !payload.aid.trim()) return null;
    if (typeof payload.sid !== 'string' || !payload.sid.trim()) return null;

    // exp claim is strictly REQUIRED
    if (payload.exp === undefined || payload.exp === null) return null;
    if (typeof payload.exp !== 'number' || !Number.isInteger(payload.exp) || !Number.isFinite(payload.exp)) {
      return null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp <= nowSec) {
      return null;
    }

    return { appointmentId: payload.aid, shopId: payload.sid };
  } catch (_) {
    return null;
  }
}

function toSingaporeLocalIcs(date) {
  const d = new Date(date);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(d);
  const get = type => parts.find(p => p.type === type)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`;
}

function toUtcIcs(date) {
  const d = new Date(date);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcsText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function foldIcsLine(line, maxOctets = 75) {
  if (typeof line !== 'string') return '';
  if (Buffer.byteLength(line, 'utf8') <= maxOctets) {
    return line;
  }

  const chunks = [];
  let currentChunk = '';
  let currentBytes = 0;
  let isFirstLine = true;

  for (const char of line) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    const limit = isFirstLine ? maxOctets : (maxOctets - 1);
    if (currentBytes + charBytes > limit) {
      chunks.push(currentChunk);
      currentChunk = char;
      currentBytes = charBytes;
      isFirstLine = false;
    } else {
      currentChunk += char;
      currentBytes += charBytes;
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  return chunks.join('\r\n ');
}

function buildCalendarEventProjection({ appointment, items = [], shop = {}, settings = {} }) {
  const merchantDisplayName = (settings.public_display_name && String(settings.public_display_name).trim().length > 0)
    ? String(settings.public_display_name).trim()
    : (shop.name || 'GG-Beauty');

  let serviceNames = [];
  if (Array.isArray(items) && items.length > 0) {
    serviceNames = items.map(item => String(item.name || item.service_name_snapshot || '')).filter(Boolean);
  }
  if (serviceNames.length === 0 && appointment.legacy_service_name) {
    serviceNames = [String(appointment.legacy_service_name)];
  }
  if (serviceNames.length === 0) {
    serviceNames = ['Appointment'];
  }

  const primaryService = serviceNames[0];
  const title = serviceNames.length > 1
    ? `${merchantDisplayName} — ${primaryService} +${serviceNames.length - 1}`
    : `${merchantDisplayName} — ${primaryService}`;

  const showAddress = settings.show_public_address !== false;
  const publicAddress = (showAddress && settings.public_address) ? String(settings.public_address).trim() : null;
  const publicPostalCode = (showAddress && settings.public_postal_code) ? String(settings.public_postal_code).trim() : null;

  let locationText = null;
  let mapUrl = null;

  if (showAddress && (publicAddress || publicPostalCode)) {
    locationText = [publicAddress, publicPostalCode].filter(Boolean).join(' ');
    if (settings.public_map_url && /^https:\/\//i.test(String(settings.public_map_url).trim())) {
      mapUrl = String(settings.public_map_url).trim();
    } else {
      mapUrl = buildAutoMapUrl(publicAddress, publicPostalCode);
    }
  }

  const appointmentNo = appointment.appointment_no || (appointment.id ? String(appointment.id).slice(0, 8) : '');
  const descriptionLines = [
    `Your appointment at ${merchantDisplayName}`,
    `Booking Reference: ${appointmentNo}`,
    `Services: ${serviceNames.join(', ')}`
  ];
  if (locationText) {
    descriptionLines.push(`Address: ${locationText}`);
  }
  if (mapUrl) {
    descriptionLines.push(`Map: ${mapUrl}`);
  }
  const description = descriptionLines.join('\n');

  return {
    title,
    startAt: appointment.start_at,
    endAt: appointment.end_at,
    location: locationText,
    description,
    appointmentNo,
    appointmentId: appointment.id,
    createdAt: appointment.created_at || appointment.start_at,
    merchantDisplayName
  };
}

function formatIcsCalendar(event) {
  const dtStamp = toUtcIcs(event.createdAt || event.startAt);
  const dtStart = toSingaporeLocalIcs(event.startAt);
  const dtEnd = toSingaporeLocalIcs(event.endAt);
  const uid = `apt-${event.appointmentId || event.appointmentNo}@ggbeauty.app`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GG-Beauty//Booking Calendar V1//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE',
    `TZID:${TIMEZONE}`,
    `X-LIC-LOCATION:${TIMEZONE}`,
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:SGT',
    'DTSTART:19700101T000000',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART;TZID=${TIMEZONE}:${dtStart}`,
    `DTEND;TZID=${TIMEZONE}:${dtEnd}`,
    `SUMMARY:${escapeIcsText(event.title)}`
  ];

  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }

  lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  lines.push('STATUS:CONFIRMED');
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.map(line => foldIcsLine(line, 75)).join('\r\n') + '\r\n';
}

function buildGoogleCalendarUrl({ title, startAt, endAt, description, location }) {
  const startUtc = toUtcIcs(startAt);
  const endUtc = toUtcIcs(endAt);
  const datesParam = `${startUtc}/${endUtc}`;

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: datesParam,
    ctz: TIMEZONE,
    details: description || ''
  });

  if (location) {
    params.set('location', location);
  }

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

async function loadAuthoritativeCalendarData(pool, { appointmentId, shopId }) {
  const query = `
    SELECT
      a.id,
      a.shop_id,
      a.appointment_no,
      a.start_at,
      a.end_at,
      a.status,
      a.created_at,
      s.name AS shop_name,
      settings.public_display_name,
      settings.public_address,
      settings.public_postal_code,
      settings.public_map_url,
      settings.show_public_address,
      legacy_s.name AS legacy_service_name,
      ai.items
    FROM appointments a
    JOIN shops s ON s.id = a.shop_id
    LEFT JOIN shop_customer_settings settings ON settings.shop_id = a.shop_id
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'sequenceNo', i.sequence_no,
          'name', i.service_name_snapshot
        ) ORDER BY i.sequence_no ASC
      ) AS items
      FROM appointment_items i
      WHERE i.appointment_id = a.id AND i.shop_id = a.shop_id
    ) ai ON true
    LEFT JOIN services legacy_s ON legacy_s.id = a.service_id
    WHERE a.id = $1 AND a.shop_id = $2
    LIMIT 1
  `;

  let row = null;
  try {
    const result = await pool.query(query, [appointmentId, shopId]);
    if (result.rows.length === 0) return null;
    row = result.rows[0];
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      const fallbackQuery = `
        SELECT
          a.id, a.shop_id, a.appointment_no, a.start_at, a.end_at, a.status, a.created_at,
          s.name AS shop_name,
          legacy_s.name AS legacy_service_name,
          ai.items
        FROM appointments a
        JOIN shops s ON s.id = a.shop_id
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'sequenceNo', i.sequence_no,
              'name', i.service_name_snapshot
            ) ORDER BY i.sequence_no ASC
          ) AS items
          FROM appointment_items i
          WHERE i.appointment_id = a.id AND i.shop_id = a.shop_id
        ) ai ON true
        LEFT JOIN services legacy_s ON legacy_s.id = a.service_id
        WHERE a.id = $1 AND a.shop_id = $2
        LIMIT 1
      `;
      try {
        const fallbackResult = await pool.query(fallbackQuery, [appointmentId, shopId]);
        if (fallbackResult.rows.length === 0) return null;
        row = fallbackResult.rows[0];
      } catch (_) {
        return null;
      }
    } else {
      throw err;
    }
  }

  if (!row) return null;

  return buildCalendarEventProjection({
    appointment: {
      id: row.id,
      appointment_no: row.appointment_no,
      start_at: row.start_at,
      end_at: row.end_at,
      status: row.status,
      created_at: row.created_at,
      legacy_service_name: row.legacy_service_name
    },
    items: row.items || [],
    shop: { name: row.shop_name },
    settings: {
      public_display_name: row.public_display_name,
      public_address: row.public_address,
      public_postal_code: row.public_postal_code,
      public_map_url: row.public_map_url,
      show_public_address: row.show_public_address
    }
  });
}

module.exports = {
  TIMEZONE,
  MIN_SECRET_BYTES,
  CALENDAR_TOKEN_TTL_SECONDS,
  getSigningSecret,
  generateCalendarToken,
  verifyCalendarToken,
  toSingaporeLocalIcs,
  toUtcIcs,
  escapeIcsText,
  foldIcsLine,
  buildCalendarEventProjection,
  formatIcsCalendar,
  buildGoogleCalendarUrl,
  loadAuthoritativeCalendarData
};
