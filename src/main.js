/* =========================================================================
   main.js — 组装场景、循环、HUD
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  /* ---------------------------------------------------------------
     0. 基础对象
     --------------------------------------------------------------- */
  const canvas = document.getElementById('sky');
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const reducePixels = isTouch || window.devicePixelRatio > 2;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
  } catch (e) {
    SAT.fatal('WebGL 初始化失败：' + e.message);
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, reducePixels ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 400000);
  camera.rotation.order = 'YXZ';

  const R = SAT.CONST.R;
  const KM = SAT.CONST.KM_PER_UNIT;

  /* ---------------------------------------------------------------
     1. 深空背景
     --------------------------------------------------------------- */
  const skyData = SAT.sky.build(renderer);
  const sky = skyData.sky;
  sky.scale.setScalar(160000);
  scene.add(sky);

  const starPoints = skyData.stars;
  starPoints.material.uniforms.uRadius.value = 118000;
  starPoints.material.uniforms.uPixel.value = renderer.getPixelRatio();
  scene.add(starPoints);

  // 镜头方向：从土星外侧俯瞰环面
  const START_DIR = new THREE.Vector3(-0.803, 0.374, -0.464).normalize();
  const START_DIST = 3.32 * R; // 随星球半径增大同比后退，保持屏幕上的观感尺寸
  const startPos = START_DIR.clone().multiplyScalar(START_DIST);

  // 恒星方向（与土星本体/星环着色器共享）
  // 位于观察者侧偏 55°、仰角 14°：形成凸月相位，星环在行星南半球投下阴影
  const SUN_DIR = new THREE.Vector3(-0.88, 0.242, 0.409).normalize();
  SAT.saturn.SUN.copy(SUN_DIR);

  /* 可见的恒星：加色混合的柔光精灵 */
  function makeGlowTexture() {
    const s = 256;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0.0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.06, 'rgba(255,246,225,0.95)');
    grd.addColorStop(0.18, 'rgba(255,214,150,0.42)');
    grd.addColorStop(0.42, 'rgba(180,200,255,0.12)');
    grd.addColorStop(1.0, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const sunSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: 0xfff2d6,
      blending: THREE.AdditiveBlending,
      // 不再依赖深度测试：太阳在 120000 单位外，深度精度已经不够用，
      // 会出现"隔着土星看到太阳"的穿透。改为每帧做射线遮挡判定。
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    })
  );
  sunSprite.scale.setScalar(20000);
  sunSprite.renderOrder = 20;
  scene.add(sunSprite);

  /* 太阳方向的镜头光晕（屏幕空间，随视角自动出现/消失） */
  const flareLayer = document.createElement('div');
  flareLayer.id = 'flare';
  flareLayer.style.cssText =
    'position:fixed;inset:0;z-index:3;pointer-events:none;overflow:hidden;mix-blend-mode:screen;';
  const flareCore = document.createElement('div');
  flareCore.style.cssText =
    'position:absolute;left:0;top:0;width:520px;height:520px;margin:-260px 0 0 -260px;border-radius:50%;' +
    'background:radial-gradient(circle,rgba(255,244,220,.85) 0%,rgba(255,214,150,.30) 18%,' +
    'rgba(190,170,255,.10) 42%,rgba(0,0,0,0) 70%);opacity:0;will-change:transform,opacity;';
  const flareStreak = document.createElement('div');
  flareStreak.style.cssText =
    'position:absolute;left:0;top:0;width:1400px;height:2px;margin:-1px 0 0 -700px;' +
    'background:linear-gradient(90deg,transparent,rgba(180,205,255,.38),transparent);' +
    'opacity:0;will-change:transform,opacity;';
  const flareGhost = document.createElement('div');
  flareGhost.style.cssText =
    'position:absolute;left:0;top:0;width:160px;height:160px;margin:-80px 0 0 -80px;border-radius:50%;' +
    'background:radial-gradient(circle,rgba(120,220,255,.22),rgba(0,0,0,0) 68%);' +
    'opacity:0;will-change:transform,opacity;';
  flareLayer.append(flareCore, flareStreak, flareGhost);
  document.body.appendChild(flareLayer);

  const _sunNDC = new THREE.Vector3();
  const _camDir = new THREE.Vector3();

  /* ---------------------------------------------------------------
     背光时刻（backlit）
     星环着色器里本来就有前向散射项 pow(dot(-L, V), 5.0)：
     当你飞到土星的背光侧、回头望向环带时，冰晶会把阳光散射向你，
     环会整条亮起来——就是「暗淡蓝点」那张著名照片里的光轴。
     这个效果已经存在，这里只是把它变成"可被发现的秘密"。
     --------------------------------------------------------------- */
  let backlitLevel = 0;
  const elBacklit = document.getElementById('backlit');

  function updateBacklit() {
    // 玩家指向土星的方向，与「背离恒星」的方向越接近，背光越强
    const toSaturn = _v_.copy(camera.position).multiplyScalar(-1).normalize();
    const antiSun = _v2_.copy(SUN_DIR).multiplyScalar(-1).normalize();

    // 两者夹角越小说明玩家在恒星的对面、正对着被照亮的环
    const align = toSaturn.dot(antiSun);
    // 0.75 以上开始出现提示，接近 1 时最强
    const target = SAT.smoothstep(0.62, 0.96, align);

    backlitLevel = SAT.damp(backlitLevel, target, 2.2, 1 / 60);

    if (elBacklit) {
      const show = backlitLevel > 0.12;
      elBacklit.style.opacity = show ? String((backlitLevel * 0.9).toFixed(2)) : '0';
      elBacklit.classList.toggle('active', show);
    }
    return backlitLevel;
  }

  const _v_ = new THREE.Vector3();
  const _v2_ = new THREE.Vector3();

  /* 判断从相机沿恒星方向是否被土星本体挡住。
     深度测试在 120000 单位的距离上精度不足，所以用解析求交。 */
  function sunOccluded() {
    const camR2 = camera.position.lengthSq();
    const b = camera.position.dot(SUN_DIR);
    const disc = b * b - (camR2 - R * R);
    if (disc <= 0) return false;
    const t = -b - Math.sqrt(disc);
    return t > 0;
  }

  function updateFlare() {
    camera.getWorldDirection(_camDir);
    _sunNDC.copy(camera.position).addScaledVector(SUN_DIR, 1000);
    _sunNDC.project(camera);

    const facing = _camDir.dot(SUN_DIR);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const sx = (_sunNDC.x * 0.5 + 0.5) * w;
    const sy = (-_sunNDC.y * 0.5 + 0.5) * h;

    // 只在朝向恒星时可见，靠近视野边缘淡出；被土星遮挡时完全不可见
    const hidden = sunOccluded() ? 0 : 1;
    const vis =
      facing > 0.55
        ? hidden * SAT.smoothstep(0.55, 0.9, facing) * SAT.smoothstep(1.6, 0.75, Math.max(Math.abs(_sunNDC.x), Math.abs(_sunNDC.y)))
        : 0;

    if (vis < 0.002) {
      flareCore.style.opacity = '0';
      flareStreak.style.opacity = '0';
      flareGhost.style.opacity = '0';
      return;
    }

    const k = vis.toFixed(3);
    flareCore.style.opacity = k;
    flareCore.style.transform = `translate(${sx}px,${sy}px) scale(${(0.6 + 0.5 * facing).toFixed(2)})`;

    flareStreak.style.opacity = (vis * 0.8).toFixed(3);
    flareStreak.style.transform =
      `translate(${sx}px,${sy}px) rotate(${(Math.atan2(_sunNDC.y, _sunNDC.x) * 180) / Math.PI - 90}deg)`;

    // 鬼影：恒星与画面中心的对称点
    const gx = w - sx;
    const gy = h - sy;
    flareGhost.style.opacity = (vis * 0.75).toFixed(3);
    flareGhost.style.transform = `translate(${gx}px,${gy}px) scale(${(0.8 + 0.6 * vis).toFixed(2)})`;
  }

  /* 近场星尘（提供视差与速度感） */
  const dustCount = reducePixels ? 900 : 2200;
  const dustPos = new Float32Array(dustCount * 3);
  const dustSeed = new Float32Array(dustCount);
  {
    const rng = SAT.rng(991);
    for (let i = 0; i < dustCount; i++) {
      dustPos[i * 3] = rng.range(-1, 1);
      dustPos[i * 3 + 1] = rng.range(-1, 1);
      dustPos[i * 3 + 2] = rng.range(-1, 1);
      dustSeed[i] = rng.f();
    }
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 1));
  const dustMat = new THREE.ShaderMaterial({
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uRange: { value: 2600 },
      uTime: { value: 0 },
      uPixel: { value: renderer.getPixelRatio() },
      uSpeed: { value: 0 }, // 0~1，高速时把粒子拉成流线
      uDir: { value: new THREE.Vector3(0, 0, -1) },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uCam; uniform float uRange; uniform float uTime; uniform float uPixel;
      uniform float uSpeed; uniform vec3 uDir;
      attribute float aSeed;
      varying float vAlpha;
      varying float vStretch;

      void main(){
        vec3 p = position * uRange;
        // 以相机为圆心做环形包裹
        vec3 rel = mod(p - uCam + uRange, uRange * 2.0) - uRange;
        vec3 wp = uCam + rel;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mv;

        float d = length(rel);
        float fade = smoothstep(uRange, uRange * 0.25, d) * smoothstep(14.0, 90.0, d);
        vAlpha = fade * (0.25 + 0.75 * aSeed) * (0.65 + 0.35 * sin(uTime * 1.7 + aSeed * 40.0));

        // 速度感：高速时粒子沿视线方向拉长。
        // 用 gl_PointSize 无法做椭圆，改为把亮度提高并让"朝向相机"的粒子更亮，
        // 再配合后处理的运动模糊观感；这里主要靠 alpha 提升 + 尺寸微调。
        float toward = abs(dot(normalize(rel), uDir));
        float speedBoost = uSpeed * uSpeed;
        vStretch = speedBoost * toward;

        vAlpha *= 1.0 + vStretch * 1.8;
        gl_PointSize = (1.1 + aSeed * 2.2) * uPixel * (320.0 / max(-mv.z, 1.0))
                     * (1.0 + vStretch * 2.2);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vStretch;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r) * vAlpha;
        // 高速时偏冷白，低速偏蓝
        vec3 col = mix(vec3(0.72, 0.82, 1.0), vec3(0.90, 0.95, 1.0), vStretch);
        gl_FragColor = vec4(col * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  scene.add(dust);

  /* ---------------------------------------------------------------
     2. 土星系统
     --------------------------------------------------------------- */
  const envTop = new THREE.Color(0.16, 0.20, 0.34);
  const envBot = new THREE.Color(0.07, 0.08, 0.13);
  const saturn = SAT.saturn.build(envTop, envBot, startPos);
  scene.add(saturn.system);
  saturn.system.rotation.z = THREE.MathUtils.degToRad(-6.5);
  saturn.system.rotation.x = THREE.MathUtils.degToRad(4.0);

  /* ---------------------------------------------------------------
     2.5 其他可跃迁到达的目的地
     三个世界在物理机制上就不同：碎星带（四万颗岩石团）、
     蓝星（大气与地面不同旋速）、深渊（黑洞吸积盘）。
     --------------------------------------------------------------- */
  const otherWorlds = {};
  for (const def of SAT.planets.WORLDS) {
    if (def.builtin) continue;
    const w = SAT.planets.buildWorld(def, R);
    if (!w) continue;
    w.group.visible = false; // 初始不显示，跃迁后才出场
    w.group.position.set(0, 0, 0);
    scene.add(w.group);
    otherWorlds[def.id] = w;
  }

  // 当前所在的世界（saturn = 主场景）
  let currentWorldId = 'saturn';

  /* ---------------------------------------------------------------
     3. 玩家 / 相机
     --------------------------------------------------------------- */
  camera.position.copy(startPos);
  const player = SAT.player.create(camera, canvas);
  player.lookAt(new THREE.Vector3(0, 0, 0));

  /* ---------------------------------------------------------------
     3.5 音效 / 玩法（碰撞 + 信标）
     --------------------------------------------------------------- */
  const audio = SAT.audio.create();

  const gameplay = SAT.gameplay.create({
    saturn,
    R,
    ringThickness: SAT.saturn.getRingThickness(),
  });
  // 不再有信标，attach 是空操作（保留调用以兼容）
  gameplay.attach(scene);

  /* 环带内部体积雾：玩家钻进环带时生效（需要 bloom，所以放到后面初始化） */
  let ringfog = null;

  /* ---------------------------------------------------------------
     4. 后处理
     --------------------------------------------------------------- */
  const bloom = SAT.bloom.create(renderer, {
    threshold: 0.62,
    soft: 0.5,
    strength: 1.05,
    scale: reducePixels ? 0.4 : 0.5,
  });

  /* 环带内部体积雾（依赖 bloom 的后处理钩子） */
  ringfog = SAT.ringfog.create({
    R,
    ringNormal: SAT.saturn.RING_NORMAL,
    ringThickness: SAT.saturn.getRingThickness(),
    renderer,
  });
  scene.add(ringfog.motes);
  bloom.setAfterHook((texture) => {
    ringfog.composite(texture, null);
  });

  /* ---------------------------------------------------------------
     4.5 跃迁星轨
     --------------------------------------------------------------- */
  const starlines = SAT.starlines.create({ count: 1400 });
  scene.add(starlines.mesh);

  // 记录土星的原始太阳方向，方便跃迁回来
  const saturnStartSun = SUN_DIR.clone();

  /* 跃迁：星轨 → 爆闪 → 另一颗星球 */
  const warp = SAT.warp.create({
    camera,
    scene,
    starlines,
    audio,
    /** 白屏最亮的瞬间执行：真正把世界换掉 */
    onSwap(worldId) {
      const target = otherWorlds[worldId];

      // 隐藏当前世界
      if (currentWorldId === 'saturn') {
        saturn.system.visible = false;
        if (gameplay.group) gameplay.group.visible = false;
        if (relic) relic.visible = false;
        ringfog.motes.visible = false;
      } else {
        const cur = otherWorlds[currentWorldId];
        if (cur) cur.group.visible = false;
      }

      // 显示目标世界
      if (target) {
        target.group.visible = true;
        currentWorldId = worldId;

        // 换太阳方向：整个场景的光照方向跟着改
        SUN_DIR.copy(target.sunDir);
        SAT.saturn.SUN.copy(target.sunDir);

        // 换环境色（三个世界没有 bgTint，用各自的默认值）
        const bt = target.def.bgTint || [0.05, 0.05, 0.08];
        if (sky.material.color) {
          sky.material.color.setRGB(bt[0] * 3, bt[1] * 3, bt[2] * 3);
        }

        // 相机拉回合适的观察距离（不同世界尺度不同）
        const distMul =
          worldId === 'blackhole' ? 6.2 : worldId === 'belt' ? 3.8 : 3.2;
        camera.position
          .copy(new THREE.Vector3(-0.8, 0.37, -0.46).normalize())
          .multiplyScalar(distMul * R);
        player.lookAt(new THREE.Vector3(0, 0, 0));
      } else {
        // 目标是土星：恢复主场景
        saturn.system.visible = true;
        if (gameplay.group) gameplay.group.visible = true;
        if (relic) relic.visible = true;
        ringfog.motes.visible = true;
        currentWorldId = 'saturn';

        SUN_DIR.copy(saturnStartSun);
        SAT.saturn.SUN.copy(saturnStartSun);
        if (sky.material.color) sky.material.color.setRGB(1, 1, 1);

        camera.position.copy(startPos);
        player.lookAt(new THREE.Vector3(0, 0, 0));
      }

      // 天空重烤：换一片星空
      try {
        SAT.sky.rebake(skyData, Math.floor(Math.random() * 90000) + 1000, renderer);
      } catch (e) {
        /* 忽略 */
      }
    },
  });

  /* ---------------------------------------------------------------
     5.6 拍照模式 / 航行日志 / 遗物
     --------------------------------------------------------------- */
  const voyageLog = SAT.photo.createLog();

  const photo = SAT.photo.createPhoto({
    renderer,
    scene,
    camera,
    bloom,
    ringfog,
    uiRoots: [
      document.getElementById('telemetry'),
      document.getElementById('compass'),
      document.getElementById('reticle'),
      document.getElementById('veloWrap'),
      document.getElementById('backlit'),
      document.getElementById('audioBtn'),
      document.getElementById('mobileHint'),
    ],
    info: () => ({
      dist: fmt(Math.round(camera.position.length() * KM)) + ' km',
      speed: (player.state.velocity.length() * KM).toFixed(0) + ' km/s',
      beacon: '',
    }),
  });

  /* ---- 稀有遗物：不做任务、不解释，只是一件不属于你的东西 ---- */
  function makeRelic() {
    const rng = SAT.rng(55123);
    // 放在环带外围一个不起眼的方位
    const ang = rng.range(0, Math.PI * 2);
    const ru = rng.range(2.15, 2.35);
    const rad = ru * R;

    const g = new THREE.Group();

    // 主体：一段断裂的桁架
    const bodyGeo = new THREE.CylinderGeometry(3.2, 4.0, 34, 8, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x8a8f99,
      wireframe: true,
      transparent: true,
      opacity: 0.55,
    });
    const body = new THREE.Mesh(bodyGeo, mat);
    body.rotation.z = Math.PI / 2.6;
    g.add(body);

    // 一点残余的指示灯
    const lamp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        color: 0xff6a3a,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    lamp.scale.setScalar(26);
    lamp.position.set(14, 6, 0);
    g.add(lamp);

    g.position.set(Math.cos(ang) * rad, rng.range(-40, 40), Math.sin(ang) * rad);
    g.name = 'relic';
    g.userData.angle = ang;
    g.userData.orbit = rad;
    g.userData.omega = (0.16 / Math.pow(ru, 1.5)) * 0.6;
    g.userData.lamp = lamp;

    return g;
  }

  const relic = makeRelic();
  scene.add(relic);
  let relicFound = false;

  /* ---------------------------------------------------------------
     5. HUD
     --------------------------------------------------------------- */
  const el = {
    dist: document.getElementById('tDist'),
    ring: document.getElementById('tRing'),
    vert: document.getElementById('tVert'),
    world: document.getElementById('tWorld'),
    hitFlash: document.getElementById('hitFlash'),
    speed: document.getElementById('tSpeed'),
    pos: document.getElementById('tPos'),
    velo: document.getElementById('velo'),
    intro: document.getElementById('intro'),
    start: document.getElementById('start'),
    toast: document.getElementById('toast'),
    speedFx: document.getElementById('speedFx'),
    reticle: document.getElementById('reticle'),
    cmpRot: document.getElementById('cmpRot'),
    cmpDeg: document.getElementById('cmpDeg'),
  };

  let toastTimer = 0;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('on'), ms || 1700);
  }

  const fmt = (n) => Math.round(n).toLocaleString('en-US');

  function updateHUD(speed) {
    const p = camera.position;
    el.dist.textContent = fmt(p.length() * KM) + ' km';
    el.ring.textContent = (p.y >= 0 ? '+' : '−') + fmt(Math.abs(p.y) * KM) + ' km';
    el.pos.textContent = `${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}`;

    // 垂直速度：明确告诉玩家此刻在上升还是下降（Space 上升 / Shift 下降）
    const vy = player.state.velocity.y * KM; // km/s
    const rising = vy > 0.5;
    const falling = vy < -0.5;
    el.vert.textContent = rising ? '▲ 上升' : falling ? '▼ 下降' : '— 稳定';
    el.vert.style.color = rising ? '#8ff0b0' : falling ? '#ffb08f' : '';

    el.speed.textContent = (speed * KM).toFixed(0) + ' km/s';
    el.velo.style.width = Math.min(100, (speed / (105 * 8.5)) * 100).toFixed(0) + '%';

    // 当前所在世界
    if (el.world) {
      const wd = SAT.planets.WORLDS.find((w) => w.id === currentWorldId);
      el.world.textContent = wd ? wd.name : currentWorldId;
    }

    // 罗盘：土星在视野中的方位
    const toSaturn = new THREE.Vector3().copy(p).multiplyScalar(-1).normalize();
    const yawSaturn = Math.atan2(-toSaturn.x, -toSaturn.z);
    const yawCam = player.getHeading();
    let rel = yawSaturn - yawCam;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    el.cmpRot.setAttribute('transform', `rotate(${(rel * 180) / Math.PI} 59 59)`);
    el.cmpDeg.textContent = String(Math.round(((((-rel * 180) / Math.PI) % 360) + 360) % 360)).padStart(3, '0') + '°';
  }

  /* ---------------------------------------------------------------
     5.5 玩法反馈 / 设置面板
     --------------------------------------------------------------- */
  let hitFlashTimer = 0;
  let pulseTimer = 0;

  function flashHit(strength) {
    el.hitFlash.style.transition = 'opacity .06s ease-out';
    el.hitFlash.style.opacity = String(SAT.clamp(0.35 + strength * 0.45, 0.2, 1));
    clearTimeout(hitFlashTimer);
    hitFlashTimer = setTimeout(() => {
      el.hitFlash.style.transition = 'opacity .5s ease-out';
      el.hitFlash.style.opacity = '0';
    }, 70);
  }

  function onGameEvent(type, data) {
    if (type === 'impact') {
      flashHit(data.strength || 1);
      audio.impact(data.strength || 1);
      player.state.velocity.multiplyScalar(0.25);
      player.state.shake = Math.max(player.state.shake, 0.012);
      toast('撞击 · 速度衰减', 1200);
    }
  }

  /* ---------------- 设置面板 ---------------- */
  const settings = {
    sens: 1,
    quality: 1,
    bloom: 1,
    thickness: 1,
    audio: true,
    spikeGuard: true,
  };

  const sEl = {
    panel: document.getElementById('settings'),
    sens: document.getElementById('sSens'),
    sensVal: document.getElementById('sSensVal'),
    qual: document.getElementById('sQual'),
    qualVal: document.getElementById('sQualVal'),
    bloom: document.getElementById('sBloom'),
    bloomVal: document.getElementById('sBloomVal'),
    thick: document.getElementById('sThick'),
    thickVal: document.getElementById('sThickVal'),
    audio: document.getElementById('sAudio'),
    spike: document.getElementById('sSpike'),
    reset: document.getElementById('sReset'),
    audioBtn: document.getElementById('audioBtn'),
  };

  const BASE_SENS = player.state.sensitivity;
  const BASE_PIXEL_RATIO = renderer.getPixelRatio();
  const BASE_BLOOM = bloom.strength !== undefined ? bloom.strength : 1.05;

  function applySettings() {
    // 灵敏度
    player.state.sensitivity = BASE_SENS * settings.sens;

    // 画质：缩放像素比
    renderer.setPixelRatio(BASE_PIXEL_RATIO * settings.quality);
    resize();

    // 泛光
    if (bloom.setStrength) bloom.setStrength(BASE_BLOOM * settings.bloom);

    // 环境音
    audio.setEnabled(settings.audio);
    sEl.audioBtn.classList.toggle('off', !settings.audio);
    sEl.audioBtn.textContent = settings.audio ? '♪' : '✕';

    // 尖峰防护
    player.setSpikeGuard(settings.spikeGuard);

    // 数值标签
    sEl.sensVal.textContent = settings.sens.toFixed(2) + '×';
    sEl.qualVal.textContent = settings.quality.toFixed(2) + '×';
    sEl.bloomVal.textContent = settings.bloom.toFixed(2) + '×';
    sEl.thickVal.textContent = settings.thickness.toFixed(2) + '×';
  }

  function openSettings(open) {
    sEl.panel.classList.toggle('on', !!open);
    if (open) document.exitPointerLock && document.exitPointerLock();
  }

  sEl.sens.addEventListener('input', (e) => {
    settings.sens = Number(e.target.value);
    applySettings();
  });
  sEl.qual.addEventListener('input', (e) => {
    settings.quality = Number(e.target.value);
    applySettings();
  });
  sEl.bloom.addEventListener('input', (e) => {
    settings.bloom = Number(e.target.value);
    applySettings();
  });
  sEl.thick.addEventListener('input', (e) => {
    settings.thickness = Number(e.target.value);
    if (saturn.rings.userData.rebuildThickness) {
      saturn.rings.userData.rebuildThickness(settings.thickness);
    }
    sEl.thickVal.textContent = settings.thickness.toFixed(2) + '×';
  });
  sEl.audio.addEventListener('change', (e) => {
    settings.audio = e.target.checked;
    applySettings();
  });
  sEl.spike.addEventListener('change', (e) => {
    settings.spikeGuard = e.target.checked;
    applySettings();
  });
  sEl.audioBtn.addEventListener('click', () => {
    settings.audio = !settings.audio;
    sEl.audio.checked = settings.audio;
    applySettings();
  });
  sEl.reset.addEventListener('click', () => {
    settings.sens = 1;
    settings.quality = 1;
    settings.bloom = 1;
    settings.thickness = 1;
    settings.audio = true;
    settings.spikeGuard = true;
    sEl.sens.value = '1';
    sEl.qual.value = '1';
    sEl.bloom.value = '1';
    sEl.thick.value = '1';
    sEl.audio.checked = true;
    sEl.spike.checked = true;
    if (saturn.rings.userData.rebuildThickness) {
      saturn.rings.userData.rebuildThickness(1);
    }
    applySettings();
    toast('已恢复默认设置', 1400);
  });

  /* Esc：解锁指针时弹出设置（而不是空转） */
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      if (photo.active) {
        photo.exit();
        return;
      }
      if (sEl.panel.classList.contains('on')) {
        openSettings(false);
      } else if (!document.pointerLockElement) {
        openSettings(true);
      }
    }
  });

  /* ---------------------------------------------------------------
     5.7 P 拍照 / L 日志 / T 跃迁
     --------------------------------------------------------------- */
  const elLog = {
    panel: document.getElementById('logPanel'),
    text: document.getElementById('logText'),
    export: document.getElementById('logExport'),
    shoot: document.getElementById('pbShoot'),
  };

  function openLog(open) {
    elLog.panel.classList.toggle('on', !!open);
    if (open) {
      elLog.text.textContent = voyageLog.format();
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }

  elLog.export.addEventListener('click', () => {
    const blob = new Blob([voyageLog.format()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voyage-log.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1200);
    toast('航行日志已导出', 1600);
  });

  elLog.shoot.addEventListener('click', () => {
    const name = photo.capture();
    toast('已保存 ' + name, 2200);
  });

  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;

    // P：拍照模式
    if (e.code === 'KeyP') {
      const on = photo.toggle();
      toast(on ? '拍照模式 · 拖动取景，按 P 拍摄' : '已退出拍照模式', 1800);
      if (on && document.pointerLockElement) document.exitPointerLock();
    }

    // 拍照模式下按空格拍摄
    if (e.code === 'Space' && photo.active) {
      e.preventDefault();
      const name = photo.capture();
      toast('已保存 ' + name, 2000);
    }

    // L：航行日志
    if (e.code === 'KeyL') {
      openLog(!elLog.panel.classList.contains('on'));
    }

    // T：打开跃迁目的地选择（M 也作为备选键）
    if ((e.code === 'KeyT' || e.code === 'KeyM') && !warp.active) {
      openWarpMenu(!warpPanel.classList.contains('on'));
    }

    // 数字键 1-4：直接跳到对应世界
    if (/^Digit[1-4]$/.test(e.code) && !warp.active) {
      const idx = Number(e.code.slice(5)) - 1;
      const def = SAT.planets.WORLDS[idx];
      if (def && def.id !== currentWorldId) {
        openWarpMenu(false);
        warp.setTargetLabel(def.name);
        warp.start(def.id, (id) => {
          const d = SAT.planets.WORLDS.find((w) => w.id === id);
          toast(`已抵达 · ${d ? d.name : id}`, 2600);
          voyageLog.add('warp-' + id, `跃迁抵达「${d ? d.name : id}」`, d ? d.subtitle : '');
        });
        toast('跃迁准备 · 星轨加速中', 1400);
      }
    }
  });

  /* ---------------------------------------------------------------
     5.8 跃迁目的地选择
     --------------------------------------------------------------- */
  const warpPanel = document.getElementById('warpPanel');
  const warpListEl = document.getElementById('warpList');

  function buildWarpList() {
    if (!warpListEl) return;
    warpListEl.innerHTML = '';
    for (const def of SAT.planets.WORLDS) {
      const isCurrent = def.id === currentWorldId;
      const btn = document.createElement('button');
      btn.className = 'warp-item' + (isCurrent ? ' current' : '');
      btn.innerHTML =
        `<span class="wi-name">${def.name}</span>` +
        `<span class="wi-sub">${def.subtitle}</span>` +
        (isCurrent ? '<span class="wi-tag">当前</span>' : '');
      btn.addEventListener('click', () => {
        if (warp.active) return;
        if (def.id === currentWorldId) {
          openWarpMenu(false);
          toast('已经在这里了', 1400);
          return;
        }
        openWarpMenu(false);
        warp.setTargetLabel(def.name);
        warp.start(def.id, (id) => {
          const d = SAT.planets.WORLDS.find((w) => w.id === id);
          toast(`已抵达 · ${d ? d.name : id}`, 2600);
          voyageLog.add('warp-' + id, `跃迁抵达「${d ? d.name : id}」`, d ? d.subtitle : '');
        });
        toast('跃迁准备 · 星轨加速中', 1400);
      });
      warpListEl.appendChild(btn);
    }
  }

  function openWarpMenu(open) {
    if (!warpPanel) return;
    if (open) {
      if (warp.active) return;
      buildWarpList();
      warpPanel.classList.add('on');
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      warpPanel.classList.remove('on');
    }
  }

  // 点击遮罩空白处关闭
  if (warpPanel) {
    warpPanel.addEventListener('click', (e) => {
      if (e.target === warpPanel) openWarpMenu(false);
    });
  }

  /* Esc 也要能关掉跃迁菜单 */
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && warpPanel && warpPanel.classList.contains('on')) {
      openWarpMenu(false);
    }
  });

  /* ---------------------------------------------------------------
     6. 指针锁定 / 开场
     --------------------------------------------------------------- */
  let started = false;
  SAT.onLockChange = (locked) => {
    el.intro.classList.toggle('hidden', locked);
    el.reticle.style.opacity = locked ? '1' : '0.25';
    if (locked) {
      // 音频必须由用户手势启动（浏览器策略），指针锁定本身就发生在点击后
      if (!audio.ready) {
        audio.init();
      }
      audio.resume();
      if (!started) {
        started = true;
        setTimeout(() => toast('环带锁定 · 自由飞行', 2200), 380);
      }
      el.start.textContent = '继续飞行 · 点击锁定视角';
    }
  };

  el.start.addEventListener('click', () => {
    // 先把音频拉起来（在用户手势的同一调用栈内最可靠）
    if (!audio.ready) audio.init();
    audio.resume();
    // 触屏设备没有指针锁定，直接把遮罩收掉，用拖动环视
    if (isTouch) {
      el.intro.classList.add('hidden');
      player.setEnabled(true);
      if (!started) {
        started = true;
        setTimeout(() => toast('拖动屏幕环视 · 左下角按住前进', 2400), 400);
      }
      startTouchMode();
      return;
    }
    player.requestLock();
    // 某些浏览器下需要直接触发一次，兜底
    if (!document.pointerLockElement) player.requestLock();
  });

  /* ---------------------------------------------------------------
     6.5 触屏：拖动环视 + 虚拟摇杆移动
     指针锁定在移动端不可用，这里用触摸事件补一套等效操作。
     --------------------------------------------------------------- */
  let touchMode = false;
  function startTouchMode() {
    if (touchMode) return;
    touchMode = true;
    document.getElementById('mobileHint').style.display = 'block';

    let lookId = null;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      // 左下角留给"前进"，其余区域用于环视
      const isLeftBottom = e.clientX < window.innerWidth * 0.35 && e.clientY > window.innerHeight * 0.5;
      if (isLeftBottom) {
        player.state.keys['KeyW'] = true;
        return;
      }
      lookId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== lookId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // 触屏上手指位移单位与鼠标不同，给一个更小的系数
      player.testInput(null, { dx: dx * 1.6, dy: dy * 1.6 });
    });

    const endTouch = (e) => {
      if (e.pointerId === lookId) lookId = null;
      player.state.keys['KeyW'] = false;
    };
    canvas.addEventListener('pointerup', endTouch);
    canvas.addEventListener('pointercancel', endTouch);
  }
  canvas.addEventListener('click', () => {
    if (!document.pointerLockElement) {
      if (!audio.ready) audio.init();
      audio.resume();
      player.requestLock();
    }
  });

  /* ---------------------------------------------------------------
     7. 尺寸
     --------------------------------------------------------------- */
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    bloom.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------------------------------------------------------------
     8. 主循环
     --------------------------------------------------------------- */
  const clock = new THREE.Clock();
  let time = 0;
  let fov = camera.fov;
  let hudAccum = 0;
  const maxPixelRatio = renderer.getPixelRatio();
  const perf = { acc: 0, frames: 0 };
  const _fwdTmp = new THREE.Vector3();

  function frame() {
    requestAnimationFrame(frame);
    let dt = clock.getDelta();
    dt = Math.min(dt, 0.05);
    time += dt;

    // 自适应画质：连续掉帧时降低渲染分辨率，保持操作跟手。
    // 注意：调整分辨率会重建全部 render target，本身会有一次开销，
    // 所以只在"持续"掉帧/富余时才调整，避免周期性反复重建。
    // 设置面板手动指定画质时，不参与自适应（避免两边打架）。
    perf.acc += dt;
    perf.frames++;
    if (perf.acc > 1.2 && !perf.locked) {
      const fps = perf.frames / perf.acc;
      perf.acc = 0;
      perf.frames = 0;

      // 低帧率连续出现 3 次才降档；高帧率也要稳定 6 次才升档
      if (fps < 40) {
        perf.low = (perf.low || 0) + 1;
        perf.high = 0;
      } else if (fps > 58) {
        perf.high = (perf.high || 0) + 1;
        perf.low = 0;
      } else {
        perf.low = 0;
        perf.high = 0;
      }

      const cur = renderer.getPixelRatio();
      if (perf.low >= 3 && cur > 0.75) {
        renderer.setPixelRatio(Math.max(0.75, cur * 0.85));
        resize();
        perf.low = 0;
      } else if (perf.high >= 6 && cur < maxPixelRatio - 0.01) {
        renderer.setPixelRatio(Math.min(maxPixelRatio, cur * 1.06));
        resize();
        perf.high = 0;
      }
    }

    const st = player.update(dt, time);

    // 天空球 / 恒星跟随相机
    sky.position.copy(camera.position);
    starPoints.position.copy(camera.position);
    starPoints.material.uniforms.uTime.value = time;
    sunSprite.position.copy(camera.position).addScaledVector(SUN_DIR, 120000);

    /* 太阳被土星本体遮挡时应当消失（复用同一个解析判定） */
    {
      const occluded = sunOccluded();
      const m = sunSprite.material;
      m.opacity = SAT.damp(m.opacity, occluded ? 0 : 0.9, 12, 1 / 60);
      sunSprite.visible = m.opacity > 0.01;
    }

    dustMat.uniforms.uCam.value.copy(camera.position);
    dustMat.uniforms.uTime.value = time;
    // 速度感：高速时把星尘拉成流线
    dustMat.uniforms.uSpeed.value = SAT.clamp(st.speed / 900, 0, 1);
    player.getForward(_fwdTmp);
    dustMat.uniforms.uDir.value.copy(_fwdTmp);

    saturn.update(dt, time, camera, camera.fov, window.innerHeight * renderer.getPixelRatio());

    // 其他星球（只有当前显示的那个需要更新）
    if (currentWorldId !== 'saturn') {
      const w = otherWorlds[currentWorldId];
      if (w && w.group.visible) w.update(dt, time, camera);
    }

    // 玩法层：碰撞检测 + 信标采样（只在土星世界里生效）
    if (currentWorldId === 'saturn') {
      gameplay.update(dt, time, camera, st.speed, onGameEvent);
    }

    // 环带体积雾（内部会驱动雾密度、冰粒、能见度）
    ringfog.update(dt, time, camera);

    // 遗物：缓慢公转 + 靠近即被"发现"
    if (relic) {
      relic.userData.angle += relic.userData.omega * dt;
      const ra = relic.userData.angle;
      relic.position.set(
        Math.cos(ra) * relic.userData.orbit,
        relic.position.y,
        Math.sin(ra) * relic.userData.orbit
      );
      relic.userData.lamp.material.opacity = 0.45 + 0.45 * Math.sin(time * 3.1);
      if (!relicFound && camera.position.distanceTo(relic.position) < R * 0.12) {
        relicFound = true;
        audio.collect();
        toast('发现不明遗物', 2600);
        voyageLog.add('relic', '找到了一件不明遗物', '环带外侧 · 不属于这里的构造物');
      }
    }

    // 航行日志：把"值得记住的事"记下来（只记第一次）
    {
      const dist = camera.position.length();
      if (dist < R * 1.30) {
        voyageLog.add('dive-deep', '第一次深入土星近旁', `${Math.round((dist * KM) / 1000)} 千公里处`);
      }
      if (ringfog.state.density > 0.55) {
        voyageLog.add('in-ring', '第一次飞进环带内部', '冰粒密度高到遮蔽视线');
      }
      if (camera.position.y > R * 1.8) {
        voyageLog.add('high', '飞到环面之上', '俯瞰整条星环');
      }
    }

    // 跃迁过渡（会接管 FOV 与星尘）
    warp.update(dt, time);

    // 环境音随速度 / 加速状态变化
    audio.update(dt, st.speed, st.boosting);

    // 加速时 FOV 拉伸
    const targetFov = st.boosting ? 74 : 60;
    fov = SAT.damp(fov, targetFov, 6, dt);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    el.speedFx.classList.toggle('on', st.boosting);
    updateFlare();
    updateBacklit();

    bloom.render(scene, camera, time, st.boosting ? 1.15 : 1.0);

    hudAccum += dt;
    if (hudAccum > 0.08) {
      hudAccum = 0;
      updateHUD(st.speed);
    }
  }

  // 首帧前编译材质，避免卡顿
  try {
    renderer.compile(scene, camera);
  } catch (e) {
    /* 忽略 */
  }
  frame();

  // 以便调试（自动化截图会用到 ?debug=1）
  window.GAME = { scene, camera, renderer, saturn, player, bloom, THREE, startPos, SUN_DIR };
  const params = new URLSearchParams(location.search);
  if (params.has('debug')) {
    el.intro.classList.add('hidden');
    el.reticle.style.opacity = '1';
    el.start.textContent = '（调试中，点击亦可锁定视角）';
    if (params.get('pos')) {
      const [x, y, z] = params.get('pos').split(',').map(Number);
      camera.position.set(x, y, z);
    }
    if (params.get('look')) {
      const [x, y, z] = params.get('look').split(',').map(Number);
      player.lookAt(new THREE.Vector3(x, y, z));
    }
    if (params.get('fov')) {
      camera.fov = Number(params.get('fov'));
      camera.updateProjectionMatrix();
    }
    // 仅用于自动化截图：直接给出速度，不锁定鼠标指针
    player.state.enabled = true;

    // 直接跳到某个星球（跳过跃迁动画，仅用于取景截图）
    const worldParam = params.get('world');
    if (worldParam && otherWorlds[worldParam]) {
      // 走一遍 onSwap 的同一套逻辑
      warp.start(worldParam);
      for (let i = 0; i < 600 && warp.active; i++) warp.update(1 / 60, i / 60);
    }
  }

  /* ---------------------------------------------------------------
     9. 自检：?selftest=1 时模拟按键与鼠标，把结果写进 #selftest
     --------------------------------------------------------------- */
  if (params.has('selftest')) {
    const results = [];
    const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
    const p0 = camera.position.clone();

    // 工具：静止转向（真空无阻力，手工清速度，专测姿态逻辑）
    const turnOnly = (dx, dy) => {
      player.state.velocity.set(0, 0, 0);
      player.testInput(null, { dx, dy });
      player.update(1 / 60, 0); // flushLook 在 update 内施加增量
      player.state.velocity.set(0, 0, 0);
    };

    // 1) W 前进
    player.testInput({ KeyW: true });
    for (let i = 0; i < 30; i++) player.update(1 / 60, i / 60);
    const dW = camera.position.distanceTo(p0);
    check('W 前进', dW > 5, `移动 ${dW.toFixed(2)} 单位`);
    player.testInput({ KeyW: false });

    // 2) 空格上升（世界 Y 轴）
    const y0 = camera.position.y;
    player.testInput({ Space: true });
    for (let i = 0; i < 40; i++) player.update(1 / 60, 1 + i / 60);
    const dUp = camera.position.y - y0;
    check('Space 上升', dUp > 2, `Y 变化 ${dUp.toFixed(2)}`);
    player.testInput({ Space: false });

    // 3) Shift 下降
    const y1 = camera.position.y;
    player.testInput({ ShiftLeft: true });
    for (let i = 0; i < 40; i++) player.update(1 / 60, 2 + i / 60);
    const dDown = camera.position.y - y1;
    check('Shift 下降', dDown < -2, `Y 变化 ${dDown.toFixed(2)}`);
    player.testInput({ ShiftLeft: false });

    // 4) A / D 侧移
    const p1 = camera.position.clone();
    player.testInput({ KeyA: true });
    for (let i = 0; i < 30; i++) player.update(1 / 60, 3 + i / 60);
    check('A 左移', camera.position.distanceTo(p1) > 3, `移动 ${camera.position.distanceTo(p1).toFixed(2)}`);
    player.testInput({ KeyA: false });
    const p2 = camera.position.clone();
    player.testInput({ KeyD: true });
    for (let i = 0; i < 30; i++) player.update(1 / 60, 4 + i / 60);
    check('D 右移', camera.position.distanceTo(p2) > 3, `移动 ${camera.position.distanceTo(p2).toFixed(2)}`);
    player.testInput({ KeyD: false });

    /* ---- 真实键盘事件链路（不经过 testInput，走 onKeyDown/onKeyUp）---- */
    const realKey = (type, code) =>
      document.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));

    // 清空所有注入的按键状态，改为完全依赖真实事件
    player.state.keys = Object.create(null);
    player.state.velocity.set(0, 0, 0);
    camera.position.copy(p0);
    player.lookAt(new THREE.Vector3(0, 0, 0));

    const ry0 = camera.position.y;
    realKey('keydown', 'Space');
    for (let i = 0; i < 45; i++) player.update(1 / 60, 20 + i / 60);
    realKey('keyup', 'Space');
    const realUp = camera.position.y - ry0;

    const ry1 = camera.position.y;
    realKey('keydown', 'ShiftLeft');
    for (let i = 0; i < 45; i++) player.update(1 / 60, 21 + i / 60);
    realKey('keyup', 'ShiftLeft');
    const realDown = camera.position.y - ry1;

    check('真实事件 Space 必须上升', realUp > 1,
      `Y 变化 ${realUp.toFixed(2)}${realUp < 0 ? '（方向反了！）' : ''}`);
    check('真实事件 Shift 必须下降', realDown < -1,
      `Y 变化 ${realDown.toFixed(2)}${realDown > 0 ? '（方向反了！）' : ''}`);

    // 5) 鼠标转向（未滚转）
    camera.position.copy(p0);
    player.lookAt(new THREE.Vector3(0, 0, 0));
    const p3 = camera.position.clone();
    const fwdA = player.getForward(new THREE.Vector3());
    turnOnly(400, 0);
    const fwdB = player.getForward(new THREE.Vector3());
    check('鼠标横向转向', fwdA.angleTo(fwdB) > 0.1, `朝向变化 ${((fwdA.angleTo(fwdB) * 180) / Math.PI).toFixed(1)}°`);
    check('原地转向不位移', camera.position.distanceTo(p3) < 0.5,
      `位移 ${camera.position.distanceTo(p3).toFixed(3)}`);

    /* ---- 核心回归：QE 翻转后鼠标必须照常工作，且没有角度墙 ---- */

    // 6) 连续滚转 8 秒（≈527°）：不允许被夹住，要能整圈翻过 360°
    player.lookAt(new THREE.Vector3(0, 0, 0));
    const before = player.state.rollTotal;
    player.testInput({ KeyE: true });
    for (let i = 0; i < 480; i++) player.update(1 / 60, 10 + i / 60);
    player.testInput({ KeyE: false });
    const spin1 = player.state.rollTotal - before;
    check('E 持续滚转可翻整圈', Math.abs(spin1) > Math.PI * 2,
      `累计 ${(spin1 * 180 / Math.PI).toFixed(0)}°（旧实现夹死在 ±180°）`);

    // 7) 滚转 180°（倒飞）后，鼠标横向仍然改变屏幕水平朝向
    player.lookAt(new THREE.Vector3(0, 0, 0));
    player.testInput({ KeyQ: true });
    while (Math.abs(player.state.rollTotal) < Math.PI - 0.05) {
      player.update(1 / 60, 20);
    }
    player.testInput({ KeyQ: false });
    player.state.rollTotal = Math.PI; // 归一化，便于报告

    const upBefore = player.getUp(new THREE.Vector3());
    const fwd0 = player.getForward(new THREE.Vector3());
    const right0 = player.getRight(new THREE.Vector3());
    turnOnly(300, 0);
    const fwd1 = player.getForward(new THREE.Vector3());
    const turnAngle = fwd0.angleTo(fwd1);
    // 转向必须实实在在发生（旧实现这里几乎为 0，因为被夹在滚转 90° 附近）
    check('倒飞 180° 后鼠标横转仍生效', turnAngle > 0.3,
      `朝向变化 ${((turnAngle * 180) / Math.PI).toFixed(1)}°`);
    // 并且是绕「机体上轴」转：机体上轴与旋转前的朝向保持垂直关系
    const axisDot = Math.abs(fwd0.clone().cross(fwd1).normalize().dot(upBefore));
    check('滚转后横转轴为机体上轴', axisDot > 0.85, `轴对齐 ${axisDot.toFixed(3)}`);
    void right0;

    // 8) 滚转后纵向鼠标仍然改变俯仰（绕机体右轴）
    const fwd2 = player.getForward(new THREE.Vector3());
    turnOnly(0, 300);
    const fwd3 = player.getForward(new THREE.Vector3());
    check('滚转后鼠标俯仰仍生效', fwd2.angleTo(fwd3) > 0.3,
      `朝向变化 ${((fwd2.angleTo(fwd3) * 180) / Math.PI).toFixed(1)}°`);

    // 9) 连续翻滚多圈 + 任意姿态下鼠标依旧有效（不再有“转不动”的死区）
    player.lookAt(new THREE.Vector3(0, 0, 0));
    let worst = Infinity;
    let worstAt = 0;
    for (let cycle = 0; cycle < 8; cycle++) {
      player.testInput({ KeyE: true });
      for (let i = 0; i < 30; i++) player.update(1 / 60, 30 + cycle);
      player.testInput({ KeyE: false });
      const fa = player.getForward(new THREE.Vector3());
      turnOnly(200, 0);
      const fb = player.getForward(new THREE.Vector3());
      const ang = fa.angleTo(fb);
      if (ang < worst) {
        worst = ang;
        worstAt = player.state.rollTotal;
      }
    }
    check('任意翻滚角度下鼠标均有响应', worst > 0.2,
      `最差单次响应 ${((worst * 180) / Math.PI).toFixed(1)}° @ 滚转 ${((worstAt * 180) / Math.PI).toFixed(0)}°`);

    // 10) 姿态保持正交归一（四元数不漂移）
    const u = player.getUp(new THREE.Vector3());
    const f = player.getForward(new THREE.Vector3());
    const r = player.getRight(new THREE.Vector3());
    const ortho = Math.max(
      Math.abs(u.dot(f)), Math.abs(u.dot(r)), Math.abs(f.dot(r)),
      Math.abs(u.length() - 1), Math.abs(f.length() - 1), Math.abs(r.length() - 1)
    );
    check('姿态正交归一', ortho < 1e-6, `最大误差 ${ortho.toExponential(1)}`);

    /* ---- 鼠标尖峰过滤：异常增量不得把视角甩飞 ---- */
    {
      player.lookAt(new THREE.Vector3(0, 0, 0));
      player.state.velocity.set(0, 0, 0);

      // 注入一个物理上不可能出现的巨大增量（指针锁定下的典型异常值）
      const before = player.getForward(new THREE.Vector3());
      player.testInput(null, { dx: 90000, dy: 0 });
      player.update(1 / 60, 0);
      const after = player.getForward(new THREE.Vector3());
      const jumped = (before.angleTo(after) * 180) / Math.PI;
      check('鼠标尖峰被丢弃', jumped < 2,
        `单次极端增量只转了 ${jumped.toFixed(1)}°（异常值整条丢弃）`);

      // 正常的小幅移动仍应完整生效
      player.lookAt(new THREE.Vector3(0, 0, 0));
      const b2 = player.getForward(new THREE.Vector3());
      player.testInput(null, { dx: 50, dy: 0 });
      player.update(1 / 60, 0);
      const a2 = player.getForward(new THREE.Vector3());
      const normal = (b2.angleTo(a2) * 180) / Math.PI;
      check('正常鼠标移动不受影响', normal > 2 && normal < 10,
        `50px 转了 ${normal.toFixed(1)}°`);

      // 连续极端事件：全部被判为异常丢弃，不会累积成失控的跳变
      player.lookAt(new THREE.Vector3(0, 0, 0));
      const b3 = player.getForward(new THREE.Vector3());
      for (let i = 0; i < 20; i++) {
        player.testInput(null, i % 2 ? { dx: 0, dy: 60000 } : { dx: 50000, dy: 0 });
        player.update(1 / 60, 0);
      }
      const a3 = player.getForward(new THREE.Vector3());
      const acc = (b3.angleTo(a3) * 180) / Math.PI;
      check('连续尖峰不会累积失控', acc < 2,
        `20 次异常增量累计 ${acc.toFixed(1)}°`);

      // 大幅但合理的快速甩动（一帧内多个正常事件）仍应正常生效
      player.lookAt(new THREE.Vector3(0, 0, 0));
      const b4 = player.getForward(new THREE.Vector3());
      for (let i = 0; i < 4; i++) player.testInput(null, { dx: 180, dy: 0 });
      player.update(1 / 60, 0);
      const a4 = player.getForward(new THREE.Vector3());
      const flick = (b4.angleTo(a4) * 180) / Math.PI;
      check('快速甩动仍正常生效', flick > 40,
        `4×180px 转了 ${flick.toFixed(0)}°（未被误杀）`);
    }

    // 11) 土星穿透保护
    camera.position.set(0, 0, 10);
    player.lookAt(new THREE.Vector3(0, 0, 0));
    for (let i = 0; i < 5; i++) player.update(1 / 60, 6 + i / 60);
    check('土星碰撞保护', camera.position.length() >= SAT.CONST.R * 1.07,
      `半径 ${camera.position.length().toFixed(0)}`);

    // 12) F 加速更快
    camera.position.copy(p0);
    player.lookAt(new THREE.Vector3(0, 0, 0));
    player.testInput({ KeyW: true });
    for (let i = 0; i < 90; i++) player.update(1 / 60, 7 + i / 60);
    const normalSpeed = player.state.speed;
    player.testInput({ KeyW: true, KeyF: true });
    for (let i = 0; i < 120; i++) player.update(1 / 60, 8 + i / 60);
    check('F 星际巡航加速', player.state.speed > normalSpeed * 1.8,
      `${normalSpeed.toFixed(0)} → ${player.state.speed.toFixed(0)} 单位/秒`);
    player.testInput({ KeyW: false, KeyF: false });

    // 13) R 复位滚转但保持朝向
    player.lookAt(new THREE.Vector3(0, 0, 0));
    const fwdKeep = player.getForward(new THREE.Vector3());
    player.testInput({ KeyE: true });
    for (let i = 0; i < 60; i++) player.update(1 / 60, 9 + i / 60);
    player.testInput({ KeyE: false });
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    const fwdAfterR = player.getForward(new THREE.Vector3());
    check('R 复位保持朝向', fwdKeep.angleTo(fwdAfterR) < 0.05,
      `朝向偏差 ${((fwdKeep.angleTo(fwdAfterR) * 180) / Math.PI).toFixed(2)}°`);

    // 14) 场景内容
    check('土星本体', !!saturn.planet);
    check('星环', !!saturn.rings);
    check('小行星带实例', saturn.belts.reduce((s, b) => s + b.count, 0) >= 8000,
      `${saturn.belts.reduce((s, b) => s + b.count, 0)} 颗`);

    /* ---- 小行星带：必须只分布在星环径向范围内，且垂直方向有厚度 ---- */
    {
      let minR = Infinity, maxR = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let n = 0;
      for (const b of saturn.belts) {
        const geo = b.mesh.geometry;
        const orbit = geo.getAttribute('aOrbit').array;
        const ys = geo.getAttribute('aY').array;
        for (let i = 0; i < b.count; i++) {
          const r = orbit[i] / SAT.CONST.R;
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
          minY = Math.min(minY, ys[i]);
          maxY = Math.max(maxY, ys[i]);
          n++;
        }
      }
      // 径向：不得超出星环外缘（F 环 2.42R），内缘允许到 C 环 1.10R
      check('小行星不超出星环径向范围', maxR <= 2.45 && minR >= 1.10,
        `半径 ${minR.toFixed(2)}R ~ ${maxR.toFixed(2)}R（星环 1.10~2.42R）`);
      // 垂直厚度：应显著大于早期版本（约 ±10 单位）
      const thick = maxY - minY;
      check('小行星带具备垂直厚度', thick > 300,
        `垂直跨度 ${thick.toFixed(0)} 单位（约 ${(thick * 15).toFixed(0)} km）`);
      check('小行星带颗粒总数', n >= 9000, `${n} 颗`);
    }

    // 15) 小行星确实在公转（时间推进后位置改变）
    {
      const before = saturn.heroes.map((h) => h.position.clone());
      for (let i = 0; i < 120; i++) saturn.update(1 / 60, 100 + i / 60, camera, camera.fov, 900);
      let moved = 0;
      saturn.heroes.forEach((h, i) => {
        if (h.position.distanceTo(before[i]) > 0.05) moved++;
      });
      check('近景小行星在公转', moved === saturn.heroes.length,
        `${moved}/${saturn.heroes.length} 块发生位移`);

      // 着色器侧的时间 uniform 也应被推进
      const tu = saturn.belts[0].mat.uniforms.uTime.value;
      check('小行星带公转时间量在推进', tu > 100, `uTime=${tu.toFixed(1)}`);
    }

    check('近景小行星', saturn.heroes.length >= 30, `${saturn.heroes.length} 块`);
    check('星空背景', scene.getObjectByName('brightStars') !== undefined || !!starPoints);

    /* ---- 玩法层：碰撞 / 信标 / 设置 ---- */
    {
      // 碰撞：把小行星带到相机位置上，必须判定为命中
      const hero = saturn.heroes[0];
      const savedPos = hero.position.clone();
      const camSaved = camera.position.clone();

      camera.position.copy(hero.position);
      const heroHit = SAT.gameplay.nearestHeroHit(saturn.heroes, camera.position, R * 0.004);
      check('近景岩石碰撞可命中', !!heroHit, heroHit ? '球体相交' : '未命中（异常）');

      // 稍微推远：不应命中
      camera.position.copy(hero.position).add(new THREE.Vector3(0, 0, 4000));
      const miss = SAT.gameplay.nearestHeroHit(saturn.heroes, camera.position, R * 0.004);
      check('远离时不误判碰撞', !miss);

      hero.position.copy(savedPos);
      camera.position.copy(camSaved);

      // 撞击事件：把相机放到某颗岩石中心
      let impactEvent = null;
      camera.position.copy(saturn.heroes[1].position);
      gameplay.update(1 / 60, 900, camera, 0, (type, data) => {
        if (type === 'impact') impactEvent = data;
      });
      check('陷入岩石会触发撞击事件', !!impactEvent,
        impactEvent ? `强度 ${impactEvent.strength.toFixed(2)}` : '未触发（异常）');

      camera.position.copy(camSaved);
    }

    // 16) 设置项
    check('设置面板存在', !!document.getElementById('settings'));
    check('音效模块可用', typeof audio.update === 'function' && typeof audio.setEnabled === 'function');
    check('尖峰防护可开关', typeof player.setSpikeGuard === 'function');
    check('环带厚度可调', typeof saturn.rings.userData.rebuildThickness === 'function');

    /* ---- 新增功能的覆盖 ---- */

    // 18) 星空重烤（跃迁的核心机制）
    {
      const seedBefore = skyData.seed;
      let ok = true;
      try {
        SAT.sky.rebake(skyData, 77777, renderer);
      } catch (e) {
        ok = false;
      }
      check('星空可重新烘焙', ok && skyData.seed === 77777,
        ok ? `种子 ${seedBefore} → ${skyData.seed}` : '烘焙失败');
      // 复原
      try {
        SAT.sky.rebake(skyData, seedBefore, renderer);
      } catch (e) {
        /* 忽略 */
      }
    }

    // 19) 环带体积雾：环内应当有浓度，远处应当为 0
    {
      const savedPos = camera.position.clone();
      const n = SAT.saturn.RING_NORMAL; // 已经过系统倾斜的世界法线

      // 在环平面内、B 环半径处取一点（用平面内的两个正交基构造）
      const u = new THREE.Vector3(1, 0, 0)
        .sub(n.clone().multiplyScalar(n.x))
        .normalize();
      const v = new THREE.Vector3().crossVectors(n, u).normalize();
      const ru = 1.75 * R;
      camera.position.copy(u).multiplyScalar(ru);

      ringfog.update(1 / 60, 0, camera);
      const densIn = ringfog.state.raw;
      check('环带内部有雾', densIn > 0.15, `密度 ${densIn.toFixed(2)}`);

      // 垂直远离环面
      camera.position.copy(u).multiplyScalar(ru).addScaledVector(n, R * 3.2);
      ringfog.update(1 / 60, 0, camera);
      check('远离环带无雾', ringfog.state.raw < 0.02, `密度 ${ringfog.state.raw.toFixed(3)}`);

      // 环带半径之外（更靠内，土星本体附近）
      camera.position.copy(u).multiplyScalar(0.6 * R);
      ringfog.update(1 / 60, 0, camera);
      check('环带半径之外无雾', ringfog.state.raw < 0.02, `密度 ${ringfog.state.raw.toFixed(3)}`);

      void v;
      camera.position.copy(savedPos);
    }

    // 20) 卫星奇观
    {
      check('四颗土卫已创建', saturn.moons.length === 4, `${saturn.moons.length} 颗`);
      const names = saturn.moons.map((m) => m.cfg.name).join(' / ');
      check('卫星各有签名', names.includes('Enceladus') && names.includes('Iapetus'),
        names);
      const hasPlume = saturn.moons.some((m) => m.plume);
      check('土卫二冰喷泉存在', hasPlume);
    }

    // 21) 背光检测
    {
      const before = camera.position.clone();
      const beforeQ = player.state.quat.clone();
      // 直接调用 updateBacklit 不应抛错
      let ok = true;
      try {
        updateBacklit();
      } catch (e) {
        ok = false;
      }
      check('背光检测可运行', ok, ok ? `当前等级 ${(backlitLevel * 100).toFixed(0)}%` : '异常');
      camera.position.copy(before);
      player.state.quat.copy(beforeQ);
    }

    // 22) 航行日志
    {
      const n0 = voyageLog.count;
      voyageLog.add('selftest-entry', '自检写入的测试记录', '');
      const n1 = voyageLog.count;
      check('航行日志可写入', n1 === n0 + 1, `${n0} → ${n1} 条`);

      // 同 id 不应重复记录
      voyageLog.add('selftest-entry', '重复', '');
      check('日志去重', voyageLog.count === n1, `仍为 ${voyageLog.count} 条`);

      const txt = voyageLog.format();
      check('日志可导出为文本', typeof txt === 'string' && txt.length > 20,
        `${txt.length} 字符`);
    }

    // 23) 拍照模式
    {
      check('拍照模块可用', typeof photo.capture === 'function' && typeof photo.toggle === 'function');
      const entered = photo.enter();
      check('可进入拍照模式', photo.active === true, '已冻结画面');
      photo.exit();
      check('可退出拍照模式', photo.active === false);
      void entered;
    }

    // 24) 跃迁 + 新星球
    {
      check('跃迁模块可用', typeof warp.start === 'function' && typeof warp.update === 'function');

      // 必须有不止一个世界
      const worldIds = SAT.planets.WORLDS.map((w) => w.id);
      check('存在多个可跃迁星球', worldIds.length >= 3, worldIds.join(' / '));

      // 其他星球已构建
      const built = Object.keys(otherWorlds).length;
      check('其他星球已构建', built >= 2, `${built} 个`);
      check('初始只显示土星',
        saturn.system.visible === true &&
          Object.values(otherWorlds).every((w) => w.group.visible === false));

      // 星轨模块
      check('星轨模块可用', typeof starlines.setIntensity === 'function');
      starlines.setIntensity(1);
      check('星轨强度可设置', starlines.state.target === 1);

      const started = warp.start('belt');
      check('跃迁可启动', started === true && warp.active === true, `阶段 ${warp.phase}`);

      // 推进到结束（onSwap 会在白屏最亮时切换世界）
      for (let i = 0; i < 600 && warp.active; i++) warp.update(1 / 60, i / 60);
      check('跃迁可正常结束', warp.active === false);

      // 切换后：碎星带应当可见，土星应当隐藏
      const beltWorld = otherWorlds.belt;
      check('跃迁后切换到新世界',
        beltWorld && beltWorld.group.visible === true && saturn.system.visible === false,
        currentWorldId);

      // 碎星带：必须真的有大规模岩石
      check('碎星带规模足够', beltWorld && beltWorld.count >= 30000,
        beltWorld ? `${beltWorld.count} 颗` : '缺失');

      // 切到地球
      warp.start('earth');
      for (let i = 0; i < 600 && warp.active; i++) warp.update(1 / 60, i / 60);
      const earthWorld = otherWorlds.earth;
      check('可跃迁到地球', earthWorld && earthWorld.group.visible === true, currentWorldId);
      check('地球有独立云层', !!(earthWorld && earthWorld.clouds && earthWorld.ground));

      // 大气与地面旋速必须不同（这是地球这个世界的核心设计）
      {
        const before = {
          g: earthWorld.ground.rotation.y,
          c: earthWorld.clouds.rotation.y,
        };
        for (let i = 0; i < 120; i++) earthWorld.update(1 / 60, i / 60, camera);
        const dg = earthWorld.ground.rotation.y - before.g;
        const dc = earthWorld.clouds.rotation.y - before.c;
        check('云层比地面转得快', dc > dg * 1.5,
          `地面 ${dg.toFixed(4)} vs 云层 ${dc.toFixed(4)} 弧度`);
      }

      // 切到黑洞
      warp.start('blackhole');
      for (let i = 0; i < 600 && warp.active; i++) warp.update(1 / 60, i / 60);
      const bh = otherWorlds.blackhole;
      check('可跃迁到黑洞', bh && bh.group.visible === true, currentWorldId);
      check('黑洞有吸积盘与视界', !!(bh && bh.disk && bh.horizon));

      // 切回土星
      warp.start('saturn');
      for (let i = 0; i < 600 && warp.active; i++) warp.update(1 / 60, i / 60);
      check('可跃迁回土星',
        saturn.system.visible === true && bh.group.visible === false,
        currentWorldId);
    }

    // 25) 太阳遮挡：从土星背后看，太阳必须不可见
    {
      const savedPos = camera.position.clone();
      const savedQ = player.state.quat.clone();

      // 站到土星正背面（相对于恒星）
      const antiSun = SUN_DIR.clone().negate();
      camera.position.copy(antiSun).multiplyScalar(R * 3);
      const occluded = sunOccluded();
      check('土星背后的太阳被遮挡', occluded === true,
        occluded ? '判定为遮挡' : '未遮挡（会穿模）');

      // 站到土星侧面：不应遮挡
      const side = new THREE.Vector3().crossVectors(SUN_DIR, new THREE.Vector3(0, 1, 0)).normalize();
      camera.position.copy(side).multiplyScalar(R * 3);
      check('侧面的太阳不被遮挡', sunOccluded() === false);

      camera.position.copy(savedPos);
      player.state.quat.copy(savedQ);
    }

    // 26) 遗物
    {
      const rel = scene.getObjectByName('relic');
      check('稀有遗物已布置', !!rel, rel ? '环带外侧' : '缺失');
    }

    // 26) 渲染无 WebGL 错误
    check('无着色器错误', !document.getElementById('errbox'));

    camera.position.copy(startPos);
    player.lookAt(new THREE.Vector3(0, 0, 0));

    const box = document.createElement('div');
    box.id = 'selftest';
    box.style.cssText =
      'position:fixed;left:12px;top:12px;z-index:200;padding:12px 16px;border-radius:10px;' +
      'background:rgba(0,0,0,.82);color:#9effa8;font:11px/1.7 monospace;white-space:pre;border:1px solid #2b5';
    box.textContent = results.join('\n');
    document.body.appendChild(box);
    window.SELFTEST_RESULTS = results;
    console.log('\nSELFTEST\n' + results.join('\n') + '\n');
  }

  /* 帧率采样（?fps=1 时显示） */
  if (params.has('fps')) {
    let frames = 0;
    let last = performance.now();
    const stat = document.createElement('div');
    stat.style.cssText =
      'position:fixed;right:12px;top:12px;z-index:200;padding:6px 12px;border-radius:8px;' +
      'background:rgba(0,0,0,.7);color:#8fe6ff;font:12px/1.5 monospace';
    document.body.appendChild(stat);
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 500) {
        const fps = (frames * 1000) / (now - last);
        stat.textContent =
          `${fps.toFixed(0)} fps · ${renderer.info.render.triangles.toLocaleString()} tris · ` +
          `${renderer.info.render.calls} calls · dpr ${renderer.getPixelRatio().toFixed(2)} · ` +
          `尖峰丢弃 ${player.state.spikeDrops}`;
        window.FPS_SAMPLE = fps;
        frames = 0;
        last = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
})();
