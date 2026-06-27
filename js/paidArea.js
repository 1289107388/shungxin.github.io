(function(global) {
  'use strict';

  const CFG = (global.AppConfig && global.AppConfig.SUPABASE) || global.SUPABASE_CONFIG || {};
  const TOKEN_KEY = (global.AppConfig && global.AppConfig.STORAGE_KEYS && global.AppConfig.STORAGE_KEYS.paidAreaToken)
    || 'shungxin_paid_area_token';
  const SUPA_URL = CFG.url || '';
  const ANON_KEY = CFG.anonKey || '';

  // ---------- token 管理（使用 sessionStorage，关闭标签页即失效） ----------
  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(token) {
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) { console.warn('[paidArea] sessionStorage 写入失败', e); }
  }
  function clearToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }
  function isAuthenticated() {
    return !!getToken();
  }

  // ---------- API ----------
  function apiUrl(path) {
    return `${SUPA_URL}/functions/v1/paid-area-auth/${path}`;
  }

  async function apiPost(path, body) {
    const r = await fetch(apiUrl(path), {
      method: 'POST',
      headers: {
        'apikey': ANON_KEY,
        'Authorization': 'Bearer ' + ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || `请求失败 ${r.status}`);
      err.status = r.status;
      err.code = data.code || '';
      throw err;
    }
    return data;
  }

  async function verifyPassword(password) {
    const result = await apiPost('verify', { password });
    if (result.token) {
      setToken(result.token);
      return result;
    }
    throw new Error('未返回访问令牌');
  }

  async function refreshToken() {
    const token = getToken();
    if (!token) throw new Error('没有可刷新的令牌');
    const result = await apiPost('refresh', { token });
    if (result.token) {
      setToken(result.token);
      return result;
    }
    throw new Error('刷新令牌失败');
  }

  // ---------- UI ----------
  function getElements() {
    return {
      gate: document.getElementById('paidAreaGate'),
      form: document.getElementById('paidAreaForm'),
      input: document.getElementById('paidAreaPassword'),
      error: document.getElementById('paidAreaError'),
      submitBtn: document.getElementById('paidAreaSubmit'),
      gallery: document.getElementById('paidGalleryGrid'),
      hero: document.getElementById('paidAreaHero'),
      logoutBtn: document.getElementById('paidAreaLogout'),
    };
  }

  function showGate() {
    const { gate, hero, gallery } = getElements();
    if (gate) gate.classList.remove('hidden');
    if (hero) hero.classList.add('gate-active');
    if (gallery) gallery.innerHTML = '';
  }

  function hideGate() {
    const { gate, hero } = getElements();
    if (gate) gate.classList.add('hidden');
    if (hero) hero.classList.remove('gate-active');
  }

  function setError(msg) {
    const { error } = getElements();
    if (!error) return;
    error.textContent = msg || '';
    error.hidden = !msg;
  }

  function setLoading(loading) {
    const { submitBtn } = getElements();
    if (!submitBtn) return;
    submitBtn.disabled = loading;
    submitBtn.textContent = loading ? '验证中…' : '进入付费区';
  }

  async function onSubmit(e) {
    e.preventDefault();
    const { input } = getElements();
    const password = input ? input.value : '';
    if (!password) { setError('请输入密码'); return; }
    setError('');
    setLoading(true);
    try {
      await verifyPassword(password);
      hideGate();
      if (typeof global.showToast === 'function') global.showToast('欢迎进入付费区', 'success');
      loadPaidGallery();
    } catch (err) {
      setError(err.message || '验证失败');
      if (input) input.value = '';
      input?.focus();
    } finally {
      setLoading(false);
    }
  }

  function loadPaidGallery() {
    // gallery.js 在付费区模式下会自动读取 token 并拉取 area=paid 数据
    if (typeof global.renderGallery === 'function') {
      global.renderGallery('all');
    }
  }

  function logoutPaidArea() {
    clearToken();
    if (typeof global.showToast === 'function') global.showToast('已退出付费区', 'info');
    showGate();
  }

  // ---------- 初始化 ----------
  function init() {
    const { gate, form, logoutBtn } = getElements();
    if (!gate) return; // 不在付费区页面

    form?.addEventListener('submit', onSubmit);
    logoutBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      logoutPaidArea();
    });

    if (isAuthenticated()) {
      hideGate();
      loadPaidGallery();
      // 后台静默刷新一次令牌，避免 token 在浏览期间过期
      refreshToken().catch(() => {
        // 刷新失败说明当前 token 已不可用，退回密码门
        clearToken();
        showGate();
      });
    } else {
      showGate();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露到全局
  global.getPaidAreaToken = getToken;
  global.setPaidAreaToken = setToken;
  global.clearPaidAreaToken = clearToken;
  global.isPaidAreaAuthenticated = isAuthenticated;
  global.verifyPaidAreaPassword = verifyPassword;
  global.refreshPaidAreaToken = refreshToken;
  global.PaidArea = {
    getToken,
    setToken,
    clearToken,
    isAuthenticated,
    verifyPassword,
    refreshToken,
  };
})(window);
