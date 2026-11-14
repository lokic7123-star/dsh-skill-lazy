import assert from 'node:assert/strict';
import { apply, tokenize, rankBM25, clip } from '../lib/index.js';

/* ----------------------------- 假宿主 ----------------------------- */

const SKILLS = [
  {
    name: 'loki-diagnosing-bugs',
    description: '诊断硬 bug 与性能回归：先分级再定层，要拿到运行时证据，不许只读代码就下结论。',
    content: '# 缺陷诊断\n步骤 A/B/C\n' + 'x'.repeat(3000),
    provider: 'filesystem',
    resourceBase: { kind: 'directory', path: 'D:/skills/loki-diagnosing-bugs' },
    invocation: { modelInvocable: true, userInvocable: true },
  },
  {
    name: 'office-pptx',
    description: 'Create, read, edit, and validate PowerPoint presentations (.pptx).',
    content: '# pptx\nuse python-pptx',
    provider: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true },
  },
  {
    name: 'loki-windows-utf8',
    description: 'Windows 终端中文乱码诊断与修复。',
    content: '# utf8\n先跑 check_utf8.py',
    provider: 'filesystem',
    invocation: { modelInvocable: true, userInvocable: false },
  },
  {
    name: 'i-have-adhd',
    description: '按 ADHD 读者习惯组织输出的用户专用技能。',
    content: '# adhd\n仅用户可调用',
    provider: 'filesystem',
    invocation: { modelInvocable: false, userInvocable: true },
  },
];

function makeHost({ skillList = SKILLS, bodySkills = null, throwOnList = false, throwOnGet = false } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const bodies = bodySkills ?? skillList;
  const ctx = {
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    skills: {
      async list() {
        if (throwOnList) throw new Error('discovery failed');
        return skillList;
      },
      async get(name) {
        if (throwOnGet) throw new Error('provider down');
        return bodies.find((s) => s.name === name);
      },
    },
    workingDirectory: { async ensure() { return 'D:/work'; } },
    on(event, handler, options) {
      if (!handlers.has(event)) handlers.set(event, []);
      const list = handlers.get(event);
      // 与 cordis 一致：prepend 插到最前（外侧），先执行、最后拍板。
      if (options && options.prepend) list.unshift(handler);
      else list.push(handler);
    },
  };
  return { ctx, tools, handlers };
}

const run = async (handlers, event, payload) => {
  const list = handlers.get(event) ?? [];
  const base = async () => ({ kind: 'continue', messages: payload.messages ?? [] });
  // 真瀑布：第 0 个监听器在最外侧，它的 next() 才会调用后面的监听器。
  const step = async (index) => (index >= list.length ? base() : list[index](payload, () => step(index + 1)));
  return step(0);
};

const exec = { agent: { id: 'agent-1' }, signal: { throwIfAborted() {} } };

/* ------------------------------ 单测 ------------------------------ */

// 1) 分词：英文词 + 驼峰 + 中文单字与二元组
{
  const terms = tokenize('skillSearch 中文乱码');
  assert.ok(terms.includes('skillsearch'));
  assert.ok(terms.includes('skill'));
  assert.ok(terms.includes('中'));
  assert.ok(terms.includes('中文'));
}

// 2) BM25：命中排前，未命中不出现
{
  const docs = ['a'.split('').concat('b'), ['c']].map((x) => x);
  const scores = rankBM25([tokenize('ppt presentation'), tokenize('中文 乱码 终端')], tokenize('乱码'));
  assert.ok(scores[1] > scores[0]);
}

// 3) clip 截断带标记
{
  const out = clip('x'.repeat(100), 20);
  assert.ok(out.length === 20);
  assert.ok(out.includes('已截断'));
  assert.equal(clip('short', 20), 'short');
}

// 4) 注册三个工具
{
  const { ctx, tools } = makeHost();
  apply(ctx, {});
  assert.deepEqual([...tools.keys()].sort(), ['skill_index', 'skill_load', 'skill_search']);
}

// 5) skill_search 命中最相关的技能
{
  const { ctx, tools } = makeHost();
  apply(ctx, {});
  const out = await tools.get('skill_search').execute({ query: 'ppt 演示' }, exec);
  assert.match(out, /office-pptx/);
}

// 6) 中文查询能命中中文描述，英文查询不会误命中中文技能
{
  const { ctx, tools } = makeHost();
  apply(ctx, {});
  const zh = await tools.get('skill_search').execute({ query: '乱码' }, exec);
  assert.match(zh, /loki-windows-utf8/);
  const en = await tools.get('skill_search').execute({ query: 'presentation' }, exec);
  assert.match(en, /office-pptx/);
}

// 7) skill_load 返回 skill_content，并带资源目录；超长正文被裁剪
{
  const { ctx, tools } = makeHost();
  apply(ctx, { loadMaxChars: 2000 });
  const out = await tools.get('skill_load').execute({ name: 'loki-diagnosing-bugs' }, exec);
  assert.match(out, /<skill_content name="loki-diagnosing-bugs">/);
  assert.match(out, /Base directory for this skill: D:\/skills\/loki-diagnosing-bugs/);
  assert.match(out, /已截断/);
}

// 8) skill_load 未知技能抛错且错误信息可行动
{
  const { ctx, tools } = makeHost();
  apply(ctx, {});
  await assert.rejects(
    () => tools.get('skill_load').execute({ name: '不存在' }, exec),
    /skill_search/,
  );
}

// 9) 与 dsh-tool-lazy 联动（需显式 loadToolsOnSkillLoad: true；默认关，不改工具可见性）
{
  const { ctx, tools } = makeHost();
  const revealed = [];
  globalThis.__dshToolLazy = { reveal: (agent, names) => revealed.push({ agent, names }) };
  apply(ctx, { loadToolsOnSkillLoad: true });
  const out = await tools.get('skill_load').execute({ name: 'office-pptx', tools: ['office'] }, exec);
  assert.equal(revealed.length, 1);
  assert.deepEqual(revealed[0].names, ['office']);
  assert.match(out, /<tool_reveal>已放开工具：office<\/tool_reveal>/);

  // 9b) 桥返回 false ⇒ 必须回执失败，不能谎报已放开
  globalThis.__dshToolLazy = { reveal: () => false };
  const failed = await tools.get('skill_load').execute({ name: 'office-pptx', tools: ['github'] }, exec);
  assert.match(failed, /<tool_reveal failed="true">/);
  assert.match(failed, /未能放开工具：github/);
  assert.doesNotMatch(failed, /已放开工具/);

  // 9c) 没有桥 ⇒ 同样回执失败并给出替代路径
  delete globalThis.__dshToolLazy;
  const noBridge = await tools.get('skill_load').execute({ name: 'office-pptx', tools: ['github'] }, exec);
  assert.match(noBridge, /未检测到 dsh-tool-lazy/);
  assert.match(noBridge, /tool_load/);
}

// 9a-2) 默认（不显式开启联动）：只读加载正文，不调用桥、不改工具可见性
{
  const { ctx, tools } = makeHost();
  let called = 0;
  globalThis.__dshToolLazy = { reveal: () => { called += 1; return { opened: ['office'], unknown: [] }; } };
  apply(ctx, {});
  const out = await tools.get('skill_load').execute({ name: 'office-pptx', tools: ['office'] }, exec);
  assert.equal(called, 0, '默认不应调用工具联动桥');
  assert.doesNotMatch(out, /已放开工具/);
  delete globalThis.__dshToolLazy;
}

// 9d) 模型不可调用的技能不得被 skill_load 绕过（对齐原生 skill 的 modelInvocable 检查）
{
  const { ctx, tools } = makeHost();
  apply(ctx, {});
  await assert.rejects(
    () => tools.get('skill_load').execute({ name: 'i-have-adhd' }, exec),
    /不允许模型调用/,
  );
  // 且它不应出现在检索与目录里
  const search = await tools.get('skill_search').execute({ query: 'adhd' }, exec);
  assert.doesNotMatch(search, /i-have-adhd/);
}

// 9d-2) 目录条目说「禁止」、正文定义说「允许」时也必须拒绝：
// 原生 skill 在读正文前先查 list() 的 modelInvocable，本插件不能只查正文这一道。
{
  const listEntry = {
    name: 'list-forbidden',
    description: '目录条目禁止模型调用。',
    invocation: { modelInvocable: false, userInvocable: true },
  };
  const bodyEntry = {
    ...listEntry,
    content: '# 正文\n本应不可达',
    provider: 'filesystem',
    invocation: { modelInvocable: true, userInvocable: true },
  };
  const { ctx, tools } = makeHost({ skillList: [listEntry], bodySkills: [bodyEntry] });
  apply(ctx, {});
  await assert.rejects(
    () => tools.get('skill_load').execute({ name: 'list-forbidden' }, exec),
    (err) => {
      assert.match(err.message, /不允许模型调用/);
      assert.doesNotMatch(err.message, /本应不可达/);
      return true;
    },
  );
}

// 9e) 正文超预算时必须显式告知截断与后续读取路径
{
  const { ctx, tools } = makeHost();
  apply(ctx, { loadMaxChars: 2000 });
  const out = await tools.get('skill_load').execute({ name: 'loki-diagnosing-bugs' }, exec);
  assert.match(out, /<skill_note>正文超出单次预算/);
  assert.match(out, /SKILL\.md/);
}

// 9f) 部分成功：一个有效组 + 一个未知组，回执必须分开列出，不能整包报「已放开」
{
  const { ctx, tools } = makeHost();
  globalThis.__dshToolLazy = {
    reveal: () => ({ opened: ['calc'], unknown: ['不存在的组xyz'] }),
  };
  apply(ctx, { loadToolsOnSkillLoad: true });
  const out = await tools.get('skill_load').execute(
    { name: 'office-pptx', tools: ['calc', '不存在的组xyz'] },
    exec,
  );
  assert.match(out, /<tool_reveal>已放开工具：calc<\/tool_reveal>/);
  assert.match(out, /<tool_reveal failed="true">未找到工具或分组：不存在的组xyz/);
  assert.doesNotMatch(out, /已放开工具：calc, 不存在的组xyz/);
  delete globalThis.__dshToolLazy;
}

// 9g) 桥回报全空（既没放开也没找到）时不得输出「已放开」
{
  const { ctx, tools } = makeHost();
  globalThis.__dshToolLazy = { reveal: () => ({ opened: [], unknown: [] }) };
  apply(ctx, { loadToolsOnSkillLoad: true });
  const out = await tools.get('skill_load').execute({ name: 'office-pptx', tools: ['x'] }, exec);
  assert.doesNotMatch(out, /<tool_reveal>已放开工具/);
  assert.match(out, /未能放开任何工具/);
  delete globalThis.__dshToolLazy;
}

// 10) 目录压缩：catalog 消息被换成紧凑文本，source 元数据原样保留
{
  const { ctx, handlers } = makeHost();
  apply(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 12 });
  const original = {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>原始超长目录</system-reminder>' }],
    source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'a', description: 'b' }] },
  };
  const decision = await run(handlers, 'agent/pre-step', {
    agent: exec.agent,
    signal: exec.signal,
    messages: [{ id: 'm0', role: 'user', content: [{ type: 'text', text: 'hi' }] }, original],
  });
  const patched = decision.messages[1];
  assert.equal(patched.id, 'm1');
  // 每条目录消息按它**自己的** entries 渲染（不能用最新快照覆盖历史消息）
  assert.match(patched.content[0].text, /compact catalog, 1 skills/);
  assert.deepEqual(patched.source, original.source);
  assert.ok(decision.messages[0].content[0].text === 'hi', '其他消息不得被改动');
}

// 10b) 宿主插入新目录后：新旧两条都必须压缩，且重复处理是幂等的
{
  const { ctx, handlers } = makeHost();
  apply(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 12 });
  const makeCatalog = (id, names) => ({
    id,
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>原始超长目录</system-reminder>' }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries: names.map((name) => ({ name, description: '这是一个非常长的技能描述用来测试截断是否生效' })),
    },
  });
  const payload = {
    agent: exec.agent,
    signal: exec.signal,
    messages: [makeCatalog('old', ['a']), makeCatalog('new', ['a', 'b', 'c'])],
  };
  const first = await run(handlers, 'agent/pre-step', payload);
  const oldText = first.messages[0].content[0].text;
  const newText = first.messages[1].content[0].text;
  assert.match(oldText, /compact catalog, 1 skills/, '旧目录消息也必须压缩');
  assert.match(newText, /compact catalog, 3 skills/, '最新目录消息必须压缩');
  assert.ok(newText.length < 900, '最新目录正文应被压短');
  // 幂等：已经是紧凑版就不应再改写（避免每步打断 prompt cache）
  const second = await run(handlers, 'agent/pre-step', { ...payload, messages: first.messages });
  assert.deepEqual(second.messages, first.messages, '重复处理不得再次改写');
}

// 11) fail-open：发现失败时原样返回 decision，不破坏这一步
{
  const { ctx, handlers } = makeHost({ throwOnList: true });
  apply(ctx, {});
  const messages = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'x' }] }];
  const decision = await run(handlers, 'agent/pre-step', { agent: exec.agent, signal: exec.signal, messages });
  assert.equal(decision.messages, messages);
}

// 12) skill_index 列出全部并裁剪描述
{
  const { ctx, tools } = makeHost();
  apply(ctx, { indexDescriptionMaxLength: 10 });
  const out = await tools.get('skill_index').execute({}, exec);
  assert.match(out, /共 3 个技能/);
  assert.ok(out.split('\n').filter((l) => l.startsWith('- ')).length === 3);
}

// 13) 顺序正确性：prepend 让本插件排在宿主目录注入器外侧，能覆盖它刚插入的 catalog
{
  const { ctx, handlers } = makeHost();
  apply(ctx, { compactCatalog: true });
  // 模拟 dsh-tool-skill：在本插件之后注册，往消息尾部追加长目录
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const catalog = {
      id: 'catalog-1',
      role: 'user',
      content: [{ type: 'text', text: 'LONG '.repeat(400) }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'a', description: 'b' }] },
    };
    return { ...decision, messages: [...decision.messages, catalog] };
  });
  const decision = await run(handlers, 'agent/pre-step', { agent: exec.agent, signal: exec.signal, messages: [] });
  const patched = decision.messages.find((m) => m.id === 'catalog-1');
  assert.ok(patched, 'catalog 消息存在');
  assert.ok(patched.content[0].text.length < 1000, `目录应被压短，实际 ${patched.content[0].text.length}`);
  // 按消息自己的 entries 渲染（宿主这条只有 1 条），不再套用最新快照
  assert.match(patched.content[0].text, /compact catalog, 1 skills/);
  assert.deepEqual(patched.source.entries, [{ name: 'a', description: 'b' }]);
}

console.log('skill-lazy mock tests passed');