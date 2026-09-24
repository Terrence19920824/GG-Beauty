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
      pending: '待确认', confirmed: '已确认', arrived: '已到店', in_service: '服务中', completed: '已完成', cancelled: '已取消', noShow: '未到店', no_show: '未到店', unknownStatus: '状态未知',
      name: '姓名', phone: '电话', email: 'Email', price: '价格', duration: '时长', category: '分类', status: '状态', actions: '操作', staffAvatar: '员工头像',
      enabled: '启用', disabled: '停用', bookable: '可预约', notBookable: '未开放预约', active: '启用', inactive: '停用',
      today: '今天', tomorrow: '明天', date: '日期', time: '时间', loading: '加载中', loadFailed: '加载失败', error: '发生错误',
      list: '列表', previousDay: '上一天', nextDay: '下一天', unassigned: '未分配', unassignedStaff: '未分配员工', noAppointmentsOnDate: '该日期暂无预约', appointmentsCount: '个预约', appointmentOverlap: '重叠', overlapNotice: '冲突预约', currentTime: '当前时间', late15Min: '已迟到 15 分钟', notArrived: '尚未到店', lateIndicatorAria: '迟到警告：已迟到 15 分钟，尚未到店',
      ownerPageTitle: 'GG-Beauty 老板端预约后台', customerPageTitle: 'GG-Beauty 在线预约', ownerTitle: 'GG-Beauty 老板端', ownerSubtitle: '预约管理后台', refreshAppointments: '刷新预约', logout: '退出登录', comingSoon: '即将推出',
      ownerLogin: 'GG-Beauty 老板登录', loginHelp: '请使用店铺提供的老板账号登录。', loginAccount: '请输入登录账号', password: '请输入密码', shopSlug: '店铺标识（如有多家店）', login: '登录', loginRequiredFields: '请输入登录账号和密码', loggingIn: '正在登录...', loginFailed: '登录失败，请重试', logoutFailed: '退出登录失败，请稍后重试', loggedOut: '已退出登录', authCheckFailed: '无法验证登录状态，请稍后重试',
      allAppointments: '全部预约', pendingAppointments: '待确认', todayAppointments: '今日预约', appointmentTime: '预约时间', customerName: '顾客姓名', service: '项目', noAppointments: '目前没有预约', loadingAppointments: '正在读取预约...', loginRequired: '请先登录后查看预约',
      confirmAppointmentPrompt: '确定要确认这条预约吗？', arrivedAppointmentPrompt: '确认顾客已到店？', startServicePrompt: '确认开始服务？', completeAppointmentPrompt: '确定要完成这条预约吗？', noShowAppointmentPrompt: '确认标记为未到店？', cancelAppointmentPrompt: '确定要取消这条预约吗？', operationFailed: '操作失败',
      serviceManagement: '服务项目', serviceHelp: '管理价格、时长与顾客预约状态', addService: '新增服务', editService: '编辑服务', noServices: '还没有服务项目', loadingServices: '正在读取服务...', serviceName: '服务名称', chineseName: '中文名称', englishName: 'English Name', chineseDescription: '中文说明', englishDescription: 'English Description', startingPrice: '起价', durationMinutes: '服务时长（分钟）', sortOrder: '排序', allowBooking: '允许顾客预约', serviceActive: '启用项目', uncategorized: '未分类', minutes: '分钟', serviceCategories: '服务分类', categoryHelp: '管理分类名称、图标、排序与状态', addCategory: '新增分类', editCategory: '编辑分类', loadingCategories: '正在读取分类...', noCategories: '还没有服务分类', icon: '图标', serviceCount: '项目数量', chooseCategory: '请选择分类', categoryRequired: '新服务必须选择分类',
      staffManagement: '员工', staffHelp: '管理员工资料、服务能力与排班', addStaff: '新增员工', basicDetails: '基本资料', staffName: '员工姓名', staffCode: '员工编号', staffActive: '员工启用状态', staffSetupNotice: '请先设置服务与排班，再开放顾客预约。', chooseStaff: '请选择一位员工', noStaff: '还没有员工', loadingStaff: '正在读取员工...', loadingStaffSettings: '正在读取员工设置...', adminReadOnly: '管理员为只读权限',
      capabilities: '会做项目', capabilityHeading: '会做的项目', locations: '所属门店', weeklySchedule: '每周排班', specialDates: '特殊日期', saveCapabilities: '保存项目', saveLocations: '保存门店', saveSchedule: '保存排班', addSpecialDate: '新增特殊日期', noLocations: '暂无门店', assignLocationFirst: '请先为员工分配门店。', assignLocationBeforeSchedule: '请先分配员工所在门店，再设置排班。', noCapabilityServices: '暂无服务项目', serviceInactive: '项目已停用', serviceNotBookable: '当前未开放预约',
      monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四', friday: '周五', saturday: '周六', sunday: '周日', working: '工作', to: '至', timezone: '时区',
      store: '门店', type: '类型', dayOff: '休息一天', leave: '请假', customHours: '特殊营业时间', startTime: '开始时间', endTime: '结束时间', notesOptional: '备注（可选）', noOverrides: '暂无特殊日期', effective: '生效中', deactivate: '停用',
      addSelectedService: '添加该项目', addAnotherService: '继续添加项目', selectedServices: '已选项目', removeService: '移除', remove: '移除', totalDuration: '预计总时长', estimatedTotal: '预计总金额', nextStep: '下一步', next: '下一步', noBookableServices: '暂无可预约项目', serviceUnavailableRetry: '项目已不可用，请重新选择', loadServicesFailed: '无法加载服务，请重试', cartModuleOutdated: '系统组件正在更新，请点击刷新页面后继续。', reloadPage: '刷新页面', selectedState: '已选择', bookingRecipient: '预约给谁？', bookForMyself: '为自己预约', bookForSomeoneElse: '为别人预约', yourDetails: '您的联系方式', recipientDetails: '服务接收人资料', recipientName: '服务接收人姓名', enterRecipientName: '请输入服务接收人姓名', countryRegion: '国家 / 地区', recipientPhone: '服务接收人手机号', recipientEmail: '服务接收人 Email（选填）', countrySingapore: '新加坡', countryMalaysia: '马来西亚', countryIndonesia: '印度尼西亚', countryChina: '中国', countryUnitedStates: '美国',
      invalidScheduleTime: '开始时间必须早于结束时间，不支持跨夜排班。', invalidOverrideTime: '开始时间必须早于结束时间，不支持跨夜。', customHoursRequired: '特殊营业时间必须填写开始和结束时间。',
      sessionExpired: '登录已过期，请重新登录', sessionExpiredShort: '登录已过期', unauthorized: '登录已过期', calendarSessionExpired: '登录已过期', staffFutureAppointments: '该员工已有未来预约，暂时不能停用。', staffServiceFutureAppointments: '该员工已有未来预约使用这个项目，暂时不能取消该服务能力。', scheduleFutureAppointments: '新排班与该员工未来预约冲突。',
      onlineAppointment: '在线预约', chooseServiceCategory: '选择服务分类', allCategories: '全部', otherCategory: '其他', reloadServices: '重新加载', chooseStaffCustomer: '选择员工', customerStaffNoPreference: '不指定员工', customerStaffNoPreferenceFastest: '不指定员工｜系统最快安排', customerStaffChoose: '选择员工', customerStaffNone: '当前没有可预约的员工', customerStaffLoading: '正在读取员工...', customerStaffAnyAvailable: '任何有空的员工', chooseStaffForSlot: '选择该时段员工', itemTimeSlot: '服务时段', chooseStaffAfterTime: '请先选择预约时间以确认可用员工', appointmentDate: '预约日期', availableTimes: '可预约时间', chooseDate: '请先选择日期', nextAvailable: '最快可预约', previousMonth: '上个月', nextMonth: '下个月', calendarAvailable: '可预约', calendarUnavailable: '不可预约', availabilitySelectionCleared: '员工或项目已变化，请重新选择日期和时间', customerPhone: '手机号码', optionalEmail: 'Email（选填）', enterName: '请输入姓名', enterPhone: '请输入手机号码', bookAppointment: '确认预约', bookingConfirmed: '预约成功', loadingCustomerServices: '正在读取服务...', noCustomerServices: '当前暂无可预约服务', checking: '正在查询...', noTimes: '当天暂无可预约时间', submitting: '正在提交...', availabilityFailed: '获取时间失败', requiredBookingFields: '请填写姓名、手机、日期并选择时间', bookingFailed: '预约失败', bookingSuccess: '预约成功！', from: '起',
      membershipEntry: 'VIP / 我的会员', myMembership: 'VIP / 我的会员', memberLabel: '会员', backToBooking: '← 返回预约', loadingMembership: '正在读取会员资料...', memberSignInHelp: '使用手机号登录或注册会员。', sendCode: '发送验证码', verificationCode: '验证码', verifyCode: '验证验证码', resendCode: '重新发送', otpSentGeneric: '如果该号码可接收短信，验证码已发送。', otpInvalid: '验证码无效或已过期', phoneInvalid: '请输入有效手机号', otpRateLimited: '请求过于频繁，请稍后再试', otpResendSoon: '请稍后再重新发送', otpGenericError: '暂时无法验证，请稍后再试', memberSupportRequired: '无法安全识别该号码，请联系商家', dateOfBirth: '出生日期', genderOptional: '性别（选填）', notSpecified: '不指定', genderFemale: '女', genderMale: '男', genderNonBinary: '非二元', preferNotToSay: '不愿透露', genderValue_female: '女', genderValue_male: '男', genderValue_non_binary: '非二元', genderValue_prefer_not_to_say: '不愿透露', completeMembership: '完成会员资料', nameRequired: '请填写姓名', dobRequired: '请填写出生日期', optional: '选填', profile: '会员资料', editProfile: '编辑资料', profileSaved: '会员资料已保存', changePhone: '更换手机号', newPhone: '新手机号', verifyNewPhone: '验证新手机号', phoneChanged: '手机号已更新', shopUnavailable: '当前商家不可用', merchantContactAria: '商家联系方式', merchantCall: '电话', merchantWhatsApp: 'WhatsApp 聊天', merchantBooking: '预约',      merchantContactSettings: '店铺联系方式', merchantContactHelp: '显示在顾客预约与会员页面；WhatsApp 使用国际号码。', merchantPublicPhone: '公开电话', merchantWhatsAppPhone: 'WhatsApp 电话', saveMerchantContact: '保存联系方式', offlineTitle: '暂时离线', offlineMessage: '目前处于离线状态，请重新连接后继续预约。',
      merchantAddress: '店铺详细地址', merchantPostalCode: '邮编', merchantMapUrl: '地图链接（选填）', merchantShowAddress: '在顾客预约端公开显示地址', openMap: '打开地图', address: '地址',
      myBookings: '我的预约', viewMyBookings: '查看我的预约', searchBookings: '查询预约', enterPhoneToView: '输入预约手机号查看预约', noBookingsFound: '未查询到相关预约', queryTooFrequent: '查询过于频繁，请稍后再试', unassignedStaff: '不指定员工', bookAgain: '继续预约', queryFailed: '查询失败，请稍后重试', appointmentNoLabel: '预约编号', statusPending: '已预约', statusConfirmed: '已确认', statusArrived: '已到店', statusInService: '服务中', statusCompleted: '已完成', statusCancelled: '已取消', statusNoShow: '未到店',
      checkoutStateDraft: '草稿单', checkoutStateUnpaid: '草稿单', checkoutStatePartiallyPaid: '部分支付', checkoutStatePaid: '已结账', checkoutStatePartiallyRefunded: '部分退款', checkoutStateRefunded: '已退款', checkoutStateVoid: '已作废', checkoutStateInconsistent: '结账状态异常', primaryStaff: '主理', assistantStaff: '助理', goToCheckout: '去结账', awaitingCheckout: '待结账', paid: '已结账', noServiceItems: '暂无服务项目', noStaffAssigned: '暂无员工', frontDeskWorkflow: '前台接待与收银流程', workflowFeaturePreview: '工作流展示', workflowAppointment: '预约', workflowArrived: '到店', workflowInService: '服务中', workflowCheckout: '去结账', workflowPaid: '已结账', checkoutDisabledNotice: '前台收银结算功能正在开发中，暂未在生产环境开放。', featureGatedNoticeTitle: '前台收银结算（特性门禁）', featureGatedNoticeDesc: '收银功能目前处于安全灰度/特性门禁阶段，尚未在生产环境开放。本阶段仅建立前台工作流与状态导航基础，不连接未发布的生产收银，不执行任何实际账单扣费。', iUnderstand: '好的，我知道了',
      appointmentDetails: '预约详情', booker: '预约人', recipient: '实际顾客', bookerSameAsRecipient: '预约人同实际顾客', notes: '备注', noNotes: '无', callCustomer: '拨打电话', openWhatsApp: '打开聊天', servicesAndStaff: '预约项目与员工', statusUpdatedSuccess: '预约状态更新成功', statusUpdateFailed: '预约状态更新失败', close: '关闭', emailNotProvided: '未填写', noCustomerPhone: '暂无电话', markArrived: '已到店', markInService: '服务中', markNoShow: '未到店', markCancelled: '取消预约',
      adjustAppointment: '调整预约', serviceAndPriceImmutableNotice: '服务项目与价格不可修改', newDate: '开始日期', newTime: '开始时间', estimatedEndTime: '预计结束时间', selectStaff: '选择员工', staffSkillMismatch: '该员工不会此项目，不能改派', customerSpecifiedStaffNotice: '原预约为顾客指定员工，改派需确认顾客同意', reassignmentReason: '改派原因', reassignmentReasonPlaceholder: '请输入改派原因（至少2个字符）', customerNotified: '已通知顾客', customerAgreed: '顾客已同意', conflictNoticeFrontDesk: '所选时间与现有预约存在冲突，前台角色无权强制重叠安排', conflictNoticeOwner: '所选时间与现有预约存在冲突。如需插单，请勾选强制重叠并填写原因。', overrideConflict: '确认强制重叠安排（插单）', conflictReason: '强制重叠原因', conflictReasonPlaceholder: '请输入强制重叠原因（至少2个字符）', saveAdjustment: '保存调整', adjusting: '正在调整...', appointmentAdjustedSuccess: '预约调整成功', reassignmentConsentRequired: '改派原指定员工必须确认已通知顾客且顾客已同意', reassignmentReasonRequired: '顾客原指定此员工，改派必须填写原因', conflictReasonRequired: '强制重叠安排必须填写原因', onlyPendingOrConfirmedEditable: '只能调整待确认或已确认的预约'
    },
    en: {
      calendar: 'Calendar', staff: 'Staff', services: 'Services', customers: 'Customers', checkout: 'Checkout', more: 'More',
      save: 'Save', saveProfile: 'Save Profile', saving: 'Saving...', saved: 'Saved', saveFailed: 'Save failed', savedReloadFailed: 'Saved, but failed to reload the latest data. Please retry.', unsavedChanges: 'Unsaved changes', discardUnsavedChanges: 'You have unsaved changes. Discard them and continue?', profileSaveDiscardsUnsaved: 'Other staff settings have unsaved changes. Saving the profile reloads staff settings. Discard those changes and continue?', cancel: 'Cancel', edit: 'Edit', add: 'Add', confirm: 'Confirm', complete: 'Complete', retry: 'Retry',
      pending: 'Pending', confirmed: 'Confirmed', arrived: 'Arrived', in_service: 'In Service', completed: 'Completed', cancelled: 'Cancelled', noShow: 'No Show', no_show: 'No Show', unknownStatus: 'Unknown Status',
      name: 'Name', phone: 'Phone', email: 'Email', price: 'Price', duration: 'Duration', category: 'Category', status: 'Status', actions: 'Actions', staffAvatar: 'Staff avatar',
      enabled: 'Enabled', disabled: 'Disabled', bookable: 'Bookable', notBookable: 'Not bookable', active: 'Active', inactive: 'Inactive',
      today: 'Today', tomorrow: 'Tomorrow', date: 'Date', time: 'Time', loading: 'Loading', loadFailed: 'Load Failed', error: 'Something went wrong',
      list: 'List', previousDay: 'Previous Day', nextDay: 'Next Day', unassigned: 'Unassigned', unassignedStaff: 'Unassigned Staff', noAppointmentsOnDate: 'No appointments on this date', appointmentsCount: 'appts', appointmentOverlap: 'Overlap', overlapNotice: 'Conflict', currentTime: 'Current Time', late15Min: '15 min late', notArrived: 'Not arrived', lateIndicatorAria: 'Late warning: 15 min late, not arrived',
      ownerPageTitle: 'GG-Beauty Owner Dashboard', customerPageTitle: 'GG-Beauty Online Appointment', ownerTitle: 'GG-Beauty Owner', ownerSubtitle: 'Appointment Dashboard', refreshAppointments: 'Refresh Appointments', logout: 'Log Out', comingSoon: 'Coming later',
      ownerLogin: 'GG-Beauty Owner Login', loginHelp: 'Use the owner account provided by the shop.', loginAccount: 'Enter login account', password: 'Enter password', shopSlug: 'Shop identifier (for multiple shops)', login: 'Log In', loginRequiredFields: 'Enter your login account and password', loggingIn: 'Logging in...', loginFailed: 'Login failed. Please try again.', logoutFailed: 'Log out failed. Please try again.', loggedOut: 'Logged out', authCheckFailed: 'Unable to verify your session. Please try again.',
      allAppointments: 'All Appointments', pendingAppointments: 'Pending', todayAppointments: 'Today', appointmentTime: 'Appointment Time', customerName: 'Customer', service: 'Service', noAppointments: 'No appointments yet', loadingAppointments: 'Loading appointments...', loginRequired: 'Log in to view appointments',
      confirmAppointmentPrompt: 'Confirm this appointment?', arrivedAppointmentPrompt: 'Mark customer as arrived?', startServicePrompt: 'Start service?', completeAppointmentPrompt: 'Complete this appointment?', noShowAppointmentPrompt: 'Mark this appointment as no show?', cancelAppointmentPrompt: 'Cancel this appointment?', operationFailed: 'Operation failed',
      serviceManagement: 'Services', serviceHelp: 'Manage pricing, duration and online booking', addService: 'Add Service', editService: 'Edit Service', noServices: 'No services yet', loadingServices: 'Loading services...', serviceName: 'Service Name', chineseName: 'Chinese Name', englishName: 'English Name', chineseDescription: 'Chinese Description', englishDescription: 'English Description', startingPrice: 'Starting Price', durationMinutes: 'Duration (minutes)', sortOrder: 'Sort Order', allowBooking: 'Allow customer booking', serviceActive: 'Service active', uncategorized: 'Uncategorised', minutes: 'min', serviceCategories: 'Service Categories', categoryHelp: 'Manage category names, icons, order and status', addCategory: 'Add Category', editCategory: 'Edit Category', loadingCategories: 'Loading categories...', noCategories: 'No service categories yet', icon: 'Icon', serviceCount: 'Services', chooseCategory: 'Choose a category', categoryRequired: 'A category is required for new services',
      staffManagement: 'Staff', staffHelp: 'Manage staff details, services and schedules', addStaff: 'Add Staff', basicDetails: 'Basic Details', staffName: 'Staff Name', staffCode: 'Staff Number', staffActive: 'Staff active', staffSetupNotice: 'Set up services and a schedule before allowing customer booking.', chooseStaff: 'Choose a staff member', noStaff: 'No staff yet', loadingStaff: 'Loading staff...', loadingStaffSettings: 'Loading staff settings...', adminReadOnly: 'Admin access is read-only',
      capabilities: 'Services', capabilityHeading: 'Services this staff member can perform', locations: 'Locations', weeklySchedule: 'Weekly Schedule', specialDates: 'Special Dates', saveCapabilities: 'Save Services', saveLocations: 'Save Locations', saveSchedule: 'Save Schedule', addSpecialDate: 'Add Override', noLocations: 'No locations', assignLocationFirst: 'Assign a location to this staff member first.', assignLocationBeforeSchedule: 'Assign a staff location before setting a schedule.', noCapabilityServices: 'No services', serviceInactive: 'Service inactive', serviceNotBookable: 'Not open for booking',
      monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday', working: 'Working', to: 'to', timezone: 'Timezone',
      store: 'Location', type: 'Type', dayOff: 'Day Off', leave: 'Leave', customHours: 'Special Hours', startTime: 'Start Time', endTime: 'End Time', notesOptional: 'Notes (optional)', noOverrides: 'No special dates', effective: 'Active', deactivate: 'Deactivate',
      addSelectedService: 'Add Service', addAnotherService: 'Add another service', selectedServices: 'Selected services', removeService: 'Remove', remove: 'Remove', totalDuration: 'Estimated duration', estimatedTotal: 'Estimated total', nextStep: 'Next', next: 'Next', noBookableServices: 'No services are currently available', serviceUnavailableRetry: 'This service is no longer available. Please select again.', loadServicesFailed: 'Unable to load services. Please try again.', cartModuleOutdated: 'System components are updating. Please reload the page to continue.', reloadPage: 'Reload Page', selectedState: 'Selected', bookingRecipient: 'Who is this booking for?', bookForMyself: 'Book for myself', bookForSomeoneElse: 'Book for someone else', yourDetails: 'Your contact details', recipientDetails: 'Service recipient details', recipientName: 'Recipient name', enterRecipientName: 'Enter recipient name', countryRegion: 'Country / Region', recipientPhone: 'Recipient phone', recipientEmail: 'Recipient email (optional)', countrySingapore: 'Singapore', countryMalaysia: 'Malaysia', countryIndonesia: 'Indonesia', countryChina: 'China', countryUnitedStates: 'United States',
      invalidScheduleTime: 'Start time must be before end time. Overnight shifts are not supported.', invalidOverrideTime: 'Start time must be before end time. Overnight periods are not supported.', customHoursRequired: 'Special hours require both a start and end time.',
      sessionExpired: 'Your session expired. Please log in again.', sessionExpiredShort: 'Session Expired', unauthorized: 'Session Expired', calendarSessionExpired: 'Session Expired', staffFutureAppointments: 'This staff member has future appointments and cannot be deactivated yet.', staffServiceFutureAppointments: 'A future appointment uses this staff service, so it cannot be removed yet.', scheduleFutureAppointments: 'The new schedule conflicts with a future appointment.',
      onlineAppointment: 'Online Appointment', chooseServiceCategory: 'Choose a Service Category', allCategories: 'All', otherCategory: 'Other', reloadServices: 'Retry', chooseStaffCustomer: 'Choose Staff', customerStaffNoPreference: 'No Preference', customerStaffNoPreferenceFastest: 'No preference | Fastest system match', customerStaffChoose: 'Choose Staff', customerStaffNone: 'No staff are currently available', customerStaffLoading: 'Loading staff...', customerStaffAnyAvailable: 'Any available staff', chooseStaffForSlot: 'Choose staff for this time slot', itemTimeSlot: 'Service Time', chooseStaffAfterTime: 'Please choose an appointment time first to see available staff', appointmentDate: 'Appointment Date', availableTimes: 'Available Times', chooseDate: 'Choose a date first', nextAvailable: 'Next available', previousMonth: 'Previous month', nextMonth: 'Next month', calendarAvailable: 'Available', calendarUnavailable: 'Unavailable', availabilitySelectionCleared: 'Staff or services changed. Choose a new date and time.', customerPhone: 'Mobile Number', optionalEmail: 'Email (optional)', enterName: 'Enter your name', enterPhone: 'Enter your mobile number', bookAppointment: 'Confirm Booking', bookingConfirmed: 'Booking Confirmed', loadingCustomerServices: 'Loading services...', noCustomerServices: 'No services are currently available for booking.', checking: 'Checking...', noTimes: 'No available times on this date.', submitting: 'Submitting...', availabilityFailed: 'Unable to load available times', requiredBookingFields: 'Enter your name, phone and date, then choose a time', bookingFailed: 'Booking failed', bookingSuccess: 'Appointment booked!', from: 'From',
      membershipEntry: 'VIP / My Membership', myMembership: 'VIP / My Membership', memberLabel: 'MEMBER', backToBooking: '← Back to booking', loadingMembership: 'Loading membership...', memberSignInHelp: 'Use your mobile number to sign in or register.', sendCode: 'Send code', verificationCode: 'Verification code', verifyCode: 'Verify code', resendCode: 'Resend code', otpSentGeneric: 'If this number can receive messages, a code has been sent.', otpInvalid: 'The code is invalid or expired', phoneInvalid: 'Enter a valid mobile number', otpRateLimited: 'Too many requests. Try again later', otpResendSoon: 'Please wait before resending', otpGenericError: 'Unable to verify right now. Try again later', memberSupportRequired: 'We cannot safely identify this number. Contact the shop', dateOfBirth: 'Date of birth', genderOptional: 'Gender (optional)', notSpecified: 'Not specified', genderFemale: 'Female', genderMale: 'Male', genderNonBinary: 'Non-binary', preferNotToSay: 'Prefer not to say', genderValue_female: 'Female', genderValue_male: 'Male', genderValue_non_binary: 'Non-binary', genderValue_prefer_not_to_say: 'Prefer not to say', completeMembership: 'Complete membership', nameRequired: 'Enter your name', dobRequired: 'Enter your date of birth', optional: 'optional', profile: 'Profile', editProfile: 'Edit profile', profileSaved: 'Profile saved', changePhone: 'Change phone', newPhone: 'New phone', verifyNewPhone: 'Verify new phone', phoneChanged: 'Phone updated', shopUnavailable: 'This shop is unavailable', merchantContactAria: 'Merchant contact options', merchantCall: 'Call', merchantWhatsApp: 'WhatsApp Chat', merchantBooking: 'Booking', merchantContactSettings: 'Shop Contact Details', merchantContactHelp: 'Shown on customer booking and membership pages. Use an international WhatsApp number.', merchantPublicPhone: 'Public phone', merchantWhatsAppPhone: 'WhatsApp phone', saveMerchantContact: 'Save Contact Details', offlineTitle: 'You are offline', offlineMessage: 'Reconnect to continue booking.',
      merchantAddress: 'Shop Address', merchantPostalCode: 'Postal Code', merchantMapUrl: 'Map Link (Optional)', merchantShowAddress: 'Display address to customers', openMap: 'Open Map', address: 'Address',
      myBookings: 'My Bookings', viewMyBookings: 'View My Bookings', searchBookings: 'Search Bookings', enterPhoneToView: 'Enter your mobile number to view bookings', noBookingsFound: 'No bookings found', queryTooFrequent: 'Too many requests. Please try again later', unassignedStaff: 'No preference', bookAgain: 'Book Again', queryFailed: 'Query failed. Please try again later', appointmentNoLabel: 'Booking No.', statusPending: 'Booked', statusConfirmed: 'Confirmed', statusArrived: 'Arrived', statusInService: 'In Service', statusCompleted: 'Completed', statusCancelled: 'Cancelled', statusNoShow: 'No Show',
      checkoutStateDraft: 'Draft', checkoutStateUnpaid: 'Draft', checkoutStatePartiallyPaid: 'Partially Paid', checkoutStatePaid: 'Paid', checkoutStatePartiallyRefunded: 'Partially Refunded', checkoutStateRefunded: 'Refunded', checkoutStateVoid: 'Voided', checkoutStateInconsistent: 'Checkout Status Issue', primaryStaff: 'Primary', assistantStaff: 'Assistant', goToCheckout: 'Checkout', awaitingCheckout: 'Awaiting Checkout', paid: 'Paid', noServiceItems: 'No service items', noStaffAssigned: 'No staff', frontDeskWorkflow: 'Front Desk Workflow', workflowFeaturePreview: 'Workflow Guide', workflowAppointment: 'Booked', workflowArrived: 'Arrived', workflowInService: 'In Service', workflowCheckout: 'Checkout', workflowPaid: 'Paid', checkoutDisabledNotice: 'Checkout / POS is currently in development and feature-gated.', featureGatedNoticeTitle: 'Front Desk Checkout (Feature Gated)', featureGatedNoticeDesc: 'Checkout is currently feature-gated awaiting backend release. This preview establishes navigation and workflow foundation without connecting to production checkout.', iUnderstand: 'Understood',
      appointmentDetails: 'Appointment Details', booker: 'Booker', recipient: 'Recipient', bookerSameAsRecipient: 'Same as recipient', notes: 'Notes', noNotes: 'None', callCustomer: 'Call', openWhatsApp: 'WhatsApp', servicesAndStaff: 'Services & Staff', statusUpdatedSuccess: 'Status updated successfully', statusUpdateFailed: 'Status update failed', close: 'Close', emailNotProvided: 'Not provided', noCustomerPhone: 'No phone number', markArrived: 'Arrived', markInService: 'In Service', markNoShow: 'No Show', markCancelled: 'Cancel',
      adjustAppointment: 'Adjust Appointment', serviceAndPriceImmutableNotice: 'Service and price cannot be modified', newDate: 'Start Date', newTime: 'Start Time', estimatedEndTime: 'Estimated End Time', selectStaff: 'Select Staff', staffSkillMismatch: 'This staff member cannot perform this service', customerSpecifiedStaffNotice: 'The original appointment requested a specific staff. Reassignment requires customer consent.', reassignmentReason: 'Reassignment Reason', reassignmentReasonPlaceholder: 'Enter reassignment reason (min 2 characters)', customerNotified: 'Customer has been notified', customerAgreed: 'Customer has agreed', conflictNoticeFrontDesk: 'This time conflicts with an existing appointment. Front desk does not have permission to force overlap.', conflictNoticeOwner: 'This time conflicts with an existing appointment. To double-book, check Force Overlap and enter a reason.', overrideConflict: 'Force overlap (double-book)', conflictReason: 'Force Overlap Reason', conflictReasonPlaceholder: 'Enter force overlap reason (min 2 characters)', saveAdjustment: 'Save Adjustment', adjusting: 'Adjusting...', appointmentAdjustedSuccess: 'Appointment adjusted successfully', reassignmentConsentRequired: 'Reassigning a customer-specified staff requires customer consent', reassignmentReasonRequired: 'Customer specified this staff member. Reassignment reason is required', conflictReasonRequired: 'A reason is required to force an overlapping appointment', onlyPendingOrConfirmedEditable: 'Only pending or confirmed appointments can be adjusted'
    }
  };

  const AUTHORITATIVE_APPOINTMENT_STATUSES = Object.freeze([
    'pending',
    'confirmed',
    'arrived',
    'in_service',
    'completed',
    'no_show',
    'cancelled'
  ]);

  function isAuthoritativeAppointmentStatus(status) {
    if (typeof status !== 'string') return false;
    const normalized = status.trim().toLowerCase();
    return AUTHORITATIVE_APPOINTMENT_STATUSES.includes(normalized);
  }

  function normalizeAppointmentStatus(status) {
    if (typeof status !== 'string') return 'unknown';
    const normalized = status.trim().toLowerCase();
    return AUTHORITATIVE_APPOINTMENT_STATUSES.includes(normalized)
      ? normalized
      : 'unknown';
  }

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
    if (!isAuthoritativeAppointmentStatus(status)) {
      return t('unknownStatus', locale);
    }
    const normalized = status.trim().toLowerCase();
    const key = normalized === 'no_show' ? 'noShow' : normalized;
    return t(key, locale);
  }
  function formatCheckoutStatus(status, locale) {
    const map = {
      unpaid: 'checkoutStateUnpaid',
      partially_paid: 'checkoutStatePartiallyPaid',
      paid: 'checkoutStatePaid',
      partially_refunded: 'checkoutStatePartiallyRefunded',
      refunded: 'checkoutStateRefunded',
      void: 'checkoutStateVoid',
      inconsistent: 'checkoutStateInconsistent'
    };
    const key = (typeof status === 'string' && Object.prototype.hasOwnProperty.call(map, status))
      ? map[status]
      : 'checkoutStateInconsistent';
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

  function getStaffInitials(name) {
    if (typeof name !== 'string') return '';
    const trimmed = name.trim();
    if (!trimmed) return '';
    const parts = trimmed.split(/[\s_\-]+/).filter(Boolean);
    if (parts.length >= 2) {
      const first = Array.from(parts[0])[0] || '';
      const second = Array.from(parts[1])[0] || '';
      return (first + second).toUpperCase();
    }
    const chars = Array.from(trimmed);
    return chars.slice(0, 2).join('').toUpperCase();
  }

  return {
    DEFAULT_LOCALE,
    STORAGE_KEY,
    dictionaries,
    AUTHORITATIVE_APPOINTMENT_STATUSES,
    isAuthoritativeAppointmentStatus,
    normalizeAppointmentStatus,
    normalizeLocale,
    browserLocale: detectBrowserLocale,
    detectBrowserLocale,
    getStoredLocale,
    setLocale,
    t,
    formatDate,
    formatDuration,
    formatPrice,
    formatStatus,
    formatCheckoutStatus,
    resolveLocalizedService,
    getStaffInitials
  };
});
