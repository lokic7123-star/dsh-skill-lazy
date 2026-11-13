/**
 * dsh-skill-lazy — 技能目录瘦身 + 检索式加载，并与 dsh-tool-lazy 联动。
 *
 * 设计边界：
 *  - 不改宿主任何文件；只读 ctx.skills / ctx.tools 的公开接口。
 *  - 默认 fail-open：任何一步出错都退回宿主原生行为，不留半残状态。
 *  - 目录压缩是「重渲染既有 catalog 消息」，不新增消息、不改 source 元数据。
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-skill-lazy';
export const inject = ['tools', 'skills', 'workingDirectory'];

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const TOOL_NAMES = ['skill_search', 'skill_load', 'skill_index'];

const DEFAULTS = {
  logFile: 'skill-lazy.log',
  compactCatalog: true,
  catalogDescriptionMaxLength: 60,
  searchMaxResults: 6,
  searchMaxChars: 6000,
  loadMaxChars: 30000,
  indexDescriptionMaxLength: 48,
  loadToolsOnSkillLoad: true,
};

function loadConfig(overrides = {}) {
  const base = { ...DEFAULTS };
  try {
    const raw = readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf8');
    Object.assign(base, JSON.parse(raw));
  } catch (err) {
    base.__configError = err && err.message ? err.message : String(err);
  }
  return { ...base, ...overrides };
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/* ------------------------------- 日志 ------------------------------- */

function makeLogger(cfg) {
  return (line) => {
    try {
      appendFileSync(
        join(PLUGIN_DIR, cfg.logFile ?? DEFAULTS.logFile),
        `${new Date().toISOString()} ${line}\n`,
      );
    } catch {
      /* 日志失败不影响功能 */
    }
  };
}

/* ---------------------------- 中文感知分词 ---------------------------- */

const CJK = /[\u2e80-\u9fff\uf900-\ufaff]/u;
const WORD = /[A-Za-z0-9]+/g;
const CAMEL = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g;

export function tokenize(text) {
  const out = [];
  const raw = String(text ?? '');
  for (const word of raw.match(WORD) ?? []) {
    out.push(word.toLowerCase());
    const parts = word.match(CAMEL);
    if (parts && parts.length > 1) for (const part of parts) out.push(part.toLowerCase());
  }
  const chars = [...raw];
  for (let i = 0; i < chars.length; i += 1) {
    if (!CJK.test(chars[i])) continue;
    out.push(chars[i]);
    if (i + 1 < chars.length && CJK.test(chars[i + 1])) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

export function rankBM25(docs, terms) {
  const n = docs.length;
  if (n === 0 || terms.length === 0) return [];
  const k1 = 1.2;
  const b = 0.75;
  const df = new Map();
  const lengths = [];
  const tfs = docs.map((doc) => {
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    lengths.push(doc.length || 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const avg = lengths.reduce((a, v) => a + v, 0) / n;
  return docs.map((_, i) => {
    let score = 0;
    for (const term of terms) {
      const f = tfs[i].get(term) ?? 0;
      if (f === 0) continue;
      const d = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * lengths[i]) / avg)));
    }
    return score;
  });
}

/* ------------------------------ 文本裁剪 ------------------------------ */

const TRUNC = '…[已截断]';

export function clip(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - TRUNC.length)) + TRUNC;
}

/* ------------------------------ 技能目录 ------------------------------ */

async function listSkills(ctx, agent, signal) {
  const options = {
    cwd: await ctx.workingDirectory.ensure(agent, signal),
    signal,
    scope: agent,
  };
  const skills = await ctx.skills.list(options);
  return skills.filter((skill) => skill.invocation?.modelInvocable !== false);
}

function catalogEntries(skills, maxLength) {
  return skills.map((skill) => ({
    name: skill.name,
    description: clip(skill.description ?? '', maxLength),
  }));
}

/** 把既有 skill-catalog 消息重渲染成紧凑版（不改 source，保证宿主 digest 稳定）。 */
function compactCatalogText(entries) {
  const lines = entries.map((entry) => (entry.description ? `- \`${entry.name}\`: ${entry.description}` : `- \`${entry.name}\``));
  return [
    '<system-reminder>',
    `The following skills are available in this session (compact catalog, ${entries.length} skills).`,
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    'If the user names a skill, or the task clearly matches one, call `skill_load` with the exact name. When unsure what exists, call `skill_search` with keywords (supports Chinese). Load all applicable skills, then follow their full instructions.',
    'A skill may also be invoked directly by the user; its block then appears in the conversation — follow it and do not reload it.',
    '</system-reminder>',
  ].join('\n');
}

function compactMessages(messages, entries, compactedText) {
  let changed = false;
  const next = messages.map((message) => {
    if (changed) return message;
    if (message?.source?.kind !== 'skill-catalog') return message;
    const existingEntries = message.source.entries;
    if (!Array.isArray(existingEntries) || existingEntries.length === 0) return message;
    changed = true;
    const content = Array.isArray(message.content) ? message.content : [];
    const first = content[0];
    if (!first || first.type !== 'text') return message;
    return {
      ...message,
      content: [{ ...first, text: compactedText(entries) }, ...content.slice(1)],
    };
  });
  return changed ? next : undefined;
}

/* ------------------------------ 工具定义 ------------------------------ */

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

function ok(message) {
  return { content: [{ type: 'text', text: message }], isError: false };
}

/* ------------------------------- 插件主体 ------------------------------- */

export function apply(ctx, pluginConfig = {}) {
  const cfg = loadConfig(pluginConfig);
  const log = makeLogger(cfg);
  const limits = {
    catalogDescriptionMaxLength: boundedInt(cfg.catalogDescriptionMaxLength, 60, 16, 500),
    searchMaxResults: boundedInt(cfg.searchMaxResults, 6, 1, 30),
    searchMaxChars: boundedInt(cfg.searchMaxChars, 6000, 600, 40000),
    loadMaxChars: boundedInt(cfg.loadMaxChars, 30000, 2000, 200000),
    indexDescriptionMaxLength: boundedInt(cfg.indexDescriptionMaxLength, 48, 8, 500),
  };
  const compactCatalog = cfg.compactCatalog !== false;

  log(`apply: compactCatalog=${compactCatalog} catalogMax=${limits.catalogDescriptionMaxLength}`);

  /* 与 dsh-tool-lazy 的桥：拿工具目录、按需放开工具组。没有它也能独立工作。 */
  const bridge = () => globalThis.__dshToolLazy ?? undefined;

  ctx.tools.register({
    name: 'skill_search',
    description: '按关键词搜索本会话可用的技能目录（用法：skill_search(query)）。用于只记得用途、不记得确切技能名时。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词，支持中文（如「审查」「PPT」「乱码」）' },
        limit: { type: 'integer', description: '最多返回几条，默认 6' },
      },
      required: ['query'],
    },
    output: textOutput,
    async execute(args, exec) {
      const limit = boundedInt(args.limit, limits.searchMaxResults, 1, 30);
      const skills = await listSkills(ctx, exec.agent, exec.signal);
      const terms = tokenize(args.query);
      if (terms.length === 0) return `搜索词为空。当前共 ${skills.length} 个技能，可用 skill_index 查看全部。`;
      const docs = skills.map((skill) => tokenize(`${skill.name} ${skill.name} ${skill.name} ${skill.description ?? ''}`));
      const scores = rankBM25(docs, terms);
      const ranked = skills
        .map((skill, index) => ({ skill, score: scores[index] }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score);
      if (ranked.length === 0) {
        const names = skills.map((s) => s.name).join(', ');
        return `没有匹配「${args.query}」的技能。当前可用：${clip(names, 1500)}`;
      }
      const head = `命中 ${ranked.length} 个技能（显示前 ${Math.min(limit, ranked.length)} 个），用 skill_load 加载完整说明：`;
      const lines = [];
      let spent = head.length;
      for (const { skill } of ranked.slice(0, limit)) {
        const line = `- ${skill.name}: ${clip(skill.description ?? '', 200)}`;
        if (spent + line.length > limits.searchMaxChars) break;
        spent += line.length + 1;
        lines.push(line);
      }
      return [head, '', ...lines].join('\n');
    },
  });

  ctx.tools.register({
    name: 'skill_load',
    description: '加载一个技能的完整说明（用法：skill_load(name)）。名字必须来自技能目录或 skill_search 结果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '技能名，必须与目录里的名字完全一致' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：顺带放开这些工具名或工具分组（交给 dsh-tool-lazy）',
        },
      },
      required: ['name'],
    },
    output: textOutput,
    async execute(args, exec) {
      const lookup = {
        cwd: await ctx.workingDirectory.ensure(exec.agent, exec.signal),
        signal: exec.signal,
        scope: exec.agent,
      };
      const skill = await ctx.skills.get(args.name, lookup);
      if (!skill) throw new Error(`技能「${args.name}」不存在或当前不可用，请用 skill_search 重新确认名字`);
      // 与原生 skill 工具一致：模型不可调用的技能（disable-model-invocation）拒绝直接加载，
      // 即使它不在目录里也不能绕过——否则这条通道就成了原生限制的后门。
      if (skill.invocation?.modelInvocable === false) {
        throw new Error(`技能「${args.name}」不允许模型调用（仅用户可调），请由用户自行触发`);
      }
      const raw = skill.content ?? '';
      const body = clip(raw, limits.loadMaxChars);
      const parts = [
        `<skill_content name="${skill.name}">`,
        '<skill_resources>',
        `Base directory for this skill: ${skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : skill.resourceBase?.kind === 'url' ? skill.resourceBase.url : `provider "${skill.provider}"`}`,
        'Load referenced resources only as needed.',
        '</skill_resources>',
        '',
        '<skill_instructions>',
        body,
        '</skill_instructions>',
      ];
      if (raw.length > limits.loadMaxChars) {
        parts.push(
          `<skill_note>正文超出单次预算（${raw.length} 字符 > ${limits.loadMaxChars}），已截断；` +
            '剩余内容请按上面的 Base directory 用文件读取工具直接读 SKILL.md 与 references。</skill_note>'
        );
      }
      parts.push('</skill_content>');
      const requested = Array.isArray(args.tools) ? args.tools.filter((t) => typeof t === 'string' && t) : [];
      if (requested.length > 0 && cfg.loadToolsOnSkillLoad !== false) {
        const hub = bridge();
        if (hub && typeof hub.reveal === 'function') {
          let opened = false;
          try {
            opened = hub.reveal(exec.agent, requested) !== false;
          } catch (err) {
            log(`reveal failed: ${err && err.message ? err.message : err}`);
          }
          parts.push(
            '',
            opened
              ? `<tool_reveal>已放开工具：${requested.join(', ')}</tool_reveal>`
              : `<tool_reveal failed="true">未能放开工具：${requested.join(', ')}（dsh-tool-lazy 未加载或名字不匹配，请用 tool_search/tool_load 手动放开）</tool_reveal>`
          );
        } else {
          parts.push('', `<tool_reveal failed="true">未检测到 dsh-tool-lazy，工具未放开；请用 tool_load 手动放开 ${requested.join(', ')}</tool_reveal>`);
        }
      }
      return parts.join('\n');
    },
  });

  ctx.tools.register({
    name: 'skill_index',
    description: '列出全部技能的名字与一行用途（用法：skill_index(查询?)）。不确定该搜什么时先看这个。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '可选过滤词' },
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const skills = await listSkills(ctx, exec.agent, exec.signal);
      const terms = args.query ? tokenize(args.query) : [];
      const filtered = terms.length === 0
        ? skills
        : skills.filter((skill) => {
            const doc = new Set(tokenize(`${skill.name} ${skill.description ?? ''}`));
            return terms.some((term) => doc.has(term));
          });
      const lines = filtered.map((skill) => `- ${skill.name}: ${clip(skill.description ?? '', limits.indexDescriptionMaxLength)}`);
      return [`共 ${filtered.length} 个技能：`, '', ...lines].join('\n');
    },
  });

  /* 目录瘦身：宿主渲染完 catalog 消息后，用紧凑版覆盖文本。
     prepend 让本处理器排在 dsh-tool-skill 之后执行（外侧），才能拿到它刚插入的 catalog 消息并覆盖。 */
  if (compactCatalog) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (!decision || decision.kind === 'reject') return decision;
      try {
        const skills = await listSkills(ctx, payload.agent, payload.signal);
        const entries = catalogEntries(skills, limits.catalogDescriptionMaxLength);
        const messages = compactMessages(decision.messages ?? [], entries, compactCatalogText);
        if (!messages) return decision;
        log(`catalog compacted: agent=${payload.agent?.id ?? '?'} skills=${entries.length} chars=${compactCatalogText(entries).length}`);
        return { ...decision, messages };
      } catch (err) {
        log(`catalog compact skipped: ${err && err.message ? err.message : err}`);
        return decision;
      }
    }, { prepend: true });
  }

  ctx.on('agent/disposed', ({ agent }) => {
    log(`agent disposed: ${agent?.id ?? '?'}`);
  });
}

export default { name, inject, apply };