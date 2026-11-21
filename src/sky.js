/* =========================================================================
   sky.js — 深空背景：程序化星云 + 恒星场 + 环境反射贴图
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  const NEB_W = 2048;
  const NEB_H = 1024;

  /* ---------------------------------------------------------------
     星云着色器（等距柱状投影 -> 天空球）

     之前"违和"的五个原因，这版逐一修掉：
     1. 颜色过于饱和（紫红青三色并置）—— 真实星云是低饱和的，以蓝灰/紫灰为底，
        只有氢发射区才偏红，且是"局部点缀"而非整体染色
     2. 星云铺满整个天空 —— 真实天球上大部分区域是接近纯黑的，
        星云应该只占少数区域，留大片空白
     3. 缺少尺度层次 —— 远、中、近三层气体要有不同的模糊度与对比度
     4. 银河带边界太软、像一团雾 —— 应该更薄更集中，内部有暗尘埃带切分
     5. 核心过曝成一团白 —— 应该是柔和的、有颜色的辉光
     --------------------------------------------------------------- */
  const nebulaFragment = /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform float uSeed;

    ${SAT.GLSL.hash}
    ${SAT.GLSL.noise3}

    vec3 dirFromUv(vec2 uv){
      float lon = uv.x * 6.28318530718 - 3.14159265359;
      float lat = (0.5 - uv.y) * 3.14159265359;
      float cl = cos(lat);
      return vec3(cl * cos(lon), sin(lat), cl * sin(lon));
    }

    // 沿某个大圆聚集（银河带 / 星云带）
    float planeFalloff(vec3 d, vec3 n, float w){
      float t = dot(d, n) / w;
      return exp(-t * t);
    }

    void main(){
      vec3 d = normalize(dirFromUv(vUv));
      vec3 p = d * 2.0 + uSeed;

      /* ---------- 银河带：薄而集中，被暗尘埃切分 ---------- */
      vec3 galacticN = normalize(vec3(0.42, 0.62, -0.66));
      float gLat = abs(dot(d, galacticN));

      // 三层不同宽度：核心薄带 + 外层弥散
      float galCore = planeFalloff(d, galacticN, 0.075);
      float galMid  = planeFalloff(d, galacticN, 0.16);
      float galWide = planeFalloff(d, galacticN, 0.34);

      /* ---------- 气体密度：只在天球少数区域出现 ---------- */
      // 大尺度：决定"哪里有星云"，覆盖约 30% 天空
      float regionA = planeFalloff(d, normalize(vec3(0.36, 0.55, -0.75)), 0.30);
      float regionB = planeFalloff(d, normalize(vec3(-0.72, -0.38, 0.58)), 0.24);
      // 用一个低频噪声把区域边缘打碎，避免"圆形光斑"的机械感
      float regionBreak = fbm3(p * 1.1, 3) * 0.5 + 0.5;
      regionA *= smoothstep(0.30, 0.72, regionBreak);
      regionB *= smoothstep(0.34, 0.76, 1.0 - regionBreak);

      float region = max(regionA, regionB * 0.85);
      // 银河带内始终有淡淡的气体
      region = max(region, galMid * 0.55);

      /* ---------- 三层气体：远 / 中 / 近 ---------- */
      // 远处：低频、低对比、像薄纱
      float farLayer = fbm3(p * 1.6 + vec3(0.0, 0.0, 0.0), 3) * 0.5 + 0.5;

      // 中层：域扭曲，形成丝缕
      float q1 = fbm3(p * 1.4, 4);
      float q2 = fbm3(p * 2.1 + 3.1, 4);
      vec3 warp = vec3(q1, q2, fbm3(p * 1.7 - 5.7, 3));
      float midLayer = fbm3(p * 2.6 + warp * 1.5, 5) * 0.5 + 0.5;

      // 近处：脊状噪声，纤维状细丝，只在密集区可见
      float ridged = 1.0 - abs(fbm3(p * 4.2 + warp * 1.1, 4));
      ridged = pow(clamp(ridged, 0.0, 1.0), 5.0);

      float dens = 0.0;
      dens += pow(farLayer, 2.6) * 0.16;                    // 极淡的底
      dens += smoothstep(0.52, 0.90, midLayer) * 0.55;      // 主体
      dens += ridged * 0.34;                                 // 细丝
      dens *= region;
      dens += galCore * 0.30 * (0.5 + 0.5 * farLayer);       // 银河核心额外增亮

      /* ---------- 暗尘埃带：切分银河，制造纵深 ---------- */
      float dustN = fbm3(p * 3.0 + vec3(11.3, -4.1, 6.4), 5) * 0.5 + 0.5;
      // 尘埃沿银河带呈薄片状
      float dustBand = smoothstep(0.30, 0.85, dustN) * (0.35 + 0.65 * galMid);
      dens *= 1.0 - clamp(dustBand, 0.0, 1.0) * 0.88;

      dens = clamp(dens, 0.0, 1.8);

      /* ---------- 配色：低饱和，以蓝灰 / 紫灰为主 ---------- */
      // 真实星云很少是"糖果色"，多数是灰调的，亮部才微微带上颜色
      vec3 cDeep   = vec3(0.055, 0.065, 0.115);  // 暗处：冷灰蓝
      vec3 cBlue   = vec3(0.130, 0.165, 0.310);  // 主体：钢蓝
      vec3 cViolet = vec3(0.235, 0.175, 0.330);  // 局部：紫灰
      vec3 cTeal   = vec3(0.085, 0.210, 0.255);  // 电离区：青
      vec3 cRose   = vec3(0.360, 0.185, 0.215);  // 氢发射区：暗玫瑰（只少量）
      vec3 cWarm   = vec3(0.480, 0.310, 0.180);  // 核心暖光

      // 颜色由几个低频场决定，避免"三色块"拼贴感
      float cA = fbm3(p * 0.85 + vec3(21.0, 3.0, 9.0), 3) * 0.5 + 0.5;
      float cB = fbm3(p * 0.62 - vec3(7.0, 15.0, 2.0), 3) * 0.5 + 0.5;

      vec3 col = mix(cDeep, cBlue, smoothstep(0.25, 0.85, cA));
      col = mix(col, cViolet, smoothstep(0.55, 0.95, cB) * 0.65);
      col = mix(col, cTeal, smoothstep(0.62, 0.98, cA * cB * 1.8) * 0.45);
      // 玫瑰色只在最密的地方微量渗入
      col = mix(col, cRose, pow(clamp(dens, 0.0, 1.0), 2.2) * smoothstep(0.45, 0.95, cB) * 0.55);

      /* ---------- 合成 ---------- */
      vec3 sky = vec3(0.0016, 0.0022, 0.0044);              // 接近纯黑的深空底
      sky += vec3(0.0060, 0.0085, 0.0165) * galWide;        // 银河带弥散光（很淡）

      vec3 neb = col * pow(dens, 1.55) * 1.05;
      // 电离高光：只在脊状细丝最亮处，冷白偏蓝
      neb += vec3(0.42, 0.58, 0.85) * pow(ridged, 3.0) * region * 0.20;

      vec3 outc = sky + neb;

      /* ---------- 核心：柔和、有颜色的辉光，不过曝 ---------- */
      float core = planeFalloff(d, normalize(vec3(0.36, 0.55, -0.75)), 0.055);
      outc += cWarm * pow(core, 2.4) * 0.055;
      outc += vec3(0.30, 0.36, 0.62) * pow(core, 1.5) * 0.045;

      outc = max(outc, vec3(0.0));
      // 近似 sRGB 编码（便于 CPU 端合成恒星后整体上传）
      outc = pow(outc, vec3(0.4545));
      gl_FragColor = vec4(outc, 1.0);
    }
  `;

  const quadVert = /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;

  function renderNebula(renderer, seed) {
    const target = new THREE.WebGLRenderTarget(NEB_W, NEB_H, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: nebulaFragment,
      uniforms: { uSeed: { value: seed === undefined ? 3.7 : seed } },
      depthTest: false,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);

    const buf = new Uint8Array(NEB_W * NEB_H * 4);
    renderer.readRenderTargetPixels(target, 0, 0, NEB_W, NEB_H, buf);

    mat.dispose();
    scene.children[0].geometry.dispose();
    target.dispose();

    return buf;
  }

  /* ---------------------------------------------------------------
     恒星层：按亮度分布绘制，含银河带聚集与色温差异
     --------------------------------------------------------------- */
  /* ---------------------------------------------------------------
     恒星层

     原先违和的另两个原因：
     6. 所有恒星一样大一样亮 —— 真实星空是强烈的幂律分布，
        肉眼可见的亮星极少，绝大多数是"几乎看不见"的暗点
     7. 色温分配太随机 —— 真实恒星大部分是偏白/淡黄，蓝白与橙红是少数
     另外：暗星一旦被泛光处理，会糊成一片底噪。所以暗星要么足够小，
     要么干脆不画，让深空保持"黑"。
     --------------------------------------------------------------- */
  const STAR_PALETTE = [
    [0.66, 0.76, 1.00], // O/B 蓝白（约 4%）
    [0.80, 0.87, 1.00], // A 白（约 12%）
    [1.00, 0.99, 0.96], // F 近白（约 20%）
    [1.00, 0.97, 0.86], // G 淡黄（约 28%）
    [1.00, 0.88, 0.68], // K 橙黄（约 24%）
    [1.00, 0.74, 0.52], // M 橙红（约 12%）
  ];
  // 累积分布：让色温按真实比例出现，而不是均匀随机
  const STAR_CDF = [0.04, 0.16, 0.36, 0.64, 0.88, 1.0];

  function pickStarColor(r) {
    for (let i = 0; i < STAR_CDF.length; i++) {
      if (r <= STAR_CDF[i]) return STAR_PALETTE[i];
    }
    return STAR_PALETTE[STAR_PALETTE.length - 1];
  }

  function unitVector(rng) {
    const u = rng.f() * 2 - 1;
    const th = rng.f() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    return [s * Math.cos(th), u, s * Math.sin(th)];
  }

  function drawStars(ctx, W, H, seed) {
    const rng = SAT.rng(seed === undefined ? 2024 : Math.floor(seed * 977) + 2024);
    const bandN = [0.36, 0.55, -0.75];
    const bl = Math.hypot(bandN[0], bandN[1], bandN[2]);
    bandN[0] /= bl; bandN[1] /= bl; bandN[2] /= bl;

    const bright = [];
    ctx.globalCompositeOperation = 'lighter';

    const stars = 22000;
    for (let i = 0; i < stars; i++) {
      let d = unitVector(rng);

      // 银河带内加密
      const isBand = rng.f() < 0.62;
      if (isBand) {
        const dot = Math.abs(d[0] * bandN[0] + d[1] * bandN[1] + d[2] * bandN[2]);
        if (dot > Math.abs(rng.gauss(0, 0.19)) + 0.045) {
          d = unitVector(rng);
        }
      }

      const lon = Math.atan2(d[2], d[0]);
      const lat = Math.asin(SAT.clamp(d[1], -1, 1));
      const u = (lon + Math.PI) / (Math.PI * 2);
      const v = 0.5 - lat / Math.PI;
      const x = u * W;
      const y = v * H;

      // 亮度幂律：真实星空是极端的幂律分布。
      // 指数 8 意味着绝大多数恒星都在最暗的一档，亮星只是极少数。
      const mag = Math.pow(rng.f(), 8.0);

      const pal = pickStarColor(rng.f());

      // 亮星交给点精灵渲染，保持锐利（烘焙纹理会被 mipmap 和泛光糊成散景）
      if (mag > 0.20) {
        bright.push({ d, pal, mag: (mag - 0.20) / 0.80 });
        continue;
      }

      // 暗星：很小、很暗。不要给它们画光晕，否则整片天会发灰。
      // 过暗的直接跳过，让深空真正黑下去。
      const size = 0.45 + mag * 1.4;
      const alpha = 0.06 + mag * 0.55;
      if (alpha < 0.075) continue;

      ctx.fillStyle = `rgba(${(pal[0] * 255) | 0},${(pal[1] * 255) | 0},${(pal[2] * 255) | 0},${alpha.toFixed(3)})`;
      ctx.fillRect(x, y, size, size);
    }
    ctx.globalCompositeOperation = 'source-over';
    return bright;
  }

  /* ---------------------------------------------------------------
     亮星层：屏幕空间恒定大小的点精灵，清晰可辨、带轻微闪烁
     --------------------------------------------------------------- */
  function buildStarPoints(brightStars) {
    const n = brightStars.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    const pha = new Float32Array(n);
    const rng = SAT.rng(777);

    brightStars.forEach((s, i) => {
      pos[i * 3] = s.d[0];
      pos[i * 3 + 1] = s.d[1];
      pos[i * 3 + 2] = s.d[2];
      // 亮度压缩，避免一片死白；越亮的星尺寸增长更明显（真实观感）
      const b = Math.pow(s.mag, 0.75);
      col[i * 3] = s.pal[0] * (0.50 + 0.62 * b);
      col[i * 3 + 1] = s.pal[1] * (0.50 + 0.62 * b);
      col[i * 3 + 2] = s.pal[2] * (0.50 + 0.62 * b);
      // 尺寸差异拉开：暗的 1.2px，最亮的 5px
      siz[i] = 1.2 + Math.pow(b, 1.8) * 3.8;
      pha[i] = rng.f() * 6.283;
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(pha, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uPixel: { value: Math.min(window.devicePixelRatio, 2) },
        uTime: { value: 0 },
        uRadius: { value: 120000 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aPhase;
        uniform float uPixel;
        uniform float uTime;
        uniform float uRadius;
        varying vec3 vColor;
        varying float vTwinkle;
        void main(){
          vec4 mv = viewMatrix * vec4(position * uRadius, 1.0);
          gl_Position = projectionMatrix * mv;
          vColor = aColor;
          vTwinkle = 0.82 + 0.18 * sin(uTime * 1.3 + aPhase) * sin(uTime * 0.37 + aPhase * 2.1);
          gl_PointSize = aSize * uPixel;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vTwinkle;
        void main(){
          vec2 p = gl_PointCoord - 0.5;
          float r = length(p) * 2.0;
          if (r > 1.0) discard;
          // 中心锐利 + 外围柔光
          float core = smoothstep(0.62, 0.0, r);
          float halo = smoothstep(1.0, 0.0, r);
          float a = (core * 1.0 + halo * 0.22) * vTwinkle;
          gl_FragColor = vec4(vColor * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = -900;
    points.name = 'brightStars';
    return points;
  }

  /* --------------------------------------------------------------- */
  function build(renderer, seed) {
    const s0 = seed === undefined ? 3.7 : seed;
    // 1) GPU 生成星云 → 读回字节 → 合成恒星
    let pixels = null;
    try {
      pixels = renderNebula(renderer, s0);
    } catch (e) {
      SAT.fatal('星云烘焙失败，退回纯色深空：' + e.message);
    }

    const canvas = document.createElement('canvas');
    canvas.width = NEB_W;
    canvas.height = NEB_H;
    const ctx = canvas.getContext('2d');

    if (pixels) {
      const img = ctx.createImageData(NEB_W, NEB_H);
      const dst = img.data;
      // readPixels 是从底部开始的
      for (let y = 0; y < NEB_H; y++) {
        const src = (NEB_H - 1 - y) * NEB_W * 4;
        const out = y * NEB_W * 4;
        for (let x = 0; x < NEB_W * 4; x++) dst[out + x] = pixels[src + x];
      }
      ctx.putImageData(img, 0, 0);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, NEB_H);
      g.addColorStop(0, '#05070f');
      g.addColorStop(0.5, '#0a0f22');
      g.addColorStop(1, '#05070f');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, NEB_W, NEB_H);
    }

    const bright = drawStars(ctx, NEB_W, NEB_H, s0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    // 2) 环境反射（小行星表面会映出星云的颜色）
    let env = null;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      env = pmrem.fromEquirectangular(tex).texture;
      pmrem.dispose();
    } catch (e) {
      SAT.fatal('环境贴图生成失败：' + e.message);
    }

    // 3) 天空球（跟随相机，无位移视差）
    const skyMat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), skyMat);
    sky.renderOrder = -1000;
    sky.frustumCulled = false;

    // 4) 亮星点精灵
    const stars = buildStarPoints(bright);

    return { tex, env, sky, stars, canvas, seed: s0, renderer };
  }

  /**
   * 重新烘焙星空（跃迁时用）。
   * 换一个种子 = 换一套星云 = 换一个宇宙。
   * 只更新已有 mesh 的贴图和点云，不重建对象，避免掉帧。
   */
  function rebake(skyData, seed, renderer) {
    const rd = renderer || skyData.renderer;
    const fresh = build(rd, seed);

    // 换天空球贴图
    const oldTex = skyData.tex;
    skyData.sky.material.map = fresh.tex;
    skyData.sky.material.needsUpdate = true;
    skyData.tex = fresh.tex;
    if (oldTex && oldTex.dispose) oldTex.dispose();

    // 换亮星点云（直接替换几何 + 材质参数）
    const oldStars = skyData.stars;
    skyData.stars.geometry.dispose();
    skyData.stars.geometry = fresh.stars.geometry;
    skyData.stars.material.uniforms.uPixel.value =
      fresh.stars.material.uniforms.uPixel.value;
    fresh.stars.material.dispose();
    if (oldStars.material && oldStars.material !== skyData.stars.material) {
      // 保留 skyData.stars 的材质（uTime 仍在用），只换几何
    }

    // 环境反射也换掉（小行星会映出新星云的颜色）
    skyData.env = fresh.env;
    skyData.seed = seed;

    return skyData;
  }

  SAT.sky = { build, rebake };
})();
