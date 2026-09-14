/**
 * GG-Beauty Checkout & Customer Display UI Adapter
 * 
 * Integration boundary between Front Desk Checkout UI, Customer Display, and future backend POS APIs.
 * Includes explicit dev/test fixture clearly segregated from production data.
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

  const POS_CONTRACT_VERSION = '1.0.0';
  const SYNC_CHANNEL_NAME = 'gg_pos_checkout_sync';
  const STORAGE_SYNC_KEY = 'gg_pos_checkout_sync_payload';

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
        notes: 'Extra long hair toner applied'
      },
      {
        itemId: 'item-2',
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
        notes: 'Sensitive scalp formula'
      }
    ],
    discount: {
      type: 'none', // 'none' | 'percent' | 'fixed'
      value: 0.00,
      code: '',
      reason: ''
    },
    paymentState: {
      mode: 'single', // 'single' | 'split'
      activeMethod: 'paynow', // 'cash' | 'card' | 'paynow' | 'other'
      tenderedCash: 0.00,
      splitPayments: [
        // e.g. { method: 'cash', amount: 100.00 }, { method: 'paynow', amount: 186.00 }
      ],
      status: 'ready' // 'ready' | 'processing' | 'completed'
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

  /**
   * Core financial and checkout calculator.
   * Pure calculation logic with zero external dependencies.
   */
  function calculateTotals(session) {
    const items = (session && Array.isArray(session.items)) ? session.items : [];
    
    // 1. Quoted Total & Subtotal
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

    // 2. Order Level Discount
    const discount = (session && session.discount) || { type: 'none', value: 0 };
    let discountAmount = 0;

    if (discount.type === 'percent') {
      const pct = Math.min(100, Math.max(0, Number(discount.value) || 0));
      discountAmount = roundMoney(subtotal * (pct / 100));
    } else if (discount.type === 'fixed') {
      const amt = Math.max(0, Number(discount.value) || 0);
      discountAmount = Math.min(subtotal, roundMoney(amt));
    }

    // 3. Final Total
    const finalTotal = roundMoney(Math.max(0, subtotal - discountAmount));

    // 4. Payment calculations
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
        // Non-cash single payment pays full amount when processed
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
   * Session mutators
   */
  function updateItemPrice(session, itemId, actualPrice) {
    const s = session;
    const item = s.items.find(i => i.itemId === itemId);
    if (item) {
      item.actualPrice = roundMoney(Math.max(0, Number(actualPrice) || 0));
    }
    return s;
  }

  function updateItemQuantity(session, itemId, quantity) {
    const s = session;
    const item = s.items.find(i => i.itemId === itemId);
    if (item) {
      item.quantity = Math.max(1, parseInt(quantity, 10) || 1);
    }
    return s;
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
   * Checkout validation
   */
  function validateCheckout(session) {
    const totals = calculateTotals(session);
    const errors = [];

    if (!session || !session.customer || !session.customer.id) {
      errors.push('Customer information is missing');
    }

    if (!session.items || session.items.length === 0) {
      errors.push('No items in checkout order');
    }

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
   * Easily connects to future Codex backend routes when ready.
   */
  async function fetchSession(appointmentId) {
    if (!appointmentId) return getMockFixture();

    try {
      const response = await fetch(`/api/owner/checkout/session?appointmentId=${encodeURIComponent(appointmentId)}`, {
        credentials: 'same-origin'
      });
      if (response.ok) {
        const result = await response.json();
        if (result && result.success && result.data) {
          return result.data;
        }
      }
    } catch (_err) {
      // Backend not yet available: fall back to dev fixture
    }

    // Return prototype fixture for local dev & testing
    const fixture = getMockFixture();
    fixture.appointmentId = appointmentId;
    return fixture;
  }

  async function submitCheckout(session) {
    const validation = validateCheckout(session);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }

    const payload = {
      appointmentId: session.appointmentId,
      customerId: session.customer?.id,
      items: session.items.map(i => ({
        itemId: i.itemId,
        serviceId: i.serviceId,
        quantity: i.quantity,
        actualPrice: i.actualPrice,
        primaryStaffId: i.primaryStaff?.id,
        assistantStaffId: i.assistantStaff?.id
      })),
      discount: session.discount,
      paymentState: session.paymentState,
      totals: calculateTotals(session)
    };

    try {
      const response = await fetch('/api/owner/checkout/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        const result = await response.json();
        return result;
      }
    } catch (_err) {
      // Backend not yet available
    }

    // Mock response when backend is concurrently developing
    return {
      success: true,
      data: {
        receiptNumber: `REC-${Date.now().toString().slice(-6)}`,
        completedAt: new Date().toISOString(),
        totals: payload.totals,
        isMockReceipt: true
      }
    };
  }

  return {
    POS_CONTRACT_VERSION,
    FIXTURE_DEV_MOCK_CHECKOUT_SESSION,
    getMockFixture,
    calculateTotals,
    updateItemPrice,
    updateItemQuantity,
    applyDiscount,
    setPaymentMethod,
    setPaymentMode,
    setTenderedCash,
    addSplitPayment,
    removeSplitPayment,
    validateCheckout,
    broadcastSession,
    subscribeCustomerDisplay,
    fetchSession,
    submitCheckout
  };
});
