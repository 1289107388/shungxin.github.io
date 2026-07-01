// 通用批量上传组件
// 支持：单页/多页共享、公开区/付费区自动识别、批量选择、逐张上传、日限额提示
(function (global) {
  'use strict';

  const CFG = (global.AppConfig && global.AppConfig.SUPABASE) || global.SUPABASE_CONFIG || {};
  const UPLOAD_URL = (CFG.url || 'https://qlhfyawbyedhqokivezn.supabase.co') + '/functions/v1/upload-image';
  const ANON_KEY = CFG.anonKey || '';

  function getAuthToken() {
    const key = (global.AppConfig && global.AppConfig.STORAGE_KEYS && global.AppConfig.STORAGE_KEYS.authToken)
      || 'shungxin_auth_token';
    return localStorage.getItem(key) || '';
  }

  function getUploadMode() {
    // 付费区页面标记
    if (global.__PAID_AREA_MODE) return 'paid';
    // 默认公开区
    return 'public';
  }

  function isAdmin() {
    try {
      const parts = getAuthToken().split('.');
      if (parts.length !== 3) return false;
      const payload = JSON.parse(atob(parts[1]));
      return payload && payload.role === 'admin';
    } catch { return false; }
  }

  function createModal() {
    let modal = document.getElementById('uploadModal');
    if (modal) return modal;

    const div = document.createElement('div');
    div.id = 'uploadModal';
    div.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);z-index:10000;align-items:center;justify-content:center;';
    div.innerHTML = `
      <div style="background:var(--color-bg,#1a1d24);border-radius:12px;width:min(560px,94vw);max-height:90vh;overflow-y:auto;color:#e6e8ed;box-shadow:0 24px 60px rgba(0,0,0,0.5);">
        <div style="padding:18px 20px;border-bottom:1px solid #2d3340;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="font-size:16px;margin:0;">📷 上传作品</h3>
          <button id="uploadCloseBtn" style="background:none;border:none;color:#9ba1ad;font-size:22px;cursor:pointer;line-height:1;">×</button>
        </div>
        <form id="userUploadForm" style="padding:18px 20px;display:flex;flex-direction:column;gap:14px;">
          <div>
            <label style="display:block;font-size:12px;color:#9ba1ad;margin-bottom:6px;">选择文件 *</label>
            <input type="file" id="userUploadFile" accept="image/*" multiple required style="width:100%;padding:10px;background:#232830;border:1px solid #2d3340;border-radius:6px;color:#e6e8ed;font-size:13px;">
            <div style="font-size:11px;color:#6b7280;margin-top:4px;">支持 jpg/png/webp，单图 ≤ 10MB，可一次选择多张</div>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#9ba1ad;margin-bottom:6px;">标题前缀（可选）</label>
            <input type="text" id="userUploadTitle" maxlength="128" placeholder="留空则使用文件名" style="width:100%;padding:9px 12px;background:#232830;border:1px solid #2d3340;border-radius:6px;color:#e6e8ed;font-size:13px;">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#9ba1ad;margin-bottom:6px;">分类</label>
            <select id="userUploadCategory" style="width:100%;padding:9px 12px;background:#232830;border:1px solid #2d3340;border-radius:6px;color:#e6e8ed;font-size:13px;">
              <option value="portrait">人像</option>
              <option value="landscape">风景</option>
              <option value="street">街拍</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#9ba1ad;margin-bottom:6px;">描述（可选，会应用到每一张）</label>
            <textarea id="userUploadDesc" rows="2" maxlength="500" placeholder="说说这组图的故事..." style="width:100%;padding:9px 12px;background:#232830;border:1px solid #2d3340;border-radius:6px;color:#e6e8ed;font-size:13px;resize:vertical;"></textarea>
          </div>
          <div style="background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.3);border-radius:6px;padding:10px 12px;font-size:12px;color:#60a5fa;" id="uploadHint">
            ℹ️ 上传后需管理员审核通过后才会在画廊显示。
          </div>
          <div id="uploadFileList" style="display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;"></div>
          <div id="uploadProgress2" style="display:none;">
            <div style="font-size:12px;color:#9ba1ad;margin-bottom:6px;" id="uploadStatus2">准备上传…</div>
            <div style="height:6px;background:#232830;border-radius:3px;overflow:hidden;">
              <div id="uploadBar2" style="height:100%;background:#4f8eff;width:0%;transition:width 0.2s;"></div>
            </div>
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px;">
            <button type="button" id="userUploadCancelBtn" style="padding:9px 18px;background:#232830;color:#e6e8ed;border:1px solid #2d3340;border-radius:6px;cursor:pointer;font-size:14px;">取消</button>
            <button type="submit" id="userUploadSubmitBtn" style="padding:9px 22px;background:#4f8eff;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;">开始上传</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(div);
    return div;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function renderFileList(files) {
    const list = document.getElementById('uploadFileList');
    if (!list) return;
    if (!files || files.length === 0) { list.innerHTML = ''; return; }
    list.innerHTML = Array.from(files).map((f, i) => `
      <div data-idx="${i}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:#232830;border:1px solid #2d3340;border-radius:6px;font-size:12px;">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.name)}</span>
        <span style="color:#6b7280;white-space:nowrap;">${formatSize(f.size)}</span>
        <span class="file-status" style="white-space:nowrap;color:#9ba1ad;">等待中</span>
      </div>
    `).join('');
  }

  function setFileStatus(idx, text, color) {
    const row = document.querySelector(`#uploadFileList > div[data-idx="${idx}"] .file-status`);
    if (row) { row.textContent = text; row.style.color = color || '#9ba1ad'; }
  }

  function uploadFile(file, fields, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', fields.title);
      fd.append('category', fields.category);
      fd.append('description', fields.description || '');
      fd.append('is_new', 'false');
      fd.append('is_visible', fields.isVisible ? 'true' : 'false');
      fd.append('area', fields.area);

      const token = getAuthToken();
      const xhr = new XMLHttpRequest();
      xhr.open('POST', UPLOAD_URL.replace(/(https?:\/\/)https?:\/\//i, '$1'));
      xhr.setRequestHeader('apikey', ANON_KEY);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total);
      };
      xhr.onload = () => {
        let res;
        try { res = JSON.parse(xhr.responseText); }
        catch { res = { error: xhr.responseText || ('HTTP ' + xhr.status) }; }
        if (xhr.status >= 200 && xhr.status < 300 && res.success) resolve(res.data);
        else reject(new Error(res.error || ('HTTP ' + xhr.status)));
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.ontimeout = () => reject(new Error('上传超时'));
      xhr.send(fd);
    });
  }

  const state = { files: [] };

  function init() {
    const modal = createModal();
    const form = document.getElementById('userUploadForm');
    const fileInput = document.getElementById('userUploadFile');
    const titleInput = document.getElementById('userUploadTitle');
    const closeBtn = document.getElementById('uploadCloseBtn');
    const cancelBtn = document.getElementById('userUploadCancelBtn');
    const submitBtn = document.getElementById('userUploadSubmitBtn');
    const list = document.getElementById('uploadFileList');
    const progress = document.getElementById('uploadProgress2');
    const bar = document.getElementById('uploadBar2');
    const status = document.getElementById('uploadStatus2');
    const hint = document.getElementById('uploadHint');

    const mode = getUploadMode();
    if (mode === 'paid' && hint) {
      hint.textContent = 'ℹ️ 当前处于付费区，上传的作品将自动归入付费区。管理员上传默认可见，普通用户上传需审核。';
    }

    function openModal() {
      const token = getAuthToken();
      if (!token) {
        if (typeof global.showToast === 'function') global.showToast('请先登录后再上传作品', 'info');
        if (global.auth && typeof global.auth.openLogin === 'function') global.auth.openLogin();
        return;
      }
      modal.style.display = 'flex';
      form.reset();
      state.files = [];
      renderFileList([]);
      if (progress) progress.style.display = 'none';
      if (bar) { bar.style.width = '0%'; bar.style.background = '#4f8eff'; }
      if (status) status.textContent = '准备上传…';
    }

    function closeModal() { modal.style.display = 'none'; }

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // 上传入口由 auth.js 统一绑定，避免重复监听

    fileInput.addEventListener('change', () => {
      state.files = Array.from(fileInput.files || []);
      renderFileList(state.files);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.files.length) {
        if (global.showToast) global.showToast('请先选择文件', 'warning');
        return;
      }

      const admin = isAdmin();
      const mode = getUploadMode();
      const baseTitle = titleInput.value.trim();
      const category = document.getElementById('userUploadCategory').value;
      const description = document.getElementById('userUploadDesc').value || '';
      const fields = {
        category,
        description,
        area: mode === 'paid' ? 'paid' : 'public',
        isVisible: admin, // 管理员默认可见，普通用户待审核
      };

      submitBtn.disabled = true;
      submitBtn.textContent = '上传中…';
      if (progress) progress.style.display = 'block';

      let completed = 0;
      let failed = 0;

      for (let i = 0; i < state.files.length; i++) {
        const f = state.files[i];
        const title = baseTitle ? `${baseTitle} ${i + 1}` : f.name.replace(/\.[^.]+$/, '');
        setFileStatus(i, '上传中…', '#4f8eff');
        try {
          await uploadFile(f, { ...fields, title }, (pct) => {
            const overall = ((completed + pct) / state.files.length) * 100;
            if (bar) bar.style.width = overall + '%';
          });
          completed++;
          setFileStatus(i, '完成', '#34d399');
        } catch (err) {
          failed++;
          setFileStatus(i, '失败: ' + err.message, '#f87171');
          console.error('[upload]', f.name, err);
        }
      }

      if (bar) bar.style.width = '100%';
      if (status) status.textContent = `上传结束：成功 ${completed} 张，失败 ${failed} 张`;
      if (bar) bar.style.background = failed ? '#f87171' : '#34d399';

      submitBtn.disabled = false;
      submitBtn.textContent = '开始上传';

      if (global.showToast) {
        global.showToast(`上传完成：成功 ${completed} 张${failed ? '，失败 ' + failed + ' 张' : ''}`, failed ? 'warning' : 'success');
      }

      if (completed > 0) {
        setTimeout(() => {
          closeModal();
          // 触发画廊刷新（如果页面支持）
          if (typeof global.refreshGallery === 'function') global.refreshGallery();
          else if (typeof global.renderGallery === 'function') global.renderGallery('all');
        }, 1200);
      }
    });

    global.Upload = { open: openModal, close: closeModal };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
