# dsh-skill-lazy

给 DeepSeek Harness（DSH）用的技能目录瘦身插件：把「每次请求都带 41 条技能长描述」换成「紧凑目录 + 按关键词检索 + 按名加载」，并可与 `dsh-tool-lazy` 联动，加载技能时顺带放开它需要的工具组。

零依赖、纯 ESM，不使用任何第三方代码（全部独立实现）。

## 它解决什么

DSH 的 `dsh-tool-skill` 会在每个会话里维护一条持久 `skill-catalog` 消息，把每个可见技能的 `name` + 完整 `description`（默认截到 500 字符）渲染进提示词。技能一多，这条消息就变成固定成本：41 个技能约 2.7K token，且每新增一个技能都在涨。

本插件做三件事：

1. **目录瘦身**：在宿主渲染完 catalog 消息后，把正文重渲染成紧凑版（名字 + 截断描述 + 一句"用 skill_search / skill_load"）。`source` 元数据原样保留，因此宿主自己的变更检测（digest）不会抖动，不会重复插消息。
2. **检索式发现**：新增 `skill_search`（BM25 + 中文二元组分词），只记得用途、不记得名字时先搜。
3. **按名加载 + 联动**：`skill_load` 输出与官方 `skill` 工具同形的 `<skill_content>`，并可通过 `tools` 参数调用 `dsh-tool-lazy` 的桥，顺带把对应工具组放开（联动见下）。

默认 **fail-open**：检索失败、目录读取失败、宿主接口变化，都原样退回官方行为，不会出现"目录被改坏、技能加载不了"的半残状态。

## 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `skill_search` | `query`（必填）、`limit` | 关键词检索技能，返回 `name: 描述`，预算内截断 |
| `skill_load` | `name`（必填）、`tools`（可选数组） | 输出完整 `<skill_content>`；传 `tools` 时联动放开工具 |
| `skill_index` | `query`（可选） | 列出全部技能名 + 一行用途 |

## 与 dsh-tool-lazy 联动

`dsh-tool-lazy` 在宿主里挂了一份共享桥 `globalThis.__dshToolLazy`。本插件调用 `bridge.reveal(agent, names)`：

```
skill_load({ name: "office-pptx", tools: ["office"] })
→ 加载技能正文
→ 同时放开 office 分组的工具（由 dsh-tool-lazy 执行 restrict 重算）
```

桥不存在时静默跳过，本插件可独立工作。

## 配置

`config.json`（插件目录内，改完需重载插件）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `compactCatalog` | `false` | 是否由本插件改写目录消息。默认关：优先用宿主原生 `dsh-tool-skill` 的 `catalogDescriptionMaxLength`（profile 里给 `tool-skill` 行配 `config`），只有原生短目录不够用、又确实需要更极端的压缩时才开 |
| `catalogDescriptionMaxLength` | `60` | 仅当 `compactCatalog: true` 生效，目录里每条描述最多多少字符（16–500） |
| `searchMaxResults` | `6` | 检索默认返回条数 |
| `searchMaxChars` | `6000` | 单次检索输出预算 |
| `loadMaxChars` | `30000` | 单次加载正文上限，超出截断并标注 |
| `indexDescriptionMaxLength` | `48` | `skill_index` 每条描述字符数 |
| `loadToolsOnSkillLoad` | `true` | 是否启用工具联动 |
| `logFile` | `skill-lazy.log` | 插件目录内的运行日志 |

## 安装

```bash
# 1. 关联到 profile
# C:\Users\<you>\.dsh\profiles\<profile>\package.json
#   "dsh": { "profile": { "bundles": [ ..., "dsh-skill-lazy" ] } }
#   "dependencies": { "dsh-skill-lazy": "link:D:/path/to/dsh-skill-lazy" }
# 2. 让包名可解析（软链接 / junction 到 node_modules）
# 3. 重载插件（plugin_manager 里关→开，或重启宿主）
```

卸载：从 `bundles` 与 `dependencies` 移除并重载，即回到官方行为（不残留任何限制）。

## 测试

```bash
node --check lib/index.js
node tests/mock.mjs   # 12 条断言：分词/排序/截断/三个工具/目录压缩/fail-open/联动
```

## 已知限制

- 目录压缩依赖宿主 catalog 消息的 `source.kind === "skill-catalog"`；宿主若改这个内部约定，插件会自动跳过压缩（fail-open），不影响功能。
- BM25 是词法检索，跨语言召回弱：中文查询主要命中中文描述，英文查询要命中英文描述。技能描述建议中英混排。
- 加载正文超 `loadMaxChars` 会被截断（默认 30K 字符，正常技能不会触发）；被截断时返回体里会带 `<skill_note>` 说明已截断，并提示按 Base directory 直接读 SKILL.md 与 references。
- 模型不可调用的技能（`disable-model-invocation` / `invocation.modelInvocable === false`）会被 `skill_load` 拒绝，与原生 `skill` 工具一致；这类技能也不会出现在目录与 `skill_search` 结果里。
- 联动回执只有在 `dsh-tool-lazy` 真的放开工具时才写「已放开工具」；桥返回失败或未安装时写 `<tool_reveal failed="true">`，不会谎报。

## 许可

MIT

## 许可与署名

本项目以 **MIT** 许可发布（见 [LICENSE](LICENSE)）。MIT 已经授予你自由使用、修改、分发与商业使用的权利；需要满足的许可条件只有一条：保留版权声明与许可声明。**除此之外没有附加条件。**

**署名请求（不是许可条件）**：如果你把本项目或它的修改版用到别处，希望顺手注明来源——原项目 `dsh-skill-lazy`、作者 lokic7123-star、仓库 https://github.com/lokic7123-star/dsh-skill-lazy 。

这只是礼貌性请求：不署名**不违反**许可，也不会因此产生任何义务或责任；README 里写不写它，都不改变 MIT 授予你的权利。