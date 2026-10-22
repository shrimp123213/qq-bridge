#!/usr/bin/env node
// build-agent-preset-patches.mjs — 把 dsh/agent-presets/<preset>/ 的 preset 源文件
// 渲染成 DSH 0.1.7 的 bundle patch 文件（plugins/qq-agent-presets/presets/<preset>.patch.yml）。
//
// 背景（为什么需要「生成」这一步）：
//   0.1.5：preset = ~/.dsh/.agent-presets/<preset>/{preset.yml,agent.cordis.yml} 目录，DSH 扫目录。
//   0.1.7：注册表既不扫目录也不接受 preset 路径，preset 变成一条普通 loader 行
//          （@deepseek-ai/dsh-agent-preset），它的 config.plugins 必须是**内联的行列表**，
//          只能由 bundle 的 patch 文件插入。于是同一份行列表必然存在两种表示：
//            源（人写/控制台改）：dsh/agent-presets/<preset>/{preset.yml,agent.cordis.yml}
//            装（DSH 读）：      plugins/qq-agent-presets/presets/<preset>.patch.yml
//          本脚本是两者之间**唯一**的转换器：源是唯一权威，产物是纯生成物（文件头写明「请勿手工编辑」）。
//          setup-dsh.mjs 在安装时会重新生成；test-agent-preset-patches.mjs 用 --check 钉住不漂移。
//
//   派生 preset（DERIVED_PRESETS）：没有自己的 agent.cordis.yml，按 dsh/agent-presets/<preset>/derive.yml
//   从 base preset 生成——行列表照搬，只按规则改写人格正文（例如二代的 Discord 版去掉 Discord 没有的工具）。
//
// 用法：
//   node scripts/build-agent-preset-patches.mjs           # 生成/刷新 patch 文件
//   node scripts/build-agent-preset-patches.mjs --check    # 只校验产物与源一致（不一致 exit 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

/** 由桥接托管、有自己源目录的两个 preset（顺序即 patch 层顺序）。 */
export const PRESETS = ['qq-chat', 'qq-chat-v2'];

/** 派生 preset：源目录里只有 preset.yml + derive.yml，正文由 base 生成。 */
export const DERIVED_PRESETS = ['dc-chat-v2'];

/** 全部要生成 patch 的 preset（顺序即 patch 层顺序）。 */
export const ALL_PRESETS = [...PRESETS, ...DERIVED_PRESETS];

/** preset 行 id：与 config.id（桥接解析的 preset 名）区分开，方便在 profile patch 里按行定位。 */
export function presetRowId(name) {
  return `preset-${name}`;
}

/**
 * 守卫行的引用方式：从 profile 目录可解析的裸说明符。
 *
 * 子行 name 按声明它的 loader 上下文解析（profile 目录），不是按 patch 文件或 preset 目录；
 * bundle patch 的「相对路径锚定」只作用于 insert 行自身（见 dsh-app-boot 的
 * anchorInsertedPluginNames），走不进 preset 行的 config.plugins。因此这里用
 * `<bundle 包名>/<子路径>`：profile package.json 以 link: 依赖声明该包，
 * node_modules junction 由 setup-dsh.mjs 或 dev_heal_links 维护。
 */
export const GUARD_SPECIFIER = 'qq-agent-presets/qq-tool-restrict.mjs';

/** 源里允许出现的相对行名 → 新机制下的等价引用。其它相对名一律报错（避免静默装不上）。 */
const RELATIVE_ROW_REWRITES = new Map([
  ['./qq-tool-restrict.mjs', GUARD_SPECIFIER],
]);

export const BUNDLE_DIR = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets');
export function patchFileFor(name) {
  return path.join(BUNDLE_DIR, 'presets', `${name}.patch.yml`);
}
function sourceDirFor(name) {
  return path.join(REPO_ROOT, 'dsh', 'agent-presets', name);
}

function readYaml(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`读取失败 ${file}：${error?.message ?? error}`);
  }
  try {
    return yaml.load(text);
  } catch (error) {
    throw new Error(`${file} 不是合法 YAML：${error?.message ?? error}`);
  }
}

/**
 * 校验并改写行列表：只允许已知的相对行名（守卫），其余相对名视为错误。
 * @param {unknown} rows agent.cordis.yml 解析出的行列表
 * @param {string} preset preset 名（诊断用）
 * @returns {object[]} 可写进 patch 的行列表（深拷贝后的新对象）
 */
function normalizeRows(rows, preset) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${preset}: agent.cordis.yml 必须是「非空的插件行列表」（顶层数组）`);
  }
  const seen = new Set();
  const walk = (list, at) => list.map((row, index) => {
    const label = `${preset}: ${at} 第 ${index + 1} 行`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label} 不是插件行（应为带 name 的映射）`);
    if (typeof row.name !== 'string' || row.name === '') throw new Error(`${label} 缺少 name`);
    if (typeof row.id !== 'string' || row.id === '') throw new Error(`${label} 缺少 id`);
    if (seen.has(row.id)) throw new Error(`${preset}: 行 id 重复：${row.id}`);
    seen.add(row.id);
    const next = { ...row };
    if (next.name.startsWith('.') || path.isAbsolute(next.name)) {
      const rewrite = RELATIVE_ROW_REWRITES.get(next.name);
      if (rewrite === undefined) {
        throw new Error(`${label}: 相对/绝对插件名 ${JSON.stringify(next.name)} 在 0.1.7 下会按 profile 目录解析，`
          + '必须改写为「bundle 包名/子路径」或去掉；请在 build-agent-preset-patches.mjs 里显式登记改写规则');
      }
      next.name = rewrite;
    }
    if (row.group === true) {
      if (!Array.isArray(row.config)) throw new Error(`${label} 是 group 行但 config 不是行列表`);
      next.config = walk(row.config, `${at}/${row.id}`);
    }
    return next;
  });
  const normalized = walk(rows, 'plugins');
  for (const required of ['persona', 'qq-tool-restrict']) {
    if (!seen.has(required)) throw new Error(`${preset}: 行列表缺少 ${required} 行（安全/人格边界不允许缺失）`);
  }
  return normalized;
}

// 段内编号条目的形状：「【段标题】 1. … 2. …」（YAML 折叠后，同一段的条目以空格相连）。
// 按 1、2、3… 依次找「 N. 」，正文里偶然出现的数字不会被当成条目。
function splitNumberedItems(paragraph) {
  const starts = [];
  let from = 0;
  for (let n = 1; ; n += 1) {
    const at = paragraph.indexOf(` ${n}. `, from);
    if (at < 0) break;
    starts.push(at);
    from = at + ` ${n}. `.length;
  }
  if (starts.length === 0) return null;
  return {
    head: paragraph.slice(0, starts[0]),
    items: starts.map((at, i) => paragraph.slice(at + ` ${i + 1}. `.length, starts[i + 1] ?? paragraph.length)),
  };
}

function joinNumberedItems({ head, items }) {
  return head + items.map((text, i) => ` ${i + 1}. ${text}`).join('');
}

/**
 * 按 derive.yml 的规则改写 base 的 persona.prefix：先整条删除编号条目（同一段重新编号），再逐字替换。
 * 任何一条规则对不上都抛错，不产出改了一半的提示词。
 */
export function derivePersonaPrefix(prefix, { removeItems = [], replace = [] } = {}, label = 'derive') {
  const paragraphs = String(prefix).split('\n');
  for (const title of removeItems) {
    let hits = 0;
    for (let p = 0; p < paragraphs.length; p += 1) {
      const parsed = splitNumberedItems(paragraphs[p]);
      if (!parsed) continue;
      const kept = parsed.items.filter((text) => !text.startsWith(title));
      if (kept.length === parsed.items.length) continue;
      hits += parsed.items.length - kept.length;
      paragraphs[p] = joinNumberedItems({ head: parsed.head, items: kept });
    }
    if (hits !== 1) throw new Error(`${label}: 要删除的条目 ${title} 应恰好出现 1 次，实际 ${hits} 次（base 的条目标题改了？）`);
  }
  let text = paragraphs.join('\n');
  for (const { from, to } of replace) {
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`${label}: 替换源「${from}」应恰好出现 1 次，实际 ${count} 次（base 的措辞改了？）`);
    text = text.replace(from, () => to);
  }
  return text;
}

function readDeriveSpec(name) {
  const spec = readYaml(path.join(sourceDirFor(name), 'derive.yml'));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${name}: derive.yml 必须是映射`);
  if (!PRESETS.includes(spec.base)) throw new Error(`${name}: derive.yml 的 base 必须是 ${PRESETS.join(' / ')} 之一`);
  const removeItems = spec.removeItems ?? [];
  const replace = spec.replace ?? [];
  if (!Array.isArray(removeItems) || removeItems.some((title) => typeof title !== 'string' || title === '')) {
    throw new Error(`${name}: derive.yml 的 removeItems 必须是非空字符串列表`);
  }
  if (!Array.isArray(replace) || replace.some((r) => typeof r?.from !== 'string' || r.from === '' || typeof r?.to !== 'string')) {
    throw new Error(`${name}: derive.yml 的 replace 每项必须是 { from, to } 字符串`);
  }
  return { base: spec.base, removeItems, replace };
}

/**
 * 读一个 preset 的元数据与行列表：源 preset 直接读 agent.cordis.yml；
 * 派生 preset 照搬 base 的行列表，只改写 persona.prefix。
 */
export function presetSource(name) {
  const dir = sourceDirFor(name);
  const meta = readYaml(path.join(dir, 'preset.yml'));
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`${name}: preset.yml 必须是映射`);
  for (const field of ['name', 'description', 'order']) {
    if (meta[field] === undefined) throw new Error(`${name}: preset.yml 缺少 ${field}`);
  }
  if (!DERIVED_PRESETS.includes(name)) {
    return { meta, plugins: normalizeRows(readYaml(path.join(dir, 'agent.cordis.yml')), name), base: null };
  }
  const spec = readDeriveSpec(name);
  const plugins = normalizeRows(readYaml(path.join(sourceDirFor(spec.base), 'agent.cordis.yml')), name);
  const persona = plugins.find((row) => row.id === 'persona');
  if (typeof persona?.config?.prefix !== 'string') throw new Error(`${name}: base ${spec.base} 的 persona 行没有 prefix`);
  persona.config = { ...persona.config, prefix: derivePersonaPrefix(persona.config.prefix, spec, name) };
  return { meta, plugins, base: spec.base };
}

/** 渲染一个 preset 的 patch 文件内容。 */
export function renderPatch(name) {
  const { meta, plugins, base } = presetSource(name);
  const row = {
    id: presetRowId(name),
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: name,
      name: meta.name,
      description: meta.description,
      order: meta.order,
      plugins,
    },
  };
  const header = [
    `# 本文件由 scripts/build-agent-preset-patches.mjs 生成，请勿手工编辑。`,
    base
      ? `# 源：dsh/agent-presets/${base}/agent.cordis.yml，人格正文按 dsh/agent-presets/${name}/derive.yml 改写（正文请改 ${base}）。`
      : `# 源：dsh/agent-presets/${name}/preset.yml + agent.cordis.yml（人格正文与工具面都在那里改）。`,
    `# 作用：把 ${name} 作为一条 @deepseek-ai/dsh-agent-preset 行插入 profile（DSH 0.1.7+ 的 preset 机制）。`,
    `# 守卫行 qq-tool-restrict 用裸说明符 ${GUARD_SPECIFIER}：子行 name 按 profile 目录解析，`,
    `# 该包以 link: 依赖注册在 profile package.json（node_modules junction 由 setup-dsh.mjs 维护）。`,
    '',
  ].join('\n');
  // lineWidth: -1 —— 长行不折行，产物与源逐字对应，diff 只反映真实改动。
  return `${header}${yaml.dump([{ insert: [row] }], { lineWidth: -1, noRefs: true })}`;
}

/** 生成（或校验）全部 patch 文件。@returns {{file:string,changed:boolean}[]} */
export function buildPatches({ check = false, log = () => {} } = {}) {
  const results = [];
  for (const name of ALL_PRESETS) {
    const file = patchFileFor(name);
    const content = renderPatch(name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const changed = current !== content;
    if (changed && !check) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    }
    log(`${changed ? (check ? '✗ 需重新生成' : '✓ 已生成') : '· 已是最新'} ${path.relative(REPO_ROOT, file)}`);
    results.push({ file, changed });
  }
  return results;
}

// 直接执行时：默认生成，--check 只校验。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const results = buildPatches({ check, log: (line) => console.log(`[preset-patches] ${line}`) });
  const stale = results.filter((r) => r.changed);
  if (check && stale.length > 0) {
    console.error(`[preset-patches] ERROR: ${stale.length} 个 patch 文件与源不一致；请运行 node scripts/build-agent-preset-patches.mjs`);
    process.exit(1);
  }
  console.log('[preset-patches] Done');
}
