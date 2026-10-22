// 语音共享内核（src/voice-core.js）自检：
//   1) 纯函数边界：缺目录、异常输入、重名递增
//   2) 安全边界：路径穿越、上传文件名净化、库内唯一命名
//   3) 入口文件用到的共享符号都已 import
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeJoinLibrary, sanitizeUploadName, uniqueLibraryPath } from '../src/voice-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 纯函数边界');
{
  const core = await import('../src/voice-core.js');

  ok(core.listAudioFiles(path.join(ROOT, 'no-such-dir-xyz')).length === 0, '目录不存在 → 返回空数组（不抛）');
  ok(core.describeAudio(null) === '未知音频', 'describeAudio(null) 不炸');
  ok(core.describeAudio({}) === '未知音频', 'describeAudio({}) 不炸');
  ok(core.formatDuration(0) === '0秒' && core.formatDuration(-5) === '0秒', '负时长被夹到 0');
  ok(core.formatBytes(0) === '0 B', 'formatBytes(0)');
  ok(core.parseTargetKey('group:0') === null, 'group:0 视为非法（id 必须为正）');
  ok(core.parseTargetKey('GROUP:1') === null, '大写 GROUP 不识别（大小写敏感，避免歧义）');
  ok(core.sanitizeUploadName('') === 'audio.mp3', '空文件名 → audio.mp3');
  ok(core.sanitizeUploadName('a'.repeat(300)).length <= 120, '超长文件名被截断到 ≤120');
  ok(core.sanitizeUploadName('a'.repeat(300)).endsWith('.mp3'), '截断后仍带扩展名');

  // 同名递增不能无限循环
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-uniq-'));
  fs.writeFileSync(path.join(tmp, 'x.mp3'), '1');
  ok(core.uniqueLibraryPath(tmp, 'x.mp3').endsWith('x-2.mp3'), '同名 → x-2.mp3');
  for (let i = 2; i <= 4; i++) fs.writeFileSync(path.join(tmp, `x-${i}.mp3`), '1');
  ok(core.uniqueLibraryPath(tmp, 'x.mp3').endsWith('x-5.mp3'), '连续同名 → x-5.mp3');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('## 安全：路径穿越与文件名净化');
{
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-lib-'));
  fs.writeFileSync(path.join(lib, 'ok.mp3'), Buffer.alloc(8, 1));
  fs.writeFileSync(path.join(path.dirname(lib), 'outside.mp3'), Buffer.alloc(8, 1));

  ok(safeJoinLibrary(lib, 'ok.mp3')?.endsWith('ok.mp3'), '库内正常文件放行');
  ok(safeJoinLibrary(lib, '../outside.mp3') === null, '拒绝 ../ 逃逸');
  ok(safeJoinLibrary(lib, '..\\outside.mp3') === null, '拒绝 ..\\ 逃逸（Windows 反斜杠）');
  ok(safeJoinLibrary(lib, '../../config.json') === null, '拒绝 ../../config.json');
  ok(safeJoinLibrary(lib, 'sub/../../x.mp3') === null, '拒绝多级混合穿越');
  ok(safeJoinLibrary(lib, '') === null, '拒绝空路径');
  ok(safeJoinLibrary(lib, 'a\0b.mp3') === null, '拒绝含 NUL 的路径');

  ok(sanitizeUploadName('../../evil.mp3') === 'evil.mp3', '上传名去掉目录部分');
  ok(sanitizeUploadName('C:\\Windows\\x.mp3') === 'x.mp3', '上传名去掉 Windows 路径');
  ok(sanitizeUploadName('a<b>c?.mp3') === 'a_b_c_.mp3', '上传名净化非法字符');
  ok(sanitizeUploadName('语音.wav') === '语音.wav', '保留中文名');
  ok(sanitizeUploadName('noext') === 'noext.mp3', '没有音频扩展名时补 .mp3');
  ok(sanitizeUploadName('...').endsWith('.mp3'), '纯点名不会变成隐藏文件');

  const p1 = uniqueLibraryPath(lib, 'ok.mp3');
  ok(p1.endsWith('ok-2.mp3'), '同名文件自动改名 ok-2.mp3', path.basename(p1));

  fs.rmSync(lib, { recursive: true, force: true });
  try { fs.rmSync(path.join(path.dirname(lib), 'outside.mp3'), { force: true }); } catch {}
}

console.log('## 共享库符号完整性（防"用了但没 import"）');
{
  // 由来：send-voice.mjs 曾经调用 formatDuration 却没 import（重构成 shim 后暴露），
  // 只有真的走 dry-run 才会炸。这里静态检查所有入口文件：凡是用了 voice-core 提供的
  // 符号，就必须在 import 列表里（或在本文件内有定义）。
  const core = await import('../src/voice-core.js');
  const symbols = Object.keys(core).filter((k) => typeof core[k] === 'function' || /^[A-Z_]+$/.test(k));
  const entrypoints = [
    { file: path.join(ROOT, 'scripts/send-voice.mjs') },
    { file: path.join(ROOT, 'src/bridge.js') }
  ];
  for (const { file: entryFile } of entrypoints) {
    const rel = path.relative(ROOT, entryFile).replace(/\\/g, '/');
    if (!fs.existsSync(entryFile)) continue;
    const src = fs.readFileSync(entryFile, 'utf8');
    // 桥接侧经 ./ 或 ../src/ 引用共享库
    const importedBlock = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*(?:send-voice-lib|voice-core)\.js'/g)]
      .map((m) => m[1]).join(',');
    const missing = symbols.filter((sym) => {
      const used = new RegExp(`(?<![\\w.$])${sym}\\s*[(,)\\[]`).test(src);
      if (!used) return false;
      if (new RegExp(`(?<![\\w$])${sym}(?![\\w$])`).test(importedBlock)) return false;
      // 本文件自己定义的也算（例如 bridge.js 里的同名内部实现不该存在，但保留容错）
      if (new RegExp(`(?:function|const|let|var)\\s+${sym}\\b`).test(src)) return false;
      return true;
    });
    ok(missing.length === 0, `${rel} 用到的共享符号都已 import`, missing.length ? `缺：${missing.join(', ')}` : '');
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
