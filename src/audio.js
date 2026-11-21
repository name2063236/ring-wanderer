/* =========================================================================
   audio.js — 程序化环境音（WebAudio，零素材）
   · 低频 drone 打底（两个略微失谐的振荡器 + 缓慢 LFO）
   · 引擎嗡鸣随速度变调
   · 加速时叠加一层呼啸噪声
   · 撞击闷响、信标采样提示音
   全部由振荡器 / 噪声缓冲现场合成，不加载任何音频文件。
   ========================================================================= */
(function () {
  const SAT = window.SAT;

  function create() {
    let ctx = null;
    let started = false;
    let enabled = true;
    let master = null;

    // 节点
    let droneGain = null;
    let engineGain = null;
    let engineFilter = null;
    let boostGain = null;
    let noiseSrc = null;

    const state = {
      speed: 0,
      boosting: false,
      intensity: 0,
    };

    /** 惰性初始化：必须等一次用户手势，否则浏览器会拒绝启动 AudioContext */
    function init() {
      if (ctx) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;

      try {
        ctx = new AC();
      } catch (e) {
        return false;
      }

      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);

      /* ---- 1. 低频 drone：两个略微失谐的正弦，营造深空的压力感 ---- */
      droneGain = ctx.createGain();
      droneGain.gain.value = 0.16;
      droneGain.connect(master);

      const d1 = ctx.createOscillator();
      d1.type = 'sine';
      d1.frequency.value = 42;

      const d2 = ctx.createOscillator();
      d2.type = 'sine';
      d2.frequency.value = 42.7; // 与 d1 相差 0.7Hz -> 极慢的拍频，像呼吸

      const d3 = ctx.createOscillator();
      d3.type = 'triangle';
      d3.frequency.value = 84.2;

      const d3g = ctx.createGain();
      d3g.gain.value = 0.22;

      d1.connect(droneGain);
      d2.connect(droneGain);
      d3.connect(d3g).connect(droneGain);

      // 缓慢的音量起伏
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.06;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.06;
      lfo.connect(lfoGain).connect(droneGain.gain);

      d1.start();
      d2.start();
      d3.start();
      lfo.start();

      /* ---- 2. 引擎：白噪声经低通滤波，随速度改变截止频率与音量 ---- */
      const bufLen = Math.floor(ctx.sampleRate * 2);
      const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

      noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuf;
      noiseSrc.loop = true;

      engineFilter = ctx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 220;
      engineFilter.Q.value = 0.7;

      engineGain = ctx.createGain();
      engineGain.gain.value = 0;

      noiseSrc.connect(engineFilter).connect(engineGain).connect(master);
      noiseSrc.start();

      /* ---- 3. 加速呼啸：高通噪声，只在加速时抬高 ---- */
      const boostSrc = ctx.createBufferSource();
      boostSrc.buffer = noiseBuf;
      boostSrc.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1400;
      bp.Q.value = 1.2;

      boostGain = ctx.createGain();
      boostGain.gain.value = 0;

      boostSrc.connect(bp).connect(boostGain).connect(master);
      boostSrc.start();

      started = true;
      master.gain.linearRampToValueAtTime(enabled ? 0.5 : 0, ctx.currentTime + 1.2);
      return true;
    }

    function resume() {
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }

    /* ---------------- 每帧参数更新 ---------------- */
    function update(dt, speed, boosting) {
      if (!ctx || !started) return;

      // 平滑过渡
      state.speed = SAT.damp(state.speed, speed, 3, dt);
      state.boosting = boosting;

      // 速度归一化（0~1，以巡航速度为上限）
      const sp = SAT.clamp(state.speed / 900, 0, 1);
      state.intensity = sp;

      const t = ctx.currentTime;
      const targetEngine = enabled ? 0.012 + sp * 0.075 : 0;
      engineGain.gain.setTargetAtTime(targetEngine, t, 0.15);
      engineFilter.frequency.setTargetAtTime(180 + sp * 1500, t, 0.2);

      const targetBoost = enabled && boosting ? 0.055 : 0;
      boostGain.gain.setTargetAtTime(targetBoost, t, 0.25);
    }

    /* ---------------- 一次性音效 ---------------- */
    function blip(freq, dur, type, vol) {
      if (!ctx || !started || !enabled) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 1.9, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol || 0.12, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur + 0.02);
    }

    /** 撞击：低频闷响 + 短促噪声 */
    function impact(strength) {
      if (!ctx || !started || !enabled) return;
      const t = ctx.currentTime;
      const k = SAT.clamp(strength || 1, 0.15, 1.4);

      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120 * k, t);
      o.frequency.exponentialRampToValueAtTime(28, t + 0.5);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.28 * k, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);

      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.7);

      // 噪声层
      const n = ctx.createBufferSource();
      const len = Math.floor(ctx.sampleRate * 0.2);
      const b = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      n.buffer = b;
      const nf = ctx.createBiquadFilter();
      nf.type = 'lowpass';
      nf.frequency.value = 900;
      const ng = ctx.createGain();
      ng.gain.value = 0.3 * k;
      n.connect(nf).connect(ng).connect(master);
      n.start(t);
    }

    /** 信标采样：清脆上行音 */
    function collect() {
      blip(660, 0.16, 'sine', 0.14);
      setTimeout(() => blip(990, 0.22, 'sine', 0.10), 70);
    }

    /** 区域完成 */
    function fanfare() {
      blip(523, 0.2, 'triangle', 0.13);
      setTimeout(() => blip(659, 0.2, 'triangle', 0.13), 110);
      setTimeout(() => blip(784, 0.34, 'triangle', 0.15), 220);
    }

    /** 跃迁：低频上扫 + 一记冲击 */
    function warp() {
      if (!ctx || !started || !enabled) return;
      const t = ctx.currentTime;

      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(60, t);
      o.frequency.exponentialRampToValueAtTime(1800, t + 1.0);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.10, t + 0.85);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);

      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(400, t);
      f.frequency.exponentialRampToValueAtTime(6000, t + 1.0);

      o.connect(f).connect(g).connect(master);
      o.start(t);
      o.stop(t + 1.3);

      setTimeout(() => {
        if (!ctx) return;
        const now = ctx.currentTime;
        const b = ctx.createOscillator();
        b.type = 'sine';
        b.frequency.setValueAtTime(90, now);
        b.frequency.exponentialRampToValueAtTime(24, now + 0.7);
        const bg = ctx.createGain();
        bg.gain.setValueAtTime(0.30, now);
        bg.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
        b.connect(bg).connect(master);
        b.start();
        b.stop(now + 0.9);
      }, 850);
    }

    /* ---------------- 开关 ---------------- */
    function setEnabled(on) {
      enabled = !!on;
      if (ctx && master) {
        master.gain.setTargetAtTime(enabled ? 0.5 : 0, ctx.currentTime, 0.1);
      }
      return enabled;
    }

    return {
      init,
      resume,
      update,
      impact,
      collect,
      fanfare,
      warp,
      setEnabled,
      get enabled() {
        return enabled;
      },
      get ready() {
        return !!ctx && started;
      },
      get state() {
        return state;
      },
    };
  }

  SAT.audio = { create };
})();
