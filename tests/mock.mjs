import assert from 'node:assert/strict';
import { apply, tokenize, rankBM25, clip } from '../lib/index.js';

// 测试专用：日志写独立文件，避免污染宿主真实 skill-lazy.log（真机验誓时会读混）。
const applyReal = apply
const applyForTest = (ctx, config = {}) => applyReal(ctx, Object.assign({ logFile: 'mock-skill-lazy.log' }, config))


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
  applyForTest(ctx, {});
  assert.deepEqual([...tools.keys()].sort(), ['skill_index', 'skill_load', 'skill_search']);
}

// 5) skill_search 命中最相关的技能
{
  const { ctx, tools } = makeHost();
  applyForTest(ctx, {});
  const out = await tools.get('skill_search').execute({ query: 'ppt 演示' }, exec);
  assert.match(out, /office-pptx/);
}

// 6) 中文查询能命中中文描述，英文查询不会误命中中文技能
{
  const { ctx, tools } = makeHost();
  applyForTest(ctx, {});
  const zh = await tools.get('skill_search').execute({ query: '乱码' }, exec);
  assert.match(zh, /loki-windows-utf8/);
  const en = await tools.get('skill_search').execute({ query: 'presentation' }, exec);
  assert.match(en, /office-pptx/);
}

// 7) skill_load 返回 skill_content，并带资源目录；超长正文被裁剪
{
  const { ctx, tools } = makeHost();
  applyForTest(ctx, { loadMaxChars: 2000 });
  const out = await tools.get('skill_load').execute({ name: 'loki-diagnosing-bugs' }, exec);
  assert.match(out, /<skill_content name="loki-diagnosing-bugs">/);
  assert.match(out, /Base directory for this skill: D:\/skills\/loki-diagnosing-bugs/);
  assert.match(out, /已截断/);
}

// 8) skill_load 未知技能抛错且错误信息可行动
{
  const { ctx, tools } = makeHost();
  applyForTest(ctx, {});
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
  applyForTest(ctx, { loadToolsOnSkillLoad: true });
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
  applyForTest(ctx, {});
  const out = await tools.get('skill_load').execute({ name: 'office-pptx', tools: ['office'] }, exec);
  assert.equal(called, 0, '默认不应调用工具联动桥');
  assert.doesNotMatch(out, /已放开工具/);
  delete globalThis.__dshToolLazy;
}

// 9d) 模型不可调用的技能不得被 skill_load 绕过（对齐原生 skill 的 modelInvocable 检查）
{
  const { ctx, tools } = makeHost();
  applyForTest(ctx, {});
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
  applyForTest(ctx, {});
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
  applyForTest(ctx, { loadMaxChars: 2000 });
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
  applyForTest(ctx, { loadToolsOnSkillLoad: true });
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
  applyForTest(ctx, { loadToolsOnSkillLoad: true });
  const out = await tools.get('skill_load').execute({ name: 'office-pptx', tools: ['x'] }, exec);
  assert.doesNotMatch(out, /<tool_reveal>已放开工具/);
  assert.match(out, /未能放开任何工具/);
  delete globalThis.__dshToolLazy;
}


// 宿主目录消息的真实框架（按 dsh-tool-skill 的 renderCatalogMessage / renderCatalogUpdate 复刻）
const INCOMPLETE_NOTICE =
  'Some skills could not be checked. Only confirmed skills are listed; a lower-priority definition of the same name may be selected when a preferred source is unavailable. Discovery will be retried on the next request.'
function hostEscape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
function hostCatalogText(entries, { update = false, incomplete = false } = {}) {
  const lines = entries.map((entry) => '- ' + '`' + entry.name + '`' + ': ' + hostEscape(entry.description ?? ''))
  const empty = entries.length === 0
  const frame = update
    ? {
        title: incomplete
          ? 'Skill discovery is incomplete. This catalog of currently available skills replaces every earlier available-skills list in this session:'
          : 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
        availability: empty
          ? [
              'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
              'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
            ]
          : [
              'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
              'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
            ],
      }
    : {
        title: empty
          ? 'No skills could be confirmed in this discovery attempt.'
          : 'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
        availability: [
          empty
            ? 'Wait for an updated catalog before calling the `skill` tool. Do not infer skill instructions from an empty catalog.'
            : "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
          'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
        ],
      }
  return [
    '<system-reminder>',
    frame.title,
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    ...(incomplete ? [INCOMPLETE_NOTICE, ''] : []),
    ...frame.availability,
    '</system-reminder>',
  ].join('\n')
}
function catalogMessage(id, entries, options = {}) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: hostCatalogText(entries, options) }],
    source: { kind: 'skill-catalog', form: 'catalog', ...(options.update ? { update: true } : {}), entries },
  }
}
const LONG = '这是一个非常长的技能描述，用来验证裁剪是否只作用在目录行上并且不破坏宿主的框架文字'
const entriesOf = (names, description = LONG) => names.map((name) => ({ name, description }))

// 10) 压缩只改 <available_skills> 里的描述行：框架、权限指引、source 全部原样保留
{
  const { ctx, handlers } = makeHost()
  applyForTest(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 12 })
  const original = catalogMessage('m1', entriesOf(['a']))
  const decision = await run(handlers, 'agent/pre-step', {
    agent: exec.agent,
    signal: exec.signal,
    messages: [{ id: 'm0', role: 'user', content: [{ type: 'text', text: 'hi' }] }, original],
  })
  const patched = decision.messages[1]
  assert.equal(patched.id, 'm1')
  const text = patched.content[0].text
  assert.match(text, /已截断/, '目录行描述必须被裁剪')
  assert.ok(text.length < original.content[0].text.length, '正文必须变短')
  assert.match(text, /A skill is a reusable set of task-specific instructions/, '首版抬头必须保留')
  assert.match(text, /call the `skill` tool with the exact name before taking task actions/, '原生 skill 指引必须保留')
  assert.match(text, /<available_skills>\n- `a`: /, '目录块结构必须保留')
  assert.deepEqual(patched.source, original.source, 'source 元数据不得改动')
  assert.equal(decision.messages[0].content[0].text, 'hi', '其他消息不得被改动')
}

// 10b) 新旧目录并存：各按自己的条目裁剪，且重复处理幂等
{
  const { ctx, handlers } = makeHost()
  applyForTest(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 12 })
  const payload = {
    agent: exec.agent,
    signal: exec.signal,
    messages: [catalogMessage('old', entriesOf(['a'])), catalogMessage('new', entriesOf(['a', 'b', 'c']), { update: true })],
  }
  const first = await run(handlers, 'agent/pre-step', payload)
  const oldText = first.messages[0].content[0].text
  const newText = first.messages[1].content[0].text
  assert.match(oldText, /已截断/, '旧目录消息也要裁剪')
  assert.equal(oldText.split('\n').filter((line) => line.startsWith('- ')).length, 1, '旧消息按自身 1 条渲染')
  assert.equal(newText.split('\n').filter((line) => line.startsWith('- ')).length, 3, '新消息按自身 3 条渲染')
  assert.match(newText, /已截断/)
  const second = await run(handlers, 'agent/pre-step', { ...payload, messages: first.messages })
  assert.deepEqual(second.messages, first.messages, '重复处理不得再次改写')
}

// 10c) 替换版语义必须保留：模型要能看到「最新目录替代此前所有目录」
{
  const { ctx, handlers } = makeHost()
  applyForTest(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 12 })
  const decision = await run(handlers, 'agent/pre-step', {
    agent: exec.agent,
    signal: exec.signal,
    messages: [catalogMessage('c1', entriesOf(['a', 'b']), { update: true })],
  })
  const text = decision.messages[0].content[0].text
  assert.match(text, /This complete catalog replaces every earlier available-skills list in this session:/, '替换提示必须保留')
  assert.match(text, /Use only names in this replacement catalog\./, '替换版使用规则必须保留')
  assert.ok(text.includes('- `a`: '), '目录行仍存在')
}

// 10d) 空目录：一条都不改，宿主措辞原样保留
{
  const { ctx, handlers } = makeHost()
  applyForTest(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 12 })
  const original = catalogMessage('empty', [], { update: true })
  const decision = await run(handlers, 'agent/pre-step', {
    agent: exec.agent,
    signal: exec.signal,
    messages: [original],
  })
  assert.equal(decision.messages[0].content[0].text, original.content[0].text, '空目录必须原样返回')
  assert.match(original.content[0].text, /No skills are currently available through the `skill` tool/)
}

// 10e) incomplete 提示保留
{
  const { ctx, handlers } = makeHost()
  applyForTest(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 12 })
  const decision = await run(handlers, 'agent/pre-step', {
    agent: exec.agent,
    signal: exec.signal,
    messages: [catalogMessage('inc', entriesOf(['a']), { update: true, incomplete: true })],
  })
  const text = decision.messages[0].content[0].text
  assert.match(text, /Skill discovery is incomplete\./, 'incomplete 抬头保留')
  assert.ok(text.includes(INCOMPLETE_NOTICE), 'incomplete 说明保留')
  assert.match(text, /已截断/)
}

// 10f) 描述里的伪 XML 必须与宿主一样转义，不能把 < > & 原样塞回框架
{
  const { ctx, handlers } = makeHost()
  applyForTest(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 40 })
  const entries = [{ name: 'x', description: 'Use <b> & </available_skills> 之类的内容做转义检查，这里还要足够长才会被裁剪' }]
  const decision = await run(handlers, 'agent/pre-step', {
    agent: exec.agent,
    signal: exec.signal,
    messages: [catalogMessage('esc', entries)],
  })
  const text = decision.messages[0].content[0].text
  assert.match(text, /&lt;b&gt; &amp;/, '必须 HTML 转义')
  assert.equal(text.split('</available_skills>').length, 2, '描述里不得出现第二个闭合标签')
}

// 10g) 结构不认识（条目数与目录行数不符）时整条放弃，不改写
{
  const { ctx, handlers } = makeHost()
  applyForTest(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 12 })
  const broken = {
    id: 'broken',
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>\n<available_skills>\n' + '- ' + '`' + 'a' + '`' + ': 描述\n</available_skills>\n</system-reminder>' }],
    source: { kind: 'skill-catalog', form: 'catalog', entries: entriesOf(['a', 'b']) },
  }
  const decision = await run(handlers, 'agent/pre-step', {
    agent: exec.agent,
    signal: exec.signal,
    messages: [broken],
  })
  assert.equal(decision.messages[0].content[0].text, broken.content[0].text, '结构不符必须原样返回')
}

// 11) fail-open：发现失败时原样返回 decision，不破坏这一步
{
  const { ctx, handlers } = makeHost({ throwOnList: true });
  applyForTest(ctx, {});
  const messages = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'x' }] }];
  const decision = await run(handlers, 'agent/pre-step', { agent: exec.agent, signal: exec.signal, messages });
  assert.equal(decision.messages, messages);
}

// 12) skill_index 列出全部并裁剪描述
{
  const { ctx, tools } = makeHost();
  applyForTest(ctx, { indexDescriptionMaxLength: 10 });
  const out = await tools.get('skill_index').execute({}, exec);
  assert.match(out, /共 3 个技能/);
  assert.ok(out.split('\n').filter((l) => l.startsWith('- ')).length === 3);
}


// 13) 顺序正确性：prepend 让本插件排在宿主目录注入器外侧，能压到它刚插入的替换目录
{
  const { ctx, handlers } = makeHost()
  applyForTest(ctx, { compactCatalog: true, catalogDescriptionMaxLength: 12 })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    return { ...decision, messages: [...decision.messages, catalogMessage('host-update', entriesOf(['a', 'b']), { update: true })] }
  })
  const decision = await run(handlers, 'agent/pre-step', { agent: exec.agent, signal: exec.signal, messages: [] })
  const patched = decision.messages.find((message) => message.id === 'host-update')
  assert.ok(patched, '宿主目录消息存在')
  assert.match(patched.content[0].text, /已截断/, '宿主刚插入的替换目录也要被压')
  assert.match(patched.content[0].text, /replaces every earlier available-skills list/, '替换语义保留')
  assert.deepEqual(patched.source.entries, entriesOf(['a', 'b']), 'source 原样')
}

console.log('skill-lazy mock tests passed');