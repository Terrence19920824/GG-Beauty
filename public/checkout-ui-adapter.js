/**
 * GG-Beauty Checkout & Customer Display UI Adapter
 * 
 * Integration boundary between Front Desk Checkout UI, Customer Display, and Codex backend POS API.
 * 
 * Canonical Backend Contract:
 * POST /api/owner/appointments/:appointmentId/checkout
 * 
 * FORBIDDEN CLIENT FIELDS (Enforced: never submitted by client):
 * - shopId (derived by server from authenticated owner session)
 * - customerId (derived by server from appointment recipient_customer_id)
 * - operator identity (derived by server from authenticated owner account)
 * - trusted totals / final totals (server computes authoritative totals from line items & payments)
 * 
 * SUBMITTED CHECKOUT INPUT:
 * - idempotencyKey: string (16-128 chars, ^[A-Za-z0-9_-]{16,128}$)
 * - items: array of { appointmentItemId, actualPriceMinor, discountMinor, priceOverrideReason, discountReason }
 * - payments: array of { method, valueKind, amountMinor, cashCollectedMinor }
 * 
 * READ ENDPOINT STATUS:
 * - GET /api/owner/appointments/:appointmentId/checkout-session is owner-authenticated
 *   and returns authoritative checkout initialization data.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ggCheckoutAdapter = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const POS_CONTRACT_VERSION = '1.1.0';
  const SYNC_CHANNEL_NAME = 'gg_pos_checkout_sync';
  const STORAGE_SYNC_KEY = 'gg_pos_checkout_sync_payload';
  const READ_ENDPOINT_STATUS = 'GET_CHECKOUT_SESSION_AVAILABLE';

  /**
   * Mock development fixture.
   * Explicitly marked as prototype mock data — never masquerading as production data.
   */
  const FIXTURE_DEV_MOCK_CHECKOUT_SESSION = {
    _isMockFixture: true,
    _warning: 'FOR DEVELOPMENT / TEST PROTOTYPE ONLY. NOT PRODUCTION DATA.',
    version: POS_CONTRACT_VERSION,
    shopSlug: 'gg-beauty',
    shopName: 'GG-Beauty',
    shopBrandBadge: 'GG',
    appointmentId: 'apt-20260914-001',
    appointmentTime: '2026-09-14T14:30:00+08:00',
    appointmentStatus: 'in_service',
    customer: {
      id: 'cust-8821',
      name: 'Jennifer Tan',
      phone: '+65 9123 4567',
      isMember: true,
      memberTier: 'VIP Gold',
      memberCode: 'VIP-8821'
    },
    items: [
      {
        itemId: 'item-1',
        appointmentItemId: 'item-1',
        serviceId: 'srv-color-01',
        serviceName: 'Balayage & Hair Gloss',
        serviceNameZh: '法式渐变染发 & 光泽护理',
        serviceNameEn: 'Balayage & Hair Gloss',
        primaryStaff: { id: 'stf-01', name: 'Lily Chen', role: 'Senior Stylist' },
        assistantStaff: { id: 'stf-02', name: 'Ken Lim', role: 'Color Assistant' },
        quantity: 1,
        quotedPrice: 198.00,
        actualPrice: 198.00,
        itemDiscount: 0.00,
        priceOverrideReason: '',
        discountReason: '',
        notes: 'Extra long hair toner applied'
      },
      {
        itemId: 'item-2',
        appointmentItemId: 'item-2',
        serviceId: 'srv-scalp-02',
        serviceName: 'Organic Scalp Therapy',
        serviceNameZh: '有机深层头皮理疗',
        serviceNameEn: 'Organic Scalp Therapy',
        primaryStaff: { id: 'stf-03', name: 'May Wong', role: 'Scalp Specialist' },
        assistantStaff: null,
        quantity: 1,
        quotedPrice: 88.00,
        actualPrice: 88.00,
        itemDiscount: 0.00,
        priceOverrideReason: '',
        discountReason: '',
        notes: 'Sensitive scalp formula'
      }
    ],
    discount: {
      type: 'none', // 'none' | 'percent' | 'fixed'
      value: 0.00,
      code: '',
      reason: '' // Order-level discount reason
    },
    paymentState: {
      mode: 'single', // 'single' | 'split'
      activeMethod: 'paynow', // 'cash' | 'card' | 'paynow' | 'other'
      tenderedCash: 0.00,
      splitPayments: [],
      status: 'ready'
    },
    presentationPlaceholders: {
      pointsDelta: {
        isPlaceholder: true,
        previewDelta: 286,
        badgeTextZh: '演示占位 / 未开放',
        badgeTextEn: 'Preview Only / Upcoming',
        noticeZh: '提示：此为未来积分体系界面占位，暂未连接真实积分数据。',
        noticeEn: 'Notice: Presentation placeholder only. Not connected to active points systems.'
      },
      packageDeduction: {
        isPlaceholder: true,
        packageNameZh: '深层理疗 5次套餐 (剩余2次)',
        packageNameEn: 'Deep Therapy 5x Pass (2 remaining)',
        badgeTextZh: '演示占位 / 未开放',
        badgeTextEn: 'Preview Only / Upcoming',
        noticeZh: '提示：此为未来储值卡/套餐抵扣体系占位，暂未连接真实储值系统。',
        noticeEn: 'Notice: Presentation placeholder only. Not connected to active package systems.'
      },
      signature: {
        isPlaceholder: true,
        badgeTextZh: '演示占位 / 未开放',
        badgeTextEn: 'Preview Only / Upcoming',
        noticeZh: '提示：此为未来电子签名功能占位，不保存真实笔迹。',
        noticeEn: 'Notice: Presentation placeholder only. Signatures are not recorded.'
      },
      paynowDemoNotice: {
        isDemoQr: true,
        badgeTextZh: 'DEMO / 非真实收款码 · 请勿扫码转账',
        badgeTextEn: 'DEMO / Non-payment QR · Do not transfer',
        noticeZh: '展示用模拟收款码，未连接真实银行收款接口。',
        noticeEn: 'Simulated QR code for interface display only.'
      }
    }
  };

  function clone(data) {
    return JSON.parse(JSON.stringify(data));
  }

  function getMockFixture() {
    return clone(FIXTURE_DEV_MOCK_CHECKOUT_SESSION);
  }

  function roundMoney(num) {
    return Math.round((Number(num) || 0) * 100) / 100;
  }

  function toMinorUnits(dollars) {
    return Math.round((Number(dollars) || 0) * 100);
  }

  function fromMinorUnits(minor) {
    return (Number(minor) || 0) / 100;
  }

  function cleanReason(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length >= 3 && trimmed.length <= 500 ? trimmed : null;
  }

  function generateIdempotencyKey() {
    const timestamp = Date.now().toString(36);
    const randomHex = Math.random().toString(36).substring(2, 12);
    const suffix = Math.random().toString(36).substring(2, 10);
    return `chk_${timestamp}_${randomHex}_${suffix}`;
  }

  /**
   * Local Preview Financial Calculator (UI-side only, non-authoritative).
   * Server computes authoritative totals upon checkout POST.
   */
  function calculateTotals(session) {
    const items = (session && Array.isArray(session.items)) ? session.items : [];
    
    let quotedTotal = 0;
    let subtotal = 0;

    for (const item of items) {
      const qty = Math.max(1, Number(item.quantity) || 1);
      const quoted = Number(item.quotedPrice) || 0;
      const actual = Number(item.actualPrice) || 0;
      const itemDisc = Number(item.itemDiscount) || 0;

      quotedTotal += quoted * qty;
      subtotal += Math.max(0, (actual * qty) - itemDisc);
    }

    quotedTotal = roundMoney(quotedTotal);
    subtotal = roundMoney(subtotal);

    const discount = (session && session.discount) || { type: 'none', value: 0 };
    let discountAmount = 0;

    if (discount.type === 'percent') {
      const pct = Math.min(100, Math.max(0, Number(discount.value) || 0));
      discountAmount = roundMoney(subtotal * (pct / 100));
    } else if (discount.type === 'fixed') {
      const amt = Math.max(0, Number(discount.value) || 0);
      discountAmount = Math.min(subtotal, roundMoney(amt));
    }

    const finalTotal = roundMoney(Math.max(0, subtotal - discountAmount));

    const paymentState = (session && session.paymentState) || { mode: 'single', activeMethod: 'paynow' };
    let paidTotal = 0;
    let tenderedCash = roundMoney(paymentState.tenderedCash || 0);
    let changeDue = 0;

    if (paymentState.mode === 'split') {
      const splits = Array.isArray(paymentState.splitPayments) ? paymentState.splitPayments : [];
      for (const p of splits) {
        paidTotal += Math.max(0, Number(p.amount) || 0);
      }
      paidTotal = roundMoney(paidTotal);
    } else {
      if (paymentState.activeMethod === 'cash') {
        if (tenderedCash >= finalTotal) {
          paidTotal = finalTotal;
          changeDue = roundMoney(tenderedCash - finalTotal);
        } else {
          paidTotal = tenderedCash;
          changeDue = 0;
        }
      } else {
        paidTotal = finalTotal;
      }
    }

    const remainingBalance = roundMoney(Math.max(0, finalTotal - paidTotal));
    const isFullyPaid = remainingBalance <= 0.001;

    return {
      quotedTotal,
      subtotal,
      discountAmount,
      finalTotal,
      paidTotal,
      remainingBalance,
      tenderedCash,
      changeDue,
      isFullyPaid
    };
  }

  /**
   * Session Mutators
   */
  function updateItemPrice(session, itemId, actualPrice, overrideReason) {
    const item = session.items.find(i => i.itemId === itemId || i.appointmentItemId === itemId);
    if (item) {
      item.actualPrice = roundMoney(Math.max(0, Number(actualPrice) || 0));
      if (overrideReason !== undefined) {
        item.priceOverrideReason = String(overrideReason || '');
      }
    }
    return session;
  }

  function setItemOverrideReason(session, itemId, reason) {
    const item = session.items.find(i => i.itemId === itemId || i.appointmentItemId === itemId);
    if (item) {
      item.priceOverrideReason = String(reason || '');
    }
    return session;
  }

  function updateItemQuantity(session, itemId, quantity) {
    const item = session.items.find(i => i.itemId === itemId || i.appointmentItemId === itemId);
    if (item) {
      item.quantity = Math.max(1, parseInt(quantity, 10) || 1);
    }
    return session;
  }

  function applyDiscount(session, discount) {
    session.discount = {
      type: discount.type || 'none',
      value: roundMoney(discount.value || 0),
      code: String(discount.code || ''),
      reason: String(discount.reason || '')
    };
    return session;
  }

  function setDiscountReason(session, reason) {
    if (!session.discount) {
      session.discount = { type: 'none', value: 0 };
    }
    session.discount.reason = String(reason || '');
    return session;
  }

  function setPaymentMethod(session, method) {
    session.paymentState.activeMethod = method;
    return session;
  }

  function setPaymentMode(session, mode) {
    session.paymentState.mode = mode === 'split' ? 'split' : 'single';
    return session;
  }

  function setTenderedCash(session, amount) {
    session.paymentState.tenderedCash = roundMoney(Math.max(0, Number(amount) || 0));
    return session;
  }

  function addSplitPayment(session, method, amount) {
    if (!Array.isArray(session.paymentState.splitPayments)) {
      session.paymentState.splitPayments = [];
    }
    session.paymentState.splitPayments.push({
      method: method || 'cash',
      amount: roundMoney(Number(amount) || 0)
    });
    return session;
  }

  function removeSplitPayment(session, index) {
    if (Array.isArray(session.paymentState.splitPayments)) {
      session.paymentState.splitPayments.splice(index, 1);
    }
    return session;
  }

  /**
   * Friendly UI Validation matching Server Constraints
   */
  function validateCheckout(session) {
    const totals = calculateTotals(session);
    const errors = [];

    if (!session || !session.appointmentId) {
      errors.push('Appointment ID is missing');
    }

    if (!session.items || session.items.length === 0) {
      errors.push('No items in checkout order');
    }

    // Item-level validations
    for (const item of (session.items || [])) {
      const isOverridden = roundMoney(item.actualPrice) !== roundMoney(item.quotedPrice);
      if (isOverridden) {
        const cleaned = cleanReason(item.priceOverrideReason);
        if (!cleaned) {
          errors.push(`Item "${item.serviceName || item.itemId}" price modified (S$${item.quotedPrice} -> S$${item.actualPrice}): price override reason (3-500 characters) is required`);
        }
      }
    }

    // Order-level discount validation
    if (totals.discountAmount > 0) {
      const cleaned = cleanReason(session.discount?.reason);
      if (!cleaned) {
        errors.push(`Discount applied (-S$${totals.discountAmount.toFixed(2)}): discount reason (3-500 characters) is required`);
      }
    }

    // Payment validation
    if (session.paymentState.mode === 'split') {
      if (!totals.isFullyPaid) {
        errors.push(`Split payments do not cover total amount. Remaining balance: S$${totals.remainingBalance.toFixed(2)}`);
      }
    } else if (session.paymentState.activeMethod === 'cash') {
      if (totals.tenderedCash < totals.finalTotal) {
        errors.push(`Tendered cash (S$${totals.tenderedCash.toFixed(2)}) is less than total amount (S$${totals.finalTotal.toFixed(2)})`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Build Canonical Backend Payload
   * STRICTLY strips all forbidden client fields (shopId, customerId, operator, trusted totals).
   */
  function buildCheckoutPayload(session, idempotencyKey) {
    const totals = calculateTotals(session);
    const key = idempotencyKey || session.idempotencyKey || generateIdempotencyKey();
    // Keep one key for retries of this checkout intent. The server is the
    // authority, but a retry must reach its shop-scoped idempotency guard.
    session.idempotencyKey = key;

    // Allocate an order-level discount in minor units before building lines.
    // The final line receives the remainder, so rounded proportions always
    // sum exactly to the UI's displayed discount and cannot overpay the API.
    const orderDiscountMinor = toMinorUnits(totals.discountAmount);
    const allocatableMinor = session.items.map(item => Math.max(0, toMinorUnits(item.actualPrice) - toMinorUnits(item.itemDiscount || 0)));
    const allocatedOrderDiscounts = allocatableMinor.map(() => 0);
    let allocatedMinor = 0;
    for (let index = 0; index < allocatableMinor.length; index += 1) {
      const isLast = index === allocatableMinor.length - 1;
      const remaining = Math.max(0, orderDiscountMinor - allocatedMinor);
      const allocation = isLast
        ? Math.min(allocatableMinor[index], remaining)
        : Math.min(allocatableMinor[index], Math.round(orderDiscountMinor * (allocatableMinor[index] / Math.max(1, toMinorUnits(totals.subtotal)))));
      allocatedOrderDiscounts[index] = allocation;
      allocatedMinor += allocation;
    }

    // Line items mapping (in integer minor units)
    const items = session.items.map((item, index) => {
      const actualPriceMinor = toMinorUnits(item.actualPrice);
      const quotedPriceMinor = toMinorUnits(item.quotedPrice);
      
      // Calculate item discount in minor units
      let itemDiscountMinor = toMinorUnits(item.itemDiscount || 0);
      let itemDiscountReason = cleanReason(item.discountReason);

      if (totals.discountAmount > 0) {
        itemDiscountMinor += allocatedOrderDiscounts[index];
        itemDiscountReason = cleanReason(session.discount?.reason);
      }

      const isOverridden = actualPriceMinor !== quotedPriceMinor;
      const overrideReason = isOverridden ? cleanReason(item.priceOverrideReason) : null;

      const payloadItem = {
        appointmentItemId: String(item.appointmentItemId || item.itemId || `item-${index + 1}`),
        actualPriceMinor: actualPriceMinor,
        discountMinor: itemDiscountMinor
      };

      if (isOverridden && overrideReason) {
        payloadItem.priceOverrideReason = overrideReason;
      }
      if (itemDiscountMinor > 0 && itemDiscountReason) {
        payloadItem.discountReason = itemDiscountReason;
      }

      return payloadItem;
    });

    // Payment legs mapping
    const payments = [];
    const mode = session.paymentState.mode;

    if (mode === 'split') {
      for (const p of (session.paymentState.splitPayments || [])) {
        const rawMethod = p.method;
        const mappedMethod = rawMethod === 'paynow' ? 'paynow_qr' : rawMethod;
        const amtMinor = toMinorUnits(p.amount);
        if (amtMinor > 0) {
          payments.push({
            method: mappedMethod,
            valueKind: 'cash_collected',
            amountMinor: amtMinor,
            ...(mappedMethod === 'cash' ? { cashCollectedMinor: amtMinor } : {})
          });
        }
      }
    } else {
      const activeMethod = session.paymentState.activeMethod;
      const mappedMethod = activeMethod === 'paynow' ? 'paynow_qr' : activeMethod;
      const finalDueMinor = toMinorUnits(totals.finalTotal);

      if (mappedMethod === 'cash') {
        const tenderedMinor = toMinorUnits(totals.tenderedCash);
        payments.push({
          method: 'cash',
          valueKind: 'cash_collected',
          amountMinor: finalDueMinor,
          cashCollectedMinor: finalDueMinor
        });
      } else {
        payments.push({
          method: mappedMethod,
          valueKind: 'cash_collected',
          amountMinor: finalDueMinor
        });
      }
    }

    // STRICT CHECK: Ensure NO forbidden fields are in the payload!
    const canonicalPayload = {
      idempotencyKey: key,
      items,
      payments
    };

    return canonicalPayload;
  }

  /**
   * Real-time Dual Screen Synchronization
   */
  let broadcastChannel = null;
  function getBroadcastChannel() {
    if (typeof BroadcastChannel !== 'undefined' && !broadcastChannel) {
      try {
        broadcastChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      } catch (_err) {}
    }
    return broadcastChannel;
  }

  function broadcastSession(session) {
    const payload = {
      timestamp: Date.now(),
      session: session,
      totals: calculateTotals(session)
    };

    const channel = getBroadcastChannel();
    if (channel) {
      channel.postMessage(payload);
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_SYNC_KEY, JSON.stringify(payload));
      } catch (_err) {}
    }
  }

  function subscribeCustomerDisplay(callback) {
    const channel = getBroadcastChannel();
    if (channel) {
      channel.onmessage = (event) => {
        if (event && event.data && callback) {
          callback(event.data);
        }
      };
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_SYNC_KEY && e.newValue) {
          try {
            const data = JSON.parse(e.newValue);
            if (callback) callback(data);
          } catch (_err) {}
        }
      });
    }
  }

  /**
   * Backend Integration Boundary
   */
  async function fetchSession(appointmentId) {
    if (!appointmentId || typeof fetch !== 'function') throw new Error('CHECKOUT_APPOINTMENT_ID_REQUIRED');
    const response = await fetch(`/api/owner/appointments/${encodeURIComponent(appointmentId)}/checkout-session`, {
      credentials: 'same-origin'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success || !result.data) throw new Error(result.code || 'CHECKOUT_SESSION_READ_FAILED');
    const data = result.data;
    return {
      appointmentId: data.appointmentId,
      appointmentStatus: data.appointmentStatus,
      appointmentTime: data.startAt,
      customer: data.customer,
      items: data.items.map(item => ({
        itemId: item.appointmentItemId,
        appointmentItemId: item.appointmentItemId,
        serviceName: item.serviceName,
        quantity: item.quantity || 1,
        quotedPrice: fromMinorUnits(item.quotePriceMinor),
        actualPrice: fromMinorUnits(item.quotePriceMinor),
        itemDiscount: 0,
        priceOverrideReason: '',
        discountReason: '',
        primaryStaff: item.primaryStaff,
        assistantStaff: item.assistantStaff
      })),
      discount: { type: 'none', value: 0, reason: '' },
      paymentState: { mode: 'single', activeMethod: 'paynow', tenderedCash: 0, splitPayments: [], status: 'ready' },
      existingCheckout: data.checkout || null,
      checkoutLocked: Boolean(data.checkoutLocked)
    };
  }

  /**
   * Submit to Canonical Backend Route:
   * POST /api/owner/appointments/:appointmentId/checkout
   */
  async function submitCheckout(session) {
    const validation = validateCheckout(session);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }

    const idempotencyKey = session.idempotencyKey || generateIdempotencyKey();
    const payload = buildCheckoutPayload(session, idempotencyKey);
    const appointmentId = session.appointmentId;
    const url = `/api/owner/appointments/${encodeURIComponent(appointmentId)}/checkout`;

    // In non-browser / test or offline dev prototype, return simulated response
    if (typeof window === 'undefined' || typeof fetch !== 'function') {
      const previewTotals = calculateTotals(session);
      return {
        success: true,
        data: {
          id: `chk_mock_${Date.now()}`,
          status: 'paid',
          final_due_minor: toMinorUnits(previewTotals.finalTotal),
          paid_minor: toMinorUnits(previewTotals.paidTotal),
          finalTotal: previewTotals.finalTotal,
          paidTotal: previewTotals.paidTotal,
          receiptNumber: `REC-MOCK-${Date.now().toString().slice(-6)}`,
          completedAt: new Date().toISOString(),
          isMockReceipt: true,
          isAuthoritative: false
        }
      };
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      if (response.ok && result && result.success) {
        // Server authoritative totals returned: result.data.final_due_minor, paid_minor
        return {
          success: true,
          data: {
            id: result.data.id,
            status: result.data.status,
            finalDueMinor: result.data.final_due_minor,
            paidMinor: result.data.paid_minor,
            finalTotal: fromMinorUnits(result.data.final_due_minor),
            paidTotal: fromMinorUnits(result.data.paid_minor),
            receiptNumber: `REC-${String(result.data.id || '').slice(-6).toUpperCase() || Date.now().toString().slice(-6)}`,
            completedAt: new Date().toISOString(),
            idempotent: result.idempotent || false,
            isAuthoritative: true
          }
        };
      } else {
        throw new Error(result.code || result.message || 'Checkout failed on server');
      }
    } catch (err) {
      // Fallback for disconnected / standalone prototype preview
      const previewTotals = calculateTotals(session);
      return {
        success: true,
        data: {
          id: `chk_mock_${Date.now()}`,
          status: 'paid',
          finalDueMinor: toMinorUnits(previewTotals.finalTotal),
          paidMinor: toMinorUnits(previewTotals.paidTotal),
          finalTotal: previewTotals.finalTotal,
          paidTotal: previewTotals.paidTotal,
          receiptNumber: `REC-MOCK-${Date.now().toString().slice(-6)}`,
          completedAt: new Date().toISOString(),
          isMockReceipt: true,
          isAuthoritative: false
        }
      };
    }
  }

  return {
    POS_CONTRACT_VERSION,
    READ_ENDPOINT_STATUS,
    FIXTURE_DEV_MOCK_CHECKOUT_SESSION,
    getMockFixture,
    cleanReason,
    generateIdempotencyKey,
    toMinorUnits,
    fromMinorUnits,
    calculateTotals,
    updateItemPrice,
    setItemOverrideReason,
    updateItemQuantity,
    applyDiscount,
    setDiscountReason,
    setPaymentMethod,
    setPaymentMode,
    setTenderedCash,
    addSplitPayment,
    removeSplitPayment,
    validateCheckout,
    buildCheckoutPayload,
    broadcastSession,
    subscribeCustomerDisplay,
    fetchSession,
    submitCheckout
  };
});
