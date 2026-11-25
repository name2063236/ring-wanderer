const fs = require('fs');
let s = fs.readFileSync('src/planets.js', 'utf8');

// 1) buildWorld 改用独立的 blackhole 模块
const oldBuild = [
  "  function buildWorld(def, R) {",
  "    if (def.id === 'belt') return buildAsteroidSwarm(R);",
  "    if (def.id === 'earth') return buildEarth(R);",
  "    if (def.id === 'blackhole') return buildBlackHole(R);",
  "    return null;",
  "  }",
].join('\n');

const newBuild = [
  "  function buildWorld(def, R) {",
  "    if (def.id === 'belt') return buildAsteroidSwarm(R);",
  "    if (def.id === 'earth') return buildEarth(R);",
  "    // 黑洞独立成模块（光线追踪实现，见 blackhole.js）",
  "    if (def.id === 'blackhole') return SAT.blackhole.create(R);",
  "    return null;",
  "  }",
].join('\n');

if (!s.includes(oldBuild)) {
  console.log('buildWorld 未匹配');
  process.exit(1);
}
s = s.replace(oldBuild, newBuild);

// 2) 删除旧的 buildBlackHole 函数（从函数头到世界表之前）
const startMark = '  /* ---------------------------------------------------------------------\n     3. 深渊（黑洞）';
let a = s.indexOf(startMark);
if (a < 0) {
  // 兼容旧注释文本
  a = s.indexOf('  function buildBlackHole(R) {');
}
const endMark = '  /* ===================== 世界表 ===================== */';
const b = s.indexOf(endMark);

if (a < 0 || b < 0 || b < a) {
  console.log('旧黑洞函数定位失败', a, b);
  process.exit(1);
}

const removed = b - a;
s = s.slice(0, a) + s.slice(b);
fs.writeFileSync('src/planets.js', s, 'utf8');

console.log('已替换 buildWorld');
console.log('已删除旧 buildBlackHole，移除 ' + removed + ' 字符');
try {
  new Function(s);
  console.log('SYNTAX OK');
} catch (e) {
  console.log('SYNTAX FAIL: ' + e.message);
}
