(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const STATE_KEYS = Object.freeze({
    INVALID: ['onboardingInvalidTitle', 'onboardingInvalidBody'],
    EXPIRED: ['onboardingExpiredTitle', 'onboardingExpiredBody'],
    REVOKED: ['onboardingRevokedTitle', 'onboardingRevokedBody'],
    ALREADY_CONSUMED: ['onboardingConsumedTitle', 'onboardingConsumedBody']
  });

  const ERROR_KEYS = Object.freeze({
    DUPLICATE_SLUG: 'onboardingDuplicateSlug',
    DUPLICATE_OWNER_LOGIN: 'onboardingDuplicateOwner',
    PASSWORD_CONFIRMATION_MISMATCH: 'onboardingPasswordMismatch',
    INVITATION_INVALID: 'onboardingInvalidBody',
    INVITATION_EXPIRED: 'onboardingExpiredBody',
    INVITATION_REVOKED: 'onboardingRevokedBody',
    INVITATION_ALREADY_CONSUMED: 'onboardingConsumedBody',
    INVITATION_CONCURRENTLY_CHANGED: 'onboardingInvitationChanged',
    INVALID_MERCHANT_NAME: 'onboardingValidationError',
    INVALID_SLUG: 'onboardingValidationError',
    INVALID_LOCATION_NAME: 'onboardingValidationError',
    INVALID_COUNTRY: 'onboardingInvalidCountry',
    INVALID_TIMEZONE: 'onboardingValidationError',
    INVALID_CURRENCY_CODE: 'onboardingValidationError',
    INVALID_LOCALE: 'onboardingValidationError',
    INVALID_OWNER_DISPLAY_NAME: 'onboardingValidationError',
    INVALID_OWNER_IDENTIFIER: 'onboardingValidationError',
    PASSWORD_TOO_SHORT: 'onboardingPasswordTooShort',
    PASSWORD_TOO_LONG: 'onboardingPasswordTooLong'
  });
  const STATE_BY_ERROR_CODE = Object.freeze({
    INVITATION_INVALID: 'INVALID',
    INVITATION_EXPIRED: 'EXPIRED',
    INVITATION_REVOKED: 'REVOKED',
    INVITATION_ALREADY_CONSUMED: 'ALREADY_CONSUMED'
  });

  const errorKeyForCode = code => ERROR_KEYS[code] || 'onboardingSafeError';
  const stateKeys = state => STATE_KEYS[state] || STATE_KEYS.INVALID;

  const initialize = () => {
    const document = root.document;
    const i18n = root.ggI18n;
    if (!document || !i18n) return;

    const elements = {
      form: document.getElementById('onboarding-form'),
      status: document.getElementById('invitation-status'),
      statusTitle: document.getElementById('status-title'),
      statusBody: document.getElementById('status-body'),
      success: document.getElementById('success-state'),
      submit: document.getElementById('submit-button'),
      formError: document.getElementById('form-error'),
      businessName: document.getElementById('business-name'),
      businessLocale: document.getElementById('business-locale'),
      password: document.getElementById('password'),
      passwordConfirmation: document.getElementById('password-confirmation'),
      passwordToggle: document.querySelector('.password-toggle'),
      languageZh: document.getElementById('language-zh'),
      languageEn: document.getElementById('language-en')
    };

    let locale = i18n.getStoredLocale(root.localStorage, root.navigator);
    let submitting = false;
    const url = new URL(root.location.href);
    let invitationToken = url.searchParams.get('token') || '';
    root.history.replaceState(null, '', url.pathname);

    const t = key => i18n.t(key, locale);

    const renderLocale = () => {
      document.documentElement.lang = locale;
      document.querySelectorAll('[data-i18n]').forEach(node => {
        node.textContent = t(node.dataset.i18n);
      });
      document.querySelectorAll('[data-i18n-aria]').forEach(node => {
        node.setAttribute('aria-label', t(node.dataset.i18nAria));
      });
      elements.languageZh.setAttribute('aria-pressed', String(locale === 'zh-CN'));
      elements.languageEn.setAttribute('aria-pressed', String(locale === 'en'));
      elements.passwordToggle.textContent = t(
        elements.password.type === 'password'
          ? 'onboardingShowPassword'
          : 'onboardingHidePassword'
      );
    };

    const setLanguage = nextLocale => {
      locale = i18n.setLocale(nextLocale, root.localStorage);
      renderLocale();
    };

    const showInvitationState = state => {
      const [titleKey, bodyKey] = stateKeys(state);
      elements.form.hidden = true;
      elements.success.hidden = true;
      elements.status.hidden = false;
      elements.status.classList.add('error');
      elements.statusTitle.dataset.i18n = titleKey;
      elements.statusBody.dataset.i18n = bodyKey;
      elements.statusTitle.textContent = t(titleKey);
      elements.statusBody.textContent = t(bodyKey);
    };

    const showSafeError = () => {
      elements.form.hidden = true;
      elements.success.hidden = true;
      elements.status.hidden = false;
      elements.status.classList.add('error');
      elements.statusTitle.dataset.i18n = 'error';
      elements.statusBody.dataset.i18n = 'onboardingSafeError';
      elements.statusTitle.textContent = t('error');
      elements.statusBody.textContent = t('onboardingSafeError');
    };

    const showFormError = key => {
      if (!key) {
        delete elements.formError.dataset.i18n;
        elements.formError.textContent = '';
        return;
      }
      elements.formError.dataset.i18n = key;
      elements.formError.textContent = t(key);
    };

    const validateInvitation = async () => {
      if (!invitationToken) {
        showInvitationState('INVALID');
        return;
      }

      try {
        const response = await root.fetch('/api/merchant-onboarding/invitation/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token: invitationToken })
        });
        const result = await response.json();
        if (!response.ok || !result.success || !result.data) {
          showSafeError();
          return;
        }
        if (result.data.state !== 'VALID') {
          showInvitationState(result.data.state);
          return;
        }

        elements.status.hidden = true;
        elements.form.hidden = false;
        if (result.data.merchantNameHint && !elements.businessName.value) {
          elements.businessName.value = result.data.merchantNameHint;
        }
      } catch (_error) {
        showSafeError();
      }
    };

    elements.languageZh.addEventListener('click', () => setLanguage('zh-CN'));
    elements.languageEn.addEventListener('click', () => setLanguage('en'));
    elements.passwordToggle.addEventListener('click', () => {
      const reveal = elements.password.type === 'password';
      elements.password.type = reveal ? 'text' : 'password';
      elements.passwordConfirmation.type = reveal ? 'text' : 'password';
      elements.passwordToggle.textContent = t(
        reveal ? 'onboardingHidePassword' : 'onboardingShowPassword'
      );
    });

    elements.form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submitting) return;
      showFormError(null);

      if (!elements.form.checkValidity()) {
        elements.form.reportValidity();
        showFormError('onboardingRequired');
        return;
      }
      if (elements.password.value !== elements.passwordConfirmation.value) {
        showFormError('onboardingPasswordMismatch');
        elements.passwordConfirmation.focus();
        return;
      }
      const pwBytes = new TextEncoder().encode(elements.password.value).length;
      if (pwBytes > 72) {
        showFormError('onboardingPasswordTooLong');
        elements.password.focus();
        return;
      }

      const data = new FormData(elements.form);
      const payload = {
        token: invitationToken,
        businessName: data.get('businessName'),
        slug: data.get('slug'),
        locationName: data.get('locationName'),
        country: data.get('country'),
        address: data.get('address'),
        postalCode: data.get('postalCode'),
        timezone: data.get('timezone'),
        currencyCode: data.get('currencyCode'),
        locale: data.get('locale'),
        ownerDisplayName: data.get('ownerDisplayName'),
        ownerLoginIdentifier: data.get('ownerLoginIdentifier'),
        password: data.get('password'),
        passwordConfirmation: data.get('passwordConfirmation')
      };

      submitting = true;
      elements.submit.disabled = true;
      elements.submit.dataset.i18n = 'onboardingSubmitting';
      elements.submit.textContent = t('onboardingSubmitting');

      try {
        const response = await root.fetch('/api/merchant-onboarding/invitation/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          if (STATE_BY_ERROR_CODE[result.code]) {
            showInvitationState(STATE_BY_ERROR_CODE[result.code]);
            return;
          }
          showFormError(errorKeyForCode(result.code));
          return;
        }

        invitationToken = '';
        elements.form.reset();
        elements.form.hidden = true;
        elements.status.hidden = true;
        elements.success.hidden = false;
      } catch (_error) {
        showFormError('onboardingSafeError');
      } finally {
        submitting = false;
        elements.submit.disabled = false;
        elements.submit.dataset.i18n = 'onboardingSubmit';
        elements.submit.textContent = t('onboardingSubmit');
      }
    });

    elements.businessLocale.value = locale;
    renderLocale();
    validateInvitation();
  };

  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
      initialize();
    }
  }

  return {
    STATE_KEYS,
    ERROR_KEYS,
    STATE_BY_ERROR_CODE,
    errorKeyForCode,
    stateKeys
  };
});
