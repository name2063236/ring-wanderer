/* =========================================================================
   blackhole.js — 引力透镜黑洞（光线追踪版）

   设计思路（关键区别）：
   旧版是「黑球 + 环形盘 + 描边」三个几何体拼在一起，
   所以看起来像贴片，没有环绕感。

   这版改为对每个像素做**光线偏折积分**：
     1. 从相机出发沿视线方向发射一条光线
     2. 每步施加引力加速度 a = -1.5·h²·r / r⁵（史瓦西时空的光子测地线）
     3. 光线进入视界 → 该像素为黑
     4. 光线穿过吸积盘 → 按体积密度累加发光
     5. 光线逃逸 → 采样星空（方向已被偏折）

   「环绕感」是这么自然产生的：
   盘在我们前方的部分直接可见（横穿画面的一条亮带）；
   盘在黑洞**背后**的部分本该被挡住，但引力把光线弯了过来，
   于是它的像出现在黑洞的上方和下方，形成拱弧。
   两者叠加，就是《星际穿越》里那个把黑洞整个包住的光环。

   因为我们逐像素积分，光子环（光线绕行多圈）、
   多重像、背景星空扭曲全都是**副产物**，不需要单独建模。
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  const vert = /* glsl */ `
    varying vec3 vWorldPos;
    varying vec2 vUv;
    void main(){
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const frag = /* glsl */ `
    precision highp float;

    varying vec3 vWorldPos;
    varying vec2 vUv;

    uniform vec3  uCamPos;
    uniform vec3  uBhPos;
    uniform float uRs;          // 史瓦西半径（世界单位）
    uniform float uDiskIn;      // 盘内缘，单位：rs
    uniform float uDiskOut;     // 盘外缘
    uniform float uTime;
    uniform float uBright;
    uniform float uHalf;        // 画布半宽（世界单位），用于边缘淡出
    uniform sampler2D uSky;     // 背景星空（等距柱状）
    uniform float uHasSky;
    uniform vec3  uDiskHot;
    uniform vec3  uDiskMid;
    uniform vec3  uDiskCool;
    uniform float uTanX;        // 视锥水平半角正切
    uniform float uTanY;        // 视锥垂直半角正切

    #define PI 3.14159265359
    #define STEPS 260

    /* ---------------- 噪声 ---------------- */
    float hash21(vec2 p){
      p = fract(p * vec2(127.31, 311.7));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float noise2(vec2 p){
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm2(vec2 p){
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++){ s += a * noise2(p); p *= 2.03; a *= 0.5; }
      return s;
    }

    /* 等距柱状投影采样坐标 */
    vec2 dirToUv(vec3 d){
      float lon = atan(d.z, d.x);
      float lat = asin(clamp(d.y, -1.0, 1.0));
      return vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
    }

    /* 没有星空贴图时的过程式星点（应急） */
    vec3 procStars(vec3 d){
      float a = atan(d.z, d.x) / (2.0 * PI) + 0.5;
      float b = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI;
      vec2 uv = vec2(a, b) * vec2(220.0, 110.0);
      vec2 cell = floor(uv);
      float h = hash21(cell);
      if (h > 0.985) {
        vec2 f = fract(uv) - 0.5;
        float dist = length(f);
        float br = (h - 0.985) / 0.015;
        return vec3(0.85, 0.90, 1.0) * smoothstep(0.28, 0.0, dist) * br * 1.6;
      }
      return vec3(0.0);
    }

    void main(){
      /* 光线起点与方向。
         quad 被放在「相机前方 PLANE_DIST 处、朝向与相机一致」，
         所以 (vWorldPos - uCamPos) 天然就是该像素的真实视线方向。 */
      vec3 ro = (uCamPos - uBhPos) / uRs;
      vec3 rd = normalize(vWorldPos - uCamPos);

      /* 角动量平方：沿测地线守恒，先算一次 */
      vec3 hvec = cross(ro, rd);
      float h2 = dot(hvec, hvec);

      vec3 p = ro;
      vec3 v = rd;

      vec3 accum = vec3(0.0);
      float absorbed = 0.0;
      float transmittance = 1.0;

      for (int i = 0; i < STEPS; i++) {
        float r2 = dot(p, p);
        float r = sqrt(r2);

        /* 进入视界：被吞掉 */
        if (r < 1.0) { absorbed = 1.0; break; }

        /* 逃逸判定：已经走远且正在远离 */
        if (r > 34.0 && dot(p, v) > 0.0) break;

        /* ---------- 自适应步长 ----------
           三档连续混合：视界附近最细、盘内次之、远场最粗。
           盘内必须足够细 —— 之前 0.11 的步长会让掠射视线在盘里
           只穿过十几步，单步贡献接近饱和，画面出现亮度台阶、
           内缘过曝成纯白。细化到 0.030 后过渡自然。 */
        float rr0 = length(p.xz);
        float inRadial = smoothstep(uDiskIn * 0.80, uDiskIn * 0.98, rr0)
                       * (1.0 - smoothstep(uDiskOut * 0.96, uDiskOut * 1.16, rr0));
        float planeNear = 1.0 - smoothstep(0.04, 0.90, abs(p.y));
        float diskW = inRadial * planeNear;

        float dtFar = clamp(r * 0.075, 0.20, 1.8);
        float dtDisk = 0.014;
        float dtHorizon = 0.045;

        float dt = mix(dtFar, dtDisk, diskW);
        dt = min(dt, mix(dtFar, dtHorizon, 1.0 - smoothstep(2.4, 7.0, r)));

        /* ---------- 吸积盘：体积采样 ---------- */
        float rr = length(p.xz);
        if (rr > uDiskIn && rr < uDiskOut * 1.04) {
          /* 盘的半厚度：外圈更厚（薄雾感），内圈极薄 */
          float t01 = clamp((rr - uDiskIn) / (uDiskOut - uDiskIn), 0.0, 1.0);
          float hgt = 0.030 + 0.16 * pow(t01, 1.8);

          float vert = exp(-(p.y * p.y) / (hgt * hgt));
          if (vert > 0.004) {
            /* 径向包络：内缘陡起，外缘缓慢消失 */
            /* 内缘必须平滑归零。
               原来用 smoothstep(0.0, ...) 在 t01=0 处仍有非零值，
               加上 clamp 把外部的点也映到 t01=0，就会在阴影边缘
               画出一圈白热的细线。改为先排除小数、再平滑上升。 */
            float inner = smoothstep(0.004, 0.085, t01);
            float outer = 1.0 - smoothstep(0.55, 1.0, t01);
            float edge = inner * outer;

            /* 开普勒差动 + 湍流细丝 */
            float ang = atan(p.z, p.x);
            float omega = 2.2 / pow(max(rr / uDiskIn, 0.45), 1.5);
            float ph = ang - uTime * omega;

            float turb = fbm2(vec2(ph * 3.4, rr * 1.35));
            float fila = fbm2(vec2(ph * 13.0, rr * 4.6));
            float fine = fbm2(vec2(ph * 34.0, rr * 11.0));
            /* 径向层纹：多层叠加，形成细密的丝带结构。
               参考图里盘面有明显的同心流线，单层太单调。 */
            float ringA = 0.5 + 0.5 * sin(rr * 21.0 + fila * 9.0);
            float ringB = 0.5 + 0.5 * sin(rr * 47.0 + turb * 11.0);
            float ringC = 0.5 + 0.5 * sin(rr * 96.0 + fine * 14.0);

            /* 锐化：指数越高，亮带越窄、边缘越利 */
            ringA = pow(clamp(ringA, 0.0, 1.0), 2.6);
            ringB = pow(clamp(ringB, 0.0, 1.0), 3.4);
            ringC = pow(clamp(ringC, 0.0, 1.0), 4.0);

            /* 对比加大：亮带更亮、暗隙更暗，线条因此更分明 */
            float ringMod = mix(0.50, 1.55, ringA) * mix(0.70, 1.42, ringB)
                          * mix(0.76, 1.28, ringC);

            /* 三项都拉开对比，细节更硬朗 */
            float dens = edge * vert * (0.40 + 1.00 * turb) * (0.62 + 0.72 * fila)
                       * (0.70 + 0.50 * fine) * ringMod;

            /* 温度随半径下降：内白热 → 橙 → 暗红 */
            /* 温度分层压紧到内缘：白热只占最里面一小圈，
               往外迅速进入金橙、再进入橙红，避免大片发白。 */
            vec3 em = mix(uDiskHot, uDiskMid, smoothstep(0.0, 0.10, t01));
            em = mix(em, uDiskCool, smoothstep(0.22, 0.85, t01));

            /* 内缘额外增亮（最内稳定圆轨道附近温度最高） */
            em *= 1.0 + 2.0 * exp(-t01 * 40.0) * inner;

            /* 光学厚度：越靠内越不透明，形成自遮挡 */
            /* 用 1-exp 形式：单步贡献随 sigma*dt 平滑饱和，
               避免"单步太亮"造成的硬边和过曝。 */
            float sigma = dens * 3.1;
            float absStep = 1.0 - exp(-sigma * dt * 0.85);

            accum += em * absStep * uBright * transmittance;
            transmittance *= exp(-sigma * dt * 0.55);
          }
        }

        /* 不透明度已饱和，后续采样不可见，提前结束 */
        if (transmittance < 0.02) break;

        /* ---------- 引力加速度（光子测地线）---------- */
        vec3 a = -1.5 * h2 * p / (r2 * r2 * r);
        v += a * dt;
        p += v * dt;
      }

      /* ---------- 背景：被偏折的星空 ---------- */
      vec3 skyCol = vec3(0.0);
      if (absorbed < 0.5) {
        vec3 dir = normalize(v);
        if (uHasSky > 0.5) {
          skyCol = texture2D(uSky, dirToUv(dir)).rgb;
        } else {
          skyCol = procStars(dir);
        }
        /* 背景整体提亮：吸积盘很亮，若背景用同一曝光会被压死，
           就看不出星空被引力弯折的形状了。 */
        skyCol *= 1.45;

        /* 黑洞附近再额外收束一点，让透镜区更醒目。
           注意这里系数不能大 —— 光子环本身就是采样背景天空形成的，
           prox 叠太多会把环烧成一圈粗白线。 */
        float prox = pow(clamp(dot(normalize(ro), dir), 0.0, 1.0), 34.0);
        skyCol *= 1.0 + prox * 0.55;

        /* 高亮压缩：提亮后密集星点会结块成白团，
           用一条柔和的上限把最亮处压回来，保持星点颗粒感。 */
        float skyLuma = dot(skyCol, vec3(0.2126, 0.7152, 0.0722));
        skyCol *= 1.0 / (1.0 + skyLuma * 0.55);
      }

      vec3 col = accum + skyCol * transmittance * (1.0 - absorbed);

      /* ---------- 电影感调色 ---------- */
      /* HDR 压缩：抬高曝光让盘更有存在感 */
      col = 1.0 - exp(-col * 1.42);

      /* S 曲线：压暗暗部、抬起亮部，层次更硬朗 */
      vec3 c2 = clamp(col, 0.0, 1.0);
      c2 = c2 * c2 * (3.0 - 2.0 * c2);
      col = mix(c2, c2 * c2, 0.26);

      /* 暖色偏移：金橙感 */
      col.r *= 1.00;
      col.g *= 1.01;
      col.b *= 1.01;

      /* 极亮处推向白金，形成内缘"白热" */
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(luma) * vec3(1.0, 0.97, 0.90), smoothstep(0.86, 1.0, luma) * 0.38);

      /* 饱和度 */
      float gray = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(gray), col, 1.16);

      col *= 1.02;

      /* 暗角：减弱到 0.26，让四角的背景星空也能看见，
         否则透镜扭曲的效果在画面边缘被切掉。 */
      float vig = 1.0 - 0.26 * pow(length(vWorldPos - uCamPos) / max(uHalf, 1.0), 2.0);
      col *= clamp(vig, 0.40, 1.0);

      /* 这个 quad 铺满整个屏幕，内部自己采样星空，
         所以不需要边缘淡出——淡化反而会和背后的天空球重影。 */
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ------------------------------------------------------------------ */
  function create(R) {
    const group = new THREE.Group();
    group.name = 'world_blackhole';

    /* 视界半径：明显放大。相机距离约 9.5 rs 时，
       阴影（视觉半径 2.6 rs）约占画面宽度的 1/3。 */
    const rs = R * 0.86;

    const diskIn = 2.55;
    const diskOut = 13.0;

    const uniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uBhPos: { value: new THREE.Vector3(0, 0, 0) },
      uRs: { value: rs },
      uDiskIn: { value: diskIn },
      uDiskOut: { value: diskOut },
      uTime: { value: 0 },
      uBright: { value: 3.0 },
      uHalf: { value: rs * 17.0 },
      uSky: { value: null },
      uHasSky: { value: 0 },
      uDiskHot: { value: new THREE.Color(1.0, 0.97, 0.88) },
      uDiskMid: { value: new THREE.Color(1.0, 0.76, 0.30) },
      uDiskCool: { value: new THREE.Color(0.86, 0.40, 0.07) },
      uTanX: { value: 0.5 },
      uTanY: { value: 0.35 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    const quadGeo = new THREE.PlaneGeometry(2, 2); // 单位平面，靠 scale 控制大小
    const quad = new THREE.Mesh(quadGeo, mat);
    quad.name = 'bhLensing';
    quad.frustumCulled = false;
    quad.renderOrder = 3;
    group.add(quad);

    /* 世界坐标下的盘平面为 XZ（Y 向上）。
       相机从低仰角观察即可得到接近侧视的构图。 */
    const sunDir = new THREE.Vector3(0.0, 0.15, 0.99).normalize();

    const _fwd = new THREE.Vector3();
    const _bhWorld = new THREE.Vector3();
    const PLANE_DIST = rs * 6.0; // quad 放在相机前方这个距离

    return {
      group,
      def: { id: 'blackhole', name: '深渊', subtitle: '引力透镜与吸积盘' },

      /* 供 main.js 使用：推荐机位（低仰角，接近侧视） */
      /* 出生机位：低仰角（约 8°），悬在盘面上方不远处。
         脚下能看到盘面向外铺展，同时完整看到黑洞与上下拱弧。 */
      camOffset: new THREE.Vector3(-0.9160, 0.1175, -0.3837).normalize(),
      camDistMul: 6.88,

      sunDir,
      rs,
      /* 兼容旧自检的字段（新实现里它们只是标记） */
      disk: { isVolumetric: true },
      horizon: { isRaymarched: true },

      /** 跃迁重新烘焙星空后，把新贴图换上 */
      setSkyTexture(tex) {
        uniforms.uSky.value = tex || null;
        uniforms.uHasSky.value = tex ? 1 : 0;
      },

      update(dt, time, camera) {
        group.getWorldPosition(_bhWorld);

        /* quad 放在相机正前方固定距离，且与相机朝向完全一致，
           这样它的四个角正好对应视锥的四个角。 */
        camera.getWorldDirection(_fwd);
        quad.position.copy(camera.position).addScaledVector(_fwd, PLANE_DIST);
        quad.quaternion.copy(camera.quaternion);
        quad.updateMatrixWorld();

        const tanY = Math.tan((camera.fov * Math.PI) / 360);
        const tanX = tanY * camera.aspect;

        /* 平面尺寸按视锥算，略微放大以覆盖边缘 */
        quad.scale.set(PLANE_DIST * tanX * 2.02, PLANE_DIST * tanY * 2.02, 1);

        uniforms.uCamPos.value.copy(camera.position);
        uniforms.uBhPos.value.copy(_bhWorld);
        uniforms.uTanX.value = tanX * 1.01;
        uniforms.uTanY.value = tanY * 1.01;
        uniforms.uHalf.value = Math.max(rs * diskOut * 1.2, camera.position.distanceTo(_bhWorld));
        uniforms.uTime.value = time;
        void dt;
      },
    };
  }

  SAT.blackhole = { create };
})();
