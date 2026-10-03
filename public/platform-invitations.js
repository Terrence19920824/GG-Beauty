(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  let currentLocale = 'en';
  let invitations = [];
  let currentFilter = 'all';

  const t = (key, params) => {
    if (root.ggI18n && typeof root.ggI18n.t === 'function') {
      return root.ggI18n.t(key, currentLocale, params);
    }
    return key;
  };

  const applyTranslations = () => {
    const document = root.document;
    if (!document) return;

    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        el.textContent = t(key);
      }
    });

    const isZh = currentLocale === 'zh-CN';
    const zhBtn = document.getElementById('lang-zh');
    const enBtn = document.getElementById('lang-en');
    if (zhBtn) zhBtn.setAttribute('aria-pressed', isZh ? 'true' : 'false');
    if (enBtn) enBtn.setAttribute('aria-pressed', !isZh ? 'true' : 'false');

    document.documentElement.lang = isZh ? 'zh-CN' : 'en';

    // Update document title
    document.title = t('platformPageTitle');
  };

  const setLocale = locale => {
    currentLocale = locale === 'zh' || locale === 'zh-CN' ? 'zh-CN' : 'en';
    if (root.ggI18n && typeof root.ggI18n.setLocale === 'function') {
      root.ggI18n.setLocale(currentLocale, root.localStorage);
    }
    applyTranslations();
    renderInvitations();
  };

  const formatTimestamp = isoString => {
    if (!isoString) return '-';
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return '-';
      return date.toLocaleString(currentLocale === 'zh-CN' ? 'zh-CN' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_err) {
      return isoString;
    }
  };

  const clearCreatedUrl = () => {
    const document = root.document;
    if (!document) return;
    const banner = document.getElementById('created-url-banner');
    const urlInput = document.getElementById('created-url-input');
    const copyMsg = document.getElementById('copy-message');
    if (urlInput) {
      urlInput.value = '';
      urlInput.removeAttribute('value');
    }
    if (copyMsg) {
      copyMsg.textContent = '';
    }
    if (banner) {
      banner.hidden = true;
    }
  };

  const showView = viewName => {
    const loginView = document.getElementById('login-view');
    const mainView = document.getElementById('main-view');
    const logoutBtn = document.getElementById('logout-btn');

    if (viewName === 'main') {
      if (loginView) loginView.hidden = true;
      if (mainView) mainView.hidden = false;
      if (logoutBtn) logoutBtn.hidden = false;
    } else {
      clearCreatedUrl();
      if (loginView) loginView.hidden = false;
      if (mainView) mainView.hidden = true;
      if (logoutBtn) logoutBtn.hidden = true;
    }
  };

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/platform/me', {
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        showView('main');
        await loadInvitations();
      } else {
        showView('login');
      }
    } catch (_error) {
      showView('login');
    }
  };

  const handleLogin = async event => {
    event.preventDefault();
    const tokenInput = document.getElementById('admin-token');
    const messageEl = document.getElementById('login-message');
    const submitBtn = document.getElementById('login-submit-btn');

    const token = tokenInput ? tokenInput.value.trim() : '';
    if (!token) return;

    if (submitBtn) submitBtn.disabled = true;
    if (messageEl) {
      messageEl.textContent = t('platformLoggingIn');
      messageEl.className = 'form-message';
    }

    try {
      const res = await fetch('/api/platform/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ token })
      });

      const body = await res.json().catch(() => ({}));

      if (res.ok && body.success) {
        if (tokenInput) tokenInput.value = '';
        if (messageEl) messageEl.textContent = '';
        showView('main');
        await loadInvitations();
      } else {
        if (messageEl) {
          messageEl.textContent = t('platformLoginFailed');
          messageEl.className = 'form-message error';
        }
      }
    } catch (_err) {
      if (messageEl) {
        messageEl.textContent = t('platformLoginFailed');
        messageEl.className = 'form-message error';
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  };

  const handleLogout = async () => {
    clearCreatedUrl();
    try {
      await fetch('/api/platform/logout', {
        method: 'POST',
        headers: { 'Accept': 'application/json' }
      });
    } catch (_err) {
      // ignore network errors on logout
    }
    invitations = [];
    showView('login');
  };

  const loadInvitations = async () => {
    const loadingEl = document.getElementById('invitations-loading');
    const listEl = document.getElementById('invitations-list');
    if (loadingEl) loadingEl.hidden = false;
    if (listEl) listEl.innerHTML = '';

    try {
      const res = await fetch('/api/platform/invitations', {
        headers: { 'Accept': 'application/json' }
      });

      if (!res.ok) {
        if (res.status === 401) {
          showView('login');
          return;
        }
        throw new Error('LIST_FAILED');
      }

      const body = await res.json();
      invitations = Array.isArray(body.data) ? body.data : [];
      renderInvitations();
    } catch (_err) {
      if (listEl) {
        listEl.innerHTML = `<div class="empty-state">${t('platformLoadFailed')}</div>`;
      }
    } finally {
      if (loadingEl) loadingEl.hidden = true;
    }
  };

  const renderInvitations = () => {
    const listEl = document.getElementById('invitations-list');
    if (!listEl) return;

    const filtered = invitations.filter(inv => {
      if (currentFilter === 'all') return true;
      return inv.status === currentFilter;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="empty-state">${t('platformNoInvitations')}</div>`;
      return;
    }

    const statusBadgeClass = {
      pending: 'badge-pending',
      consumed: 'badge-consumed',
      expired: 'badge-expired',
      revoked: 'badge-revoked'
    };

    const statusLabelKey = {
      pending: 'platformStatusPending',
      consumed: 'platformStatusConsumed',
      expired: 'platformStatusExpired',
      revoked: 'platformStatusRevoked'
    };

    listEl.innerHTML = filtered.map(inv => {
      const badgeCls = statusBadgeClass[inv.status] || 'badge-expired';
      const labelKey = statusLabelKey[inv.status] || 'platformStatus';
      const isPending = inv.status === 'pending';

      const hintRow = inv.merchantNameHint
        ? `<div><span class="detail-label">${t('platformMerchantNameHint')}</span><span class="detail-val">${escapeHtml(inv.merchantNameHint)}</span></div>`
        : '';
      const emailRow = inv.contactEmail
        ? `<div><span class="detail-label">${t('platformContactEmail')}</span><span class="detail-val">${escapeHtml(inv.contactEmail)}</span></div>`
        : '';
      const phoneRow = inv.contactPhone
        ? `<div><span class="detail-label">${t('platformContactPhone')}</span><span class="detail-val">${escapeHtml(inv.contactPhone)}</span></div>`
        : '';

      const consumedRow = inv.consumedAt
        ? `<div><span class="detail-label">${t('platformConsumedAt')}</span><span class="detail-val">${formatTimestamp(inv.consumedAt)}</span></div>`
        : '';
      const revokedRow = inv.revokedAt
        ? `<div><span class="detail-label">${t('platformRevokedAt')}</span><span class="detail-val">${formatTimestamp(inv.revokedAt)}</span></div>`
        : '';

      const revokeButton = isPending
        ? `<div class="item-actions">
             <button type="button" class="btn-danger" data-action="revoke" data-id="${escapeHtml(inv.id)}">${t('platformRevoke')}</button>
           </div>`
        : '';

      return `
        <article class="invitation-item" data-id="${escapeHtml(inv.id)}">
          <div class="item-header">
            <span class="item-id">${escapeHtml(inv.id)}</span>
            <span class="badge ${badgeCls}">${t(labelKey)}</span>
          </div>
          <div class="item-details">
            ${hintRow}
            ${emailRow}
            ${phoneRow}
            <div><span class="detail-label">${t('platformCreatedAt')}</span><span class="detail-val">${formatTimestamp(inv.createdAt)}</span></div>
            <div><span class="detail-label">${t('platformExpiresAt')}</span><span class="detail-val">${formatTimestamp(inv.expiresAt)}</span></div>
            ${consumedRow}
            ${revokedRow}
          </div>
          ${revokeButton}
        </article>
      `;
    }).join('');

    // Attach revoke event handlers
    listEl.querySelectorAll('button[data-action="revoke"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        if (id) confirmAndRevoke(id);
      });
    });
  };

  const escapeHtml = str => {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  const confirmAndRevoke = async id => {
    const confirmation = root.confirm(t('platformConfirmRevoke'));
    if (!confirmation) return;

    try {
      const res = await fetch(`/api/platform/invitations/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) {
        // Update local status immediately
        const target = invitations.find(i => i.id === id);
        if (target) {
          target.status = 'revoked';
          target.revokedAt = new Date().toISOString();
        }
        renderInvitations();
      } else {
        root.alert(t('platformRevokeFailed'));
      }
    } catch (_err) {
      root.alert(t('platformRevokeFailed'));
    }
  };

  const handleCreate = async event => {
    event.preventDefault();
    clearCreatedUrl();
    const form = document.getElementById('create-invitation-form');
    const submitBtn = document.getElementById('create-submit-btn');
    const messageEl = document.getElementById('create-message');

    const nameHint = (document.getElementById('merchant-name-hint')?.value || '').trim();
    const contactEmail = (document.getElementById('contact-email')?.value || '').trim();
    const contactPhone = (document.getElementById('contact-phone')?.value || '').trim();
    const ttlDaysVal = parseInt(document.getElementById('ttl-days')?.value, 10) || 7;

    if (submitBtn) submitBtn.disabled = true;
    if (messageEl) {
      messageEl.textContent = t('platformCreating');
      messageEl.className = 'form-message';
    }

    try {
      const res = await fetch('/api/platform/invitations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          merchantNameHint: nameHint || undefined,
          contactEmail: contactEmail || undefined,
          contactPhone: contactPhone || undefined,
          ttlDays: ttlDaysVal
        })
      });

      const body = await res.json().catch(() => ({}));

      if (res.ok && body.success && body.data) {
        if (messageEl) messageEl.textContent = '';
        if (form) form.reset();
        document.getElementById('ttl-days').value = '7';

        // Hide creation panel
        const panel = document.getElementById('create-panel');
        if (panel) panel.hidden = true;

        // Display created URL in one-time banner
        const banner = document.getElementById('created-url-banner');
        const urlInput = document.getElementById('created-url-input');
        if (urlInput) urlInput.value = body.data.onboardingUrl;
        if (banner) banner.hidden = false;

        // Add to local list and render
        invitations.unshift({
          id: body.data.invitationId,
          status: body.data.status,
          expiresAt: body.data.expiresAt,
          createdAt: body.data.createdAt,
          merchantNameHint: body.data.merchantNameHint,
          contactEmail: body.data.contactEmail,
          contactPhone: body.data.contactPhone,
          createdBy: body.data.createdBy
        });
        renderInvitations();
      } else {
        if (messageEl) {
          messageEl.textContent = t('platformCreateFailed');
          messageEl.className = 'form-message error';
        }
      }
    } catch (_err) {
      if (messageEl) {
        messageEl.textContent = t('platformCreateFailed');
        messageEl.className = 'form-message error';
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  };

  const copyCreatedUrl = async () => {
    const input = document.getElementById('created-url-input');
    const msg = document.getElementById('copy-message');
    if (!input || !input.value) return;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(input.value);
      } else {
        input.select();
        document.execCommand('copy');
      }
      if (msg) {
        msg.textContent = t('platformLinkCopied');
        setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
      }
    } catch (_err) {
      if (msg) msg.textContent = t('platformCopyFailed');
    }
  };

  const init = () => {
    const doc = root.document;
    if (!doc) return;

    // Detect initial locale
    if (root.ggI18n && typeof root.ggI18n.getStoredLocale === 'function') {
      currentLocale = root.ggI18n.getStoredLocale(root.localStorage, root.navigator);
    }
    applyTranslations();

    // Language buttons
    doc.getElementById('lang-zh')?.addEventListener('click', () => setLocale('zh-CN'));
    doc.getElementById('lang-en')?.addEventListener('click', () => setLocale('en'));

    // Login form
    doc.getElementById('login-form')?.addEventListener('submit', handleLogin);

    // Logout button
    doc.getElementById('logout-btn')?.addEventListener('click', handleLogout);

    // Toggle creation panel
    doc.getElementById('toggle-create-btn')?.addEventListener('click', () => {
      const panel = doc.getElementById('create-panel');
      if (panel) panel.hidden = !panel.hidden;
    });

    doc.getElementById('cancel-create-btn')?.addEventListener('click', () => {
      const panel = doc.getElementById('create-panel');
      if (panel) panel.hidden = true;
    });

    // Create form submit
    doc.getElementById('create-invitation-form')?.addEventListener('submit', handleCreate);

    // Copy link button
    doc.getElementById('copy-url-btn')?.addEventListener('click', copyCreatedUrl);

    // Dismiss banner button
    doc.getElementById('dismiss-url-btn')?.addEventListener('click', clearCreatedUrl);

    // Wipe DOM state on browser unload / hide
    root.addEventListener?.('beforeunload', clearCreatedUrl);
    root.addEventListener?.('pagehide', clearCreatedUrl);

    // Filter tabs
    doc.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        doc.querySelectorAll('.tab-btn').forEach(b => b.setAttribute('aria-selected', 'false'));
        btn.setAttribute('aria-selected', 'true');
        currentFilter = btn.getAttribute('data-filter') || 'all';
        renderInvitations();
      });
    });

    // Initial session check
    checkAuth();
  };

  if (typeof root.document !== 'undefined') {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return {
    init,
    setLocale,
    t,
    clearCreatedUrl
  };
});
