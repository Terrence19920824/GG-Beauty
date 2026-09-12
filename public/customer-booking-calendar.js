(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ggCustomerBookingCalendar = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const pad = value => String(value).padStart(2, '0');
  const isoDate = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
  const parseMonth = value => {
    const match = /^(\d{4})-(\d{2})$/.exec(value || '');
    if (!match) throw new Error('CALENDAR_MONTH_INVALID');
    const year = Number(match[1]), month = Number(match[2]);
    if (year < 2000 || year > 2200 || month < 1 || month > 12) throw new Error('CALENDAR_MONTH_INVALID');
    return { year, month };
  };
  const shiftMonth = (value, delta) => {
    const { year, month } = parseMonth(value);
    const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
  };
  const monthRange = value => {
    const { year, month } = parseMonth(value);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { startDate: isoDate(year, month, 1), endDate: isoDate(year, month, last) };
  };
  const monthModel = ({ monthValue, locale, availability = new Map(), selectedDate = '', today = '' }) => {
    const { year, month } = parseMonth(monthValue);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const leading = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const chinese = locale === 'zh-CN';
    const title = chinese ? `${year}年${month}月`
      : new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
    const weekdays = chinese
      ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const cells = Array.from({ length: leading }, () => null);
    for (let day = 1; day <= days; day += 1) {
      const date = isoDate(year, month, day);
      const summary = availability.get(date);
      cells.push({ date, day, available: summary?.hasAvailability === true,
        earliestStartAt: summary?.earliestStartAt || null, selected: date === selectedDate,
        past: Boolean(today && date < today) });
    }
    return { title, weekdays, cells };
  };

  const reconcileSelectedDate = ({ selectedDate, monthValue, availability }) => {
    if (!selectedDate || !selectedDate.startsWith(monthValue)) return selectedDate || '';
    return availability.get(selectedDate)?.hasAvailability === true ? selectedDate : '';
  };

  return { monthModel, monthRange, reconcileSelectedDate, shiftMonth };
});
