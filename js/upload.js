(function(global) {
  'use strict';

  // 用户上传图片逻辑
  const modal = document.getElementById('uploadModal');
  if (!modal) {
    global.Upload = { open: function() {} };
    return;
  }
  const closeBtn = document.getElementById('uploadCloseBtn');
  const cancelBtn = document.getElementById('userUploadCancelBtn');
  const form = document.getElementById('userUploadForm');
  const fileInput = document.getElementById('userUploadFile');
  const titleInput = document.getElementById('userUploadTitle');
  const submitBtn = document.getElementById('userUploadSubmitBtn');

  // 从 AppConfig.SUPABASE / window.SUPABASE_CONFIG 拿配置
  // SUPABASE_CONFIG.url 已经是完整 https:// 形式,直接返回;
  // 但若未来被改成纯域名,自动补上 https:// 避免 ERR_NAME_NOT_RESOLVED
  function getConfig() {
    const cfg = (global.AppConfig && global.AppConfig.SUPABASE) || global.SUPABASE_CONFIG || {};
    let url = cfg.url || 'https://qlhfyawbyedhqokivezn.supabase.co';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return {
      url,
      anonKey: cfg.anonKey || '',
    };
  }
  // 从 localStorage 拿 token (与主站 auth 模块约定一致,优先读 AppConfig)
  function getToken() {
    const key = (global.AppConfig && global.AppConfig.STORAGE_KEYS && global.AppConfig.STORAGE_KEYS.authToken)
      || 'shungxin_auth_token';
    return localStorage.getItem(key) || '';
  }
  function openModal() {
    const token = getToken();
    if (!token) {
      if (typeof global.showToast === 'function') global.showToast('请先登录后再上传作品', 'info');
      if (global.auth && typeof global.auth.openLogin === 'function') global.auth.openLogin();
      return;
    }
    modal.style.display = 'flex';
    // 重置表单
    form.reset();
    document.getElementById('uploadProgress2').style.display = 'none';
    document.getElementById('uploadBar2').style.width = '0%';
    document.getElementById('uploadBar2').style.background = '#4f8eff';
    document.getElementById('uploadStatus2').textContent = '上传中…';
    submitBtn.disabled = false;
    submitBtn.textContent = '上传';
  }
  function closeModal() {
    modal.style.display = 'none';
  }
  // 选中文件后自动填标题
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!titleInput.value) titleInput.value = f.name.replace(/\.[^.]+$/, '');
  });
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  // 绑定菜单项
  const menuBtn = document.getElementById('userMenuUpload');
  if (menuBtn) menuBtn.addEventListener('click', openModal);

  // ===== P0-1.3 魔数校验函数 =====
  // 读取文件前 16 字节,与已知图片格式的 magic number 比对
  // 返回 {ok: true, type: 'jpeg'} 或 {ok: false, reason: '...'}
  async function verifyImageMagic(file) {
    try {
      // 文件名兜底黑名单(防止直接拒绝 .php / .exe 等)
      const name = (file.name || '').toLowerCase();
      const blacklist = ['.php', '.exe', '.sh', '.bat', '.cmd', '.js', '.html', '.htm', '.svg', '.xml', '.asp', '.aspx', '.jsp', '.cgi', '.pl', '.py'];
      for (const ext of blacklist) {
        if (name.endsWith(ext)) {
          return { ok: false, reason: '文件名后缀不允许 (' + ext + ')' };
        }
      }

      // 读前 16 字节
      const buf = await file.slice(0, 16).arrayBuffer();
      const bytes = new Uint8Array(buf);

      if (bytes.length < 4) return { ok: false, reason: '文件太小' };

      // JPEG: FF D8 FF
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { ok: true, type: 'jpeg' };
      }
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
          && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
        return { ok: true, type: 'png' };
      }
      // GIF: 47 49 46 38 (37/39) 61
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
          && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
        return { ok: true, type: 'gif' };
      }
      // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50 (RIFF....WEBP)
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
          && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return { ok: true, type: 'webp' };
      }
      // BMP: 42 4D
      if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
        return { ok: true, type: 'bmp' };
      }
      // HEIC/HEIF/AVIF: ?? ?? ?? ?? 66 74 79 70 ??(68 65 69 63|68 65 69 73|6D 69 66 31|61 76 69 66)
      if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'].indexOf(brand) >= 0) {
          return { ok: true, type: brand };
        }
      }
      // 没匹配上
      return { ok: false, reason: '文件头不是已知图片格式' };
    } catch (e) {
      return { ok: false, reason: '读取文件失败: ' + (e.message || String(e)) };
    }
  }

  // 表单提交
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = fileInput.files[0];
    if (!f) {
      if (typeof global.showToast === 'function') global.showToast('请选择文件', 'warning');
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      if (typeof global.showToast === 'function') global.showToast('文件超过 10MB', 'warning');
      return;
    }

    // ===== P0-1.3 魔数校验:读取文件头部 16 字节,验证真实文件类型 =====
    // 防止有人把 .exe 改后缀成 .jpg 上传
    const magicCheck = await verifyImageMagic(f);
    if (!magicCheck.ok) {
      if (typeof global.showToast === 'function') {
        global.showToast('文件类型不安全: ' + magicCheck.reason + ' (支持 JPG/PNG/WebP/GIF)', 'error');
      }
      return;
    }

    const fd = new FormData();
    fd.append('file', f);
    fd.append('title', titleInput.value.trim());
    fd.append('category', document.getElementById('userUploadCategory').value);
    fd.append('description', document.getElementById('userUploadDesc').value || '');
    fd.append('is_new', 'false');
    fd.append('is_visible', 'false');   // 用户上传默认待审核

    submitBtn.disabled = true;
    submitBtn.textContent = '上传中…';
    document.getElementById('uploadProgress2').style.display = 'block';

    const { url, anonKey } = getConfig();
    const token = getToken();
    const uploadUrl = `${url}/functions/v1/upload-image`;
    console.log('[upload-image] 实际 URL:', uploadUrl);
    // 兜底:如果还出现双 https,强制修正一次
    const finalUrl = uploadUrl.replace(/(https?:\/\/)https?:\/\//i, '$1');
    if (finalUrl !== uploadUrl) console.warn('[upload-image] 修正了双 https:', finalUrl);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', finalUrl);
    xhr.setRequestHeader('apikey', anonKey);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        document.getElementById('uploadBar2').style.width = pct + '%';
        document.getElementById('uploadStatus2').textContent = `上传中… ${pct}%`;
      }
    };
    xhr.onload = () => {
      submitBtn.disabled = false;
      submitBtn.textContent = '上传';
      let res;
      try { res = JSON.parse(xhr.responseText); }
      catch { res = { error: xhr.responseText || ('HTTP ' + xhr.status) }; }
      if (xhr.status >= 200 && xhr.status < 300 && res.success) {
        document.getElementById('uploadStatus2').textContent = '✅ 上传成功!等待审核';
        document.getElementById('uploadBar2').style.width = '100%';
        document.getElementById('uploadBar2').style.background = '#34d399';
        setTimeout(() => {
          closeModal();
          // 如果主站有 toast 系统,触发一下;否则用 alert
          if (global.showToast) global.showToast('作品已上传,等待管理员审核', 'success');
        }, 1500);
      } else {
        document.getElementById('uploadStatus2').textContent = '❌ ' + (res.error || ('HTTP ' + xhr.status));
        document.getElementById('uploadBar2').style.background = '#f87171';
      }
    };
    xhr.onerror = (ev) => {
      submitBtn.disabled = false;
      submitBtn.textContent = '上传';
      const hint = location.protocol === 'file:'
        ? 'file:// 协议下无法上传,请通过 http:// 访问网站'
        : '请检查网络或浏览器控制台 (F12) Network 面板';
      const msg = '❌ 网络错误 · ' + hint;
      document.getElementById('uploadStatus2').textContent = msg;
      document.getElementById('uploadBar2').style.background = '#f87171';
      // 关键诊断信息打到 console
      console.error('[upload-image] xhr error', {
        protocol: location.protocol,
        host: location.host,
        readyState: xhr.readyState,
        status: xhr.status,
        response: (xhr.responseText || '').slice(0, 200),
      });
      // 同时显示在页面上
      const detail = '状态: ' + xhr.status + ' · readyState: ' + xhr.readyState + ' · 协议: ' + location.protocol;
      if (global.showToast) global.showToast(msg + ' · ' + detail, 'error');
    };
    xhr.ontimeout = () => {
      document.getElementById('uploadStatus2').textContent = '❌ 上传超时,请重试或换更小的图';
      document.getElementById('uploadBar2').style.background = '#f87171';
    };
    xhr.send(fd);
  });

  // 暴露模块
  global.Upload = {
    open: openModal,
    close: closeModal,
  };
})(window);
