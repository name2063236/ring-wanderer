/* =========================================================================
   util.js — 伪随机数 / 数学工具 / 共享 GLSL 片段
   ========================================================================= */
(function () {
  const SAT = (window.SAT = window.SAT || {});
  SAT.THREE = window.THREE;

  /* ---------- 确定性随机 ---------- */
  SAT.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  SAT.rng = function (seed) {
    const r = SAT.mulberry32(seed);
    return {
      f: r,
      range: (a, b) => a + (b - a) * r(),
      int: (a, b) => Math.floor(a + (b - a + 1) * r()),
      sign: () => (r() < 0.5 ? -1 : 1),
      // 近似正态（Irwin–Hall）
      gauss: (mu, sigma) => {
        const g = (r() + r() + r() + r() - 2) * 0.75;
        return mu + g * sigma;
      },
      pick: (arr) => arr[Math.floor(r() * arr.length)],
    };
  };

  SAT.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  SAT.lerp = (a, b, t) => a + (b - a) * t;
  SAT.smoothstep = (e0, e1, x) => {
    const t = SAT.clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  /** 与帧率无关的指数逼近 */
  SAT.damp = (a, b, lambda, dt) => b + (a - b) * Math.exp(-lambda * dt);

  /* ---------- 尺度常量 ---------- */
  // 1 世界单位 = 15 km，保持土星 / 星环之间真实的比例关系。
  // 调小换算比 = 整个土星系统在世界里更大（HUD 的 km 读数自动保持一致）。
  SAT.CONST = {
    KM_PER_UNIT: 15,
    SATURN_RADIUS_KM: 58232,
    get R() {
      return this.SATURN_RADIUS_KM / this.KM_PER_UNIT; // 3882 单位
    },
    // 环半径以土星赤道半径为单位（依据真实环系结构近似）
    RING: {
      dIn: 1.1, // D 环内缘
      cIn: 1.28, // C 环
      cB: 1.53,
      bC: 1.95, // B/Cassini 分界
      cassiniEnd: 2.027,
      aOut: 2.35, // A 环外缘
      encke0: 2.293,
      encke1: 2.303,
      keeler0: 2.328,
      keeler1: 2.333,
      f0: 2.4,
      f1: 2.404,
      out: 2.42,
    },
  };

  /* ---------- 共享 GLSL ---------- */
  const hash = `
    float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
    float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec3 hash33(vec3 p){
      p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
               dot(p, vec3(269.5, 183.3, 246.1)),
               dot(p, vec3(113.5, 271.9, 124.6)));
      return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
    }
  `;

  const noise3 = `
    float gnoise(vec3 p){
      vec3 i = floor(p); vec3 f = fract(p);
      vec3 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(dot(hash33(i + vec3(0,0,0)), f - vec3(0,0,0)),
                         dot(hash33(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                     mix(dot(hash33(i + vec3(0,1,0)), f - vec3(0,1,0)),
                         dot(hash33(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
                 mix(mix(dot(hash33(i + vec3(0,0,1)), f - vec3(0,0,1)),
                         dot(hash33(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                     mix(dot(hash33(i + vec3(0,1,1)), f - vec3(0,1,1)),
                         dot(hash33(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
    }
    float fbm3(vec3 p, int oct){
      float s = 0.0, a = 0.5, n = 0.0;
      for (int i = 0; i < 6; i++){
        if (i >= oct) break;
        s += a * gnoise(p);
        n += a;
        p = p * 2.03 + 11.7;
        a *= 0.5;
      }
      return s / max(n, 0.0001);
    }
  `;

  const band = `
    float bandMask(float x, float a, float b, float soft){
      return smoothstep(a - soft, a + soft, x) * (1.0 - smoothstep(b - soft, b + soft, x));
    }
  `;

  /** 环系覆盖度（以土星半径为单位）——行星阴影与星环着色共用 */
  const ringProfile = `
    float ringProfile(float rr){
      float d = 0.0;
      d = max(d, 0.030 * bandMask(rr, ${SAT.CONST.RING.dIn}, ${SAT.CONST.RING.cIn}, 0.010));  // D 环（极淡）
      d = max(d, 0.150 * bandMask(rr, ${SAT.CONST.RING.cIn}, ${SAT.CONST.RING.cB}, 0.006));   // C 环
      d = max(d, 0.980 * bandMask(rr, ${SAT.CONST.RING.cB}, ${SAT.CONST.RING.bC}, 0.007));    // B 环（最亮）
      d = max(d, 0.030 * bandMask(rr, ${SAT.CONST.RING.bC}, ${SAT.CONST.RING.cassiniEnd}, 0.004)); // 卡西尼缝
      d = max(d, 0.620 * bandMask(rr, ${SAT.CONST.RING.cassiniEnd}, ${SAT.CONST.RING.aOut}, 0.006)); // A 环
      d *= 1.0 - 0.96 * bandMask(rr, ${SAT.CONST.RING.encke0}, ${SAT.CONST.RING.encke1}, 0.0015);   // 恩克缝
      d *= 1.0 - 0.85 * bandMask(rr, ${SAT.CONST.RING.keeler0}, ${SAT.CONST.RING.keeler1}, 0.0012); // 基勒缝
      d = max(d, 0.560 * bandMask(rr, ${SAT.CONST.RING.f0}, ${SAT.CONST.RING.f1}, 0.0014));         // F 环
      return clamp(d, 0.0, 1.0);
    }
  `;

  SAT.GLSL = { hash, noise3, band, ringProfile };

  /* ---------- 简易屏幕日志（便于排错） ---------- */
  const origError = console.error.bind(console);

  SAT.fatal = function (msg) {
    origError(msg);
    let el = document.getElementById('errbox');
    if (!el) {
      el = document.createElement('div');
      el.id = 'errbox';
      el.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:99;max-height:40vh;overflow:auto;' +
        'padding:10px 14px;background:rgba(0,0,0,.92);color:#ff9a9a;font:11px/1.45 monospace;white-space:pre-wrap';
      document.body.appendChild(el);
    }
    el.textContent += msg + '\n\n';
  };

  // 把 console.error / 未捕获异常也记录进 #errbox，方便无头环境排错
  (function () {
    console.error = function (...args) {
      origError(...args);
      try {
        const text = args
          .map((a) => (a && a.message ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ');
        if (/THREE|WebGL|shader|Shader|GLSL|program/i.test(text)) SAT.fatal('[console] ' + text.slice(0, 6000));
      } catch (e) {
        /* ignore */
      }
    };
    window.addEventListener('error', (e) => {
      SAT.fatal('[error] ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
    });
  })();
})();
