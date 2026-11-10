/**
 * player.js - 独立音乐播放模块
 * 包含：
 * 1. 默认精选歌单与播放队列管理
 * 2. 播控状态机（竞态 token 防串歌 + 播放/暂停/切歌/循环模式/进度拖拽）
 * 3. 毫秒级歌词同步引擎
 */
(function (window) {
  'use strict';

  const DEFAULT_PLAYLIST = [
    {
      platform: 'tx',
      id: '0039MnYb0qxYhV',
      songmid: '0039MnYb0qxYhV',
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      duration: 269,
      score: 100.0,
    },
    {
      platform: 'kw',
      id: '5886682',
      songmid: '5886682',
      title: '海阔天空',
      artist: 'Beyond',
      album: '乐与怒',
      duration: 326,
      score: 100.0,
    },
    {
      platform: 'wy',
      id: '347230',
      songmid: '347230',
      title: '海阔天空',
      artist: 'Beyond',
      album: '乐与怒',
      duration: 326,
      score: 100.0,
    },
    {
      platform: 'kw',
      id: '5046200',
      songmid: '5046200',
      title: '平凡之路',
      artist: '朴树',
      album: '猎户星座',
      duration: 301,
      score: 95.0,
    },
    {
      platform: 'kw',
      id: '255280',
      songmid: '255280',
      title: '十年',
      artist: '陈奕迅',
      album: '黑·白·灰',
      duration: 205,
      score: 95.0,
    },
  ];

  function formatTime(sec) {
    if (!sec || isNaN(sec)) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }

  class MusicPlayer {
    constructor() {
      this.audio = new Audio();
      this.audio.preload = 'auto';

      this.playlist = [...DEFAULT_PLAYLIST];
      this.currentIndex = -1;
      this.isDefaultList = true;
      this.playMode = 'loop'; // 'loop' | 'single' | 'shuffle'

      this.isResolving = false;
      this.isPlaying = false;
      this._playToken = 0;
      this._abortCtrl = null;

      this.lyrics = [];
      this.currentLyricIdx = -1;

      this.listeners = {
        trackChange: [],
        stateChange: [],
        timeUpdate: [],
        lyricUpdate: [],
        playlistChange: [],
      };

      this._bindAudioEvents();
    }

    _bindAudioEvents() {
      this.audio.addEventListener('play', () => {
        this.isPlaying = true;
        this._emit('stateChange', { isPlaying: true, isResolving: this.isResolving });
      });

      this.audio.addEventListener('pause', () => {
        this.isPlaying = false;
        this._emit('stateChange', { isPlaying: false, isResolving: this.isResolving });
      });

      this.audio.addEventListener('timeupdate', () => {
        const cur = this.audio.currentTime || 0;
        const dur = this.audio.duration || 0;
        const pct = dur > 0 ? (cur / dur) * 100 : 0;
        this._emit('timeUpdate', {
          currentTime: cur,
          duration: dur,
          percent: pct,
          formattedCurrent: formatTime(cur),
          formattedDuration: formatTime(dur),
        });
        this._syncLyrics(cur);
      });

      this.audio.addEventListener('ended', () => {
        this._handleTrackEnded();
      });

      this.audio.addEventListener('error', () => {
        this.isPlaying = false;
        this._emit('stateChange', {
          isPlaying: false,
          isResolving: false,
          error: '音频流加载失败（可能受防盗链或网络波动影响）',
        });
      });
    }

    _handleTrackEnded() {
      if (this.playMode === 'single') {
        this.audio.currentTime = 0;
        this.audio.play().catch(() => {});
      } else {
        this.next();
      }
    }

    _syncLyrics(currentTime) {
      if (!this.lyrics || this.lyrics.length === 0) return;

      let idx = -1;
      for (let i = 0; i < this.lyrics.length; i++) {
        if (currentTime >= this.lyrics[i].time) {
          idx = i;
        } else {
          break;
        }
      }

      if (idx !== this.currentLyricIdx) {
        this.currentLyricIdx = idx;
        const currentLine = idx >= 0 ? this.lyrics[idx].text : '';
        const nextLine = idx + 1 < this.lyrics.length ? this.lyrics[idx + 1].text : '';
        this._emit('lyricUpdate', {
          index: idx,
          currentLine,
          nextLine,
          allLines: this.lyrics,
        });
      }
    }

    async fetchLyrics(song, token) {
      this.lyrics = [];
      this.currentLyricIdx = -1;
      this._emit('lyricUpdate', {
        index: -1,
        currentLine: '正在匹配歌词...',
        nextLine: '',
        allLines: [],
      });

      try {
        const plat = encodeURIComponent(song.platform || 'kw');
        const sid = encodeURIComponent(song.id || '');
        const title = encodeURIComponent(song.title || '');
        const artist = encodeURIComponent(song.artist || '');
        const res = await fetch(
          `/api/lyric?platform=${plat}&id=${sid}&title=${title}&artist=${artist}`
        );
        const lines = await res.json();
        if (token !== this._playToken) return;
        this.lyrics = Array.isArray(lines) ? lines : [];
        if (this.lyrics.length === 0) {
          this._emit('lyricUpdate', {
            index: -1,
            currentLine: '纯音乐或暂无歌词',
            nextLine: '',
            allLines: [],
          });
        } else {
          this._syncLyrics(this.audio.currentTime || 0);
        }
      } catch {
        if (token !== this._playToken) return;
        this.lyrics = [];
        this._emit('lyricUpdate', {
          index: -1,
          currentLine: '暂无歌词',
          nextLine: '',
          allLines: [],
        });
      }
    }

    async playIndex(idx) {
      if (idx < 0 || idx >= this.playlist.length) return;

      if (this._abortCtrl) {
        this._abortCtrl.abort();
      }
      this._abortCtrl = new AbortController();
      const token = ++this._playToken;

      this.currentIndex = idx;
      const song = this.playlist[idx];
      this.isResolving = true;

      this._emit('trackChange', { index: idx, song });
      this._emit('stateChange', { isPlaying: false, isResolving: true, song });

      this.fetchLyrics(song, token);

      try {
        const t0 = performance.now();
        const res = await fetch('/api/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(song),
          signal: this._abortCtrl.signal,
        });
        const data = await res.json();
        if (token !== this._playToken) return;

        const cost = (performance.now() - t0).toFixed(0);
        this.isResolving = false;

        if (data.success && data.url) {
          this.audio.src = data.url;
          this.audio.play().catch((e) => console.warn('自动出声受阻:', e));
          this._emit('stateChange', {
            isPlaying: true,
            isResolving: false,
            song,
            sourceName: data.source_name,
            resolvedPlatform: data.platform,
            strategy: data.strategy,
            fallbackFrom: data.fallback_from,
            costMs: cost,
            bytes: data.bytes || 0,
          });
        } else {
          this._emit('stateChange', {
            isPlaying: false,
            isResolving: false,
            song,
            error: data.error || '所有音源通道均未通过校验',
          });
        }
      } catch (err) {
        if (err?.name === 'AbortError' || token !== this._playToken) return;
        this.isResolving = false;
        this._emit('stateChange', {
          isPlaying: false,
          isResolving: false,
          song,
          error: '网络错误: ' + err.message,
        });
      }
    }

    togglePlay() {
      if (!this.audio.src) {
        if (this.playlist.length > 0) {
          this.playIndex(this.currentIndex >= 0 ? this.currentIndex : 0);
        }
        return;
      }
      if (this.audio.paused) {
        this.audio.play().catch(() => {});
      } else {
        this.audio.pause();
      }
    }

    next() {
      if (this.playlist.length === 0) return;
      if (this.playMode === 'shuffle') {
        const nextIdx = Math.floor(Math.random() * this.playlist.length);
        this.playIndex(nextIdx);
      } else {
        const nextIdx = (this.currentIndex + 1) % this.playlist.length;
        this.playIndex(nextIdx);
      }
    }

    prev() {
      if (this.playlist.length === 0) return;
      let prevIdx = this.currentIndex - 1;
      if (prevIdx < 0) prevIdx = this.playlist.length - 1;
      this.playIndex(prevIdx);
    }

    seek(percent) {
      if (!this.audio.duration) return;
      const pct = Math.max(0, Math.min(1, percent));
      this.audio.currentTime = pct * this.audio.duration;
    }

    cycleMode() {
      if (this.playMode === 'loop') this.playMode = 'single';
      else if (this.playMode === 'single') this.playMode = 'shuffle';
      else this.playMode = 'loop';
      return this.playMode;
    }

    getModeLabel() {
      if (this.playMode === 'loop') return { mode: 'loop', icon: '🔁', label: '列表循环' };
      if (this.playMode === 'single') return { mode: 'single', icon: '🔂', label: '单曲循环' };
      return { mode: 'shuffle', icon: '🔀', label: '随机播放' };
    }

    setPlaylist(newList, autoPlayIndex = -1) {
      if (!Array.isArray(newList)) return;
      this.playlist = [...newList];
      this.currentIndex = -1;
      this.isDefaultList = false;
      this._emit('playlistChange', { playlist: this.playlist, isDefault: false });
      if (autoPlayIndex >= 0 && autoPlayIndex < this.playlist.length) {
        this.playIndex(autoPlayIndex);
      }
    }

    loadDefaultPlaylist() {
      this.playlist = [...DEFAULT_PLAYLIST];
      this.isDefaultList = true;
      this.currentIndex = -1;
      this._emit('playlistChange', { playlist: this.playlist, isDefault: true });
    }

    on(event, callback) {
      if (this.listeners[event]) {
        this.listeners[event].push(callback);
      }
    }

    _emit(event, data) {
      if (this.listeners[event]) {
        this.listeners[event].forEach((cb) => {
          try {
            cb(data);
          } catch (e) {
            console.error(e);
          }
        });
      }
    }
  }

  window.MusicPlayer = MusicPlayer;
})(window);
