// =====================================================================
// config.js
// 单一来源: 全站所有常量、API 地址、配置项
// 修改这里就改了全站,不要在别处再硬编码同样的值
//
// 用法:
//   <script src="js/config.js"></script>  <!-- 放在所有业务 JS 之前 -->
//   业务代码用 window.AppConfig.xxx
//
// 维护规则:
//   - 改 Supabase 项目: 改 SUPABASE.url 和 SUPABASE.anonKey
//   - 改 Edge Function 路径: 改 FUNCTIONS.xxx
//   - 改分类标签: 改 CATEGORIES
//   - 改主题/限制: 改 UI/THEMES / STORAGE
// =====================================================================

(function (global) {
  'use strict';

  const AppConfig = {
    // ==================== Supabase ====================
    SUPABASE: {
      // 当前实际部署的项目
      url: 'https://qlhfyawbyedhqokivezn.supabase.co',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsaGZ5YXdieWVkaHFva2l2ZXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyODUyNTUsImV4cCI6MjA5Nzg2MTI1NX0.uJF2_JLDl2cDruSYeHAg4r6ZxZRbsgqhW_xfZ3YZ_Kk',
    },

    // ==================== Edge Function 路由 ====================
    // 完整 URL 在 helper getFunctionUrl() 里拼,不要在业务代码拼
    FUNCTIONS: {
      publicGallery: 'public-gallery',
      likeToggle: 'like-toggle',
      commentApi: 'comment-api',
      viewCount: 'view-count',
      authApi: 'auth-api',
      uploadImage: 'upload-image',
      adminApi: 'admin-api',
      storageMonitor: 'storage-monitor',
      paidAreaAuth: 'paid-area-auth',
      collectionsApi: 'collections-api',
    },

    // ==================== Storage(本地/Supabase Storage 资源) ====================
    STORAGE: {
      // 前端页面挂载在哪个 bucket(主站是 'site')
      siteBucket: 'site',
      // 音频文件(中文文件名 Supabase Storage 不支持,用英文名)
      audioSrc: 'assets/audio/feng-jaychou.mp3',
      // 播放列表配置(可扩展多首,path 相对于站点根目录)
      PLAYLIST: [
        { id: 'feng',   title: '枫',      artist: '周杰伦', path: 'assets/audio/feng-jaychou.mp3' },
      ],
    },

    // ==================== UI 配置 ====================
    UI: {
      // 主题
      THEMES: {
        dark: 'dark',
        light: 'light',
        default: 'dark',
      },

      // 分类(必须和 getCategoryLabel() 里的映射保持一致)
      CATEGORIES: [
        { id: 'all',      label: '全部',  filterValue: 'all' },
        { id: 'landscape', label: '风景',  filterValue: 'landscape' },
        { id: 'city',     label: '城市',  filterValue: 'city' },
        { id: 'portrait', label: '人像',  filterValue: 'portrait' },
        { id: 'nature',   label: '自然',  filterValue: 'nature' },
      ],

      // 上传限制
      MAX_FILE_SIZE: 10 * 1024 * 1024,        // 10MB
      ALLOWED_MIME: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'],

      // 排序
      SORTS: {
        newest: 'newest',
        hottest: 'hottest',
        default: 'newest',
      },
    },

    // ==================== LocalStorage Keys ====================
    STORAGE_KEYS: {
      theme: 'shungxin_theme',
      authToken: 'shungxin_auth_token',
      authUser: 'shungxin_auth_user',
      visitorId: 'visitor_id',
      paidAreaToken: 'shungxin_paid_area_token',
      // 兼容旧 key(密码保护时代留下来的,如已清理可删)
      legacyGalleryAccess: 'gallery_access',
    },

    // ==================== Giscus 评论系统 ====================
    GISCUS: {
      repo: '1289107388/shungxin.github.io',
      repoId: 'R_kgDOTCxZGQ',
      category: 'General',
      categoryId: 'DIC_kwDOTCxZGc4C_xSE',
      theme: 'noborder_dark',
      lang: 'zh-CN',
    },

    // ==================== Helper ====================
    /**
     * 拼 Edge Function 完整 URL
     * @param {string} functionName - FUNCTIONS.* 里定义的名字
     * @param {string} [path] - 可选子路径,比如 'images' 或 'login'
     * @returns {string}
     */
    getFunctionUrl(functionName, path) {
      const slug = this.FUNCTIONS[functionName] || functionName;
      const base = this.SUPABASE.url + '/functions/v1/' + slug;
      return path ? base + '/' + path : base;
    },

    /**
     * 拼 Storage 公开访问 URL
     * @param {string} filePath - 相对 bucket 根的路径,比如 'index.html' 或 'assets/images/foo.png'
     * @returns {string}
     */
    getStorageUrl(filePath) {
      return this.SUPABASE.url + '/storage/v1/object/public/' + this.STORAGE.siteBucket + '/' + filePath;
    },

    /**
     * 检查 Supabase 是否已配置(没填就是占位符)
     * @returns {boolean}
     */
    isConfigured() {
      return this.SUPABASE.url
        && !this.SUPABASE.url.includes('YOUR_')
        && this.SUPABASE.anonKey
        && !this.SUPABASE.anonKey.includes('YOUR_');
    },
  };

  // 暴露到全局
  global.AppConfig = AppConfig;

  // 兼容:老代码用的 window.SUPABASE_CONFIG 也指向同一个 url/anonKey
  // 后续业务代码应该用 AppConfig,但保留这个别名避免破坏现有代码
  global.SUPABASE_CONFIG = {
    url: AppConfig.SUPABASE.url,
    anonKey: AppConfig.SUPABASE.anonKey,
  };
})(window);
