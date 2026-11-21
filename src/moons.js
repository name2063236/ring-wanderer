/* =========================================================================
   moons.js — 四颗土卫的签名奇观
   · Enceladus 土卫二：南极冰喷泉（真实存在，水冰羽流高数百公里）
   · Iapetus   土卫八：阴阳脸（前导半球反照率 ~0.05，后随半球 ~0.6）
   · Titan     土卫六：橙色浓雾大气，能见度极低
   · Rhea      土卫三：撞击坑密布的冰壳
   全部用真实天文特征驱动，不是随便加点特效。
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  function create(R, SUN, SUN_COLOR) {
    const group = new THREE.Group();
    group.name = 'moons';

    /* ================= 公用的球体着色器骨架 ================= */
    const sphereVert = /* glsl */ `
      varying vec3 vN;
      varying vec3 vWorldPos;
      varying vec3 vObj;
      void main(){
        vObj = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;

    /* ---------------- 土卫八：阴阳脸 ---------------- */
    const iapetusFrag = /* glsl */ `
      precision highp float;
      varying vec3 vN;
      varying vec3 vWorldPos;
      varying vec3 vObj;
      uniform vec3 uLightDir;
      uniform vec3 uSunColor;

      ${SAT.GLSL.hash}
      ${SAT.GLSL.noise3}

      void main(){
        vec3 N = normalize(vN);
        vec3 L = normalize(uLightDir);
        vec3 V = normalize(cameraPosition - vWorldPos);

        // 前导半球（朝向轨道运动方向）极暗，后随半球很亮。
        // 真实反照率对比约 0.05 : 0.6 —— 这是太阳系最极端的一张"阴阳脸"。
        float lon = atan(vObj.x, vObj.z);
        // 边界不是一刀切，有过渡带
        float split = smoothstep(-0.55, 0.55, sin(lon));
        float albedo = mix(0.045, 0.62, split);
        // 拆分边界处的斑驳
        float mott = fbm3(vObj * 5.0, 3) * 0.5 + 0.5;
        albedo *= 0.85 + 0.30 * mott;

        vec3 base = vec3(albedo) * vec3(0.96, 0.94, 0.90);

        float ndl = dot(N, L);
        float day = smoothstep(-0.08, 0.30, ndl);
        vec3 col = base * uSunColor * max(ndl, 0.0) * 1.35;
        col += base * vec3(0.020, 0.026, 0.045) * (1.0 - day);

        float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.5);
        col += base * uSunColor * rim * day * 0.22;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    /* ---------------- 土卫二：冰壳 + 南极裂隙 ---------------- */
    const enceladusFrag = /* glsl */ `
      precision highp float;
      varying vec3 vN;
      varying vec3 vWorldPos;
      varying vec3 vObj;
      uniform vec3 uLightDir;
      uniform vec3 uSunColor;

      ${SAT.GLSL.hash}
      ${SAT.GLSL.noise3}

      void main(){
        vec3 N = normalize(vN);
        vec3 L = normalize(uLightDir);
        vec3 V = normalize(cameraPosition - vWorldPos);

        // 极亮的冰（反照率接近 1，是太阳系最白的天体之一）
        float cracks = 1.0 - abs(fbm3(vObj * 8.0, 4));
        cracks = pow(clamp(cracks, 0.0, 1.0), 6.0);

        vec3 base = vec3(0.90, 0.94, 0.98);
        base *= 0.92 + 0.12 * (fbm3(vObj * 3.0, 3) * 0.5 + 0.5);
        // "虎纹"裂隙：南极区的青色条纹
        float south = smoothstep(0.15, -0.75, vObj.y);
        vec3 tiger = vec3(0.42, 0.78, 0.86);
        base = mix(base, mix(base, tiger, 0.65), cracks * south * 0.85);

        float ndl = dot(N, L);
        float day = smoothstep(-0.06, 0.26, ndl);
        vec3 col = base * uSunColor * max(ndl, 0.0) * 1.55;
        col += base * vec3(0.030, 0.040, 0.065) * (1.0 - day);

        float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
        col += vec3(0.7, 0.9, 1.0) * rim * day * 0.30;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    /* ---------------- 土卫六：橙色浓雾大气 ---------------- */
    const titanFrag = /* glsl */ `
      precision highp float;
      varying vec3 vN;
      varying vec3 vWorldPos;
      varying vec3 vObj;
      uniform vec3 uLightDir;
      uniform vec3 uSunColor;

      ${SAT.GLSL.hash}
      ${SAT.GLSL.noise3}

      void main(){
        vec3 N = normalize(vN);
        vec3 L = normalize(uLightDir);
        vec3 V = normalize(cameraPosition - vWorldPos);

        // 浓厚橙色雾霾，几乎看不到表面
        vec3 haze = vec3(0.78, 0.48, 0.18);
        float swirl = fbm3(vObj * 2.2, 3) * 0.5 + 0.5;
        vec3 base = haze * (0.82 + 0.26 * swirl);

        float ndl = dot(N, L);
        // 米氏散射：大气让明暗交界线非常柔和
        float day = smoothstep(-0.35, 0.55, ndl);
        vec3 col = base * uSunColor * mix(0.10, 1.15, day);
        col += base * vec3(0.045, 0.030, 0.020) * (1.0 - day);

        // 明显的大气边缘光
        float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.4);
        col += vec3(1.0, 0.62, 0.26) * rim * day * 0.55;
        col += vec3(0.9, 0.55, 0.2) * rim * (1.0 - day) * 0.20;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    /* ---------------- 土卫三：撞击坑 ---------------- */
    const rheaFrag = /* glsl */ `
      precision highp float;
      varying vec3 vN;
      varying vec3 vWorldPos;
      varying vec3 vObj;
      uniform vec3 uLightDir;
      uniform vec3 uSunColor;

      ${SAT.GLSL.hash}
      ${SAT.GLSL.noise3}

      void main(){
        vec3 N = normalize(vN);
        vec3 L = normalize(uLightDir);
        vec3 V = normalize(cameraPosition - vWorldPos);

        // 用多层脊状噪声模拟密集撞击坑
        float c1 = 1.0 - abs(fbm3(vObj * 9.0, 4));
        float c2 = 1.0 - abs(fbm3(vObj * 21.0, 3));
        float craters = pow(clamp(c1, 0.0, 1.0), 5.0) * 0.6
                      + pow(clamp(c2, 0.0, 1.0), 7.0) * 0.4;

        vec3 base = vec3(0.72, 0.74, 0.76);
        // 坑底更暗，坑缘更亮
        base *= 1.0 - craters * 0.38;
        base += vec3(0.10) * pow(clamp(c1, 0.0, 1.0), 12.0);

        // 用密度差做一点法线扰动，让坑有立体感
        float h = craters;
        float hx = 1.0 - abs(fbm3(normalize(vObj + vec3(0.01, 0.0, 0.0)) * 9.0, 4));
        vec3 Nb = normalize(N + vObj * (h - pow(clamp(hx, 0.0, 1.0), 5.0)) * 0.5);

        float ndl = dot(Nb, L);
        float day = smoothstep(-0.08, 0.28, ndl);
        vec3 col = base * uSunColor * max(ndl, 0.0) * 1.40;
        col += base * vec3(0.025, 0.032, 0.052) * (1.0 - day);

        float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.5);
        col += base * uSunColor * rim * day * 0.20;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    /* ================= 冰喷泉（土卫二） ================= */
    function makePlume(radius) {
      const COUNT = 900;
      const pos = new Float32Array(COUNT * 3);
      const seed = new Float32Array(COUNT);
      const rng = SAT.rng(8899);

      for (let i = 0; i < COUNT; i++) {
        // 从南极裂隙喷出：锥形分布
        const a = rng.f() * Math.PI * 2;
        const spread = Math.pow(rng.f(), 0.6) * 0.42;
        const dist = Math.pow(rng.f(), 0.55);

        // 起点在南极附近
        const y0 = -0.94 + rng.range(0, 0.10);
        const r0 = Math.sqrt(Math.max(0, 1 - y0 * y0));

        // 向外发散
        const rr = r0 * (0.15 + spread) * (0.2 + dist * 2.2);
        const yy = y0 - dist * 2.6;

        pos[i * 3] = Math.cos(a) * rr;
        pos[i * 3 + 1] = yy;
        pos[i * 3 + 2] = Math.sin(a) * rr;
        seed[i] = rng.f();
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uPixel: { value: Math.min(window.devicePixelRatio, 2) },
          uScale: { value: radius },
        },
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform float uPixel;
          uniform float uScale;
          attribute float aSeed;
          varying float vAlpha;

          void main(){
            // 粒子沿 -Y 方向持续外喷，用时间做循环位移
            vec3 p = position;
            float t = fract(uTime * 0.18 + aSeed);
            p.y -= t * 1.4;
            p.xz *= 1.0 + t * 0.85;

            vec4 mv = modelViewMatrix * vec4(p * uScale, 1.0);
            gl_Position = projectionMatrix * mv;

            // 喷得越远越淡
            vAlpha = (1.0 - t) * (1.0 - t) * (0.35 + 0.65 * aSeed);
            gl_PointSize = (1.2 + aSeed * 2.4) * uPixel * (200.0 / max(-mv.z, 1.0));
          }
        `,
        fragmentShader: /* glsl */ `
          varying float vAlpha;
          void main(){
            vec2 p = gl_PointCoord - 0.5;
            float r = length(p) * 2.0;
            if (r > 1.0) discard;
            float a = smoothstep(1.0, 0.05, r) * vAlpha * 0.75;
            gl_FragColor = vec4(vec3(0.85, 0.95, 1.0) * a, a);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      return pts;
    }

    /* ================= 组装 ================= */
    const MOONS = [
      {
        name: 'Enceladus',
        r: 12.6 * 4, // 放大以便可见（真实半径 252km，这里刻意夸大）
        orbit: 2.55,
        phase: 5.3,
        inc: 0.2,
        color: [0.92, 0.95, 0.99],
        speed: 0.0021,
        frag: enceladusFrag,
        plume: true,
      },
      {
        name: 'Iapetus',
        r: 36.7 * 3,
        orbit: 8.6,
        phase: 4.1,
        inc: 1.1,
        color: [0.55, 0.50, 0.45],
        speed: 0.0006,
        frag: iapetusFrag,
      },
      {
        name: 'Titan',
        r: 128.7 * 1.6,
        orbit: 3.05,
        phase: 0.7,
        inc: 0.4,
        color: [0.78, 0.48, 0.18],
        speed: 0.0016,
        frag: titanFrag,
      },
      {
        name: 'Rhea',
        r: 38.1 * 3,
        orbit: 4.20,
        phase: 2.4,
        inc: -0.5,
        color: [0.74, 0.76, 0.78],
        speed: 0.0011,
        frag: rheaFrag,
      },
    ];

    const list = [];

    for (const m of MOONS) {
      const geo = new THREE.SphereGeometry(1, 64, 44);
      const mat = new THREE.ShaderMaterial({
        vertexShader: sphereVert,
        fragmentShader: m.frag,
        uniforms: {
          uLightDir: { value: SUN },
          uSunColor: { value: SUN_COLOR },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(m.r);
      mesh.name = 'moon_' + m.name;
      group.add(mesh);

      let plume = null;
      if (m.plume) {
        plume = makePlume(m.r);
        mesh.add(plume); // 跟随卫星
      }

      list.push({ mesh, cfg: m, angle: m.phase, plume });
    }

    return {
      group,
      list,
      update(dt, time, R) {
        for (const m of list) {
          m.angle += dt * m.cfg.speed * 60;
          const rad = m.cfg.orbit * R;
          const y = Math.sin(m.angle * 0.37) * rad * 0.12 * m.cfg.inc;
          m.mesh.position.set(Math.cos(m.angle) * rad, y, Math.sin(m.angle) * rad);
          m.mesh.rotation.y += dt * 0.05;
          if (m.plume) m.plume.material.uniforms.uTime.value = time;
        }
      },
    };
  }

  SAT.moons = { create };
})();
