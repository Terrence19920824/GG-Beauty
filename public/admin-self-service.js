(function (global) {
  'use strict';

  const state = {
    locale: 'en',
    profile: null,
    services: [],
    categories: [],
    staff: [],
    selectedStaffId: null,
    capability: [],
    locations: [],
    schedule: null,
    overrides: [],
    selectedLocationId: null,
    editingServiceId: null,
    editingCategoryId: null,
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
  const localeApi = global.ggI18n || global.ggServiceLocale || {
    STORAGE_KEY: 'gg_beauty_locale',
    normalizeLocale: locale => typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
    browserLocale: navigatorLike => {
      const languages = Array.isArray(navigatorLike?.languages) ? navigatorLike.languages : [navigatorLike?.language];
      return languages.some(language => typeof language === 'string' && language.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en';
    }
  };
  const t = (key, params) => localeApi.t ? localeApi.t(key, state.locale, params) : key;
  const localizedValue = (item, fields) => {
    const requested = state.locale === 'zh-CN' ? fields.zh : fields.en;
    return apiValue(item, requested[0], requested[1])
      || apiValue(item, fields.en[0], fields.en[1])
      || apiValue(item, fields.zh[0], fields.zh[1])
      || apiValue(item, fields.canonical[0], fields.canonical[1])
      || '';
  };
  const localizedCapabilityServiceName = service => localizedValue(service, {
    zh: ['nameZh', 'name_zh'], en: ['nameEn', 'name_en'],
    canonical: ['canonicalName', 'canonical_name']
  }) || service.name || '';
  const localizedCapabilityCategoryName = service => localizedValue(service, {
    zh: ['categoryNameZh', 'category_name_zh'], en: ['categoryNameEn', 'category_name_en'],
    canonical: ['categoryName', 'category_name']
  }) || service.category || t('uncategorized');

  function initialLocale() {
    try {
      const saved = global.localStorage?.getItem(localeApi.STORAGE_KEY);
      if (saved === 'zh-CN' || saved === 'en') return saved;
    } catch (_error) {}
    return localeApi.getStoredLocale
      ? localeApi.getStoredLocale(global.localStorage, global.navigator || {})
      : localeApi.browserLocale(global.navigator || {});
  }

  function setLocale(locale) {
    state.locale = localeApi.setLocale
      ? localeApi.setLocale(locale, global.localStorage)
      : localeApi.normalizeLocale(locale);
    if (!localeApi.setLocale) try { global.localStorage?.setItem(localeApi.STORAGE_KEY, state.locale); } catch (_error) {}
    if (document.documentElement) document.documentElement.lang = state.locale;
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('[data-i18n]').forEach(element => {
        element.textContent = t(element.dataset.i18n);
      });
      document.querySelectorAll('[data-i18n-title]').forEach(element => {
        element.title = t(element.dataset.i18nTitle);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        element.placeholder = t(element.dataset.i18nPlaceholder);
      });
    }
    const zh = byId('adminLanguageZh');
    const en = byId('adminLanguageEn');
    if (zh) zh.disabled = state.locale === 'zh-CN';
    if (en) en.disabled = state.locale === 'en';
    if (state.categories.length) renderCategories();
    if (state.services.length) renderServices();
    const serviceTitle = byId('serviceFormTitle');
    if (serviceTitle && !byId('serviceFormPanel')?.hidden) serviceTitle.textContent = state.editingServiceId ? t('editService') : t('addService');
    if (state.staff.length) {
      renderStaffList();
      if (state.selectedStaffId) {
        const selected = state.staff.find(item => item.id === state.selectedStaffId);
        if (selected) { renderStaffForm(selected); renderStaffSettings(); }
      }
    }
    if (typeof global.renderAppointments === 'function' && !byId('calendarView')?.hidden) global.renderAppointments(global.currentAppointments || []);
  }

  const businessMessage = (result, fallback) => ({
    STAFF_HAS_FUTURE_APPOINTMENTS: t('staffFutureAppointments'),
    STAFF_SERVICE_HAS_FUTURE_APPOINTMENTS: t('staffServiceFutureAppointments'),
    SCHEDULE_CONFLICTS_WITH_FUTURE_APPOINTMENTS: t('scheduleFutureAppointments')
  }[result?.code] || (state.locale === 'zh-CN' ? result?.message : null) || fallback);

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
    });
    let result = {};
    try { result = await response.json(); } catch (_error) { result = {}; }
    if (response.status === 401) {
      if (typeof global.showLogin === 'function') global.showLogin(t('sessionExpired'));
      const error = new Error(t('sessionExpired'));
      error.sessionExpired = true;
      throw error;
    }
    if (!response.ok || result.success === false) {
      const error = new Error(businessMessage(result, t('operationFailed')));
      error.status = response.status;
      error.code = result.code;
      throw error;
    }
    return result.data;
  }

  function setBusy(buttonId, busy) {
    const button = byId(buttonId);
    if (!button) return;
    button.disabled = busy;
    const idleKey = {
      saveServiceButton: 'save', saveStaffButton: 'save', saveCapabilityButton: 'saveCapabilities',
      saveCategoryButton: 'save',
      saveLocationsButton: 'saveLocations', saveScheduleButton: 'saveSchedule', saveOverrideButton: 'addSpecialDate'
    }[buttonId] || 'save';
    button.textContent = busy ? t('saving') : t(idleKey);
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
    byId('addCategoryButton').hidden = !write;
    byId('addStaffButton').hidden = !write;
  }

  function reset() {
    state.profile = null;
    state.services = [];
    state.categories = [];
    state.staff = [];
    state.selectedStaffId = null;
    byId('servicesList').textContent = '';
    byId('staffList').textContent = '';
    byId('staffDetail').innerHTML = `<div class="empty">${t('chooseStaff')}</div>`;
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
    list.textContent = t('loadingServices');
    try {
      const [categories, services] = await Promise.all([request('/api/owner/service-categories'), request('/api/owner/services')]);
      state.categories = categories || [];
      state.services = services || [];
      renderCategories();
      renderServices();
    } catch (error) {
      if (!error.sessionExpired) { list.className = 'error'; list.textContent = error.message; }
    }
  }

  function categoryName(category) { return [category.nameZh, category.nameEn, category.canonicalName].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).slice(0,2).join(' / '); }
  function renderCategories() {
    const list=byId('categoriesList'); if(!state.categories.length){list.className='empty';list.textContent=t('noCategories');return;}
    list.className=''; const actions=canWrite();
    list.innerHTML=`<div class="service-table"><table><thead><tr><th>${t('category')}</th><th>${t('icon')}</th><th>${t('sortOrder')}</th><th>${t('serviceCount')}</th><th>${t('status')}</th>${actions?`<th>${t('actions')}</th>`:''}</tr></thead><tbody>${state.categories.map(category=>`<tr><td>${escapeHtml(categoryName(category))}</td><td>${escapeHtml(category.iconKey||'—')}</td><td>${escapeHtml(category.sortOrder??0)}</td><td>${escapeHtml(category.serviceCount??0)}</td><td>${category.isActive?t('active'):t('inactive')}</td>${actions?`<td><button class="secondary-btn" onclick="ownerSelfService.openCategoryForm('${escapeHtml(category.id)}')">${t('edit')}</button></td>`:''}</tr>`).join('')}</tbody></table></div>`;
  }
  function openCategoryForm(id) { if(!canWrite())return; const category=id?state.categories.find(item=>item.id===id):null; state.editingCategoryId=category?.id||null; byId('categoryFormTitle').textContent=category?t('editCategory'):t('addCategory'); byId('categoryNameZh').value=category?.nameZh||''; byId('categoryNameEn').value=category?.nameEn||category?.canonicalName||''; byId('categoryIconKey').value=category?.iconKey||''; byId('categorySortOrder').value=category?.sortOrder??0; byId('categoryActive').checked=category?.isActive??true; byId('categoryFormPanel').hidden=false; }
  function closeCategoryForm(){state.editingCategoryId=null;byId('categoryFormPanel').hidden=true;}
  async function saveCategory(){if(!canWrite())return;const nameZh=value('categoryNameZh').trim(),nameEn=value('categoryNameEn').trim();const body={canonicalName:nameEn||nameZh,iconKey:value('categoryIconKey').trim()||null,sortOrder:Number(value('categorySortOrder')),isActive:checked('categoryActive')};if(nameZh)body.nameZh=nameZh;if(nameEn)body.nameEn=nameEn;setBusy('saveCategoryButton',true);try{const id=state.editingCategoryId;await request(id?`/api/owner/service-categories/${encodeURIComponent(id)}`:'/api/owner/service-categories',{method:id?'PATCH':'POST',body:JSON.stringify(body)});closeCategoryForm();await loadServices();}catch(error){if(!error.sessionExpired)setMessage('categoriesMessage',error.message,true);}finally{setBusy('saveCategoryButton',false);}}

  function renderServices() {
    const list = byId('servicesList');
    if (!state.services.length) {
      list.className = 'empty';
      list.textContent = t('noServices');
      return;
    }
    list.className = '';
    const actions = canWrite();
    list.innerHTML = `<div class="service-table"><table><thead><tr><th>${t('category')}</th><th>${t('serviceName')}</th><th>${t('price')}</th><th>${t('duration')}</th><th>${t('bookable')}</th><th>${t('status')}</th>${actions ? `<th>${t('actions')}</th>` : ''}</tr></thead><tbody>${state.services.map(service => {
      const id = escapeHtml(service.id);
      const bilingualName = [service.nameZh, service.nameEn, service.canonicalName || service.name]
        .filter(Boolean)
        .filter((name, index, names) => names.indexOf(name) === index)
        .slice(0, 2)
        .join(' / ');
      const isFrom = apiValue(service, 'priceIsFrom', 'price_is_from') === true;
      const price = localeApi.formatPrice ? localeApi.formatPrice(service.price, isFrom, state.locale) : `S$${Number(service.price || 0).toFixed(2)}`;
      const duration = localeApi.formatDuration ? localeApi.formatDuration(apiValue(service, 'durationMinutes', 'duration_minutes'), state.locale) : apiValue(service, 'durationMinutes', 'duration_minutes');
      const linkedCategory = state.categories.find(category => category.id === service.categoryId);
      return `<tr><td>${escapeHtml(linkedCategory ? categoryName(linkedCategory) : service.category || t('uncategorized'))}</td><td>${escapeHtml(bilingualName)}</td><td>${price}</td><td>${escapeHtml(duration)}</td><td>${service.bookable ? t('enabled') : t('disabled')}</td><td>${apiValue(service, 'isActive', 'is_active') ? t('active') : t('inactive')}</td>${actions ? `<td><button class="secondary-btn" onclick="ownerSelfService.openServiceForm('${id}')">${t('edit')}</button></td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
  }

  function openServiceForm(serviceId) {
    if (!canWrite()) return;
    const service = serviceId ? state.services.find(item => item.id === serviceId) : null;
    state.editingServiceId = service?.id || null;
    byId('serviceFormTitle').textContent = service ? t('editService') : t('addService');
    byId('serviceNameZh').value = service?.nameZh || '';
    byId('serviceNameEn').value = service?.nameEn || service?.canonicalName || service?.name || '';
    byId('serviceCategoryId').innerHTML = `<option value="">${t('chooseCategory')}</option>${state.categories.filter(category=>category.isActive||category.id===service?.categoryId).map(category=>`<option value="${escapeHtml(category.id)}">${escapeHtml(categoryName(category))}</option>`).join('')}`;
    byId('serviceCategoryId').value = service?.categoryId || '';
    byId('serviceDescriptionZh').value = service?.descriptionZh || '';
    byId('serviceDescriptionEn').value = service?.descriptionEn || service?.canonicalDescription || service?.description || '';
    byId('servicePrice').value = service?.price ?? '';
    byId('serviceDuration').value = apiValue(service, 'durationMinutes', 'duration_minutes') ?? 60;
    byId('serviceSortOrder').value = apiValue(service, 'sortOrder', 'sort_order') ?? 0;
    byId('serviceBookable').checked = service?.bookable ?? false;
    byId('serviceActive').checked = apiValue(service, 'isActive', 'is_active') ?? true;
    byId('servicePriceIsFrom').checked = apiValue(service, 'priceIsFrom', 'price_is_from') ?? false;
    byId('serviceFormPanel').hidden = false;
  }

  function closeServiceForm() {
    state.editingServiceId = null;
    byId('serviceFormPanel').hidden = true;
  }

  async function saveService() {
    if (!canWrite()) return;
    const nameZh = value('serviceNameZh').trim();
    const nameEn = value('serviceNameEn').trim();
    const descriptionZh = value('serviceDescriptionZh').trim();
    const descriptionEn = value('serviceDescriptionEn').trim();
    const categoryId = value('serviceCategoryId').trim();
    if (!state.editingServiceId && !categoryId) { setMessage('servicesMessage', t('categoryRequired'), true); return; }
    const body = {
      name: nameEn || nameZh,
      categoryId: categoryId || null,
      price: Number(value('servicePrice')),
      priceIsFrom: checked('servicePriceIsFrom'),
      durationMinutes: Number(value('serviceDuration')),
      bookable: checked('serviceBookable'),
      isActive: checked('serviceActive'),
      sortOrder: Number(value('serviceSortOrder'))
    };
    if (nameZh) body.nameZh = nameZh;
    if (nameEn) body.nameEn = nameEn;
    if (descriptionZh) body.descriptionZh = descriptionZh;
    if (descriptionEn) body.descriptionEn = descriptionEn;
    setBusy('saveServiceButton', true);
    setMessage('servicesMessage', '');
    try {
      const editing = state.editingServiceId;
      await request(editing ? `/api/owner/services/${encodeURIComponent(editing)}` : '/api/owner/services', {
        method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body)
      });
      closeServiceForm();
      setMessage('servicesMessage', t('saved'));
      await loadServices();
    } catch (error) {
      if (!error.sessionExpired) setMessage('servicesMessage', error.message, true);
    } finally { setBusy('saveServiceButton', false); }
  }

  async function loadStaff() {
    const list = byId('staffList');
    list.className = 'loading';
    list.textContent = t('loadingStaff');
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
    if (!state.staff.length) { list.className = 'empty'; list.textContent = t('noStaff'); return; }
    list.className = '';
    list.innerHTML = state.staff.map(staff => `<div class="list-card ${staff.id === state.selectedStaffId ? 'selected' : ''}" onclick="ownerSelfService.selectStaff('${escapeHtml(staff.id)}')"><h3>${escapeHtml(staff.name)}</h3>${apiValue(staff, 'staffCode', 'staff_code') ? `<div class="muted">${t('staffCode')}: ${escapeHtml(apiValue(staff, 'staffCode', 'staff_code'))}</div>` : ''}<span class="pill">${staff.bookable ? t('bookable') : t('notBookable')}</span><span class="pill">${apiValue(staff, 'isActive', 'is_active') ? t('active') : t('inactive')}</span><div>${(staff.locations || []).map(location => `<span class="pill">${escapeHtml(location.name)}</span>`).join('')}</div></div>`).join('');
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
    byId('staffDetail').innerHTML = `<div class="section-heading"><h3>${isNew ? t('addStaff') : t('basicDetails')}</h3></div>${isNew ? `<div class="notice">${t('staffSetupNotice')}</div>` : ''}<div class="form-grid"><label class="field"><span>${t('staffName')}</span><input id="staffName" maxlength="200" value="${escapeHtml(staff?.name || '')}" ${disabled}></label><label class="field"><span>${t('staffCode')}</span><input id="staffCode" maxlength="50" value="${escapeHtml(apiValue(staff, 'staffCode', 'staff_code') || '')}" ${disabled}></label><label class="field"><span>${t('phone')}</span><input id="staffPhone" maxlength="50" value="${escapeHtml(staff?.phone || '')}" ${disabled}></label><label class="field"><span>${t('email')}</span><input id="staffEmail" maxlength="254" value="${escapeHtml(staff?.email || '')}" ${disabled}></label><label class="check-row"><input id="staffBookable" type="checkbox" ${staff?.bookable ? 'checked' : ''} ${disabled}>${t('allowBooking')}</label><label class="check-row"><input id="staffActive" type="checkbox" ${isNew || apiValue(staff, 'isActive', 'is_active') ? 'checked' : ''} ${disabled}>${t('staffActive')}</label></div>${canWrite() ? `<div class="form-actions"><span id="staffSaveStatus" class="save-status"></span><button id="saveStaffButton" class="primary-btn" onclick="ownerSelfService.saveStaff(${isNew ? 'true' : 'false'})">${t('save')}</button></div>` : `<div class="notice">${t('adminReadOnly')}</div>`}${isNew ? '' : '<div id="staffSettings"></div>'}`;
  }

  async function saveStaff(isNew) {
    if (!canWrite()) return;
    const body = { name: value('staffName').trim(), phone: value('staffPhone').trim() || null, email: value('staffEmail').trim() || null, staffCode: value('staffCode').trim() || null, bookable: isNew ? false : checked('staffBookable'), isActive: checked('staffActive') };
    setBusy('saveStaffButton', true);
    try {
      const saved = await request(isNew ? '/api/owner/staff' : `/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}`, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) });
      state.selectedStaffId = saved.id || state.selectedStaffId;
      setMessage('staffMessage', t('saved'));
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
    byId('staffSettings').innerHTML = `<div class="loading">${t('loadingStaffSettings')}</div>`;
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
    byId('staffSettings').innerHTML = `<div class="tabs"><button class="tab-btn active" onclick="ownerSelfService.openStaffTab('capability')">${t('capabilities')}</button><button class="tab-btn" onclick="ownerSelfService.openStaffTab('locations')">${t('locations')}</button><button class="tab-btn" onclick="ownerSelfService.openStaffTab('schedule')">${t('weeklySchedule')}</button><button class="tab-btn" onclick="ownerSelfService.openStaffTab('overrides')">${t('specialDates')}</button></div><div id="staffTabContent"></div>`;
    openStaffTab('capability');
    if (!activeLocations.length && !readonly) setMessage('staffMessage', t('assignLocationBeforeSchedule'));
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
    const groups = [];
    const groupById = new Map();
    const orderedServices = [...state.capability].sort((left, right) => {
      const leftCategoryOrder = Number(apiValue(left, 'categorySortOrder', 'category_sort_order') ?? Number.MAX_SAFE_INTEGER);
      const rightCategoryOrder = Number(apiValue(right, 'categorySortOrder', 'category_sort_order') ?? Number.MAX_SAFE_INTEGER);
      if (leftCategoryOrder !== rightCategoryOrder) return leftCategoryOrder - rightCategoryOrder;
      const leftCategory = String(apiValue(left, 'categoryId', 'category_id') || left.category || '');
      const rightCategory = String(apiValue(right, 'categoryId', 'category_id') || right.category || '');
      if (leftCategory !== rightCategory) return leftCategory.localeCompare(rightCategory);
      const leftServiceOrder = Number(apiValue(left, 'serviceSortOrder', 'service_sort_order') ?? 0);
      const rightServiceOrder = Number(apiValue(right, 'serviceSortOrder', 'service_sort_order') ?? 0);
      if (leftServiceOrder !== rightServiceOrder) return leftServiceOrder - rightServiceOrder;
      const canonical = service => String(apiValue(service, 'canonicalName', 'canonical_name') || service.name || '');
      const nameOrder = canonical(left).localeCompare(canonical(right));
      return nameOrder || String(apiValue(left, 'serviceId', 'service_id')).localeCompare(String(apiValue(right, 'serviceId', 'service_id')));
    });
    orderedServices.forEach(service => {
      const categoryId = apiValue(service, 'categoryId', 'category_id');
      const key = categoryId || `legacy:${service.category || ''}`;
      let group = groupById.get(key);
      if (!group) {
        group = { key, service, services: [] };
        groupById.set(key, group);
        groups.push(group);
      }
      group.services.push(service);
    });
    const content = groups.map(group => `<section class="capability-group" data-category-id="${escapeHtml(apiValue(group.service, 'categoryId', 'category_id') || '')}"><h4>${escapeHtml(localizedCapabilityCategoryName(group.service))}</h4>${group.services.map(service => {
      const id = apiValue(service, 'serviceId', 'service_id');
      const active = apiValue(service, 'isActive', 'is_active');
      const selected = state.capabilityIds.has(id);
      const disabled = !canWrite() || (!active && !selected);
      return `<div class="check-row" data-service-id="${escapeHtml(id)}"><input type="checkbox" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="ownerSelfService.toggleCapability('${escapeHtml(id)}', this.checked)"><label>${escapeHtml(localizedCapabilityServiceName(service))}${!active ? ` <span class="muted">· ${t('serviceInactive')}</span>` : ''}${!service.bookable ? ` <span class="muted">· ${t('serviceNotBookable')}</span>` : ''}</label></div>`;
    }).join('')}</section>`).join('');
    container.innerHTML = `<div class="section-heading"><h3>${t('capabilityHeading')}</h3></div>${content || `<div class="empty">${t('noCapabilityServices')}</div>`}${canWrite() ? `<div class="form-actions"><span id="capabilityStatus" class="save-status"></span><button id="saveCapabilityButton" class="primary-btn" onclick="ownerSelfService.saveCapability()">${t('saveCapabilities')}</button></div>` : `<div class="notice">${t('adminReadOnly')}</div>`}`;
  }

  function toggleCapability(id, enabled) { enabled ? state.capabilityIds.add(id) : state.capabilityIds.delete(id); }
  async function saveCapability() {
    setBusy('saveCapabilityButton', true);
    try {
      await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/services`, { method: 'PUT', body: JSON.stringify({ serviceIds: [...state.capabilityIds] }) });
      setMessage('capabilityStatus', t('saved'));
    } catch (error) { if (!error.sessionExpired) setMessage('capabilityStatus', error.message, true); }
    finally { setBusy('saveCapabilityButton', false); }
  }

  function renderLocations(container) {
    container.innerHTML = `<div class="section-heading"><h3>${t('locations')}</h3></div>${state.locations.map(location => `<div class="check-row"><input type="checkbox" ${state.locationIds.has(location.id) ? 'checked' : ''} ${!canWrite() || apiValue(location, 'isActive', 'is_active') === false ? 'disabled' : ''} onchange="ownerSelfService.toggleLocation('${escapeHtml(location.id)}', this.checked)"><label>${escapeHtml(location.name)} <span class="muted">${escapeHtml(location.timezone || '')}</span></label></div>`).join('') || `<div class="empty">${t('noLocations')}</div>`}${canWrite() ? `<div class="form-actions"><span id="locationStatus" class="save-status"></span><button id="saveLocationsButton" class="primary-btn" onclick="ownerSelfService.saveLocations()">${t('saveLocations')}</button></div>` : `<div class="notice">${t('adminReadOnly')}</div>`}`;
  }
  function toggleLocation(id, enabled) { enabled ? state.locationIds.add(id) : state.locationIds.delete(id); }
  async function saveLocations() {
    setBusy('saveLocationsButton', true);
    try {
      await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/locations`, { method: 'PUT', body: JSON.stringify({ locationIds: [...state.locationIds] }) });
      setMessage('locationStatus', t('saved'));
      await selectStaff(state.selectedStaffId);
    } catch (error) { if (!error.sessionExpired) setMessage('locationStatus', error.message, true); }
    finally { setBusy('saveLocationsButton', false); }
  }

  function renderSchedule(container) {
    const assigned = state.locations.filter(item => item.assigned);
    if (!assigned.length) { container.innerHTML = `<div class="notice">${t('assignLocationFirst')}</div>`; return; }
    const days = state.schedule?.days || Array.from({ length: 7 }, (_, index) => ({ dayOfWeek: index + 1, isWorking: false }));
    const names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(t);
    container.innerHTML = `<div class="section-heading"><h3>${t('weeklySchedule')}</h3><select id="scheduleLocation" onchange="ownerSelfService.changeScheduleLocation(this.value)">${assigned.map(location => `<option value="${escapeHtml(location.id)}" ${location.id === state.selectedLocationId ? 'selected' : ''}>${escapeHtml(location.name)}</option>`).join('')}</select></div><div class="muted">${t('timezone')}: ${escapeHtml(state.schedule?.timezone || assigned.find(item => item.id === state.selectedLocationId)?.timezone || '')}</div>${days.map(day => `<div class="schedule-row"><span class="weekday">${names[day.dayOfWeek - 1]}</span><label><input id="scheduleWorking${day.dayOfWeek}" type="checkbox" ${day.isWorking ? 'checked' : ''} ${!canWrite() ? 'disabled' : ''}> ${t('working')}</label><input id="scheduleStart${day.dayOfWeek}" type="time" value="${escapeHtml(day.startTime || '10:00')}" ${!canWrite() ? 'disabled' : ''}><span>${t('to')}</span><input id="scheduleEnd${day.dayOfWeek}" type="time" value="${escapeHtml(day.endTime || '19:00')}" ${!canWrite() ? 'disabled' : ''}></div>`).join('')}${canWrite() ? `<div class="form-actions"><span id="scheduleStatus" class="save-status"></span><button id="saveScheduleButton" class="primary-btn" onclick="ownerSelfService.saveSchedule()">${t('saveSchedule')}</button></div>` : `<div class="notice">${t('adminReadOnly')}</div>`}`;
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
        if (!entry.startTime || !entry.endTime || entry.startTime >= entry.endTime) { setMessage('scheduleStatus', t('invalidScheduleTime'), true); return; }
      }
      days.push(entry);
    }
    setBusy('saveScheduleButton', true);
    try {
      await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/schedule`, { method: 'PUT', body: JSON.stringify({ locationId: state.selectedLocationId, days }) });
      setMessage('scheduleStatus', t('saved'));
      await loadSchedule();
    } catch (error) { if (!error.sessionExpired) setMessage('scheduleStatus', error.message, true); }
    finally { setBusy('saveScheduleButton', false); }
  }

  function renderOverrides(container) {
    const assigned = state.locations.filter(item => item.assigned);
    container.innerHTML = `<div class="section-heading"><h3>${t('specialDates')}</h3></div>${canWrite() && assigned.length ? `<div class="form-grid"><label class="field"><span>${t('store')}</span><select id="overrideLocation">${assigned.map(location => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name)}</option>`).join('')}</select></label><label class="field"><span>${t('date')}</span><input id="overrideDate" type="date"></label><label class="field"><span>${t('type')}</span><select id="overrideType" onchange="ownerSelfService.updateOverrideFields()"><option value="day_off">${t('dayOff')}</option><option value="leave">${t('leave')}</option><option value="custom_hours">${t('customHours')}</option></select></label><label id="overrideStartField" class="field" hidden><span>${t('startTime')}</span><input id="overrideStart" type="time"></label><label id="overrideEndField" class="field" hidden><span>${t('endTime')}</span><input id="overrideEnd" type="time"></label><label class="field full"><span>${t('notesOptional')}</span><input id="overrideReason" maxlength="1000"></label></div><div class="form-actions"><span id="overrideStatus" class="save-status"></span><button id="saveOverrideButton" class="primary-btn" onclick="ownerSelfService.saveOverride()">${t('addSpecialDate')}</button></div>` : (!assigned.length ? `<div class="notice">${t('assignLocationFirst')}</div>` : `<div class="notice">${t('adminReadOnly')}</div>`)}<div>${state.overrides.map(item => `<div class="list-card"><strong>${escapeHtml(dateValue(apiValue(item, 'scheduleDate', 'schedule_date')))}</strong> · ${escapeHtml(overrideLabel(apiValue(item, 'overrideType', 'override_type')))}<div class="muted">${escapeHtml(apiValue(item, 'locationName', 'location_name') || '')} ${timeValue(apiValue(item, 'startTime', 'start_time'))}${apiValue(item, 'endTime', 'end_time') ? ` - ${escapeHtml(timeValue(apiValue(item, 'endTime', 'end_time')))}` : ''} · ${apiValue(item, 'isActive', 'is_active') ? t('effective') : t('inactive')}</div>${canWrite() && apiValue(item, 'isActive', 'is_active') ? `<button class="secondary-btn" onclick="ownerSelfService.deactivateOverride('${escapeHtml(item.id)}')">${t('deactivate')}</button>` : ''}</div>`).join('') || `<div class="empty">${t('noOverrides')}</div>`}</div>`;
  }

  function overrideLabel(type) { return ({ day_off: t('dayOff'), leave: t('leave'), custom_hours: t('customHours'), working: t('customHours') }[type] || t('specialDates')); }
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
      if ((body.startTime || body.endTime) && (!body.startTime || !body.endTime || body.startTime >= body.endTime)) { setMessage('overrideStatus', t('invalidOverrideTime'), true); return; }
      if (type === 'custom_hours' && (!body.startTime || !body.endTime)) { setMessage('overrideStatus', t('customHoursRequired'), true); return; }
    }
    setBusy('saveOverrideButton', true);
    try {
      await request(`/api/owner/staff/${encodeURIComponent(state.selectedStaffId)}/schedule-overrides`, { method: 'POST', body: JSON.stringify(body) });
      setMessage('overrideStatus', t('saved'));
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

  global.ownerSelfService = { setLocale, setProfile, reset, showView, loadServices, renderCategories, openCategoryForm, closeCategoryForm, saveCategory, openServiceForm, closeServiceForm, saveService, loadStaff, openStaffForm, saveStaff, selectStaff, openStaffTab, toggleCapability, saveCapability, toggleLocation, saveLocations, changeScheduleLocation, saveSchedule, updateOverrideFields, saveOverride, deactivateOverride, _state: state, _request: request };
  setLocale(initialLocale());
})(globalThis);
