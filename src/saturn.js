/* =========================================================================
   saturn.js — 土星本体 / 冰质星环 / 环带小行星
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;
  const R = SAT.CONST.R;
  const RI = SAT.CONST.RING;

  // 由 main.js 在启动时原地 copy 覆盖（所有材质共享同一个 Vector3 实例）
  const SUN = new THREE.Vector3(0.62, 0.30, 0.72).normalize();
  const SUN_COLOR = new THREE.Color(1.0, 0.95, 0.86);
  // 星环平面法线（世界空间，由 update 根据土星系统的倾斜更新）
  const RING_NORMAL = new THREE.Vector3(0, 1, 0);

  /* ===================== 土星本体 ===================== */
  /* 质感目标：真实的土星不是「斑马条纹」，而是低对比、边界柔和的奶油色带，
     有明显的纬向剪切、极区冷色，以及微妙的涡旋。
     做法：用「纬向坐标 + 域扭曲」生成连续色带场，再用低频噪声打破规则性。 */
  const planetVert = /* glsl */ `
    varying vec3 vObj;
    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    void main(){
      vObj = normalize(position);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const planetFrag = /* glsl */ `
    precision highp float;

    varying vec3 vObj;
    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;

    uniform vec3  uLightDir;
    uniform vec3  uSunColor;
    uniform vec3  uRingNormal;
    uniform float uPlanetRadius;
    uniform float uTime;

    ${SAT.GLSL.hash}
    ${SAT.GLSL.noise3}
    ${SAT.GLSL.band}
    ${SAT.GLSL.ringProfile}

    // 不同纬度流速不同 -> 产生剪切感
    vec3 zonalWarp(vec3 n, float speed, float scale){
      float a = atan(n.z, n.x);
      float warp = a - speed * 0.9;
      return vec3(cos(warp) * scale, n.y * scale, sin(warp) * scale);
    }

    // 从 p 沿 L 打到星环平面上的落点，求该处星环投下的阴影
    float ringShadow(vec3 p, vec3 L){
      float dn = dot(uRingNormal, L);
      if (abs(dn) < 1e-5) return 1.0;
      float t = -dot(uRingNormal, p) / dn;
      if (t <= 0.0) return 1.0;
      vec3 x = p + L * t;
      float rr = length(x) / uPlanetRadius;
      float d = ringProfile(rr);
      float pen = smoothstep(0.0, uPlanetRadius * 0.16, t);
      return 1.0 - 0.68 * d * mix(0.5, 1.0, pen);
    }

    void main(){
      vec3 n = normalize(vObj);
      vec3 N = normalize(vWorldNormal);
      vec3 L = normalize(uLightDir);
      vec3 V = normalize(cameraPosition - vWorldPos);

      float lat = clamp(n.y, -1.0, 1.0);
      float alat = abs(lat);

      /* ---- 1. 连续色带场（不是离散条纹）---- */
      float wA = fbm3(zonalWarp(n, 0.6, 2.6), 3);
      float wB = fbm3(zonalWarp(n, -1.1, 5.2), 3);
      float wC = fbm3(zonalWarp(n, 2.0, 9.0), 2);

      float bandField =
            sin(lat * 9.5 + wA * 2.6) * 0.34
          + sin(lat * 19.0 + wA * 2.0 + wB * 1.4) * 0.30
          + sin(lat * 38.0 + wB * 1.8) * 0.22
          + sin(lat * 77.0 + wC * 1.2) * 0.14;
      bandField = bandField * 0.5 + 0.5;

      // 只在赤道附近有强对比，越靠近极区越平缓
      float beltContrast = mix(0.34, 1.0, smoothstep(0.92, 0.25, alat))
                         * (0.72 + 0.28 * smoothstep(0.02, 0.26, alat));
      bandField = mix(0.55, bandField, beltContrast);

      /* ---- 2. 配色：低饱和奶油 / 蜂蜜 / 淡棕 ---- */
      vec3 cShadow  = vec3(0.50, 0.40, 0.27);
      vec3 cBase    = vec3(0.79, 0.68, 0.50);
      vec3 cLight   = vec3(0.98, 0.92, 0.77);
      vec3 cPolar   = vec3(0.60, 0.63, 0.63);
      vec3 cEquator = vec3(0.95, 0.88, 0.71);

      vec3 base = mix(cShadow, cBase, smoothstep(0.04, 0.60, bandField));
      base = mix(base, cLight, smoothstep(0.56, 0.94, bandField) * 0.95);

      // 细带：幅度极小，只提供呼吸感，不制造斑马纹
      float fine = fbm3(zonalWarp(n, 0.4, 30.0), 3) * 0.5 + 0.5;
      base *= 1.0 + (fine - 0.5) * 0.055;

      // 赤道稍暖稍亮
      base = mix(base, cEquator, exp(-pow(lat * 7.0, 2.0)) * 0.30);

      // 极区冷色
      float polar = smoothstep(0.74, 0.995, alat);
      base = mix(base, cPolar, polar * 0.28);

      // 极区六边形风暴（北极）
      float hexPolar = smoothstep(0.94, 0.999, lat);
      float hexA = atan(n.z, n.x);
      base = mix(base, vec3(0.52, 0.56, 0.58), hexPolar * (0.28 + 0.14 * sin(hexA * 6.0 + wA * 2.0)));

      /* ---- 3. 微妙的涡旋与湍流斑块 ---- */
      float swirl = fbm3(zonalWarp(n, 1.6, 17.0) + vec3(wA, wB, 0.0) * 1.2, 4);
      base *= 1.0 + swirl * 0.045;

      // 偶发的亮涡（白色椭圆风暴）
      float vort = fbm3(zonalWarp(n, -2.2, 26.0), 3);
      float spot = smoothstep(0.60, 0.82, vort) * smoothstep(0.72, 0.28, alat) * 0.30;
      base = mix(base, cLight * 1.03, spot);

      /* ---- 4. 极轻微的起伏 ----
         气态行星没有地形，法线扰动必须很弱，否则会在条带边缘画出假暗线 */
      vec3 t1 = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
      vec3 t2 = cross(N, t1);
      float hgt  = fbm3(n * 3.0 + vec3(wA, 0.0, wB), 3);
      float hgt1 = fbm3(normalize(n + t1 * 0.02) * 3.0 + vec3(wA, 0.0, wB), 3);
      float hgt2 = fbm3(normalize(n + t2 * 0.02) * 3.0 + vec3(wA, 0.0, wB), 3);
      vec3 Nb = normalize(N + (t1 * (hgt1 - hgt) + t2 * (hgt2 - hgt)) * 0.55);

      /* ---- 5. 光照 ---- */
      float ndl = dot(Nb, L);
      float day = smoothstep(-0.14, 0.40, ndl);
      float diff = pow(max(ndl, 0.0), 0.85);

      float rs = ringShadow(vWorldPos, L);

      float softDiff = mix(diff, smoothstep(-0.1, 0.9, ndl), 0.55);
      float limb = mix(1.0, 0.88, pow(clamp(dot(V, N), 0.0, 1.0), 0.55));
      vec3 col = base * uSunColor * softDiff * 1.24 * limb * mix(0.26, 1.0, day) * rs;

      col += base * uSunColor * pow(clamp(ndl * 0.5 + 0.5, 0.0, 1.0), 3.0) * 0.05;

      /* ---- 6. 夜面与大气散射 ---- */
      vec3 night = base * vec3(0.040, 0.052, 0.094);
      night += base * vec3(0.055, 0.046, 0.030) * smoothstep(0.15, 0.95, alat) * 0.5;
      col += night * (1.0 - day);

      float ndv = clamp(dot(V, N), 0.0, 1.0);
      float rim = pow(1.0 - ndv, 3.4);
      col += vec3(1.00, 0.92, 0.72) * rim * day * 0.36;
      col += vec3(0.24, 0.40, 0.86) * pow(1.0 - ndv, 5.0) * (1.0 - day) * 0.34;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ===================== 星环 ===================== */
  /* 离线烘焙 1D 环结构：R = 径向密度，G = 亮度扰动，B = 色温偏移。
     频率够高才会在近景出现真正的环缝，远处由 mipmap 平均掉。 */
  function bakeRingTexture() {
    const W = 4096;
    const H = 4;
    const lo = RI.dIn;
    const hi = RI.out;
    const data = new Uint8Array(W * H * 4);

    const valueNoise = (seed) => {
      const rng = SAT.rng(seed);
      const N = 512;
      const tbl = new Float32Array(N);
      for (let i = 0; i < N; i++) tbl[i] = rng.f();
      return (x) => {
        const xi = Math.floor(x);
        const f = x - xi;
        const a = tbl[((xi % N) + N) % N];
        const b = tbl[(((xi + 1) % N) + N) % N];
        const t = f * f * (3 - 2 * f);
        return a + (b - a) * t;
      };
    };

    const n1 = valueNoise(11);
    const n2 = valueNoise(23);
    const n3 = valueNoise(37);
    const n4 = valueNoise(53);
    const n5 = valueNoise(71);

    const fbm1 = (n, x, oct) => {
      let s = 0, amp = 0.5, norm = 0, f = 1;
      for (let i = 0; i < oct; i++) {
        s += amp * n(x * f);
        norm += amp;
        amp *= 0.5;
        f *= 2.07;
      }
      return s / norm;
    };

    const band = (x, a, b, soft) =>
      SAT.smoothstep(a - soft, a + soft, x) * (1 - SAT.smoothstep(b - soft, b + soft, x));

    const profile = (rr) => {
      let d = 0;
      d = Math.max(d, 0.03 * band(rr, RI.dIn, RI.cIn, 0.01));
      d = Math.max(d, 0.15 * band(rr, RI.cIn, RI.cB, 0.006));
      d = Math.max(d, 0.98 * band(rr, RI.cB, RI.bC, 0.007));
      d = Math.max(d, 0.03 * band(rr, RI.bC, RI.cassiniEnd, 0.004));
      d = Math.max(d, 0.62 * band(rr, RI.cassiniEnd, RI.aOut, 0.006));
      d *= 1 - 0.96 * band(rr, RI.encke0, RI.encke1, 0.0015);
      d *= 1 - 0.85 * band(rr, RI.keeler0, RI.keeler1, 0.0012);
      d = Math.max(d, 0.56 * band(rr, RI.f0, RI.f1, 0.0014));
      return SAT.clamp(d, 0, 1);
    };

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const rr = lo + (hi - lo) * (x / (W - 1));
        const t = (rr - lo) / (hi - lo);

        const g1 = fbm1(n1, t * 900, 3);
        const g2 = fbm1(n2, t * 2600, 3);
        const g3 = fbm1(n3, t * 7000, 2);
        const g4 = fbm1(n4, t * 19000, 2);
        const g5 = fbm1(n5, t * 48000, 1);

        const stripes =
          0.55 +
          0.45 * Math.abs(Math.sin(t * 5200 + g2 * 5.0)) * Math.abs(Math.sin(t * 1300 + g1 * 4.0));

        let dens = 0.42 + 0.62 * g1 * (0.55 + 0.8 * g2) * (0.72 + 0.5 * g3) * stripes;
        dens *= 0.86 + 0.30 * g4;
        dens *= 0.92 + 0.16 * g5;
        dens = SAT.clamp(dens, 0.04, 1.6);

        const gapSeeds = [
          [0.118, 0.0022],
          [0.263, 0.0013],
          [0.351, 0.0018],
          [0.487, 0.0011],
          [0.612, 0.0020],
          [0.744, 0.0014],
          [0.856, 0.0024],
        ];
        let gaps = 1;
        for (const [p, wdt] of gapSeeds) {
          if (Math.abs(t - p) < wdt) gaps *= 0.25;
          else if (Math.abs(t - p) < wdt * 3) gaps *= 0.72;
        }
        dens *= gaps;

        const bright = SAT.clamp(0.5 + 0.5 * (g2 - 0.5) * 2.2 + 0.25 * (g4 - 0.5), 0, 1);
        const warm = SAT.clamp(0.72 + 0.5 * (g3 - 0.5) * 2.4, 0.55, 1.12);

        const idx = (y * W + x) * 4;
        data[idx] = Math.round(SAT.clamp(dens / 1.6, 0, 1) * 255);
        data[idx + 1] = Math.round(bright * 255);
        data[idx + 2] = Math.round(SAT.clamp(warm / 1.12, 0, 1) * 255);
        data[idx + 3] = 255;
      }
    }

    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  const RING_TEXTURE = bakeRingTexture();

  const ringVert = /* glsl */ `
    attribute float aSide;
    varying vec3 vWorldPos;
    varying vec3 vLocal;
    varying vec3 vNormalW;
    varying vec2 vUvRing;
    varying float vSide;
    void main(){
      vLocal = position;
      vUvRing = uv;
      vSide = aSide;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vNormalW = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const ringFrag = /* glsl */ `
    precision highp float;

    varying vec3 vWorldPos;
    varying vec3 vLocal;
    varying vec3 vNormalW;
    varying vec2 vUvRing;
    varying float vSide;

    uniform vec3  uLightDir;
    uniform vec3  uSunColor;
    uniform vec3  uRingNormal;
    uniform float uPlanetRadius;
    uniform float uTime;
    uniform sampler2D uRingTex;
    uniform float uTexLo;
    uniform float uTexHi;
    uniform float uThickness;

    ${SAT.GLSL.hash}
    ${SAT.GLSL.noise3}
    ${SAT.GLSL.band}
    ${SAT.GLSL.ringProfile}

    void main(){
      float rr = length(vLocal.xz) / uPlanetRadius;
      if (rr < ${RI.dIn} || rr > ${RI.out}) discard;

      float profile = ringProfile(rr);
      if (profile < 0.0015) discard;

      vec3 V = normalize(cameraPosition - vWorldPos);
      vec3 L = normalize(uLightDir);
      vec3 N = normalize(uRingNormal);

      float graze = max(abs(dot(V, N)), 0.012);

      // 侧壁由顶点属性直接标记（不靠法线判断）
      float halfT = uThickness * 0.5;
      float yLocal = vLocal.y;
      float rHeight = clamp(abs(yLocal) / max(halfT, 1.0), 0.0, 1.0);
      vec3 Nf = normalize(vNormalW);
      float isWall = clamp(vSide, 0.0, 1.0);

      float u = (rr - uTexLo) / (uTexHi - uTexLo);
      vec3 tex = texture2D(uRingTex, vec2(clamp(u, 0.0, 1.0), 0.5)).rgb;
      float ringlets = tex.r * 1.25;
      float brightVar = tex.g;
      float warmShift = tex.b;

      float density = clamp(profile * ringlets, 0.0, 1.0);

      // 分区配色
      vec3 cC = vec3(0.24, 0.20, 0.16);
      vec3 cB = vec3(1.00, 0.93, 0.80);
      vec3 cA = vec3(0.50, 0.53, 0.59);
      float wB = bandMask(rr, ${RI.cB}, ${RI.bC}, 0.012);
      float wA = bandMask(rr, ${RI.cassiniEnd}, ${RI.aOut}, 0.012);
      vec3 base = mix(cC, cB, wB);
      base = mix(base, cA, wA * 0.92);
      base = mix(base, vec3(0.90, 0.94, 1.00), bandMask(rr, ${RI.f0}, ${RI.f1}, 0.003) * 0.9);
      base = mix(base * vec3(1.06, 0.98, 0.86), base * vec3(0.92, 0.96, 1.06),
                 smoothstep(${RI.cIn}, ${RI.aOut}, rr));
      base *= mix(0.82, 1.18, brightVar);
      base *= mix(1.0, warmShift, 0.35);

      float ndl = abs(dot(N, L));
      float lit = 0.14 + 1.05 * pow(ndl, 0.8);

      // 行星本影
      float b = dot(vWorldPos, L);
      float c = dot(vWorldPos, vWorldPos) - uPlanetRadius * uPlanetRadius;
      float disc = b * b - c;
      float shadow = 1.0;
      if (disc > 0.0) {
        float tNear = -b - sqrt(disc);
        if (tNear > 0.0) {
          float softness = clamp(sqrt(disc) / (uPlanetRadius * 0.045), 0.0, 1.0);
          shadow = mix(0.04, 1.0, softness);
        }
      }

      // 前向散射：逆光时冰晶更亮——星环「光环感」的核心
      float phase = pow(clamp(dot(-L, V), 0.0, 1.0), 5.0);
      float scatter = 0.55 + 2.8 * phase;

      vec3 col = base * uSunColor * lit * shadow * scatter * 1.30;
      col += base * vec3(0.30, 0.35, 0.44) * density * 0.40;
      col += base * vec3(1.0, 0.87, 0.64) * smoothstep(0.55, 0.0, graze) * profile * 0.55;

      // 侧壁：让厚度读得出来
      float wallStrat = fbm3(vec3(rr * 420.0, yLocal * 0.30, 2.0), 3) * 0.5 + 0.5;
      float wallLit = 0.30 + 0.70 * abs(dot(Nf, L));
      vec3 wallCol = base * uSunColor * wallLit * (0.62 + 0.62 * wallStrat) * shadow * 1.05;
      wallCol += base * vec3(0.26, 0.29, 0.35) * density * 0.55;

      float wallRim = smoothstep(0.62, 1.0, rHeight) * 0.40;
      wallCol += base * uSunColor * wallRim * shadow * 1.3;

      col = mix(col, wallCol, isWall);

      float alpha = clamp(density * 1.45, 0.0, 1.0);
      alpha *= mix(mix(0.70, 1.0, clamp(graze * 8.0, 0.0, 1.0)), 1.0, isWall);
      if (alpha < 0.02) discard;

      gl_FragColor = vec4(col, alpha);
    }
  `;

  /* 星环外侧的柔和辉光（加法混合，营造光环） */
  const ringGlowFrag = /* glsl */ `
    precision highp float;

    varying vec3 vWorldPos;
    varying vec3 vLocal;

    uniform vec3  uLightDir;
    uniform vec3  uRingNormal;
    uniform float uPlanetRadius;

    ${SAT.GLSL.hash}
    ${SAT.GLSL.noise3}
    ${SAT.GLSL.band}
    ${SAT.GLSL.ringProfile}

    void main(){
      float rr = length(vLocal.xz) / uPlanetRadius;
      vec3 V = normalize(cameraPosition - vWorldPos);
      vec3 N = normalize(uRingNormal);
      float graze = abs(dot(V, N));

      float halo = exp(-pow((rr - 1.92) / 0.62, 2.0));
      float inner = exp(-pow((rr - 1.60) / 0.28, 2.0));
      float g = halo * 0.55 + inner * 0.25;
      g *= smoothstep(0.0, 0.30, graze) * 0.55 + 0.45;

      float b = dot(vWorldPos, uLightDir);
      float c = dot(vWorldPos, vWorldPos) - uPlanetRadius * uPlanetRadius;
      float disc = b * b - c;
      if (disc > 0.0 && -b - sqrt(disc) > 0.0) g *= 0.25;

      vec3 tint = vec3(1.0, 0.86, 0.62);
      gl_FragColor = vec4(tint * g * 0.30, g * 0.30);
    }
  `;

  /* ===================== 小行星 ===================== */
  /* 每颗岩石在顶点着色器里独立公转：
     - 角速度按开普勒定律随半径变化（内圈快、外圈慢）
     - 整个环带是差动旋转，而不是整体刚性转动
     - CPU 每帧只需要更新一个 uTime */

  const asteroidVert = /* glsl */ `
    attribute float aOrbit;
    attribute float aAngle0;
    attribute float aSpeed;
    attribute float aY;
    attribute vec3  aScale;
    attribute vec3  aRot0;
    attribute vec3  aSpin;
    attribute vec3  aColor;

    uniform float uTime;

    varying vec3 vWorldPos;
    varying vec3 vNormalW;
    varying vec3 vColor;
    varying vec3 vObj;

    mat3 rotMat(vec3 r){
      float cx = cos(r.x), sx = sin(r.x);
      float cy = cos(r.y), sy = sin(r.y);
      float cz = cos(r.z), sz = sin(r.z);
      mat3 mx = mat3(1.0, 0.0, 0.0,  0.0, cx, sx,  0.0, -sx, cx);
      mat3 my = mat3(cy, 0.0, -sy,  0.0, 1.0, 0.0,  sy, 0.0, cy);
      mat3 mz = mat3(cz, sz, 0.0,  -sz, cz, 0.0,  0.0, 0.0, 1.0);
      return mz * my * mx;
    }

    void main(){
      vObj = position;
      vColor = aColor;

      float ang = aAngle0 + uTime * aSpeed;
      vec3 center = vec3(cos(ang) * aOrbit, aY, sin(ang) * aOrbit);

      mat3 rot = rotMat(aRot0 + aSpin * uTime);
      vec3 p = rot * (position * aScale);

      vec4 wp = modelMatrix * vec4(center + p, 1.0);
      vWorldPos = wp.xyz;
      vNormalW = normalize(mat3(modelMatrix) * (rot * normal));
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const heroVert = /* glsl */ `
    varying vec3 vWorldPos;
    varying vec3 vNormalW;
    varying vec3 vColor;
    varying vec3 vObj;
    uniform vec3 uTint;
    void main(){
      vObj = position;
      vColor = uTint;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vNormalW = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const asteroidFrag = /* glsl */ `
    precision highp float;

    varying vec3 vWorldPos;
    varying vec3 vNormalW;
    varying vec3 vColor;
    varying vec3 vObj;

    uniform vec3  uLightDir;
    uniform vec3  uSunColor;
    uniform vec3  uCamPos;
    uniform vec3  uEnvTop;
    uniform vec3  uEnvBot;

    ${SAT.GLSL.hash}
    ${SAT.GLSL.noise3}

    void main(){
      vec3 N = normalize(vNormalW);
      vec3 L = normalize(uLightDir);
      vec3 V = normalize(uCamPos - vWorldPos);

      float mott = fbm3(vObj * 3.2 + 4.0, 3) * 0.5 + 0.5;
      float pits = smoothstep(0.42, 0.58, fbm3(vObj * 9.0, 2) * 0.5 + 0.5);
      vec3 rock = vColor * (0.66 + 0.52 * mott) * (0.82 + 0.30 * pits);

      float ndl = max(dot(N, L), 0.0);
      float wrap = pow(clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0), 2.0);

      vec3 col = rock * uSunColor * (ndl * 2.6 + wrap * 0.16);
      col += rock * mix(uEnvBot, uEnvTop, clamp(N.y * 0.5 + 0.5, 0.0, 1.0)) * 1.10;
      float up = clamp(dot(N, normalize(vec3(0.0, 1.0, 0.0))), 0.0, 1.0);
      col += rock * vec3(0.30, 0.27, 0.19) * up * 0.55;

      float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
      col += vec3(0.38, 0.58, 1.0) * fres * 0.34 * (0.30 + 0.70 * ndl);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* --- 岩石几何：把二十面体顶点揉成不规则岩块 --- */
  function rockGeometry(seed, detail) {
    const g = new THREE.IcosahedronGeometry(1, detail || 1);
    const rng = SAT.rng(seed);
    const pos = g.attributes.position;
    const v = new THREE.Vector3();
    const cache = new Map();
    const stretch = [
      1 + rng.range(-0.22, 0.22),
      0.66 + rng.range(-0.12, 0.12),
      1 + rng.range(-0.22, 0.22),
    ];

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
      let s = cache.get(key);
      if (s === undefined) {
        const n =
          Math.sin(v.x * 3.1 + seed) * Math.cos(v.y * 2.7 - seed) * Math.sin(v.z * 3.9 + seed * 0.5);
        s = 0.74 + 0.26 * n + rng.range(-0.12, 0.12);
        cache.set(key, s);
      }
      v.multiplyScalar(s);
      v.x *= stretch[0];
      v.y *= stretch[1];
      v.z *= stretch[2];
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  function makeAsteroidBelts(envTop, envBot) {
    const groups = [];
    const geos = [rockGeometry(11, 1), rockGeometry(29, 1), rockGeometry(77, 1)];
    const palette = [
      new THREE.Color(0.42, 0.38, 0.34),
      new THREE.Color(0.56, 0.49, 0.41),
      new THREE.Color(0.34, 0.35, 0.39),
      new THREE.Color(0.63, 0.57, 0.48),
      new THREE.Color(0.28, 0.30, 0.34),
    ];

    /* 环带全部收在星环的径向范围内（D 环内缘 ~ F 环外缘）。
       垂直方向（thick）是加厚的重点：
       - 主体在 ±thick*0.5 内密集堆积
       - 少数飞散碎石可以到 ±thick 外，像被撞出环面的颗粒
       这样厚度变大，而平面范围不扩大。 */
    const bands = [
      { inner: 1.50, outer: 2.40, count: 6400, sizeMin: 1.0, sizeMax: 18.0,
        thick: 260, fringe: 0.22, seed: 5 },
      { inner: 1.14, outer: 1.55, count: 2000, sizeMin: 0.7, sizeMax: 11.0,
        thick: 130, fringe: 0.15, seed: 9 },
      { inner: 2.36, outer: 2.44, count: 1000, sizeMin: 0.8, sizeMax: 12.0,
        thick: 200, fringe: 0.30, seed: 13 },
    ];

    bands.forEach((cfg, bi) => {
      const rng = SAT.rng(cfg.seed * 7717);
      const geo = geos[bi].clone();
      const count = cfg.count;

      const aOrbit = new Float32Array(count);
      const aAngle0 = new Float32Array(count);
      const aSpeed = new Float32Array(count);
      const aY = new Float32Array(count);
      const aScale = new Float32Array(count * 3);
      const aRot0 = new Float32Array(count * 3);
      const aSpin = new Float32Array(count * 3);
      const aColor = new Float32Array(count * 3);
      const col = new THREE.Color();

      for (let i = 0; i < count; i++) {
        // 径向：只在环带范围内
        let rU = Math.pow(rng.f(), 0.75);
        if (rng.f() < 0.34) {
          rU = SAT.clamp(Math.pow(rng.f(), 0.9) + rng.gauss(0, 0.018), 0, 1);
        }
        const rUnit = SAT.lerp(cfg.inner, cfg.outer, rU);
        const orbit = rUnit * R;

        // 垂直：厚度的来源
        let y;
        if (rng.f() < cfg.fringe) {
          y = (rng.f() < 0.5 ? -1 : 1) * SAT.lerp(cfg.thick * 0.55, cfg.thick * 1.0, rng.f());
        } else {
          const peak = Math.pow(rng.f(), 0.55);
          y = (rng.f() < 0.5 ? -1 : 1) * peak * cfg.thick * 0.5;
        }

        aOrbit[i] = orbit;
        aAngle0[i] = rng.f() * Math.PI * 2;
        // 开普勒：角速度 ∝ r^-1.5
        aSpeed[i] = (0.16 / Math.pow(rUnit, 1.5)) * rng.range(0.985, 1.015);
        aY[i] = y;

        const s = SAT.lerp(cfg.sizeMin, cfg.sizeMax, Math.pow(rng.f(), 2.5));
        aScale[i * 3] = s * rng.range(0.7, 1.6);
        aScale[i * 3 + 1] = s * rng.range(0.5, 1.1);
        aScale[i * 3 + 2] = s * rng.range(0.7, 1.6);

        aRot0[i * 3] = rng.f() * 6.283;
        aRot0[i * 3 + 1] = rng.f() * 6.283;
        aRot0[i * 3 + 2] = rng.f() * 6.283;

        const spin = rng.range(0.04, 0.22);
        aSpin[i * 3] = rng.range(-spin, spin);
        aSpin[i * 3 + 1] = rng.range(-spin, spin);
        aSpin[i * 3 + 2] = rng.range(-spin, spin);

        col.copy(rng.pick(palette)).multiplyScalar(rng.range(0.70, 1.20));
        aColor[i * 3] = col.r;
        aColor[i * 3 + 1] = col.g;
        aColor[i * 3 + 2] = col.b;
      }

      const inst = new THREE.InstancedBufferGeometry();
      inst.index = geo.index;
      inst.attributes.position = geo.attributes.position;
      inst.attributes.normal = geo.attributes.normal;
      inst.instanceCount = count;

      inst.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(aOrbit, 1));
      inst.setAttribute('aAngle0', new THREE.InstancedBufferAttribute(aAngle0, 1));
      inst.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(aSpeed, 1));
      inst.setAttribute('aY', new THREE.InstancedBufferAttribute(aY, 1));
      inst.setAttribute('aScale', new THREE.InstancedBufferAttribute(aScale, 3));
      inst.setAttribute('aRot0', new THREE.InstancedBufferAttribute(aRot0, 3));
      inst.setAttribute('aSpin', new THREE.InstancedBufferAttribute(aSpin, 3));
      inst.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));

      inst.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

      const mat = new THREE.ShaderMaterial({
        vertexShader: asteroidVert,
        fragmentShader: asteroidFrag,
        uniforms: {
          uTime: { value: 0 },
          uLightDir: { value: SUN },
          uSunColor: { value: SUN_COLOR },
          uCamPos: { value: new THREE.Vector3() },
          uEnvTop: { value: envTop },
          uEnvBot: { value: envBot },
        },
      });

      const mesh = new THREE.Mesh(inst, mat);
      mesh.frustumCulled = false;
      mesh.name = 'asteroidBelt' + bi;

      groups.push({ mesh, mat, count });
    });

    return groups;
  }

  /* --- 近景「主角级」小行星：沿环带厚度层叠堆高，并绕土星公转 --- */
  function makeHeroRocks(envTop, envBot, origin) {
    const rng = SAT.rng(4242);
    const list = [];

    const palette = [
      [0.40, 0.37, 0.34],
      [0.58, 0.51, 0.43],
      [0.33, 0.35, 0.39],
      [0.47, 0.41, 0.36],
      [0.66, 0.62, 0.56],
      [0.52, 0.45, 0.33],
      [0.28, 0.29, 0.33],
      [0.61, 0.57, 0.50],
    ];

    const COUNT = 46;
    const innerR = 1.42 * R;
    const outerR = 2.42 * R;
    const thick = RING_THICKNESS * 5.5;

    // 预生成 8 种岩石几何，减少独占 buffer 数量
    const geoBank = [];
    for (let k = 0; k < 8; k++) {
      geoBank.push(rockGeometry(300 + k * 137, k % 3 === 0 ? 1 : 2));
    }

    for (let i = 0; i < COUNT; i++) {
      const geo = geoBank[i % geoBank.length];
      const c = rng.pick(palette);
      const mat = new THREE.ShaderMaterial({
        vertexShader: heroVert,
        fragmentShader: asteroidFrag,
        uniforms: {
          uLightDir: { value: SUN },
          uSunColor: { value: SUN_COLOR },
          uCamPos: { value: new THREE.Vector3() },
          uEnvTop: { value: envTop },
          uEnvBot: { value: envBot },
          uTint: { value: new THREE.Color(c[0], c[1], c[2]).multiplyScalar(rng.range(0.85, 1.15)) },
        },
      });

      const m = new THREE.Mesh(geo, mat);

      const rad = SAT.lerp(innerR, outerR, rng.f());

      let y;
      if (rng.f() < 0.25) {
        y = (rng.f() < 0.5 ? -1 : 1) * SAT.lerp(thick * 0.55, thick * 1.15, rng.f());
      } else {
        y = (rng.f() - 0.5) * 2 * thick * 0.5;
      }

      const originAng = Math.atan2(origin.z, origin.x);
      const ang = originAng + rng.gauss(0, 0.55);

      m.position.set(Math.cos(ang) * rad, y, Math.sin(ang) * rad);

      const s = rng.range(9, 46);
      m.scale.set(s * rng.range(0.5, 1.8), s * rng.range(0.42, 1.2), s * rng.range(0.5, 1.8));
      m.rotation.set(rng.f() * 6.283, rng.f() * 6.283, rng.f() * 6.283);
      m.userData.spin = new THREE.Vector3(
        rng.range(-0.12, 0.12),
        rng.range(-0.12, 0.12),
        rng.range(-0.12, 0.12)
      );
      m.userData.orbit = rad;
      m.userData.angle = ang;
      m.userData.omega = (0.16 / Math.pow(rad / R, 1.5)) * rng.range(0.97, 1.03);
      list.push(m);
    }
    return list;
  }

  /* ===================== 土卫 ===================== */
  // 四颗卫星的签名奇观在 moons.js 里实现（喷泉 / 阴阳脸 / 浓雾 / 撞击坑）
  function makeMoons() {
    return SAT.moons.create(R, SUN, SUN_COLOR);
  }

  /* ===================== 装配 ===================== */
  function build(envTop, envBot, playerStart) {
    const system = new THREE.Group();
    system.name = 'saturnSystem';

    const planet = makePlanet();
    planet.name = 'saturnPlanet';

    const rings = makeRings();
    const belts = makeAsteroidBelts(envTop, envBot);
    const heroes = makeHeroRocks(envTop, envBot, playerStart);
    const moonSet = makeMoons();

    system.add(planet, rings, moonSet.group);
    belts.forEach((b) => system.add(b.mesh));
    heroes.forEach((h) => system.add(h));

    return {
      system,
      planet,
      rings,
      belts,
      heroes,
      moons: moonSet.list,
      update(dt, time, camera, fov, viewportHeight) {
        planet.rotation.y += dt * 0.0032;
        planet.material.uniforms.uTime.value = time;

        const ringMesh = rings.children[0];
        ringMesh.material.uniforms.uTime.value = time;
        void fov;
        void viewportHeight;

        // 卫星（含土卫二冰喷泉）由 moons.js 驱动
        moonSet.update(dt, time, R);

        // 星环平面法线跟随系统倾斜
        system.updateMatrixWorld();
        RING_NORMAL.set(0, 1, 0).transformDirection(system.matrixWorld).normalize();

        // 星环上的漂浮冰块颗粒
        const motes = rings.getObjectByName('ringMotes');
        if (motes) {
          motes.material.uniforms.uTime.value = time;
          motes.material.uniforms.uCamPos.value.copy(camera.position);
          motes.rotation.y += dt * 0.004;
        }

        for (const b of belts) {
          b.mat.uniforms.uTime.value = time;
          b.mat.uniforms.uCamPos.value.copy(camera.position);
        }
        for (const h of heroes) {
          h.userData.angle += h.userData.omega * dt;
          const a = h.userData.angle;
          const rad = h.userData.orbit;
          h.position.set(Math.cos(a) * rad, h.position.y, Math.sin(a) * rad);
          h.rotation.x += h.userData.spin.x * dt;
          h.rotation.y += h.userData.spin.y * dt;
          h.rotation.z += h.userData.spin.z * dt;
          h.material.uniforms.uCamPos.value.copy(camera.position);
        }
      },
    };
  }

  function makePlanet() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: planetVert,
      fragmentShader: planetFrag,
      uniforms: {
        uLightDir: { value: SUN },
        uSunColor: { value: SUN_COLOR },
        uRingNormal: { value: RING_NORMAL },
        uPlanetRadius: { value: R },
        uTime: { value: 0 },
      },
    });
    return new THREE.Mesh(new THREE.SphereGeometry(R, 160, 96), mat);
  }

  /* ===================== 星环（立体体积） =====================
     不是单层平面，而是一条有厚度的环带：
     - 上下表面 + 内外侧壁构成封闭实体
     - 侧壁用顶点属性 aSide 显式标记
     - 启用 depthWrite + alphaTest，避免各层互相叠加混色 */

  const RING_THICKNESS_BASE = 62;
  let RING_THICKNESS = RING_THICKNESS_BASE;

  function setRingThicknessScale(k) {
    RING_THICKNESS = RING_THICKNESS_BASE * SAT.clamp(k, 0.25, 3);
    return RING_THICKNESS;
  }

  const RING_SEGMENTS_R = 128;
  const RING_SEGMENTS_A = 256;
  const RING_SURFACE_SAMPLES = 1200;

  const bandC = (x, a, b, soft) =>
    SAT.smoothstep(a - soft, a + soft, x) * (1 - SAT.smoothstep(b - soft, b + soft, x));

  function ringHeightProfile() {
    const samples = new Float32Array(RING_SURFACE_SAMPLES);
    for (let i = 0; i < RING_SURFACE_SAMPLES; i++) {
      const t = i / (RING_SURFACE_SAMPLES - 1);
      const rr = RI.dIn + (RI.out - RI.dIn) * t;
      let d = 0;
      d = Math.max(d, 0.03 * bandC(rr, RI.dIn, RI.cIn, 0.01));
      d = Math.max(d, 0.15 * bandC(rr, RI.cIn, RI.cB, 0.006));
      d = Math.max(d, 0.98 * bandC(rr, RI.cB, RI.bC, 0.007));
      d = Math.max(d, 0.03 * bandC(rr, RI.bC, RI.cassiniEnd, 0.004));
      d = Math.max(d, 0.62 * bandC(rr, RI.cassiniEnd, RI.aOut, 0.006));
      d = Math.max(d, 0.56 * bandC(rr, RI.f0, RI.f1, 0.0014));
      samples[i] = SAT.clamp(d, 0, 1);
    }
    return samples;
  }

  const RING_HEIGHTS = ringHeightProfile();

  function ringHeightAt(t) {
    const f = SAT.clamp(t, 0, 1) * (RING_SURFACE_SAMPLES - 1);
    const i = Math.floor(f);
    const j = Math.min(RING_SURFACE_SAMPLES - 1, i + 1);
    const k = f - i;
    return RING_HEIGHTS[i] * (1 - k) + RING_HEIGHTS[j] * k;
  }

  /** 生成环带几何：上下表面 + 内外侧壁 */
  function makeRingGeometry() {
    const ri = RI.dIn * R;
    const ro = RI.out * R;
    const halfT = RING_THICKNESS * 0.5;

    const nR = RING_SEGMENTS_R;
    const nA = RING_SEGMENTS_A;

    const positions = [];
    const uvs = [];
    const sides = [];
    const indices = [];

    // 上下表面
    for (const side of [1, -1]) {
      const base = positions.length / 3;
      for (let a = 0; a <= nA; a++) {
        const ang = (a / nA) * Math.PI * 2;
        for (let i = 0; i <= nR; i++) {
          const t = i / nR;
          const rad = SAT.lerp(ri, ro, t);
          const h = (ringHeightAt(t) - 0.5) * halfT * 0.55;
          positions.push(Math.cos(ang) * rad, side * (halfT + h), Math.sin(ang) * rad);
          uvs.push(t, 0.5);
          sides.push(0);
        }
      }
      for (let a = 0; a < nA; a++) {
        for (let i = 0; i < nR; i++) {
          const a0 = base + a * (nR + 1) + i;
          const a1 = a0 + 1;
          const b0 = base + (a + 1) * (nR + 1) + i;
          const b1 = b0 + 1;
          if (side > 0) indices.push(a0, b0, a1, a1, b0, b1);
          else indices.push(a0, a1, b0, a1, b1, b0);
        }
      }
    }

    // 内外侧壁
    for (const [rad, tEdge] of [
      [ri, 0],
      [ro, 1],
    ]) {
      const base = positions.length / 3;
      const h = (ringHeightAt(tEdge) - 0.5) * halfT * 0.55;
      for (let a = 0; a <= nA; a++) {
        const ang = (a / nA) * Math.PI * 2;
        for (let k = 0; k <= 4; k++) {
          const y = SAT.lerp(-(halfT + h), halfT + h, k / 4);
          positions.push(Math.cos(ang) * rad, y, Math.sin(ang) * rad);
          uvs.push(tEdge, k / 4);
          sides.push(1);
        }
      }
      for (let a = 0; a < nA; a++) {
        for (let k = 0; k < 4; k++) {
          const a0 = base + a * 5 + k;
          const a1 = a0 + 1;
          const b0 = base + (a + 1) * 5 + k;
          const b1 = b0 + 1;
          if (rad === ri) indices.push(a0, a1, b0, a1, b1, b0);
          else indices.push(a0, b0, a1, a1, b0, b1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  /* --- 漂浮冰块颗粒 --- */
  function makeRingMotes(count) {
    const rng = SAT.rng(5150);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const t = Math.pow(rng.f(), 0.7);
      const rr = SAT.lerp(RI.dIn, RI.out, t) * R;
      const ang = rng.f() * Math.PI * 2;
      const y = rng.gauss(0, RING_THICKNESS * 0.22);
      pos[i * 3] = Math.cos(ang) * rr;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(ang) * rr;
      size[i] = rng.range(0.5, 2.2);
      phase[i] = rng.f() * 6.283;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uPixel: { value: Math.min(window.devicePixelRatio, 2) },
        uTime: { value: 0 },
        uLightDir: { value: SUN },
        uRingNormal: { value: RING_NORMAL },
        uCamPos: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aPhase;
        uniform float uPixel;
        uniform float uTime;
        uniform vec3 uCamPos;
        uniform vec3 uRingNormal;
        uniform vec3 uLightDir;
        varying float vAlpha;

        void main(){
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;

          float dist = length(position - uCamPos);
          gl_PointSize = aSize * uPixel * (900.0 / max(dist, 1.0));

          float shade = 0.45 + 0.55 * abs(dot(normalize(uRingNormal), normalize(uLightDir)));
          float twinkle = 0.7 + 0.3 * sin(uTime * 2.0 + aPhase);
          vAlpha = shade * twinkle * smoothstep(0.0, 300.0, dist);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main(){
          vec2 p = gl_PointCoord - 0.5;
          float r = length(p) * 2.0;
          if (r > 1.0) discard;
          float a = smoothstep(1.0, 0.15, r) * vAlpha * 0.34;
          gl_FragColor = vec4(vec3(1.0, 0.95, 0.86) * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const pts = new THREE.Points(geo, mat);
    pts.name = 'ringMotes';
    pts.frustumCulled = false;
    return pts;
  }

  function makeRings() {
    const geo = makeRingGeometry();

    const mat = new THREE.ShaderMaterial({
      vertexShader: ringVert,
      fragmentShader: ringFrag,
      uniforms: {
        uLightDir: { value: SUN },
        uSunColor: { value: SUN_COLOR },
        uRingNormal: { value: RING_NORMAL },
        uPlanetRadius: { value: R },
        uTime: { value: 0 },
        uRingTex: { value: RING_TEXTURE },
        uTexLo: { value: RI.dIn },
        uTexHi: { value: RI.out },
        uThickness: { value: RING_THICKNESS },
      },
      transparent: true,
      depthWrite: true,
      alphaTest: 0.01,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'rings';
    mesh.renderOrder = 4;

    // 外围柔和光晕（保持平面）
    const outer = RI.out * R;
    const glowGeo = new THREE.PlaneGeometry(outer * 2.06, outer * 2.06, 1, 1);
    glowGeo.rotateX(-Math.PI / 2);
    const glowMat = new THREE.ShaderMaterial({
      vertexShader: ringVert,
      fragmentShader: ringGlowFrag,
      uniforms: {
        uLightDir: { value: SUN },
        uRingNormal: { value: RING_NORMAL },
        uPlanetRadius: { value: R },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.name = 'ringGlow';
    glow.renderOrder = 6;

    const motes = makeRingMotes(4200);

    const group = new THREE.Group();
    group.add(mesh, glow, motes);
    group.name = 'ringGroup';

    /* 设置面板改厚度：重建环带几何 */
    group.userData.rebuildThickness = function (scale) {
      setRingThicknessScale(scale);
      const oldGeo = mesh.geometry;
      mesh.geometry = makeRingGeometry();
      mat.uniforms.uThickness.value = RING_THICKNESS;
      oldGeo.dispose();
      return RING_THICKNESS;
    };

    return group;
  }

  SAT.saturn = {
    build,
    SUN,
    SUN_COLOR,
    R,
    RING_NORMAL,
    RING_THICKNESS_BASE,
    getRingThickness: () => RING_THICKNESS,
    setRingThicknessScale,
  };
})();
