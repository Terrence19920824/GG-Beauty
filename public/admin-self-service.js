(function (global) {
  'use strict';

  const state = {
    profile: null,
    services: [],
    staff: [],
    selectedStaffId: null,
    capability: [],
    locations: [],
    schedule: null,
    overrides: [],
    selectedLocationId: null,
    editingServiceId: null,
    capabilityIds: new Set(),
    locationIds: new Set()
  };

  const byId = id => document.getElementById(id);
  const value = id => byId(id).value;
  const checked = id => byId(id).checked;
  const escapeHtml = input => String(input == null ? '' : input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
  const canWrite = () => ['owner', 'manager'].includes(state.profile?.membership?.role);
  const apiValue = (object, camel, snake) => object?.[camel] ?? object?.[snake];
  const dateValue = input => input ? String(input).slice(0, 10) : '';
  const timeValue = input => input == null ? '' : String(input).slice(0, 5);

  const businessMessage = (result, fallback) => ({
    STAFF_HAS_FUTURE_APPOINTMENTS: '该员工已有未来预约，暂时不能停用。',
    STAFF_SERVICE_HAS_FUTURE_APPOINTMENTS: '该员工已有未来预约使用这个项目，暂时不能取消该服务能力。',
    SCHEDULE_CONFLICTS_WITH_FUTURE_APPOINTMENTS: '新排班与该员工未来预约冲突。'
  }[result?.code] || result?.message || fallback);

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
    });
    let result = {};
    try { result = await response.json(); } catch (_error) { result = {}; }
    if (response.status === 401) {
      if (typeof global.showLogin === 'function') global.showLogin(result.message || '登录已过期，请重新登录');
      const error = new Error('登录已过期，请重新登录');
      error.sessionExpired = true;
      throw error;
    }
    if (!response.ok || result.success === false) {
      const error = new Error(businessMessage(result, '操作失败，请稍后重试'));
      error.status = response.status;
      error.code = result.code;
      throw error;
    }
    return result.data;
  }

  function setBusy(buttonId, busy) {
    const button = byId(buttonId);
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? '保存中...' : button.dataset.label;
  }

  function setMessage(id, text, isError = false) {
    const element = byId(id);
    if (!element) return;
    element.textContent = text;
    element.style.color = isError ? '#c62828' : '#087443';
  }

  function setProfile(profile) {
    state.profile = profile;
    const write = canWrite();
    byId('addServiceButton').hidden = !write;
    byId('addStaffButton').hidden = !write;
  }

  function reset() {
    state.profile = null;
    state.services = [];
    state.staff = [];
    state.selectedStaffId = null;
    byId('servicesList').textContent = '';
    byId('staffList').textContent = '';
    byId('staffDetail').innerHTML = '<div class="empty">请选择一位员工</div>';
    showViewOnly('calendar');
  }

  function showViewOnly(name) {
    ['calendar', 'staff', 'services'].forEach(item => {
      byId(`${item}View`).hidden = item !== name;
      byId(`nav-${item}`).classList.toggle('active', item === name);
    });
  }

  async function showView(name) {
    showViewOnly(name);
    if (name === 'calendar') return global.loadAppointments();
    if (name === 'services') return loadServices();
    if (name === 'staff') return loadStaff();
  }

  async function loadServices() {
    const list = byId('servicesList');
    list.className = 'loading';
    list.textContent = '正在读取服务...';
    try {
      state.services = await request('/api/owner/services') || [];
      renderServices();
    } catch (error) {
      if (!error.sessionExpired) { list.className = 'error'; list.textContent = error.message; }
    }
  }

  function renderServices() {
    const list = byId('servicesList');
    if (!state.services.length) {
      list.className = 'empty';
      list.textContent = '还没有服务项目';
      return;
    }
    list.className = '';
    const actions = canWrite();
    list.innerHTML = `<div class="service-table"><table><thead><tr><th>分类</th><th>服务名称</th><th>价格</th><th>时长</th><th>可预约</th><th>状态</th>${actions ? '<th>操作</th>' : ''}</tr></thead><tbody>${state.services.map(service => {
      const id = escapeHtml(service.id);
      return `<tr><td>${escapeHtml(service.category || '未分类')}</td><td>${escapeHtml(service.name)}</td><td>S$ ${Number(service.price || 0).toFixed(2)}</td><td>${escapeHtml(apiValue(service, 'durationMinutes', 'duration_minutes'))} 分钟</td><td>${service.bookable ? '开启' : '关闭'}</td><td>${apiValue(service, 'isActive', 'is_active') ? '启用' : '停用'}</td>${actions ? `<td><button class="secondary-btn" onclick="ownerSelfService.openServiceForm('${id}')">编辑</button></td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
  }

  function openServiceForm(serviceId) {
    if (!canWrite()) return;
    const service = serviceId ? state.services.find(item => item.id === serviceId) : null;
    state.editingServiceId = service?.id || null;
    byId('serviceFormTitle').textContent = service ? '编辑服务' : '新增服务';
    byId('serviceName').value = service?.name || '';
    byId('serviceCategory').value = service?.category || '';
    byId('serviceDescription').value = service?.description || '';
    byId('servicePrice').value = service?.price ?? '';
    byId('serviceDuration').value = apiValue(service, 'durationMinutes', 'duration_minutes') ?? 60;
    byId('serviceSortOrder').value = apiValue(service, 'sortOrder', 'sort_order') ?? 0;
    byId('serviceBookable').checked = service?.bookable ?? false;
    byId('serviceActive').checked = apiValue(service, 'isActive', 'is_active') ?? true;
    byId('serviceFormPanel').hidden = false;
  }

  function closeServiceForm() {
    state.editingServiceId = null;
    byId('serviceFormPanel').hidden = true;
  }

  async function saveService() {
    if (!canWrite()) return;
    const body = {
      name: value('serviceName').trim(),
      category: value('serviceCategory').trim() || null,
      description: value('serviceDescription').trim() || null,
      price: Number(value('servicePrice')),
      durationMinutes: Number(value('serviceDuration')),
      bookable: checked('serviceBookable'),
      isActive: checked('serviceActive'),
      sortOrder: Number(value('serviceSortOrder'))
    };
    setBusy('saveServiceButton', true);
    setMessage('servicesMessage', '');
    try {
      const editing = state.editingServiceId;
      await request(editing ? `/api/owner/services/${encodeURIComponent(editing)}` : '/api/owner/services', {
        method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body)
      });
      closeServiceForm();
      setMessage('servicesMessage', '已保存');
      await loadServices();
    } catch (error) {
      if (!error.sessionExpired) setMessage('servicesMessage', error.message, true);
    } finally { setBusy('saveServiceButton', false); }
  }

  async function loadStaff() {
    const list = byId('staffList');
    list.className = 'loading';
    list.textContent = '正在读取员工...';
    try {
      state.staff = await request('/api/owner/staff') || [];
      renderStaffList();
      if (state.selectedStaffId && state.staff.some(item => item.id === state.selectedStaffId)) await selectStaff(state.selectedStaffId);
    } catch (error) {
      if (!error.sessionExpired) { list.className = 'error'; list.textContent = error.message; }
    }
  }

  function renderStaffList() {
    const list = byId('staffList');
    if (!state.staff.length) { list.className = 'empty'; list.textContent = '还没有员工'; return; }
    list.className = '';
    list.innerHTML = state.staff.map(staff => `<div class="list-card ${staff.id === state.selectedStaffId ? 'selected' : ''}" onclick="ownerSelfService.selectStaff('${escapeHtml(staff.id)}')"><h3>${escapeHtml(staff.name)}</h3>${apiValue(staff, 'staffCode', 'staff_code') ? `<div class="muted">员工编号：${escapeHtml(apiValue(staff, 'staffCode', 'staff_code'))}</div>` : ''}<span class="pill">${staff.bookable ? '可预约' : '未开放预约'}</span><span class="pill">${apiValue(staff, 'isActive', 'is_active') ? '启用' : '停用'}</span><div>${(staff.locations || []).map(location => `<span class="pill">${escapeHtml(location.name)}</span>`).join('')}</div></div>`).join('');
  }

  function openStaffForm() {
    if (!canWrite()) return;
    state.selectedStaffId = null;
    renderStaffForm(null);
    renderStaffList();
  }

  function renderStaffForm(staff) {
    const isNew = !staff;
    const disabled = canWrite() ? '' : 'disabled';
    byId('staffDetail').innerHTML = `<div class="section-heading"><h3>${isNew ? '新增员工' : '基本资料'}</h3></div>${isNew ? '<div class="notice">请先设置服务与排班，再开放顾客预约。</div>' : ''}<div class="form-grid"><label class="field"><span>员工姓名</span><input id="staffName" maxlength="200" value="${escapeHtml(staff?.name || '')}" ${disabled}></label><label class="field"><span>员工编号</span><input id="staffCode" maxlength="50" value="${escapeHtml(apiValue(staff, 'staffCode', 'staff_code') || '')}" ${disabled}></label><label class="field"><span>电话</span><input id="staffPhone" maxlength="50" value="${escapeHtml(staff?.phone || '')}" ${disabled}></label><label class="field"><span>Email</span><input id="staffEmail" maxlength="254" value="${escapeHtml(staff?.email || '')}" ${disabled}></label><label class="check-row"><input id="staffBookable" type="checkbox" ${staff?.bookable ? 'checked' : ''} ${disabled}>允许顾客预约</label><label class="check-row"><input id="staffActive" type="checkbox" ${isNew || apiValue(staff, 'isActive', 'is_active') ? 'checked' : ''} ${disabled}>员工启用状态</label></div>${canWrite() ? `<div class="form-actions"><span id="staffSaveStatus" class="save-status"></span><button id="saveStaffButton" class="primary-btn" onclick="ownerSelfService.saveStaff(${isNew ? 'true' : 'false'})">保存</button></div>` : '<div class="notice">管理员为只读权限</div>'}${isNew ? '' : '<div id="staffSettings"></div>'}`;
  }

  async function saveStaff(isNew) {
    if (!canWrite()) return;
    const body = { name: value('staffName').trim(), phone: value('staffPhone').trim() || null, email: value('staffEmail').trim() || null, staffCode: value('staffCode').trim() || null, bookable: isNew ? false : checked('staffBookable'), isActive: checked('staffActive') };
    setBusy('saveStaffButton', true);
    try {
      const saved = await request(isNew ? '/api/owner/staff' : `/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}`, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) });
      state.selectedStaffId = saved.id || state.selectedStaffId;
      setMessage('staffMessage', '已保存');
      await loadStaff();
    } catch (error) {
      if (!error.sessionExpired) setMessage('staffSaveStatus', error.message, true);
    } finally { setBusy('saveStaffButton', false); }
  }

  async function selectStaff(staffId) {
    state.selectedStaffId = staffId;
    renderStaffList();
    const staff = state.staff.find(item => item.id === staffId);
    if (!staff) return;
    renderStaffForm(staff);
    byId('staffSettings').innerHTML = '<div class="loading">正在读取员工设置...</div>';
    try {
      const [capability, locations, overrides] = await Promise.all([
        request(`/api/owner/staff/${encodeURIComponent(staffId)}/services`),
        request(`/api/owner/staff/${encodeURIComponent(staffId)}/locations`),
        request(`/api/owner/staff/${encodeURIComponent(staffId)}/schedule-overrides`)
      ]);
      state.capability = capability || [];
      state.locations = locations || [];
      state.overrides = overrides || [];
      state.capabilityIds = new Set(state.capability.filter(item => item.assigned).map(item => apiValue(item, 'serviceId', 'service_id')));
      state.locationIds = new Set(state.locations.filter(item => item.assigned).map(item => item.id));
      const availableLocation = state.locations.find(item => item.assigned && apiValue(item, 'isActive', 'is_active') !== false);
      state.selectedLocationId = availableLocation?.id || null;
      await loadSchedule();
      renderStaffSettings();
    } catch (error) {
      if (!error.sessionExpired) byId('staffSettings').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  }

  async function loadSchedule() {
    state.schedule = null;
    if (!state.selectedLocationId) return;
    state.schedule = await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/schedule?locationId=${encodeURIComponent(state.selectedLocationId)}`);
  }

  function renderStaffSettings() {
    const readonly = !canWrite();
    const activeLocations = state.locations.filter(item => item.assigned);
    byId('staffSettings').innerHTML = `<div class="tabs"><button class="tab-btn active" onclick="ownerSelfService.openStaffTab('capability')">会做项目</button><button class="tab-btn" onclick="ownerSelfService.openStaffTab('locations')">所属门店</button><button class="tab-btn" onclick="ownerSelfService.openStaffTab('schedule')">每周排班</button><button class="tab-btn" onclick="ownerSelfService.openStaffTab('overrides')">特殊日期</button></div><div id="staffTabContent"></div>`;
    openStaffTab('capability');
    if (!activeLocations.length && !readonly) setMessage('staffMessage', '请先分配员工所在门店，再设置排班。');
  }

  function openStaffTab(tab) {
    const container = byId('staffTabContent');
    if (!container) return;
    if (tab === 'capability') renderCapability(container);
    if (tab === 'locations') renderLocations(container);
    if (tab === 'schedule') renderSchedule(container);
    if (tab === 'overrides') renderOverrides(container);
  }

  function renderCapability(container) {
    container.innerHTML = `<div class="section-heading"><h3>会做的项目</h3></div>${state.capability.map(service => {
      const id = apiValue(service, 'serviceId', 'service_id');
      const active = apiValue(service, 'isActive', 'is_active');
      const selected = state.capabilityIds.has(id);
      const disabled = !canWrite() || (!active && !selected);
      return `<div class="check-row"><input type="checkbox" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="ownerSelfService.toggleCapability('${escapeHtml(id)}', this.checked)"><label>${escapeHtml(service.name)} <span class="muted">${escapeHtml(service.category || '')}${!active ? ' · 项目已停用' : ''}${!service.bookable ? ' · 当前未开放预约' : ''}</span></label></div>`;
    }).join('') || '<div class="empty">暂无服务项目</div>'}${canWrite() ? '<div class="form-actions"><span id="capabilityStatus" class="save-status"></span><button id="saveCapabilityButton" class="primary-btn" onclick="ownerSelfService.saveCapability()">保存项目</button></div>' : '<div class="notice">管理员为只读权限</div>'}`;
  }

  function toggleCapability(id, enabled) { enabled ? state.capabilityIds.add(id) : state.capabilityIds.delete(id); }
  async function saveCapability() {
    setBusy('saveCapabilityButton', true);
    try {
      await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/services`, { method: 'PUT', body: JSON.stringify({ serviceIds: [...state.capabilityIds] }) });
      setMessage('capabilityStatus', '已保存');
    } catch (error) { if (!error.sessionExpired) setMessage('capabilityStatus', error.message, true); }
    finally { setBusy('saveCapabilityButton', false); }
  }

  function renderLocations(container) {
    container.innerHTML = `<div class="section-heading"><h3>所属门店</h3></div>${state.locations.map(location => `<div class="check-row"><input type="checkbox" ${state.locationIds.has(location.id) ? 'checked' : ''} ${!canWrite() || apiValue(location, 'isActive', 'is_active') === false ? 'disabled' : ''} onchange="ownerSelfService.toggleLocation('${escapeHtml(location.id)}', this.checked)"><label>${escapeHtml(location.name)} <span class="muted">${escapeHtml(location.timezone || '')}</span></label></div>`).join('') || '<div class="empty">暂无门店</div>'}${canWrite() ? '<div class="form-actions"><span id="locationStatus" class="save-status"></span><button id="saveLocationsButton" class="primary-btn" onclick="ownerSelfService.saveLocations()">保存门店</button></div>' : '<div class="notice">管理员为只读权限</div>'}`;
  }
  function toggleLocation(id, enabled) { enabled ? state.locationIds.add(id) : state.locationIds.delete(id); }
  async function saveLocations() {
    setBusy('saveLocationsButton', true);
    try {
      await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/locations`, { method: 'PUT', body: JSON.stringify({ locationIds: [...state.locationIds] }) });
      setMessage('locationStatus', '已保存');
      await selectStaff(state.selectedStaffId);
    } catch (error) { if (!error.sessionExpired) setMessage('locationStatus', error.message, true); }
    finally { setBusy('saveLocationsButton', false); }
  }

  function renderSchedule(container) {
    const assigned = state.locations.filter(item => item.assigned);
    if (!assigned.length) { container.innerHTML = '<div class="notice">请先为员工分配门店。</div>'; return; }
    const days = state.schedule?.days || Array.from({ length: 7 }, (_, index) => ({ dayOfWeek: index + 1, isWorking: false }));
    const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    container.innerHTML = `<div class="section-heading"><h3>每周排班</h3><select id="scheduleLocation" onchange="ownerSelfService.changeScheduleLocation(this.value)">${assigned.map(location => `<option value="${escapeHtml(location.id)}" ${location.id === state.selectedLocationId ? 'selected' : ''}>${escapeHtml(location.name)}</option>`).join('')}</select></div><div class="muted">时区：${escapeHtml(state.schedule?.timezone || assigned.find(item => item.id === state.selectedLocationId)?.timezone || '')}</div>${days.map(day => `<div class="schedule-row"><span class="weekday">${names[day.dayOfWeek - 1]}</span><label><input id="scheduleWorking${day.dayOfWeek}" type="checkbox" ${day.isWorking ? 'checked' : ''} ${!canWrite() ? 'disabled' : ''}> 工作</label><input id="scheduleStart${day.dayOfWeek}" type="time" value="${escapeHtml(day.startTime || '10:00')}" ${!canWrite() ? 'disabled' : ''}><span>至</span><input id="scheduleEnd${day.dayOfWeek}" type="time" value="${escapeHtml(day.endTime || '19:00')}" ${!canWrite() ? 'disabled' : ''}></div>`).join('')}${canWrite() ? '<div class="form-actions"><span id="scheduleStatus" class="save-status"></span><button id="saveScheduleButton" class="primary-btn" onclick="ownerSelfService.saveSchedule()">保存排班</button></div>' : '<div class="notice">管理员为只读权限</div>'}`;
  }

  async function changeScheduleLocation(locationId) {
    state.selectedLocationId = locationId;
    try { await loadSchedule(); renderSchedule(byId('staffTabContent')); }
    catch (error) { if (!error.sessionExpired) byId('staffTabContent').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
  }

  async function saveSchedule() {
    const days = [];
    for (let day = 1; day <= 7; day += 1) {
      const isWorking = checked(`scheduleWorking${day}`);
      const entry = { dayOfWeek: day, isWorking };
      if (isWorking) {
        entry.startTime = value(`scheduleStart${day}`);
        entry.endTime = value(`scheduleEnd${day}`);
        if (!entry.startTime || !entry.endTime || entry.startTime >= entry.endTime) { setMessage('scheduleStatus', '开始时间必须早于结束时间，不支持跨夜排班。', true); return; }
      }
      days.push(entry);
    }
    setBusy('saveScheduleButton', true);
    try {
      await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/schedule`, { method: 'PUT', body: JSON.stringify({ locationId: state.selectedLocationId, days }) });
      setMessage('scheduleStatus', '已保存');
      await loadSchedule();
    } catch (error) { if (!error.sessionExpired) setMessage('scheduleStatus', error.message, true); }
    finally { setBusy('saveScheduleButton', false); }
  }

  function renderOverrides(container) {
    const assigned = state.locations.filter(item => item.assigned);
    container.innerHTML = `<div class="section-heading"><h3>特殊日期</h3></div>${canWrite() && assigned.length ? `<div class="form-grid"><label class="field"><span>门店</span><select id="overrideLocation">${assigned.map(location => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name)}</option>`).join('')}</select></label><label class="field"><span>日期</span><input id="overrideDate" type="date"></label><label class="field"><span>类型</span><select id="overrideType" onchange="ownerSelfService.updateOverrideFields()"><option value="day_off">休息一天</option><option value="leave">请假</option><option value="custom_hours">特殊营业时间</option></select></label><label id="overrideStartField" class="field" hidden><span>开始时间</span><input id="overrideStart" type="time"></label><label id="overrideEndField" class="field" hidden><span>结束时间</span><input id="overrideEnd" type="time"></label><label class="field full"><span>备注（可选）</span><input id="overrideReason" maxlength="1000"></label></div><div class="form-actions"><span id="overrideStatus" class="save-status"></span><button id="saveOverrideButton" class="primary-btn" onclick="ownerSelfService.saveOverride()">新增特殊日期</button></div>` : (!assigned.length ? '<div class="notice">请先为员工分配门店。</div>' : '<div class="notice">管理员为只读权限</div>')}<div>${state.overrides.map(item => `<div class="list-card"><strong>${escapeHtml(dateValue(apiValue(item, 'scheduleDate', 'schedule_date')))}</strong> · ${escapeHtml(overrideLabel(apiValue(item, 'overrideType', 'override_type')))}<div class="muted">${escapeHtml(apiValue(item, 'locationName', 'location_name') || '')} ${timeValue(apiValue(item, 'startTime', 'start_time'))}${apiValue(item, 'endTime', 'end_time') ? ` - ${escapeHtml(timeValue(apiValue(item, 'endTime', 'end_time')))}` : ''} · ${apiValue(item, 'isActive', 'is_active') ? '生效中' : '已停用'}</div>${canWrite() && apiValue(item, 'isActive', 'is_active') ? `<button class="secondary-btn" onclick="ownerSelfService.deactivateOverride('${escapeHtml(item.id)}')">停用</button>` : ''}</div>`).join('') || '<div class="empty">暂无特殊日期</div>'}</div>`;
  }

  function overrideLabel(type) { return ({ day_off: '休息一天', leave: '请假', custom_hours: '特殊营业时间', working: '特殊营业时间' }[type] || '特殊日期'); }
  function updateOverrideFields() {
    const showTimes = value('overrideType') !== 'day_off';
    byId('overrideStartField').hidden = !showTimes;
    byId('overrideEndField').hidden = !showTimes;
  }
  async function saveOverride() {
    const type = value('overrideType');
    const body = { locationId: value('overrideLocation'), scheduleDate: value('overrideDate'), overrideType: type, reason: value('overrideReason').trim() || null };
    if (type !== 'day_off') {
      body.startTime = value('overrideStart') || null;
      body.endTime = value('overrideEnd') || null;
      if ((body.startTime || body.endTime) && (!body.startTime || !body.endTime || body.startTime >= body.endTime)) { setMessage('overrideStatus', '开始时间必须早于结束时间，不支持跨夜。', true); return; }
      if (type === 'custom_hours' && (!body.startTime || !body.endTime)) { setMessage('overrideStatus', '特殊营业时间必须填写开始和结束时间。', true); return; }
    }
    setBusy('saveOverrideButton', true);
    try {
      await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/schedule-overrides`, { method: 'POST', body: JSON.stringify(body) });
      setMessage('overrideStatus', '已保存');
      state.overrides = await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/schedule-overrides`) || [];
      renderOverrides(byId('staffTabContent'));
    } catch (error) { if (!error.sessionExpired) setMessage('overrideStatus', error.message, true); }
    finally { setBusy('saveOverrideButton', false); }
  }
  async function deactivateOverride(overrideId) {
    try {
      await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/schedule-overrides/${encodeURIComponent(overrideId)}`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) });
      state.overrides = await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/schedule-overrides`) || [];
      renderOverrides(byId('staffTabContent'));
    } catch (error) { if (!error.sessionExpired) setMessage('staffMessage', error.message, true); }
  }

  global.ownerSelfService = { setProfile, reset, showView, loadServices, openServiceForm, closeServiceForm, saveService, loadStaff, openStaffForm, saveStaff, selectStaff, openStaffTab, toggleCapability, saveCapability, toggleLocation, saveLocations, changeScheduleLocation, saveSchedule, updateOverrideFields, saveOverride, deactivateOverride, _state: state, _request: request };
})(globalThis);
