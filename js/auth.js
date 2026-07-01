(function(global) {
  'use strict';
  if (global.__authInitialized) return;
  global.__authInitialized = true;

  // P1 阶段 A: 优先用 AppConfig.STORAGE_KEYS, 老 key 作 fallback
  const CFG = (global.AppConfig && global.AppConfig.SUPABASE) || global.SUPABASE_CONFIG || {};
  const SK = (global.AppConfig && global.AppConfig.STORAGE_KEYS) || {};
  const SUPABASE_URL = CFG.url || 'https://qlhfyawbyedhqokivezn.supabase.co';
  const ANON_KEY = CFG.anonKey || '';
  const TOKEN_KEY = SK.authToken || 'shungxin_auth_token';
  const USER_KEY = SK.authUser || 'shungxin_auth_user';
  const EXPIRES_KEY = (SK.authToken || 'shungxin_auth_token') + '_expires';

  const state = {
    user: null,
    token: null,
  };

  // ----- localStorage -----
  function loadFromStorage() {
    try {
      const t = localStorage.getItem(TOKEN_KEY);
      const u = localStorage.getItem(USER_KEY);
      const exp = localStorage.getItem(EXPIRES_KEY);
      if (t && u) {
        // 检查是否过期
        if (exp && parseInt(exp) < Date.now()) {
          // token 已过期,清除
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
          localStorage.removeItem(EXPIRES_KEY);
          console.warn('[auth] token 已过期,已清除登录状态');
          return;
        }
        state.token = t;
        state.user = JSON.parse(u);
      }
    } catch (e) { console.warn('[auth] localStorage read error', e); }
  }
  function saveToStorage(expiresIn) {
    try {
      if (state.token && state.user) {
        localStorage.setItem(TOKEN_KEY, state.token);
        localStorage.setItem(USER_KEY, JSON.stringify(state.user));
        // 保存过期时间: 默认 7 天, 如果传入了 expiresIn 则用传入的值(秒)
        const expiresMs = (expiresIn || 7 * 24 * 60 * 60) * 1000;
        localStorage.setItem(EXPIRES_KEY, String(Date.now() + expiresMs));
      } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(EXPIRES_KEY);
      }
    } catch (e) { console.warn('[auth] localStorage write error', e); }
  }

  // ----- API -----
  async function authApi(path, method, body) {
    const headers = {
      'apikey': ANON_KEY,
      'Content-Type': 'application/json',
    };
    // 只有用户已登录时才传 Authorization header
    if (state.token) {
      headers['Authorization'] = 'Bearer ' + state.token;
    }
    try {
      const r = await fetch(SUPABASE_URL + '/functions/v1/auth-api/' + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = data.error || ('请求失败 ' + r.status);
        const err = new Error(msg);
        err.status = r.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === 'TypeError') throw new Error('网络异常，请检查连接');
      throw e;
    }
  }

  // ----- UI 同步 -----
  function renderAuthArea() {
    const authArea = document.getElementById('authArea');
    const userMenu = document.getElementById('userMenu');
    if (!authArea || !userMenu) return;
    if (state.user) {
      authArea.hidden = true;
      userMenu.hidden = false;
      const name = state.user.display_name || state.user.username;
      document.getElementById('userName').textContent = name;
      document.getElementById('userMenuName').textContent = name;
      document.getElementById('userMenuRole').textContent = state.user.role || 'user';
      const avatar = document.getElementById('userAvatar');
      avatar.textContent = (name || '?').charAt(0).toUpperCase();
      if (state.user.avatar) {
        avatar.style.backgroundImage = 'url(' + state.user.avatar + ')';
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      }
      authArea.dataset.state = 'logged-in';
      userMenu.dataset.state = 'logged-in';
    } else {
      authArea.hidden = false;
      userMenu.hidden = true;
      authArea.dataset.state = 'logged-out';
    }
  }

  function showError(formId, errId, msg) {
    const el = document.getElementById(errId);
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function hideError(errId) {
    const el = document.getElementById(errId);
    if (el) el.hidden = true;
  }

  // ----- 模态框控制 -----
  function openAuthModal(tab) {
    const m = document.getElementById('authModal');
    if (!m) return;
    m.classList.remove('hidden');
    switchTab(tab || 'login');
    hideError('loginError'); hideError('registerError');
    setTimeout(() => {
      const firstInput = m.querySelector('input:not([type=hidden])');
      if (firstInput) firstInput.focus();
    }, 100);
  }
  function closeAuthModal() {
    const m = document.getElementById('authModal');
    if (m) m.classList.add('hidden');
  }
  function switchTab(tab) {
    const tl = document.getElementById('authTabLogin');
    const tr = document.getElementById('authTabRegister');
    const fl = document.getElementById('loginForm');
    const fr = document.getElementById('registerForm');
    if (tab === 'register') {
      tl.classList.remove('active'); tl.setAttribute('aria-selected', 'false');
      tr.classList.add('active');    tr.setAttribute('aria-selected', 'true');
      fl.classList.add('hidden');    fr.classList.remove('hidden');
    } else {
      tr.classList.remove('active'); tr.setAttribute('aria-selected', 'false');
      tl.classList.add('active');    tl.setAttribute('aria-selected', 'true');
      fr.classList.add('hidden');    fl.classList.remove('hidden');
    }
  }

  // ----- 登录 -----
  async function doLogin(username, password) {
    const result = await authApi('login', 'POST', { username, password });
    state.user = result.user;
    state.token = result.token;
    saveToStorage(result.expires_in);
    renderAuthArea();
    // 通知其他模块
    global.dispatchEvent(new CustomEvent('auth:login', { detail: { user: state.user, token: state.token } }));
    // P1 阶段 C-1: 同步广播到 EventBus, 新代码用 EventBus.on 监听
    try { global.EventBus && global.EventBus.emit('auth:login', { user: state.user, token: state.token }); } catch (_) {}
    return result;
  }
  async function doRegister(username, password, displayName) {
    const result = await authApi('register', 'POST', {
      username, password,
      display_name: displayName || username,
    });
    state.user = result.user;
    state.token = result.token;
    saveToStorage(result.expires_in);
    renderAuthArea();
    global.dispatchEvent(new CustomEvent('auth:login', { detail: { user: state.user, token: state.token } }));
    try { global.EventBus && global.EventBus.emit('auth:login', { user: state.user, token: state.token }); } catch (_) {}
    return result;
  }
  async function doLogout() {
    try { await authApi('logout', 'POST'); } catch (e) { console.warn('logout api err', e); }
    state.user = null; state.token = null;
    saveToStorage();
    renderAuthArea();
    global.dispatchEvent(new CustomEvent('auth:logout'));
    try { global.EventBus && global.EventBus.emit('auth:logout', { user: state.user }); } catch (_) {}
  }
  async function doChangePassword(oldPwd, newPwd) {
    const result = await authApi('change-password', 'POST', { old_password: oldPwd, new_password: newPwd });
    // 改密成功后服务端吊销所有 token,本地也要清掉
    state.user = null; state.token = null;
    saveToStorage();
    renderAuthArea();
    global.dispatchEvent(new CustomEvent('auth:logout'));
    try { global.EventBus && global.EventBus.emit('auth:logout', { user: state.user }); } catch (_) {}
    return result;
  }
  async function fetchMe() {
    if (!state.token) return null;
    try {
      const result = await authApi('me', 'GET');
      state.user = result.user;
      saveToStorage();
      renderAuthArea();
      return result.user;
    } catch (e) {
      // 注意:不要在这里清空 localStorage!
      // 401 可能是 Supabase 网关误拒(比如 auth-api 的 Verify JWT 没关),
      // 也可能是网络抖动。如果把 token 擦了,用户刷新页面就被强制登出,
      // 等于"网站不保存登录状态"的 bug。
      // 正确做法:保留 localStorage,只对真正的"业务 401"(用户已注销 / token 真过期)
      // 在 logout 或受保护接口失败时再清。
      if (e.status === 401) {
        console.warn('[auth] /me 返回 401,保留 localStorage,等待下次受保护请求再判定', e.data || e.message);
      }
      return null;
    }
  }

  // ----- 用户名可用性检查 -----
  let usernameCheckTimer = null;
  async function checkUsername(username) {
    const statusEl = document.getElementById('usernameStatus');
    if (!username || username.length < 3) {
      if (statusEl) { statusEl.textContent = ''; statusEl.className = 'field-status'; }
      return;
    }
    try {
      const r = await authApi('check-username?username=' + encodeURIComponent(username), 'GET');
      if (statusEl) {
        if (r.available) { statusEl.textContent = '✓ 用户名可用'; statusEl.className = 'field-status ok'; }
        else { statusEl.textContent = '✗ ' + (r.reason || '用户名已被占用'); statusEl.className = 'field-status err'; }
      }
    } catch (e) { /* ignore */ }
  }

  // ----- 暴露到全局 -----
  global.auth = {
    get user() { return state.user; },
    get token() { return state.token; },
    isLoggedIn() { return !!state.user; },
    getToken() { return state.token; },
    getUser() { return state.user; },
    openLogin: () => openAuthModal('login'),
    openRegister: () => openAuthModal('register'),
    close: closeAuthModal,
    logout: doLogout,
    login: doLogin,
    register: doRegister,
    fetchMe,
  };

  // ----- 事件绑定 -----
  function bindEvents() {
    document.getElementById('authLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
    document.getElementById('authRegisterBtn')?.addEventListener('click', () => openAuthModal('register'));
    document.getElementById('authModalClose')?.addEventListener('click', closeAuthModal);
    document.getElementById('authTabLogin')?.addEventListener('click', () => switchTab('login'));
    document.getElementById('authTabRegister')?.addEventListener('click', () => switchTab('register'));
    document.getElementById('gotoRegister')?.addEventListener('click', (e) => { e.preventDefault(); switchTab('register'); });
    document.getElementById('gotoLogin')?.addEventListener('click', (e) => { e.preventDefault(); switchTab('login'); });

    // 点击背景关闭
    document.getElementById('authModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'authModal') closeAuthModal();
    });
    document.getElementById('changePwdModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'changePwdModal') closeChangePwdModal();
    });

    // 登录表单
    document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('loginUsername').value.trim();
      const password = document.getElementById('loginPassword').value;
      const btn = document.getElementById('loginSubmit');
      const errId = 'loginError';
      hideError(errId);
      if (!username || !password) { showError('loginForm', errId, '请填写用户名和密码'); return; }
      btn.disabled = true; btn.textContent = '登录中...';
      try {
        await doLogin(username, password);
        closeAuthModal();
        document.getElementById('loginPassword').value = '';
        if (global.showToast) global.showToast('登录成功，欢迎 ' + (state.user.display_name || state.user.username), 'success');
      } catch (err) {
        showError('loginForm', errId, err.message || '登录失败');
      } finally {
        btn.disabled = false; btn.textContent = '登 录';
      }
    });

    // 注册表单
    document.getElementById('registerForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('registerUsername').value.trim();
      const displayName = document.getElementById('registerDisplayName').value.trim();
      const password = document.getElementById('registerPassword').value;
      const password2 = document.getElementById('registerPasswordConfirm').value;
      const btn = document.getElementById('registerSubmit');
      const errId = 'registerError';
      hideError(errId);
      if (!username || !password) { showError('registerForm', errId, '请填写用户名和密码'); return; }
      if (password !== password2) { showError('registerForm', errId, '两次输入的密码不一致'); return; }
      btn.disabled = true; btn.textContent = '注册中...';
      try {
        await doRegister(username, password, displayName);
        closeAuthModal();
        document.getElementById('registerPassword').value = '';
        document.getElementById('registerPasswordConfirm').value = '';
        if (global.showToast) global.showToast('注册成功！欢迎 ' + (state.user.display_name || state.user.username), 'success');
      } catch (err) {
        showError('registerForm', errId, err.message || '注册失败');
      } finally {
        btn.disabled = false; btn.textContent = '注册并登录';
      }
    });

    // 用户名可用性实时检查
    const ru = document.getElementById('registerUsername');
    if (ru) ru.addEventListener('input', () => {
      clearTimeout(usernameCheckTimer);
      const v = ru.value.trim();
      usernameCheckTimer = setTimeout(() => checkUsername(v), 500);
    });

    // 用户菜单
    const trigger = document.getElementById('userMenuTrigger');
    const dropdown = document.getElementById('userMenuDropdown');
    if (trigger && dropdown) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !dropdown.hidden;
        dropdown.hidden = open;
        trigger.setAttribute('aria-expanded', String(!open));
      });
      document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && !trigger.contains(e.target)) {
          dropdown.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
        }
      });
    }
    document.getElementById('userMenuProfile')?.addEventListener('click', () => {
      dropdown.hidden = true;
      if (state.user) {
        const identifier = state.user.username || String(state.user.id);
        if (typeof global.openUserProfile === 'function') {
          global.openUserProfile(identifier);
        } else if (global.showToast) {
          global.showToast(`用户 #${state.user.id} · ${state.user.username}`, 'info');
        }
      }
    });
    document.getElementById('userMenuChangePwd')?.addEventListener('click', () => {
      dropdown.hidden = true;
      openChangePwdModal();
    });
    document.getElementById('userMenuUpload')?.addEventListener('click', () => {
      dropdown.hidden = true;
      if (global.Upload && typeof global.Upload.open === 'function') {
        global.Upload.open();
      } else if (global.showToast) {
        global.showToast('上传组件加载中，请稍后再试', 'info');
      }
    });
    document.getElementById('userMenuLogout')?.addEventListener('click', async () => {
      dropdown.hidden = true;
      if (!confirm('确定要退出登录吗？')) return;
      await doLogout();
      if (global.showToast) global.showToast('已退出登录', 'info');
    });
    document.getElementById('changePwdClose')?.addEventListener('click', closeChangePwdModal);

    // 评论框里的登录/注册入口
    document.getElementById('composerLoginBtn')?.addEventListener('click', () => {
      if (global.auth) global.auth.openLogin();
    });
    document.getElementById('composerRegisterBtn')?.addEventListener('click', () => {
      if (global.auth) global.auth.openRegister();
    });
    // 登录状态变化时,刷新评论框登录提示
    global.addEventListener('auth:login', () => {
      const h = document.getElementById('composerAuthHint');
      if (h) h.hidden = true;
    });
    global.addEventListener('auth:logout', () => {
      const h = document.getElementById('composerAuthHint');
      if (h) h.hidden = false;
    });

    // 修改密码表单
    document.getElementById('changePwdForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldPwd = document.getElementById('oldPassword').value;
      const newPwd = document.getElementById('newPassword').value;
      const newPwd2 = document.getElementById('newPasswordConfirm').value;
      const errId = 'changePwdError';
      hideError(errId);
      if (!oldPwd || !newPwd) { showError('changePwdForm', errId, '请填写完整'); return; }
      if (newPwd !== newPwd2) { showError('changePwdForm', errId, '两次输入的新密码不一致'); return; }
      if (oldPwd === newPwd) { showError('changePwdForm', errId, '新密码不能与原密码相同'); return; }
      try {
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = '更新中...';
        await doChangePassword(oldPwd, newPwd);
        closeChangePwdModal();
        e.target.reset();
        if (global.showToast) global.showToast('密码已更新，请重新登录', 'success');
      } catch (err) {
        showError('changePwdForm', errId, err.message || '更新失败');
      } finally {
        const btn = e.target.querySelector('button[type=submit]');
        if (btn) { btn.disabled = false; btn.textContent = '更新密码'; }
      }
    });

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!document.getElementById('authModal').classList.contains('hidden')) closeAuthModal();
        if (!document.getElementById('changePwdModal').classList.contains('hidden')) closeChangePwdModal();
      }
    });
  }

  function openChangePwdModal() {
    const m = document.getElementById('changePwdModal');
    if (m) m.classList.remove('hidden');
    hideError('changePwdError');
    setTimeout(() => document.getElementById('oldPassword')?.focus(), 100);
  }
  function closeChangePwdModal() {
    const m = document.getElementById('changePwdModal');
    if (m) m.classList.add('hidden');
  }

  // ----- 启动 -----
  function init() {
    loadFromStorage();
    renderAuthArea();
    bindEvents();
    // 异步刷新用户信息(token 可能已过期)
    if (state.token) fetchMe();
    console.log('[auth] initialized, user:', state.user ? state.user.username : 'guest');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露模块
  global.Auth = global.auth;
})(window);
