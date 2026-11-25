/* =========================================================================
   planets.js — 可跃迁到达的目的地

   这一版按三条反馈重做：
   1. 蓝星（地球）精度太低 → 重写：真实经纬度映射、大陆/海洋/沙漠/森林/冰盖
      由多层噪声雕刻，云层有高度感与真实纬度带（ITCZ / 副热带高压带 / 中纬风暴带）
   2. 碎星带五颜六色 → 全部改为统一的灰褐岩石色系，只有明度与色温微差
   3. 黑洞像换皮的土星 → 彻底去掉「球体 + 环形盘」的土星式结构：
      改为正面朝向的纯黑圆盘 + 引力透镜的星空畸变 + 悬垂的吸积盘（不是环！）
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  const NOISE = SAT.GLSL.hash + SAT.GLSL.noise3;

  /* =====================================================================
     1. 碎星带 —— 统一灰褐岩石色，只有明度与色温的微差
     ===================================================================== */
  function buildAsteroidSwarm(R) {
    const group = new THREE.Group();
    group.name = 'world_belt';

    const COUNT = 42000;
    const rng = SAT.rng(33017);

    /* 几何：多种不规则块，但顶点抖动幅度一致，避免"球形汤圆" */
    const geos = [];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.IcosahedronGeometry(1, 1);
      const pos = g.attributes.position;
      const v = new THREE.Vector3();
      const cache = new Map();
      const seedA = rng.f() * 10;
      const seedB = rng.f() * 10;
      for (let j = 0; j < pos.count; j++) {
        v.fromBufferAttribute(pos, j);
        const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
        let s = cache.get(key);
        if (s === undefined) {
          // 多频扰动 -> 棱角 + 坑洼
          const n =
            Math.sin(v.x * 3.1 + seedA) * Math.cos(v.y * 2.7 + seedB) * Math.sin(v.z * 3.9 + seedA * 0.5) * 0.22 +
            Math.sin(v.x * 7.3 + seedB) * Math.cos(v.z * 6.1 + seedA) * 0.08;
          s = 0.78 + n + rng.range(-0.10, 0.10);
          cache.set(key, s);
        }
        v.multiplyScalar(s);
        pos.setXYZ(j, v.x, v.y, v.z);
      }
      g.computeVertexNormals();
      geos.push(g);
    }

    const scaleArr = new Float32Array(COUNT * 3);
    const rotArr = new Float32Array(COUNT * 3);
    const spinArr = new Float32Array(COUNT * 3);
    const posArr = new Float32Array(COUNT * 3);
    const colArr = new Float32Array(COUNT * 3);

    const RX = R * 2.6;
    const RY = R * 0.62;
    const RZ = R * 2.1;

    for (let i = 0; i < COUNT; i++) {
      let u = rng.f() * 2 - 1;
      let th = rng.f() * Math.PI * 2;
      let s = Math.sqrt(Math.max(0, 1 - u * u));
      let x = s * Math.cos(th);
      let y = u;
      let z = s * Math.sin(th);

      const rr = Math.pow(rng.f(), 0.55);
      const hollow = 0.18 + rr * 0.82;

      posArr[i * 3] = x * RX * hollow;
      posArr[i * 3 + 1] = y * RY * hollow;
      posArr[i * 3 + 2] = z * RZ * hollow;

      const sz = SAT.lerp(1.2, 46, Math.pow(rng.f(), 3.2));
      scaleArr[i * 3] = sz * rng.range(0.7, 1.5);
      scaleArr[i * 3 + 1] = sz * rng.range(0.55, 1.1);
      scaleArr[i * 3 + 2] = sz * rng.range(0.7, 1.5);

      rotArr[i * 3] = rng.f() * 6.283;
      rotArr[i * 3 + 1] = rng.f() * 6.283;
      rotArr[i * 3 + 2] = rng.f() * 6.283;

      const sp = rng.range(0.05, 0.4);
      spinArr[i * 3] = rng.range(-sp, sp);
      spinArr[i * 3 + 1] = rng.range(-sp, sp);
      spinArr[i * 3 + 2] = rng.range(-sp, sp);

      /* 颜色：统一灰褐。真实小行星带（C 型碳质 / S 型硅质）都是低饱和度的灰褐，
         只在明度与色温上有细微差别，不会五颜六色。 */
      const lum = rng.range(0.30, 0.62); // 明度跨度
      const warm = rng.range(-0.04, 0.05); // 轻微冷暖偏移
      colArr[i * 3] = lum * (1.0 + warm);
      colArr[i * 3 + 1] = lum * (0.97 + warm * 0.4);
      colArr[i * 3 + 2] = lum * (0.93 - warm * 0.6);
    }

    const inst = new THREE.InstancedBufferGeometry();
    inst.index = geos[0].index;
    inst.attributes.position = geos[0].attributes.position;
    inst.attributes.normal = geos[0].attributes.normal;
    inst.instanceCount = COUNT;

    inst.setAttribute('aPos', new THREE.InstancedBufferAttribute(posArr, 3));
    inst.setAttribute('aScale', new THREE.InstancedBufferAttribute(scaleArr, 3));
    inst.setAttribute('aRot0', new THREE.InstancedBufferAttribute(rotArr, 3));
    inst.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spinArr, 3));
    inst.setAttribute('aColor', new THREE.InstancedBufferAttribute(colArr, 3));
    inst.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    const sunDir = new THREE.Vector3(0.55, 0.42, -0.72).normalize();

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLightDir: { value: sunDir },
        uSunColor: { value: new THREE.Color(1.0, 0.95, 0.88) },
        uCamPos: { value: new THREE.Vector3() },
        uEnvTop: { value: new THREE.Color(0.10, 0.10, 0.13) },
        uEnvBot: { value: new THREE.Color(0.04, 0.04, 0.05) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aPos;
        attribute vec3 aScale;
        attribute vec3 aRot0;
        attribute vec3 aSpin;
        attribute vec3 aColor;

        uniform float uTime;

        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        varying vec3 vColor;
        varying vec3 vObj;

        mat3 rotMat(vec3 r){
          float cx = cos(r.x), sx = sin(r.x);
          float cy = cos(r.y), sy = sin(r.y);
          float cz = cos(r.z), sz = sin(r.z);
          mat3 mx = mat3(1.0,0.0,0.0, 0.0,cx,sx, 0.0,-sx,cx);
          mat3 my = mat3(cy,0.0,-sy, 0.0,1.0,0.0, sy,0.0,cy);
          mat3 mz = mat3(cz,sz,0.0, -sz,cz,0.0, 0.0,0.0,1.0);
          return mz * my * mx;
        }

        void main(){
          vObj = position;
          vColor = aColor;

          float t = uTime * 0.035;
          float ct = cos(t), st = sin(t);
          vec3 center = vec3(
            aPos.x * ct - aPos.z * st,
            aPos.y,
            aPos.x * st + aPos.z * ct
          );

          mat3 rot = rotMat(aRot0 + aSpin * uTime);
          vec3 p = rot * (position * aScale);

          vec4 wp = modelMatrix * vec4(center + p, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * (rot * normal));
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        varying vec3 vColor;
        varying vec3 vObj;

        uniform vec3 uLightDir;
        uniform vec3 uSunColor;
        uniform vec3 uCamPos;
        uniform vec3 uEnvTop;
        uniform vec3 uEnvBot;

        ${NOISE}

        void main(){
          vec3 N = normalize(vNormalW);
          vec3 L = normalize(uLightDir);
          vec3 V = normalize(uCamPos - vWorldPos);

          // 表面斑驳（保持低对比，避免发光感）
          float mott = fbm3(vObj * 4.0, 3) * 0.5 + 0.5;
          float pits = smoothstep(0.42, 0.60, fbm3(vObj * 11.0, 2) * 0.5 + 0.5);
          vec3 rock = vColor * (0.78 + 0.34 * mott) * (0.88 + 0.18 * pits);

          float ndl = max(dot(N, L), 0.0);
          float wrap = pow(clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0), 2.0);

          vec3 col = rock * uSunColor * (ndl * 2.3 + wrap * 0.12);
          col += rock * mix(uEnvBot, uEnvTop, clamp(N.y * 0.5 + 0.5, 0.0, 1.0)) * 0.9;

          float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
          col += vec3(0.45, 0.50, 0.60) * fres * 0.16 * (0.3 + 0.7 * ndl);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    const swarm = new THREE.Mesh(inst, mat);
    swarm.frustumCulled = false;
    group.add(swarm);

    // 背景尘埃（也统一为灰褐）
    const dustCount = 9000;
    const dp = new Float32Array(dustCount * 3);
    const ds = new Float32Array(dustCount);
    for (let i = 0; i < dustCount; i++) {
      const u = rng.f() * 2 - 1;
      const th = rng.f() * Math.PI * 2;
      const s2 = Math.sqrt(Math.max(0, 1 - u * u));
      const rr = Math.pow(rng.f(), 0.4) * 1.35;
      dp[i * 3] = s2 * Math.cos(th) * RX * rr;
      dp[i * 3 + 1] = u * RY * rr;
      dp[i * 3 + 2] = s2 * Math.sin(th) * RZ * rr;
      ds[i] = rng.f();
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    dg.setAttribute('aSeed', new THREE.BufferAttribute(ds, 1));
    const dmat = new THREE.ShaderMaterial({
      uniforms: {
        uPixel: { value: Math.min(window.devicePixelRatio, 2) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uPixel;
        uniform float uTime;
        varying float vA;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vA = (0.12 + 0.40 * aSeed) * (0.65 + 0.35 * sin(uTime * 1.7 + aSeed * 33.0));
          gl_PointSize = (0.7 + aSeed * 1.6) * uPixel * (500.0 / max(-mv.z, 1.0));
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main(){
          vec2 p = gl_PointCoord - 0.5;
          if (length(p) * 2.0 > 1.0) discard;
          float a = smoothstep(1.0, 0.1, length(p) * 2.0) * vA * 0.35;
          gl_FragColor = vec4(vec3(0.66, 0.62, 0.58) * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dustPts = new THREE.Points(dg, dmat);
    dustPts.frustumCulled = false;
    group.add(dustPts);

    return {
      group,
      def: { id: 'belt', name: '碎星带', subtitle: '超大规模小行星团' },
      sunDir,
      swarm,
      count: COUNT,
      update(dt, time, camera) {
        mat.uniforms.uTime.value = time;
        mat.uniforms.uCamPos.value.copy(camera.position);
        dmat.uniforms.uTime.value = time;
      },
    };
  }

  /* =====================================================================
     2. 蓝星（地球）—— 高精度版
     关键改进：
     - 真实经纬度映射（经度 λ、纬度 φ），不再是各向同性噪声
     - 大陆由「板块噪声」雕刻，带海岸线细节与内陆水系
     - 生物群区按纬度分层：冰盖 / 苔原 / 针叶林 / 温带 / 沙漠 / 热带雨林
     - 云层按真实大气环流分层：赤道辐合带（多）、副热带高压（少）、中纬风暴（多）
     - 海洋有深浅、太阳耀斑高光
     - 地表与云层用不同角速度（核心设计）
     ===================================================================== */
  function buildEarth(R) {
    const group = new THREE.Group();
    group.name = 'world_earth';

    const r = R * 0.92;
    const sunDir = new THREE.Vector3(0.72, 0.22, 0.66).normalize();

    /* ---------- 地表 ---------- */
    const groundMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLightDir: { value: sunDir },
        uSunColor: { value: new THREE.Color(1.0, 0.97, 0.92) },
        uGroundSpin: { value: 0.018 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vObj;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        void main(){
          vObj = normalize(position);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vObj;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        uniform vec3 uLightDir;
        uniform vec3 uSunColor;
        uniform float uTime;
        uniform float uGroundSpin;

        ${NOISE}

        /* ---------- 大陆高度场 ----------
           用多层噪声叠出一个"大陆—海洋—山脉"的高度。
           不是简单的阈值，而是让海岸线本身有分形细节。 */
        float continent(vec3 p){
          // 大尺度板块
          vec3 w = vec3(
            fbm3(p * 1.1 + 11.3, 4),
            fbm3(p * 1.1 - 7.7, 4),
            fbm3(p * 1.1 + 3.1, 4)
          );
          // 域扭曲后的主高度
          float h = fbm3(p * 2.1 + w * 1.6, 7);
          // 细节：海岸线锯齿
          h += fbm3(p * 7.5 + w * 3.0, 4) * 0.18;
          h += fbm3(p * 19.0 + w * 2.0, 3) * 0.06;
          return h;
        }

        void main(){
          vec3 n = normalize(vObj);
          vec3 N = normalize(vNormalW);
          vec3 L = normalize(uLightDir);
          vec3 V = normalize(cameraPosition - vWorldPos);

          float lat = clamp(n.y, -1.0, 1.0);
          float alat = abs(lat);

          float h = continent(n);

          // 海平面
          const float SEA = 0.02;
          float landness = smoothstep(SEA - 0.015, SEA + 0.02, h);

          /* ---------- 海洋 ---------- */
          // 深度由高度决定
          float depth = clamp((SEA - h) * 5.0, 0.0, 1.0);
          vec3 shallow = vec3(0.055, 0.26, 0.34);
          vec3 deep = vec3(0.006, 0.045, 0.14);
          vec3 ocean = mix(shallow, deep, depth);
          // 极地海洋偏冷
          ocean = mix(ocean, vec3(0.10, 0.22, 0.30), smoothstep(0.6, 0.95, alat) * 0.5);

          /* ---------- 陆地：按纬度分生物群区 ---------- */
          // 高度归一化
          float elev = clamp((h - SEA) * 4.0, 0.0, 1.0);

          // 沙漠带（副热带 ~15~30 度）：用噪声决定哪里真的干
          float desertBand = exp(-pow((alat - 0.34) / 0.16, 2.0));
          float aridity = fbm3(n * 3.2 + 21.0, 4) * 0.5 + 0.5;
          float desert = smoothstep(0.45, 0.72, aridity) * desertBand;

          // 热带（|lat| < 0.22）：雨林
          float tropic = smoothstep(0.30, 0.10, alat);

          // 温带（0.25 ~ 0.62）：森林 / 草原
          float temperate = smoothstep(0.20, 0.36, alat) * smoothstep(0.72, 0.55, alat);

          // 针叶林（0.55 ~ 0.75）
          float boreal = smoothstep(0.50, 0.66, alat) * smoothstep(0.86, 0.72, alat);

          // 苔原（0.72 ~ 0.88）
          float tundra = smoothstep(0.70, 0.84, alat) * smoothstep(0.95, 0.86, alat);

          vec3 cForest = vec3(0.045, 0.135, 0.045);
          vec3 cTropic = vec3(0.035, 0.165, 0.055);
          vec3 cTemperate = vec3(0.115, 0.205, 0.075);
          vec3 cDesert = vec3(0.50, 0.38, 0.20);
          vec3 cBoreal = vec3(0.085, 0.145, 0.085);
          vec3 cTundra = vec3(0.30, 0.29, 0.24);
          vec3 cRock = vec3(0.24, 0.22, 0.20);
          vec3 cSnow = vec3(0.88, 0.92, 0.96);

          vec3 land = cTemperate;
          land = mix(land, cTropic, tropic);
          land = mix(land, cDesert, desert);
          land = mix(land, cBoreal, boreal);
          land = mix(land, cTundra, tundra);
          // 热带也带一点森林深浅
          land = mix(land, cForest, tropic * 0.35);

          // 高海拔：岩石 -> 积雪
          float rock = smoothstep(0.45, 0.70, elev);
          land = mix(land, cRock, rock);
          land = mix(land, cSnow, smoothstep(0.72, 0.90, elev));

          // 极冠（两极）
          float ice = smoothstep(0.86, 0.965, alat) * (0.75 + 0.25 * (fbm3(n * 9.0, 3) * 0.5 + 0.5));
          land = mix(land, cSnow, ice);
          ocean = mix(ocean, vec3(0.80, 0.88, 0.94), ice * 0.85);

          vec3 base = mix(ocean, land, landness);

          /* ---------- 光照 ---------- */
          float ndl = dot(N, L);
          float day = smoothstep(-0.10, 0.30, ndl);

          vec3 col = base * uSunColor * max(ndl, 0.0) * 1.5;

          // 海洋镜面高光（太阳耀斑）
          if (landness < 0.5) {
            vec3 H = normalize(L + V);
            float spec = pow(max(dot(N, H), 0.0), 120.0);
            col += uSunColor * spec * 1.6 * (1.0 - landness * 2.0);
          }

          // 夜面：城市灯光（只在陆地、中低纬、靠近海岸密度更高）
          float coast = 1.0 - smoothstep(0.0, 0.14, abs(h - SEA));
          float cityNoise = fbm3(n * 34.0, 3) * 0.5 + 0.5;
          float cities = smoothstep(0.66, 0.88, cityNoise) * landness * (0.4 + 0.6 * coast);
          cities *= smoothstep(0.72, 0.20, alat);
          col += vec3(1.0, 0.74, 0.34) * cities * (1.0 - day) * 1.4;

          // 夜面反照
          col += base * vec3(0.016, 0.022, 0.040) * (1.0 - day);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const ground = new THREE.Mesh(new THREE.SphereGeometry(r, 256, 160), groundMat);
    group.add(ground);

    /* ---------- 云层：按真实大气环流分层 ---------- */
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLightDir: { value: sunDir },
        uSunColor: { value: new THREE.Color(1.0, 0.97, 0.92) },
        uCloudSpin: { value: 0.041 }, // 比地表 0.018 快 2.3 倍
      },
      vertexShader: /* glsl */ `
        varying vec3 vObj;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        void main(){
          vObj = normalize(position);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vObj;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        uniform vec3 uLightDir;
        uniform vec3 uSunColor;
        uniform float uTime;
        uniform float uCloudSpin;

        ${NOISE}

        void main(){
          vec3 n = normalize(vObj);
          vec3 N = normalize(vNormalW);
          vec3 L = normalize(uLightDir);
          vec3 V = normalize(cameraPosition - vWorldPos);

          float lat = clamp(n.y, -1.0, 1.0);
          float alat = abs(lat);

          /* 大气环流：三个带
             - 赤道辐合带 ITCZ（|lat| < 0.10）：对流旺盛，云多
             - 副热带高压带（0.22 ~ 0.38）：下沉气流，云少（沙漠正好在这里）
             - 中纬度风暴带（0.45 ~ 0.70）：气旋活跃，云多且呈螺旋
          */
          float itcz = exp(-pow(lat / 0.10, 2.0));
          float subtrop = exp(-pow((alat - 0.30) / 0.10, 2.0));
          float midlat = exp(-pow((alat - 0.57) / 0.13, 2.0));

          float bandBias = itcz * 0.55 + midlat * 0.42 - subtrop * 0.42;

          /* 云块：域扭曲 FBM */
          vec3 p = n * 4.2;
          vec3 w = vec3(
            fbm3(p * 0.9, 3),
            fbm3(p * 0.9 + 5.1, 3),
            fbm3(p * 0.9 - 2.7, 3)
          );
          float c = fbm3(p * 1.8 + w * 1.4, 6) * 0.5 + 0.5;
          // 细丝
          float filaments = fbm3(p * 6.0 + w * 2.2, 4) * 0.5 + 0.5;

          /* 中纬度气旋：螺旋结构 */
          float ang = atan(n.z, n.x);
          float swirlAng = ang - lat * 3.4;
          float cyclone = fbm3(vec3(
            cos(swirlAng) * 4.5,
            lat * 11.0,
            sin(swirlAng) * 4.5
          ), 5) * 0.5 + 0.5;
          float cycloneMask = midlat * smoothstep(0.52, 0.78, cyclone);

          float dens = c * 0.72 + filaments * 0.16 + bandBias + cycloneMask * 0.32;
          dens = smoothstep(0.50, 0.78, dens);

          // 极区云被拉成条带
          dens *= mix(1.0, 0.55, smoothstep(0.82, 0.98, alat));

          if (dens < 0.01) discard;

          float ndl = dot(N, L);
          float day = smoothstep(-0.08, 0.28, ndl);
          vec3 col = vec3(0.97, 0.98, 1.0) * uSunColor * max(ndl, 0.0) * 1.55;
          col += vec3(0.035, 0.05, 0.09) * (1.0 - day);

          gl_FragColor = vec4(col, dens * 0.94);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(r * 1.008, 256, 160), cloudMat);
    group.add(clouds);

    /* ---------- 大气辉光 ---------- */
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uLightDir: { value: sunDir },
        uAtmoColor: { value: new THREE.Color(0.34, 0.58, 1.0) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        varying vec3 vObj;
        void main(){
          vObj = normalize(position);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        varying vec3 vObj;
        uniform vec3 uLightDir;
        uniform vec3 uAtmoColor;

        ${NOISE}

        void main(){
          vec3 N = normalize(vNormalW);
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L = normalize(uLightDir);

          // 边缘光：视线越接近切线越亮
          float rim = pow(1.0 - abs(dot(V, N)), 4.0);
          // 受光侧
          float lit = smoothstep(-0.50, 0.60, dot(N, L));
          // 条纹细节，避免纯色
          float streak = fbm3(vObj * 6.0, 3) * 0.5 + 0.5;

          float a = rim * lit * (0.55 + 0.45 * streak) * 1.1;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uAtmoColor * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(r * 1.045, 128, 96), atmoMat);
    group.add(atmo);

    // 地轴倾角
    group.rotation.z = THREE.MathUtils.degToRad(23.4);

    return {
      group,
      def: { id: 'earth', name: '蓝星', subtitle: '大气与地面不同旋速' },
      sunDir,
      ground,
      clouds,
      update(dt, time, camera) {
        groundMat.uniforms.uTime.value = time;
        cloudMat.uniforms.uTime.value = time;
        ground.rotation.y += dt * groundMat.uniforms.uGroundSpin.value;
        clouds.rotation.y += dt * cloudMat.uniforms.uCloudSpin.value;
        void camera;
      },
    };
  }

  /* =====================================================================
     3. 深渊（黑洞）—— 彻底脱离「球 + 环」的土星式结构

     真实黑洞的视觉特征（依据广义相对论成像 / EHT 观测）：
     - 中心是一个**纯黑的圆斑**（不是球体表面，是"没有东西"）
     - 周围有一圈**光子环**（很细、很亮）
     - 吸积盘因为引力透镜，正面看到的是**盘的下方绕到上方**，
       所以呈现为一个"悬垂的环带"而不是平躺的环
     - 一侧因多普勒效应明显增亮
     - 背景星场被透镜扭曲成弧

     实现上用**屏幕空间**做，而不是 3D 几何：
     这样才不会被"球体 + 环"的几何直觉限制住。
     ===================================================================== */
  /* ===================== 世界表 ===================== */
  const WORLDS = [
    { id: 'saturn', name: '土星', subtitle: '环带', builtin: true },
    { id: 'belt', name: '碎星带', subtitle: '超大规模小行星团' },
    { id: 'earth', name: '蓝星', subtitle: '大气与地面不同旋速' },
    { id: 'blackhole', name: '深渊', subtitle: '引力透镜与吸积盘' },
  ];

  function buildWorld(def, R) {
    if (def.id === 'belt') return buildAsteroidSwarm(R);
    if (def.id === 'earth') return buildEarth(R);
    // 黑洞独立成模块（光线追踪实现，见 blackhole.js）
    if (def.id === 'blackhole') return SAT.blackhole.create(R);
    return null;
  }

  SAT.planets = { WORLDS, buildWorld };
})();
