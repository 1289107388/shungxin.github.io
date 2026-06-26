(function(global) {
  'use strict';

  /* ============================
     Music Player — 浮底音乐播放器
     功能: 播放/暂停、上一首/下一首、播放列表、进度拖拽、音量控制
     ============================ */
  (function() {
    // DOM 引用
    const bgAudio = document.getElementById('bgAudio');
    const playerPlayBtn = document.getElementById('playerPlayBtn');
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    const playerProgressBar = document.getElementById('playerProgressBar');
    const playerProgressWrap = document.getElementById('playerProgressWrap');
    const playerTime = document.getElementById('playerTime');
    const musicPlayer = document.getElementById('musicPlayer');
    const playerToggle = document.getElementById('playerToggle');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeFill = document.getElementById('volumeFill');
    const volumeIcon = document.getElementById('volumeIcon');
    const playerErrorMsg = document.getElementById('playerErrorMsg');
    const playerSongName = document.getElementById('playerSongName');
    const playerArtist = document.getElementById('playerArtist');
    const playerPrevBtn = document.getElementById('playerPrevBtn');
    const playerNextBtn = document.getElementById('playerNextBtn');
    const playerListBtn = document.getElementById('playerListBtn');
    const playerListCount = document.getElementById('playerListCount');
    const playerPlaylist = document.getElementById('playerPlaylist');
    const playerPlaylistClose = document.getElementById('playerPlaylistClose');
    const playerPlaylistList = document.getElementById('playerPlaylistList');

    // 播放列表数据
    const playlist = (global.AppConfig && global.AppConfig.STORAGE && Array.isArray(global.AppConfig.STORAGE.PLAYLIST))
      ? global.AppConfig.STORAGE.PLAYLIST
      : [];
    let currentIndex = 0;
    let isPlaying = false;
    let currentVolume = 0.7;
    let lastNonZeroVolume = 0.7;
    let isDraggingProgress = false;

    // 初始化音量
    bgAudio.volume = currentVolume;
    volumeFill.style.width = (currentVolume * 100) + '%';
    updateVolumeIcon(currentVolume);
    playerListCount.textContent = String(playlist.length);

    // 优先使用 utils.js 中的统一实现,没有则 fallback
    function formatTime(sec) {
      if (global.Utils && typeof global.Utils.formatTime === 'function') {
        return global.Utils.formatTime(sec);
      }
      if (!sec || !isFinite(sec) || sec < 0) return '--:--';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function loadTrack(index) {
      if (!playlist.length) {
        playerSongName.childNodes[0].textContent = '暂无歌曲';
        playerArtist.textContent = '--';
        playerTime.textContent = '--:-- / --:--';
        playerErrorMsg.classList.add('visible');
        return;
      }
      currentIndex = ((index % playlist.length) + playlist.length) % playlist.length;
      const track = playlist[currentIndex];
      bgAudio.src = track.path;
      bgAudio.load();
      playerSongName.childNodes[0].textContent = track.title || '未知歌曲';
      playerArtist.textContent = track.artist || '未知歌手';
      playerTime.textContent = '--:-- / --:--';
      playerErrorMsg.classList.remove('visible');
      renderPlaylist();
    }

    function updateUI() {
      if (isPlaying) {
        playIcon.style.display = 'none';
        pauseIcon.style.display = '';
        musicPlayer.classList.add('playing-state');
        playerToggle.classList.add('playing');
        const svg = playerToggle.querySelector('svg');
        if (svg) svg.style.animation = 'spin 3s linear infinite';
      } else {
        playIcon.style.display = '';
        pauseIcon.style.display = 'none';
        musicPlayer.classList.remove('playing-state');
        playerToggle.classList.remove('playing');
        const svg = playerToggle.querySelector('svg');
        if (svg) svg.style.animation = '';
      }
    }

    function playTrack() {
      if (!playlist.length) return;
      const playPromise = bgAudio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(function() {
            isPlaying = true;
            updateUI();
          })
          .catch(function(err) {
            console.warn('Audio play failed:', err);
            playerErrorMsg.classList.add('visible');
            isPlaying = false;
            updateUI();
          });
      } else {
        isPlaying = true;
        updateUI();
      }
    }

    function pauseTrack() {
      bgAudio.pause();
      isPlaying = false;
      updateUI();
    }

    function togglePlay() {
      if (isPlaying) {
        pauseTrack();
      } else {
        playTrack();
      }
    }

    function playPrev() {
      if (!playlist.length) return;
      loadTrack(currentIndex - 1);
      playTrack();
    }

    function playNext() {
      if (!playlist.length) return;
      loadTrack(currentIndex + 1);
      playTrack();
    }

    function updateProgress() {
      if (!bgAudio.duration || !isFinite(bgAudio.duration)) return;
      const pct = (bgAudio.currentTime / bgAudio.duration) * 100;
      playerProgressBar.style.width = pct + '%';
      playerTime.textContent = formatTime(bgAudio.currentTime) + ' / ' + formatTime(bgAudio.duration);
    }

    function seekTo(clientX) {
      if (!bgAudio.duration || !isFinite(bgAudio.duration)) return;
      const rect = playerProgressWrap.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      bgAudio.currentTime = pct * bgAudio.duration;
      updateProgress();
    }

    function renderPlaylist() {
      playerPlaylistList.innerHTML = '';
      playlist.forEach(function(track, idx) {
        const li = document.createElement('li');
        li.className = 'player-playlist-item' + (idx === currentIndex ? ' active' : '');
        li.title = (track.title || '未知歌曲') + ' - ' + (track.artist || '未知歌手');
        li.innerHTML = '<span class="playlist-num">' + (idx + 1) + '</span>' +
          '<span class="playlist-title">' + escapeHtml(track.title || '未知歌曲') + '</span>' +
          '<span class="playlist-artist">' + escapeHtml(track.artist || '未知歌手') + '</span>';
        li.addEventListener('click', function() {
          loadTrack(idx);
          playTrack();
        });
        playerPlaylistList.appendChild(li);
      });
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function togglePlaylist(show) {
      if (typeof show === 'boolean') {
        playerPlaylist.hidden = !show;
      } else {
        playerPlaylist.hidden = !playerPlaylist.hidden;
      }
    }

    // 音量图标更新
    function updateVolumeIcon(pct) {
      if (!volumeIcon) return;
      if (pct === 0) {
        volumeIcon.textContent = '🔇';
      } else if (pct < 0.5) {
        volumeIcon.textContent = '🔉';
      } else {
        volumeIcon.textContent = '🔊';
      }
    }

    // 事件绑定: 播放控制
    playerPlayBtn.addEventListener('click', togglePlay);
    playerPrevBtn.addEventListener('click', playPrev);
    playerNextBtn.addEventListener('click', playNext);

    // 事件绑定: 播放器展开/收起
    playerToggle.addEventListener('click', function() {
      musicPlayer.classList.toggle('hidden-player');
    });

    // 事件绑定: 播放列表
    playerListBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      togglePlaylist();
    });
    playerPlaylistClose.addEventListener('click', function(e) {
      e.stopPropagation();
      togglePlaylist(false);
    });
    document.addEventListener('click', function(e) {
      if (!playerPlaylist.hidden && !playerPlaylist.contains(e.target) && e.target !== playerListBtn && !playerListBtn.contains(e.target)) {
        togglePlaylist(false);
      }
    });

    // 事件绑定: 音频元数据/播放进度/结束/错误
    bgAudio.addEventListener('loadedmetadata', function() {
      playerTime.textContent = formatTime(bgAudio.currentTime || 0) + ' / ' + formatTime(bgAudio.duration);
      playerErrorMsg.classList.remove('visible');
    });
    bgAudio.addEventListener('timeupdate', function() {
      if (!isDraggingProgress) {
        updateProgress();
      }
    });
    bgAudio.addEventListener('ended', function() {
      // 播放列表顺序播放,到末尾循环到第一首
      playNext();
    });
    bgAudio.addEventListener('error', function(e) {
      console.warn('Audio source error:', e);
      playerErrorMsg.classList.add('visible');
      playerTime.textContent = '--:-- / --:--';
      isPlaying = false;
      updateUI();
    });

    // 事件绑定: 进度条点击 + 拖拽 (Pointer Events)
    playerProgressWrap.addEventListener('pointerdown', function(e) {
      if (!playlist.length) return;
      isDraggingProgress = true;
      playerProgressWrap.classList.add('dragging');
      playerProgressWrap.setPointerCapture(e.pointerId);
      seekTo(e.clientX);
    });
    playerProgressWrap.addEventListener('pointermove', function(e) {
      if (!isDraggingProgress) return;
      e.preventDefault();
      seekTo(e.clientX);
    });
    playerProgressWrap.addEventListener('pointerup', function(e) {
      if (!isDraggingProgress) return;
      isDraggingProgress = false;
      playerProgressWrap.classList.remove('dragging');
      playerProgressWrap.releasePointerCapture(e.pointerId);
    });
    playerProgressWrap.addEventListener('pointercancel', function(e) {
      isDraggingProgress = false;
      playerProgressWrap.classList.remove('dragging');
      playerProgressWrap.releasePointerCapture(e.pointerId);
    });
    // 保留 click 作为兜底
    playerProgressWrap.addEventListener('click', function(e) {
      seekTo(e.clientX);
    });

    // 事件绑定: 音量
    volumeSlider.addEventListener('click', function(e) {
      const rect = volumeSlider.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      currentVolume = pct;
      bgAudio.volume = pct;
      volumeFill.style.width = (pct * 100) + '%';
      updateVolumeIcon(pct);
      if (pct > 0) lastNonZeroVolume = pct;
    });
    volumeIcon.addEventListener('click', function(e) {
      e.stopPropagation();
      if (currentVolume > 0) {
        lastNonZeroVolume = currentVolume;
        currentVolume = 0;
        bgAudio.volume = 0;
        volumeFill.style.width = '0%';
        updateVolumeIcon(0);
      } else {
        currentVolume = lastNonZeroVolume;
        bgAudio.volume = lastNonZeroVolume;
        volumeFill.style.width = (lastNonZeroVolume * 100) + '%';
        updateVolumeIcon(lastNonZeroVolume);
      }
    });

    // 键盘快捷键: 空格播放/暂停
    document.addEventListener('keydown', function(e) {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        togglePlay();
      }
    });

    // 初始化
    loadTrack(0);
  })();

  // 对外暴露简单接口
  global.MusicPlayer = {
    togglePlay: function() {
      const bgAudio = document.getElementById('bgAudio');
      if (!bgAudio) return;
      if (bgAudio.paused) {
        bgAudio.play().catch(function() {});
      } else {
        bgAudio.pause();
      }
    }
  };
})(window);
