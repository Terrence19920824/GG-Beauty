(function(root){'use strict';
  const i18n=root.ggI18n,shopContext=root.ggCustomerShopContext;
  const phoneSelector=root.ggCustomerPhoneSelector;
  const state={locale:i18n.getStoredLocale(root.localStorage,root.navigator),shopSlug:'',config:null,challengeId:'',phoneChangeChallengeId:'',resendUntil:0,member:null,timer:null,phoneSelectors:{}};
  const $=id=>root.document.getElementById(id),t=key=>i18n.t(key,state.locale);
  const show=(id,visible)=>{const el=$(id);if(el)el.hidden=!visible;};
  async function renderCountrySelect(id,searchId){const el=$(id);if(!el)return;if(!phoneSelector||typeof phoneSelector.bind!=='function')throw new Error('PHONE_COUNTRY_SOURCE_UNAVAILABLE');if(!state.phoneSelectors[id])state.phoneSelectors[id]=phoneSelector.bind({select:el,searchInput:$(searchId),locale:state.locale,defaultCountry:'SG'});await state.phoneSelectors[id].load(state.locale,el.value||state.config?.defaultPhoneCountryCode||'SG');}
  async function renderCountries(){await Promise.all([renderCountrySelect('countryCode','countrySearch'),renderCountrySelect('changeCountryCode','changeCountrySearch')]);}
  function renderLocale(){root.document.documentElement.lang=state.locale;root.document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t(el.dataset.i18n);});root.document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{el.placeholder=t(el.dataset.i18nPlaceholder);});$('languageZh').disabled=state.locale==='zh-CN';$('languageEn').disabled=state.locale==='en';const switchBtn=$('languageSwitchBtn');if(switchBtn){const lbl=state.locale==='zh-CN'?'切换语言':'Change language';switchBtn.setAttribute('aria-label',lbl);switchBtn.setAttribute('title',lbl);}if(state.config)root.document.title=`${state.config.shopName||state.shopSlug} · ${t('myAccount')}`;renderResend();if(state.member)renderMember();}
  async function setLocale(locale){state.locale=i18n.setLocale(locale,root.localStorage);renderLocale();await renderCountries();}
  function message(id,key){const el=$(id);if(el)el.textContent=key?t(key):'';}
  async function api(url,options){const response=await root.fetch(url,options);const result=await response.json().catch(()=>({}));if(!response.ok||result.success===false){const error=new Error(result.code||'REQUEST_FAILED');error.code=result.code;error.status=response.status;throw error;}return result.data;}
  function authError(error){return ({OTP_INVALID:'otpInvalid',PHONE_INVALID:'phoneInvalid',OTP_RATE_LIMITED:'otpRateLimited',OTP_RESEND_TOO_SOON:'otpResendSoon',CUSTOMER_PHONE_AMBIGUOUS:'memberSupportRequired',DOB_REQUIRED:'dobRequired',DOB_INVALID:'dobInvalid',CUSTOMER_PROFILE_VERIFICATION_REQUIRED:'profileVerificationRequired',CUSTOMER_NAME_REQUIRED:'nameRequired'}[error?.code]||'otpGenericError');}
  function setBirthdayMax(){const max=new Date().toISOString().slice(0,10);if($('registrationDob'))$('registrationDob').max=max;if($('profileDobInput'))$('profileDobInput').max=max;}
  function showRegistrationStep(){show('phoneStep',false);show('codeStep',false);show('registrationStep',true);setBirthdayMax();$('registrationName')?.focus?.();$('registrationStep')?.scrollIntoView?.({behavior:'smooth',block:'start'});}
  function returnToPhoneStep(){state.challengeId='';if($('otpCode'))$('otpCode').value='';show('registrationStep',false);show('codeStep',false);show('phoneStep',true);message('authMessage','');$('memberPhone')?.focus?.();}
  function renderResend(){if(!$('resendCode'))return;if(state.timer){root.clearTimeout(state.timer);state.timer=null;}const seconds=Math.max(0,Math.ceil((state.resendUntil-Date.now())/1000));$('resendCode').disabled=seconds>0;$('resendCode').textContent=seconds?`${t('resendCode')} (${seconds}s)`:t('resendCode');if(seconds)state.timer=root.setTimeout(()=>{state.timer=null;renderResend();},1000);}
  async function loadMember(){try{const member=await api('/api/customer/me');if(member.shop_slug!==state.shopSlug&&member.shopSlug!==state.shopSlug)throw new Error('CUSTOMER_SESSION_SHOP_MISMATCH');state.member=member;show('loadingPanel',false);show('authPanel',false);show('memberPanel',true);renderMember();}catch(error){state.member=null;show('loadingPanel',false);show('memberPanel',false);show('authPanel',true);}}
  function renderDynamicSections(){const host=$('memberDynamicSections');if(!host)return;const modules=state.config?.memberModules||state.member?.modules||{};const items=[];if(modules.points===true)items.push(`<div class="module-card"><div><strong>${t('pointsModule')}</strong><div class="hint">${t('pointsHelp')}</div></div><span class="module-badge">${t('comingSoonNotice')}</span></div>`);if(modules.storedValue===true)items.push(`<div class="module-card"><div><strong>${t('storedValueModule')}</strong><div class="hint">${t('storedValueHelp')}</div></div><span class="module-badge">${t('comingSoonNotice')}</span></div>`);if(modules.packages===true)items.push(`<div class="module-card"><div><strong>${t('packagesModule')}</strong><div class="hint">${t('packagesHelp')}</div></div><span class="module-badge">${t('comingSoonNotice')}</span></div>`);if(items.length>0){host.innerHTML=items.join('');host.hidden=false;}else{host.innerHTML='';host.hidden=true;}}
  function renderMember(){const m=state.member;if(!m)return;const panel=$('memberPanel');panel.dataset.shop=state.shopSlug;panel.dataset.memberTheme=state.config?.memberTheme?.key||'premium-black';if(root.ggCustomerTheme&&typeof root.ggCustomerTheme.resolveTheme==='function'){const theme=root.ggCustomerTheme.resolveTheme(state.shopSlug,{shopName:m.shop_name||m.shopName||state.config?.shopName});if(root.document&&root.document.documentElement)root.ggCustomerTheme.applyTheme(root.document.documentElement,theme);}$('shopName').textContent=m.shop_name||m.shopName||state.config?.shopName||'';$('shopLogo').textContent=(m.shop_name||m.shopName||'GG').split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase();$('memberName').textContent=m.name||'';$('memberCode').textContent=m.member_code||m.memberCode||'';
    const modules=state.config?.memberModules||m.modules||{};
    const hasMembership=Boolean(modules.membershipTier||modules.membership);
    const isMemberActive=Boolean(m.membership&&m.membership.isActive);
    const allOff=!hasMembership&&!modules.points&&!modules.storedValue&&!modules.packages;
    if($('accountDisabledNotice'))$('accountDisabledNotice').hidden=!allOff;
    if($('memberCardContainer'))$('memberCardContainer').hidden=!hasMembership||!isMemberActive;
    if(hasMembership&&isMemberActive){
      if($('memberTierLabel'))$('memberTierLabel').textContent=m.membership?.tierName||t('ordinaryMember');
      if($('memberValidity'))$('memberValidity').textContent=m.membership?.expiresAt?`${t('validUntil')}: ${String(m.membership.expiresAt).slice(0,10)}`:t('permanentValidity');
    }
    const phoneVal=m.phone_normalized||m.phoneNormalized||m.phone||'';
    const verifyBadge=m.isPhoneVerified?`<span class="verified-badge">${t('phoneVerified')}</span>`:`<span class="unverified-badge">${t('phoneUnverified')}</span>`;
    $('memberVerifiedPhone').innerHTML=`${phoneVal} ${verifyBadge}`;
    if($('profilePhone'))$('profilePhone').innerHTML=`${t('phone')}: ${phoneVal} ${verifyBadge}`;
    const isVerified=Boolean(m.isPhoneVerified);
    show('profileEmail',isVerified);
    show('profileDob',isVerified);
    show('profileGender',isVerified);
    show('editMemberProfile',isVerified);
    if(!isVerified)show('profileEdit',false);
    if(isVerified){
      $('profileEmail').textContent=`${t('email')}: ${m.email||'—'}`;
      $('profileDob').textContent=`${t('dateOfBirth')}: ${m.date_of_birth||m.dateOfBirth?String(m.date_of_birth||m.dateOfBirth).slice(0,10):'—'}`;
      $('profileGender').textContent=`${t('genderOptional')}: ${m.gender?t(`genderValue_${m.gender}`):t('notSpecified')}`;
    }
    renderDynamicSections();
  }
  async function phoneSignIn(isRegistration){
    message('authMessage','');
    const body={shopSlug:state.shopSlug,countryCode:$('countryCode').value,phone:$('memberPhone').value};
    if(isRegistration){
      body.name=$('registrationName').value;
      body.email=$('registrationEmail').value;
      body.dateOfBirth=$('registrationDob').value;
    }
    try{
      await api('/api/customer/auth/sign-in',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      await loadMember();
    }catch(error){
      if(error.code==='CUSTOMER_NAME_REQUIRED'){
        showRegistrationStep();
      }
      message('authMessage',authError(error));
    }
  }
  async function sendCode(){message('authMessage','');$('sendCode').disabled=true;try{const data=await api('/api/customer/auth/otp/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shopSlug:state.shopSlug,countryCode:$('countryCode').value,phone:$('memberPhone').value})});state.challengeId=data.challengeId;state.resendUntil=Date.now()+60000;show('codeStep',true);show('registrationStep',false);message('authMessage','otpSentGeneric');renderResend();}catch(error){message('authMessage',authError(error));}finally{$('sendCode').disabled=false;}}
  async function verify(profile){message('authMessage','');if(!state.challengeId){return phoneSignIn(profile);}const body={challengeId:state.challengeId,code:$('otpCode').value};if(profile)Object.assign(body,{name:$('registrationName').value,email:$('registrationEmail').value,dateOfBirth:$('registrationDob').value});try{await api('/api/customer/auth/otp/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await loadMember();}catch(error){if(['CUSTOMER_NAME_REQUIRED','DOB_REQUIRED','DOB_INVALID'].includes(error.code))showRegistrationStep();message('authMessage',authError(error));}}
  function editProfile(){const m=state.member;if(!m||!m.isPhoneVerified)return;$('profileName').value=m.name||'';$('profileEmailInput').value=m.email||'';$('profileDobInput').value=m.date_of_birth||m.dateOfBirth?String(m.date_of_birth||m.dateOfBirth).slice(0,10):'';$('profileGenderInput').value=m.gender||'';show('profileEdit',true);}
  async function saveProfile(){try{state.member=await api('/api/customer/me',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('profileName').value,email:$('profileEmailInput').value,dateOfBirth:$('profileDobInput').value,gender:$('profileGenderInput').value})});show('profileEdit',false);renderMember();message('memberMessage','profileSaved');}catch(error){message('memberMessage',authError(error));}}
  function showPhoneChange(){show('phoneChangePanel',true);show('phoneChangeVerify',false);$('changePhone').value='';$('phoneChangeCode').value='';renderCountries().catch(()=>message('memberMessage','otpGenericError'));message('memberMessage','');}
  async function requestPhoneChange(){try{const data=await api('/api/customer/phone-change/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({countryCode:$('changeCountryCode').value,phone:$('changePhone').value})});state.phoneChangeChallengeId=data.challengeId;show('phoneChangeVerify',true);message('memberMessage','otpSentGeneric');}catch(error){message('memberMessage',authError(error));}}
  async function confirmPhoneChange(){try{await api('/api/customer/phone-change/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challengeId:state.phoneChangeChallengeId,code:$('phoneChangeCode').value})});show('phoneChangePanel',false);await loadMember();message('memberMessage','phoneChanged');}catch(error){message('memberMessage',authError(error));}}
  async function logout(){await api('/api/customer/logout',{method:'POST'});state.member=null;show('memberPanel',false);show('authPanel',true);show('phoneStep',true);show('codeStep',false);show('registrationStep',false);}
  async function init(){renderLocale();setBirthdayMax();const candidate=shopContext.resolveCandidate(root.location);if(!candidate){show('loadingPanel',false);show('authPanel',true);message('authMessage','shopUnavailable');return;}state.shopSlug=candidate;$('pwaManifest').href=`/manifest.webmanifest?shop=${encodeURIComponent(candidate)}`;if(root.ggCustomerTheme&&typeof root.ggCustomerTheme.resolveTheme==='function'){const theme=root.ggCustomerTheme.resolveTheme(candidate,{shopName:state.config?.shopName});if(root.document&&root.document.documentElement)root.ggCustomerTheme.applyTheme(root.document.documentElement,theme);}try{state.config=await api(`/api/customer/member/config?shopSlug=${encodeURIComponent(candidate)}`);if(root.ggCustomerTheme&&typeof root.ggCustomerTheme.resolveTheme==='function'){const theme=root.ggCustomerTheme.resolveTheme(candidate,{shopName:state.config?.shopName});if(root.document&&root.document.documentElement)root.ggCustomerTheme.applyTheme(root.document.documentElement,theme);}$('memberShopHeading').textContent=state.config.shopName||candidate;root.document.title=`${state.config.shopName||candidate} · ${t('myAccount')}`;await renderCountries();await loadMember();}catch(error){show('loadingPanel',false);show('authPanel',true);message('authMessage','shopUnavailable');}}
  if(root.document){$('languageZh').addEventListener('click',()=>setLocale('zh-CN').catch(()=>message('authMessage','otpGenericError')));$('languageEn').addEventListener('click',()=>setLocale('en').catch(()=>message('authMessage','otpGenericError')));$('languageSwitchBtn')?.addEventListener('click',()=>{const nextLocale=state.locale==='zh-CN'?'en':'zh-CN';setLocale(nextLocale).catch(()=>message('authMessage','otpGenericError'));});$('phoneSignInBtn')?.addEventListener('click',()=>phoneSignIn(false));$('sendCode').addEventListener('click',sendCode);$('resendCode').addEventListener('click',sendCode);$('verifyCode').addEventListener('click',()=>verify(false));$('completeMembership').addEventListener('click',()=>verify(true));$('registrationBack').addEventListener('click',returnToPhoneStep);$('editMemberProfile').addEventListener('click',editProfile);$('saveMemberProfile').addEventListener('click',saveProfile);$('changeMemberPhone').addEventListener('click',showPhoneChange);$('sendPhoneChangeCode').addEventListener('click',requestPhoneChange);$('confirmPhoneChange').addEventListener('click',confirmPhoneChange);$('logoutMember').addEventListener('click',logout);init();}
  root.ggCustomerMemberUI={state,setLocale,sendCode,phoneSignIn,verify,loadMember,requestPhoneChange,confirmPhoneChange};
})(typeof globalThis==='object'?globalThis:this);
