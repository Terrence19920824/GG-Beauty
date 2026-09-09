(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ggI18n = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_LOCALE = 'en';
  const STORAGE_KEY = 'gg_beauty_locale';
  const dictionaries = {
    'zh-CN': {
      calendar: '日历', staff: '员工', services: '服务', customers: '顾客', checkout: '收银', more: '更多',
      save: '保存', saveProfile: '保存基本资料', saving: '保存中...', saved: '已保存', saveFailed: '保存失败', savedReloadFailed: '已保存，但重新读取失败，请重试', unsavedChanges: '有未保存更改', discardUnsavedChanges: '有未保存更改。放弃更改并继续吗？', profileSaveDiscardsUnsaved: '其他设置有未保存更改。保存基本资料会重新读取员工设置，是否放弃这些更改并继续？', cancel: '取消', edit: '编辑', add: '新增', confirm: '确认', complete: '完成', retry: '重试',
      pending: '待确认', confirmed: '已确认', completed: '已完成', cancelled: '已取消', noShow: '未到店',
      name: '姓名', phone: '电话', email: 'Email', price: '价格', duration: '时长', category: '分类', status: '状态', actions: '操作',
      enabled: '启用', disabled: '停用', bookable: '可预约', notBookable: '未开放预约', active: '启用', inactive: '停用',
      today: '今天', tomorrow: '明天', date: '日期', time: '时间', loading: '正在读取...', error: '发生错误',
      ownerPageTitle: 'GG-Beauty 老板端预约后台', customerPageTitle: 'GG-Beauty 在线预约', ownerTitle: 'GG-Beauty 老板端', ownerSubtitle: '预约管理后台', refreshAppointments: '刷新预约', logout: '退出登录', comingSoon: '即将推出',
      ownerLogin: 'GG-Beauty 老板登录', loginHelp: '请使用店铺提供的老板账号登录。', loginAccount: '请输入登录账号', password: '请输入密码', shopSlug: '店铺标识（如有多家店）', login: '登录', loginRequiredFields: '请输入登录账号和密码', loggingIn: '正在登录...', loginFailed: '登录失败，请重试', logoutFailed: '退出登录失败，请稍后重试', loggedOut: '已退出登录', authCheckFailed: '无法验证登录状态，请稍后重试',
      allAppointments: '全部预约', pendingAppointments: '待确认', todayAppointments: '今日预约', appointmentTime: '预约时间', customerName: '顾客姓名', service: '项目', noAppointments: '目前没有预约', loadingAppointments: '正在读取预约...', loginRequired: '请先登录后查看预约',
      confirmAppointmentPrompt: '确定要确认这条预约吗？', completeAppointmentPrompt: '确定要完成这条预约吗？', cancelAppointmentPrompt: '确定要取消这条预约吗？', operationFailed: '操作失败',
      serviceManagement: '服务项目', serviceHelp: '管理价格、时长与顾客预约状态', addService: '新增服务', editService: '编辑服务', noServices: '还没有服务项目', loadingServices: '正在读取服务...', serviceName: '服务名称', chineseName: '中文名称', englishName: 'English Name', chineseDescription: '中文说明', englishDescription: 'English Description', startingPrice: '起价 / From', durationMinutes: '服务时长（分钟）', sortOrder: '排序', allowBooking: '允许顾客预约', serviceActive: '启用项目', uncategorized: '未分类', minutes: '分钟', serviceCategories: '服务分类', categoryHelp: '管理分类名称、图标、排序与状态', addCategory: '新增分类', editCategory: '编辑分类', loadingCategories: '正在读取分类...', noCategories: '还没有服务分类', icon: '图标', serviceCount: '项目数量', chooseCategory: '请选择分类', categoryRequired: '新服务必须选择分类',
      staffManagement: '员工', staffHelp: '管理员工资料、服务能力与排班', addStaff: '新增员工', basicDetails: '基本资料', staffName: '员工姓名', staffCode: '员工编号', staffActive: '员工启用状态', staffSetupNotice: '请先设置服务与排班，再开放顾客预约。', chooseStaff: '请选择一位员工', noStaff: '还没有员工', loadingStaff: '正在读取员工...', loadingStaffSettings: '正在读取员工设置...', adminReadOnly: '管理员为只读权限',
      capabilities: '会做项目', capabilityHeading: '会做的项目', locations: '所属门店', weeklySchedule: '每周排班', specialDates: '特殊日期', saveCapabilities: '保存项目', saveLocations: '保存门店', saveSchedule: '保存排班', addSpecialDate: '新增特殊日期', noLocations: '暂无门店', assignLocationFirst: '请先为员工分配门店。', assignLocationBeforeSchedule: '请先分配员工所在门店，再设置排班。', noCapabilityServices: '暂无服务项目', serviceInactive: '项目已停用', serviceNotBookable: '当前未开放预约',
      monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四', friday: '周五', saturday: '周六', sunday: '周日', working: '工作', to: '至', timezone: '时区',
      store: '门店', type: '类型', dayOff: '休息一天', leave: '请假', customHours: '特殊营业时间', startTime: '开始时间', endTime: '结束时间', notesOptional: '备注（可选）', noOverrides: '暂无特殊日期', effective: '生效中', deactivate: '停用',
      invalidScheduleTime: '开始时间必须早于结束时间，不支持跨夜排班。', invalidOverrideTime: '开始时间必须早于结束时间，不支持跨夜。', customHoursRequired: '特殊营业时间必须填写开始和结束时间。',
      sessionExpired: '登录已过期，请重新登录', staffFutureAppointments: '该员工已有未来预约，暂时不能停用。', staffServiceFutureAppointments: '该员工已有未来预约使用这个项目，暂时不能取消该服务能力。', scheduleFutureAppointments: '新排班与该员工未来预约冲突。',
      onlineAppointment: '在线预约', chooseStaffCustomer: '选择员工', customerStaffNoPreference: '不指定员工', customerStaffChoose: '选择员工', customerStaffNone: '当前没有可预约的员工', customerStaffLoading: '正在读取员工...', customerStaffAnyAvailable: '任何有空的员工', appointmentDate: '预约日期', availableTimes: '可预约时间', chooseDate: '请先选择日期', customerPhone: '手机号码', optionalEmail: 'Email（选填）', enterName: '请输入姓名', enterPhone: '请输入手机号码', bookAppointment: '确认预约', loadingCustomerServices: '正在读取服务...', noCustomerServices: '暂无可预约服务', checking: '正在查询...', noTimes: '当天暂无可预约时间', submitting: '正在提交...', availabilityFailed: '获取时间失败', requiredBookingFields: '请填写姓名、手机、日期并选择时间', bookingFailed: '预约失败', bookingSuccess: '预约成功！', from: '起'
    },
    en: {
      calendar: 'Calendar', staff: 'Staff', services: 'Services', customers: 'Customers', checkout: 'Checkout', more: 'More',
      save: 'Save', saveProfile: 'Save Profile', saving: 'Saving...', saved: 'Saved', saveFailed: 'Save failed', savedReloadFailed: 'Saved, but failed to reload the latest data. Please retry.', unsavedChanges: 'Unsaved changes', discardUnsavedChanges: 'You have unsaved changes. Discard them and continue?', profileSaveDiscardsUnsaved: 'Other staff settings have unsaved changes. Saving the profile reloads staff settings. Discard those changes and continue?', cancel: 'Cancel', edit: 'Edit', add: 'Add', confirm: 'Confirm', complete: 'Complete', retry: 'Retry',
      pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', noShow: 'No Show',
      name: 'Name', phone: 'Phone', email: 'Email', price: 'Price', duration: 'Duration', category: 'Category', status: 'Status', actions: 'Actions',
      enabled: 'Enabled', disabled: 'Disabled', bookable: 'Bookable', notBookable: 'Not bookable', active: 'Active', inactive: 'Inactive',
      today: 'Today', tomorrow: 'Tomorrow', date: 'Date', time: 'Time', loading: 'Loading...', error: 'Something went wrong',
      ownerPageTitle: 'GG-Beauty Owner Dashboard', customerPageTitle: 'GG-Beauty Online Appointment', ownerTitle: 'GG-Beauty Owner', ownerSubtitle: 'Appointment Dashboard', refreshAppointments: 'Refresh Appointments', logout: 'Log Out', comingSoon: 'Coming later',
      ownerLogin: 'GG-Beauty Owner Login', loginHelp: 'Use the owner account provided by the shop.', loginAccount: 'Enter login account', password: 'Enter password', shopSlug: 'Shop identifier (for multiple shops)', login: 'Log In', loginRequiredFields: 'Enter your login account and password', loggingIn: 'Logging in...', loginFailed: 'Login failed. Please try again.', logoutFailed: 'Log out failed. Please try again.', loggedOut: 'Logged out', authCheckFailed: 'Unable to verify your session. Please try again.',
      allAppointments: 'All Appointments', pendingAppointments: 'Pending', todayAppointments: 'Today', appointmentTime: 'Appointment Time', customerName: 'Customer', service: 'Service', noAppointments: 'No appointments yet', loadingAppointments: 'Loading appointments...', loginRequired: 'Log in to view appointments',
      confirmAppointmentPrompt: 'Confirm this appointment?', completeAppointmentPrompt: 'Complete this appointment?', cancelAppointmentPrompt: 'Cancel this appointment?', operationFailed: 'Operation failed',
      serviceManagement: 'Services', serviceHelp: 'Manage pricing, duration and online booking', addService: 'Add Service', editService: 'Edit Service', noServices: 'No services yet', loadingServices: 'Loading services...', serviceName: 'Service Name', chineseName: 'Chinese Name', englishName: 'English Name', chineseDescription: 'Chinese Description', englishDescription: 'English Description', startingPrice: 'Starting Price / From', durationMinutes: 'Duration (minutes)', sortOrder: 'Sort Order', allowBooking: 'Allow customer booking', serviceActive: 'Service active', uncategorized: 'Uncategorised', minutes: 'min', serviceCategories: 'Service Categories', categoryHelp: 'Manage category names, icons, order and status', addCategory: 'Add Category', editCategory: 'Edit Category', loadingCategories: 'Loading categories...', noCategories: 'No service categories yet', icon: 'Icon', serviceCount: 'Services', chooseCategory: 'Choose a category', categoryRequired: 'A category is required for new services',
      staffManagement: 'Staff', staffHelp: 'Manage staff details, services and schedules', addStaff: 'Add Staff', basicDetails: 'Basic Details', staffName: 'Staff Name', staffCode: 'Staff Number', staffActive: 'Staff active', staffSetupNotice: 'Set up services and a schedule before allowing customer booking.', chooseStaff: 'Choose a staff member', noStaff: 'No staff yet', loadingStaff: 'Loading staff...', loadingStaffSettings: 'Loading staff settings...', adminReadOnly: 'Admin access is read-only',
      capabilities: 'Services', capabilityHeading: 'Services this staff member can perform', locations: 'Locations', weeklySchedule: 'Weekly Schedule', specialDates: 'Special Dates', saveCapabilities: 'Save Services', saveLocations: 'Save Locations', saveSchedule: 'Save Schedule', addSpecialDate: 'Add Override', noLocations: 'No locations', assignLocationFirst: 'Assign a location to this staff member first.', assignLocationBeforeSchedule: 'Assign a staff location before setting a schedule.', noCapabilityServices: 'No services', serviceInactive: 'Service inactive', serviceNotBookable: 'Not open for booking',
      monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday', working: 'Working', to: 'to', timezone: 'Timezone',
      store: 'Location', type: 'Type', dayOff: 'Day Off', leave: 'Leave', customHours: 'Special Hours', startTime: 'Start Time', endTime: 'End Time', notesOptional: 'Notes (optional)', noOverrides: 'No special dates', effective: 'Active', deactivate: 'Deactivate',
      invalidScheduleTime: 'Start time must be before end time. Overnight shifts are not supported.', invalidOverrideTime: 'Start time must be before end time. Overnight periods are not supported.', customHoursRequired: 'Special hours require both a start and end time.',
      sessionExpired: 'Your session expired. Please log in again.', staffFutureAppointments: 'This staff member has future appointments and cannot be deactivated yet.', staffServiceFutureAppointments: 'A future appointment uses this staff service, so it cannot be removed yet.', scheduleFutureAppointments: 'The new schedule conflicts with a future appointment.',
      onlineAppointment: 'Online Appointment', chooseStaffCustomer: 'Choose Staff', customerStaffNoPreference: 'No Preference', customerStaffChoose: 'Choose Staff', customerStaffNone: 'No staff are currently available', customerStaffLoading: 'Loading staff...', customerStaffAnyAvailable: 'Any available staff', appointmentDate: 'Appointment Date', availableTimes: 'Available Times', chooseDate: 'Choose a date first', customerPhone: 'Mobile Number', optionalEmail: 'Email (optional)', enterName: 'Enter your name', enterPhone: 'Enter your mobile number', bookAppointment: 'Book Appointment', loadingCustomerServices: 'Loading services...', noCustomerServices: 'No services available', checking: 'Checking...', noTimes: 'No available times on this date.', submitting: 'Submitting...', availabilityFailed: 'Unable to load available times', requiredBookingFields: 'Enter your name, phone and date, then choose a time', bookingFailed: 'Booking failed', bookingSuccess: 'Appointment booked!', from: 'From'
    }
  };

  function normalizeLocale(value) {
    if (typeof value !== 'string') return DEFAULT_LOCALE;
    const locale = value.trim().toLowerCase();
    return locale === 'zh' || locale.startsWith('zh-') ? 'zh-CN' : DEFAULT_LOCALE;
  }

  function detectBrowserLocale(navigatorLike) {
    const languages = Array.isArray(navigatorLike && navigatorLike.languages)
      ? navigatorLike.languages : [navigatorLike && navigatorLike.language];
    return languages.some(value => typeof value === 'string' && value.toLowerCase().startsWith('zh')) ? 'zh-CN' : DEFAULT_LOCALE;
  }

  function getStoredLocale(storage, navigatorLike) {
    try {
      const stored = storage && storage.getItem(STORAGE_KEY);
      if (stored === 'zh-CN' || stored === 'en') return stored;
    } catch (_error) {}
    return detectBrowserLocale(navigatorLike);
  }

  function setLocale(locale, storage) {
    const normalized = normalizeLocale(locale);
    try { if (storage) storage.setItem(STORAGE_KEY, normalized); } catch (_error) {}
    return normalized;
  }

  function t(key, locale, params) {
    const normalized = normalizeLocale(locale);
    let result = dictionaries[normalized][key] || dictionaries.en[key] || key;
    for (const [name, value] of Object.entries(params || {})) result = result.replaceAll(`{${name}}`, String(value));
    return result;
  }

  function formatDuration(minutes, locale) { return `${minutes} ${t('minutes', locale)}`; }
  function formatDate(value, locale) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    const options = normalizeLocale(locale) === 'zh-CN'
      ? { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
      : { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' };
    return new Intl.DateTimeFormat(normalizeLocale(locale), options).format(date);
  }
  function formatPrice(price, priceIsFrom, locale) {
    const amount = `S$${Number(price || 0).toFixed(2)}`;
    if (!priceIsFrom) return amount;
    return normalizeLocale(locale) === 'zh-CN' ? `${amount} ${t('from', locale)}` : `${t('from', locale)} ${amount}`;
  }
  function formatStatus(status, locale) {
    const key = status === 'no_show' ? 'noShow' : status;
    return t(key, locale);
  }
  function resolveLocalizedService(service, requestedLocale) {
    const locale = normalizeLocale(requestedLocale);
    const translations = service && service.translations ? service.translations : {};
    const requested = translations[locale] || {};
    const english = translations.en || {};
    const chinese = translations['zh-CN'] || {};
    const canonicalName = service && (service.canonicalName || service.name) || '';
    const canonicalDescription = service && (service.canonicalDescription || service.description) || null;
    return { locale, name: requested.name || english.name || chinese.name || canonicalName, description: requested.description || english.description || chinese.description || canonicalDescription };
  }

  return { DEFAULT_LOCALE, STORAGE_KEY, dictionaries, normalizeLocale, browserLocale: detectBrowserLocale, detectBrowserLocale, getStoredLocale, setLocale, t, formatDate, formatDuration, formatPrice, formatStatus, resolveLocalizedService };
});
