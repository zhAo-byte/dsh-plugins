# dsh-codex-bridge

**DeepSeek Harness ↔ Codex 生态桥。** 一个插件包、一层 profile layer、五行职责：

| 行 id | 模块 | 干什么 |
| --- | --- | --- |
| `skill-codex` | `dsh-codex-bridge`（包根） | 把 Codex 的 **skill**（知识/流程）接进 `ctx.skills` |
| `mcp-codex` | `dsh-codex-bridge/mcp` | 把 Codex 的 **MCP server**（能力/工具）批量接进 `ctx.tools` |
| `codex-auth` | `dsh-codex-bridge/auth` | 启动时**只读**检查 Codex 登录状态并给出提示 |
| `codex-panel` | `dsh-codex-bridge/panel` | 把上面三件事的摘要写进 Harness 侧 `codex-bridge` 设置命名空间 |
| `codex-panel-client` | `dsh-codex-bridge-client`（`client/`） | 浏览器侧那张卡：读上面那个命名空间并渲染（见第四节） |

四行宿主都**只读** Codex 的配置与目录，不写、不迁移；Codex 侧保持唯一真源，这边跟着变。
唯一被写的是 Harness 自己的 `codex-bridge` 设置命名空间——那是本桥的展示位，不是 Codex 的配置。

```
知识层  ctx.skills   ←  <project>/.codex/skills · $CODEX_HOME/skills · $CODEX_HOME/skills/.system
                        · $CODEX_HOME/plugins/cache/**/skills · [[skills.config]]
能力层  ctx.tools    ←  <project>/.mcp.json · $CODEX_HOME/plugins/cache/**/.mcp.json
                        · $CODEX_HOME/config.toml 的 [mcp_servers.*]
展示层  设置卡片     ←  ctx.settings 的 codex-bridge 命名空间（宿主写、浏览器读）
```

## 安装

```sh
npm i -g pnpm                                      # dsh plugin 依赖 pnpm
dsh plugin --profile web add /path/to/dsh-codex-bridge
```

本包声明了 `dsh.bundle.patch`，`dsh plugin add` 会把它写进 profile 依赖并列入 `dsh.profile.bundles`；
包内 `cordis.patch.yml` 插入上面几行，**用户的 `cordis.patch.yml` 保持原样 `[]`**。
每行都保留 id，所以仍可在用户补丁层按 id 覆盖配置或 `disabled: true` 关掉任意一行。

**新行在 profile 引导阶段装载**，`add` 之后要**重启一次后端**（macOS 外壳：`Harness → 重启后端` ⇧⌘R）。

依赖：`yaml` 由包内 `node_modules/yaml` 软链到 `~/.dsh/profiles/node_modules/yaml`；
`@deepseek-ai/*` 由 `node_modules/@deepseek-ai` 软链到运行中的 Harness。

浏览器半边是一个**独立包名**（`dsh-codex-bridge-client`，目录 `client/`）：`dsh-client-modules`
拒绝「一个 client 包名被两个 Loader 行解析到」，而本包被四行宿主共用，所以卡的实现不能挂在包根上。
它同样要能从 profile 根解析到：

```sh
ln -sfn /path/to/dsh-codex-bridge/client ~/.dsh/profiles/web/node_modules/dsh-codex-bridge-client
```

（`dsh plugin --profile web add /path/to/dsh-codex-bridge/client` 会把这个软链写进 profile 依赖，效果相同。）

---

# 一、skill-codex：知识层

## 来源与优先级

| rank | source | 位置 |
| --- | --- | --- |
| 150 | `project-codex` | `<repo>/.codex/skills`（就近 `.git` 祖先） |
| 300 | `custom` | 配置里的 `skillDirs` |
| 350 | `codex-config` | `config.toml` 的 `[[skills.config]]` 显式路径 |
| 450 | `codex-user` | `$CODEX_HOME/skills` |
| 460 | `codex-system` | `$CODEX_HOME/skills/.system`（imagegen / skill-creator / review-agent …） |
| 550 | `codex-plugin` | `$CODEX_HOME/plugins/cache/**/skills` |

同名 `rank` 小者胜（仅在同一注册层内比较）。`enabled = false` 的条目按 Codex 的意图排除。
`.system` 是**容器目录**，DSH 的 `<root>/<name>/SKILL.md` 规则不会下钻，所以它单独作为一个根。

## 配置

```yaml
- id: skill-codex
  config:
    codexHome: ~/.codex
    includeUserSkills: true
    includeSystemSkills: true
    includePluginSkills: true
    includeRepoSkills: true
    includeConfigEntries: true
    respectConfigDisables: true
    skillDirs: []
    excludePlugins: []          # 例：['chrome', 'openai-bundled/sites']
    watch: true                 # Codex 侧改动 → 自动 invalidate
    watchDebounceMs: 400
```

## 自检

```sh
node tools/catalog-check.mjs /path/to/workspace --load    # 只发现：分组列出 + 逐个读正文
node tools/integration-check.mjs /path/to/workspace pdf   # 真 SkillRegistry：注册/合并/夺冠/加载
```

本机实测：`88` 个 skill（user 11 / system 6 / plugin 71），正文 `88/88` 可读；
注册表 `85` 条（同名按 rank 合并）；`load imagegen: ok`。
`6` 条警告是源文件自身的 frontmatter 问题（4 个 unity skill 的 `description` 不是合法 YAML、
`Presentations`/`Spreadsheets` 不是 kebab 名），与 DSH 内置 provider 的行为一致。

---

# 二、mcp-codex：能力层

官方 `@deepseek-ai/dsh-mcp-client` 设计上是**一个 server 一行**。本行读 Codex 的 MCP 来源，
映射成官方 client 的配置，再用 `ctx.plugin()` 为每个 server 动态装载一个 `mcp-client` 子插件——
一行配置全部接入，工具名保持官方的 `mcp__<serverName>__<tool>`。

## 来源与优先级

后者覆盖前者（同名 server）：

| 顺序 | 来源 |
| --- | --- |
| 1 | `<projectRoot>/.mcp.json`、`<cwd>/.mcp.json` |
| 2 | 已安装插件自带的 `.mcp.json`（见下） |
| 3 | `$CODEX_HOME/config.toml` 的 `[mcp_servers.<name>]`（含 `.env` 子表） |

`enabled = false` 是**压制**而非跳过：同名 server 会从结果里删除，你在 Codex 里关掉的，这里不会偷偷打开。

### 「已安装插件」不是 `plugins/cache`

`~/.codex/plugins/cache` 里混着**历史市场留下的死缓存**（`codex plugin list` 里根本不存在的插件）。
只按目录枚举会读到早已不存在的插件，又会漏掉本地市场的活跃副本。本桥按 `codex plugin list` 的口径判定：

1. `config.toml` 里 `source_type = "local"` 的 marketplace → 从它自己的
   `<root>/.agents/plugins/marketplace.json` 清单解析插件目录，但**只取 `config.toml` 里有
   `[plugins."<name>@<market>"]` 记录的**——清单列出的是"市场上架"，config 里才是"已安装"；
2. `plugins/cache/<market>/<plugin>` 只有在带 `.codex-remote-plugin-install.json` 标记时才算数
   （远程市场的安装凭据）。

## 字段映射

| Codex | dsh-mcp-client | 说明 |
| --- | --- | --- |
| `command` / `args` / `cwd` | 同名字段 | 相对路径按来源目录解析 |
| `env` | `env` | 字面量直接搬 |
| `env_vars: [A, B]` | `env` | 从当前进程环境转发同名变量 |
| `tool_timeout_sec` | `toolCallTimeoutMs` | ×1000；缺省 60s |
| `url`（`type: http`） | `transport: streamable-http` | |
| `headers` | `headers` | 值里的 `${VAR}` 从环境展开 |
| `bearer_token_env_var` | `headers.Authorization` | 环境变量存在时注入 `Bearer …` |
| `startup_timeout_sec`、`tools.*.approval_mode`、`enabled_tools`、`omit_tools_from` | — | 官方 client 无对应概念，忽略 |

## 配置

```yaml
- id: mcp-codex
  config:
    codexHome: ~/.codex
    includeConfigServers: true
    includePluginServers: true
    includeRepoMcp: true
    includeDisabled: false
    onlyServers: []             # 白名单
    excludeServers: []          # 黑名单，例：['node_repl']
    skipUnauthenticated: true   # OAuth-only / 缺 token 的 HTTP server 直接跳过
    envPassthrough: true
    toolCallTimeoutMs: 60000
    oauthProxy:                 # OAuth 服务器走本地代理（见下节）
      enabled: false
      package: 'mcp-remote@0.14.2'
      servers: []               # 留空 = 所有 oauth_resource 的 server
      args: []                  # 追加给 mcp-remote 的参数
    extraServers: []            # Codex 不知道的 server，优先级最高（见下节）
```

### OAuth 服务器：一次授权，长期可用

DSH 官方的 `dsh-mcp-client` **没有 OAuth 能力**（源码里 `oauth / authorize / pkce / refresh_token`
出现 0 次，HTTP 配置只有静态 `headers`）。所以"在 DSH 里点一次授权"这件事，client 本身做不到；
但把远端 server 包一层**会做 OAuth 的本地代理**就等价了：

```yaml
- id: mcp-codex
  config:
    oauthProxy: { enabled: true }
```

于是 `figma` 这类 `oauth_resource` 的 server 会被改写成 stdio 子进程：

```
figma: url https://mcp.figma.com/mcp
   ↓
command: npx   args: ['-y', 'mcp-remote@0.14.2', 'https://mcp.figma.com/mcp']
```

`mcp-remote`（npm `mcp-remote`，MIT，活跃维护）负责 DCR/PKCE 授权、把 token 存在 `~/.mcp-auth`
并**自动刷新**；DSH 这边只看到一个普通 stdio 子进程。**一次授权之后每次启动都直接复用缓存**。

> **首次授权建议在带外做**：MCP server 在 profile 引导阶段连接，第一次没有缓存 token 时代理会等
> 浏览器回调（默认 30s 超时），可能拖慢甚至卡住启动。先手动跑一次：
>
> ```sh
> npx -p mcp-remote@latest mcp-remote-client https://mcp.figma.com/mcp
> ```
>
> 浏览器里同意后 token 就落在 `~/.mcp-auth`，之后再开 `oauthProxy` 并重启后端即可。
> 排查问题用 `--debug`（日志在 `~/.mcp-auth/{hash}_debug.log`），重置用 `rm -rf ~/.mcp-auth`。

#### 实测：Figma 的**远程** MCP 走不通，而且不是配置问题

本机跑 `mcp-remote-client https://mcp.figma.com/mcp` 的结果：

```
Discovered authorization server: https://api.figma.com
RegistrationRejectedError: Dynamic Client Registration rejected (HTTP 403): Forbidden
  submitted client_name: 'MCP CLI Client'
```

查 Figma 的授权服务器 metadata：DCR 端点存在（`/v1/oauth/mcp/register`）、PKCE S256、scope `mcp:connect`、
但没有 `client_id_metadata_document_supported`、没有 device code。而 [Figma 官方文档](https://developers.figma.com/docs/figma-mcp-server/)
把原因写得很直接：

> Only clients listed in the [Figma MCP Catalog](https://www.figma.com/mcp-catalog/) can connect to the
> Figma MCP Server.

也就是说这是 **Figma 侧的客户端白名单**，不是 DSH、也不是 `mcp-remote` 的问题——Codex 能连是因为它的 client
在名单里（凭据存在 keychain，无法安全复用）。**不要**去伪造别的产品的 `client_name` 绕过白名单。

合法出路是 [Figma 桌面版 MCP server](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)：
装 Figma 桌面版 → 打开设计文件 → Dev Mode（⇧D）→ 面板里 **Enable desktop MCP server**，
它监听 `http://127.0.0.1:3845/mcp` 且**不需要 OAuth**。用 `extraServers` 接进来即可：

```yaml
- id: mcp-codex
  config:
    extraServers:
      - name: figma-desktop
        url: http://127.0.0.1:3845/mcp
```

`extraServers` 是给"Codex 配置里没有的 server"留的口子，优先级最高（覆盖同名发现结果），
字段与 `.mcp.json` 的 server 条目一致（`command`/`args`/`env`/`cwd` 或 `url`/`headers`）。


## 自检

```sh
node tools/mcp-check.mjs --cwd /path/to/workspace   # 只发现、不连接：列出 server 与跳过原因
node tools/mcp-integration-check.mjs                # 真启动：引导 ToolRuntime + 本行，打印注册到的工具
```

本机实测：

```
servers 2      CSharpMCP(config.toml) · node_repl(config.toml)
skipped 3      cua_repl（活跃插件里 enabled = false）
               codex_app（enabled = false）
               computer-use（config.toml 里 enabled = false）
tools   18     CSharpMCP 14 · node_repl 4

$ node tools/mcp-check.mjs --oauth-proxy
（本机没有 oauth_resource 的 server 了 —— Figma 插件并未安装，见下节）
```

## 代价与边界

- **工具定义进每一次模型请求**（22 个 ≈ 数 K token）。建议 `excludeServers: ['node_repl']`
  —— 它与 `cua_repl` 工具名几乎重复，而后者 env 里才开了 browser/computer 两个 surface。
- **启动延迟**：boot 时连所有 server；连不上的只写日志 + 退避重连（`failOnStartupError: false`），
  不会拖垮 profile。
- **OAuth**：官方 client 只支持静态 header，所以默认跳过；开 `oauthProxy` 后由 `mcp-remote` 代理接管
  （见上节），`github` 这类静态 token 的则不需要 OAuth——设好 `GITHUB_PAT_TOKEN` 即可。
- **只桥工具**：MCP resources / prompts 官方不支持，这是 `dsh-mcp-client` 自身边界。
- Codex 的 per-tool `approval_mode` 不迁移，审批走 DSH 自己的策略层。

---

# 三、codex-auth：启动自检（只读，不改 Codex 逻辑）

有些 Codex 侧能力（例如通过 `codex exec` 用订阅额度跑 imagegen）需要一份有效的 Codex 登录。
这一行只在 profile 引导时**报告**状态，绝不做这些事：

- 不跑 `codex login`，不弹浏览器，不开本地回调端口；
- 不 spawn Codex 二进制；
- 不写 `$CODEX_HOME` 的任何文件（包括 auth.json）；
- 不碰 Codex 的刷新逻辑。

它只读 `$CODEX_HOME/auth.json`，本地解出 JWT 的 `exp` 做判断，四种状态：

| state | 含义 | 输出 |
| --- | --- | --- |
| `ok` | 有 chatgpt 登录且 access token 未过期 | info |
| `expired` | 已过期；有 refresh token 时 Codex 下次使用会自动刷新 | warn + 提示 |
| `missing` | 没有 auth.json / 无 token / 文件损坏 | warn + `run \`codex login\` once` |
| `apikey` | Codex 用的是 API key，不是订阅登录 | warn + 说明订阅不参与 |

```yaml
- id: codex-auth
  config:
    enabled: true
    codexHome: ~/.codex
```

输出走 **stderr**（在有 `ctx.logger` 时同时走 logger）：web profile 里 `ctx.logger` 并不落 stdout，
而宿主会把后端 stdout/stderr 收进 App 日志——"提示没人看得见"等于没做。

实测（隔离 DSH_HOME 引导的真实输出）：

```
codex-auth: Codex login present (auth_mode: chatgpt), access token valid until 2026-09-24 12:59
codex-auth: no auth.json under /tmp/definitely-no-codex-home — run `codex login` once if you want
            Codex-backed capabilities (image generation through `codex exec`)
```

自检：`node tools/auth-check.mjs [--codex-home <dir>]`。

> **为什么不"启动时自动 OAuth"**：那需要浏览器 + 本地回调端口，会阻塞启动路径，在 SSH/远程/无头环境直接卡死；
> 而且 token 本来就在 `auth.json` 里由 Codex 自己刷新。[Zed](https://zed.dev/blog/chatgpt-subscription-in-zed)
> 能"直接用订阅"，是因为它自己实现了 OAuth 2.0 PKCE
> （[PR #56811](https://github.com/zed-industries/zed/pull/56811)）并自己直连 ChatGPT 后端——那是**它的**模型客户端身份，
> 不是可以借给第三方宿主的 token 用途。DSH 要"用订阅画图"，走 `codex exec`，让持有凭据的 Codex 去画。

# 四、codex-panel + codex-panel-client：展示层

宿主行把「Codex 登录状态 + skill 计数 + MCP 计数 + 每条被拒/被跳过的原因」写进 Harness 自己的
`codex-bridge` 设置命名空间；浏览器半边的卡（`client/`，包名 `dsh-codex-bridge-client`）读它并渲染。

```
codex-panel（宿主）──写──▶ ctx.settings['codex-bridge'] ──读──▶ codex-panel-client（浏览器）
```

**为什么绕设置服务**：登录态、被拒 skill、被跳过 server 全是宿主侧事实，浏览器拿不到；
而带类型的 remote 需要本部署没有的生成工具链。设置服务本来就暴露给浏览器、本来就承载宿主值，
所以这里复用它的命名空间，只装**摘要**（88 条 skill 明细仍走官方 `skills/list` remote）。

## 卡片长什么样

```
▾ Codex bridge                             ● skills 88 · 15 off · 6 bad · mcp 2
  Codex skills, MCP servers, and login state as DSH sees them
  ────────────────────────────────────────────────────────────────
  LOGIN    ● chatgpt   Codex login present, access token valid until …
  SKILLS   Skills · 88 usable, 15 disabled by config, 6 with source problems
           · 15 disabled in the Codex config — not a problem
             ◌ ~/.codex/skills/speckit-analyze/SKILL.md: enabled = false in …
           · 6 the source itself has a problem
             ● /…/Presentations/SKILL.md: invalid skill name "Presentations"
             ● /…/unity/…/physics-3d-collision/SKILL.md: invalid YAML frontmatter…
  MCP      MCP · 2 loaded, 3 disabled by config
           · 3 disabled in the Codex config — not a problem
             ◌ cua_repl: enabled = false in Codex config
  read 2026-09-16T07:40:27.123Z · Codex files are read-only from here
```

挂到 **设置 → 插件** 页（可配置那张卡），按命名空间 key 分发（`settings.plugin.item`）。
命名空间不可用时卡不渲染——没装这个桥的部署看不到任何痕迹。

### 严重度分三档，别把「你自己关的」画成错误

第一版把每条被跳过的 skill 都画成红点，本机 21 条里 15 条是 `speckit-*` —— 也就是
**你自己在 Codex 配置里 `enabled = false` 的**。那是 Codex 的 opt-out，本桥刻意尊重它
（README 第二节：「你在 Codex 里关掉的，这里不会偷偷打开」），红点属于误导：

| 档 | 触发 | 呈现 | 本机 |
| --- | --- | --- | --- |
| ✅ | 已注册 | 绿点 | 88 skill · 2 MCP |
| ◌ off | 原因含 `enabled = false` | 灰点 + 桶标题「disabled in the Codex config — not a problem」 | 15 skill · 3 MCP |
| ❌ bad | 其余（frontmatter 坏、名字非法） | 红点 + 桶标题「the source itself has a problem」 | 6 skill · 0 MCP |

判定是纯函数 `severityOf(reason)`（浏览器侧）与 `skipKind(reason)`（宿主侧自检），
两边匹配同一句 `enabled = false`，所以卡片和 `panel-check` 永远不会给出不一致的严重度。
**代价是它匹配的是文案而不是结构化字段**——原因串由 `status.js` 从 provider 的 rejection
拼出来，浏览器拿不到别的信号，除非往命名空间加一个枚举字段（目前不值得）。

点击展开后每一档都有桶标题，所以「6 条 red」和「15 条 grey」不会被读成同一件事。

工程上的几个刻意选择：

- **手写 bundle，没有构建链**：本包不带 bundler，`client/lib/client.js` 就是产物，
  形如 `window.__ModuleLoader__.load({ id, factory })` + 惰性 CJS 工厂。
  只 `require('react')`（shell 基线表里的模块）——不申请任何 `dsh.client.external`。
- **样式一份 `<style>`**：包在工厂闭包里，按 `data-plugin-css` 幂等注入；
  只用 `--dsw-alias-*` 语义 token，且都带 fallback，不依赖私有类名。
- **只读**：卡没有任何写控件，`inject` 面只给 `readSnapshot` / `subscribe`。
  设置命名空间里唯一的写入者是宿主行。
- **宿主半是空壳**：`client/lib/index.js` 什么都不做——Loader 需要一个可导入的宿主行，
  `dsh-client-modules` 从同一行组合浏览器 bundle。

## 自检

```sh
node tools/panel-check.mjs .            # 宿主侧：浏览器无关地打印同一批 ✅/❌ 行
node tools/panel-check.mjs . --json     # 完整 payload（含 skipped 原因）
node tools/client-check.mjs             # 端到端：隔离 DSH_HOME 真启动 web profile 并断言四件事
```

`client-check.mjs` 是「卡到底装上了没有」的那一问。它**不碰你正在跑的后端**：临时 home 里
复制 profile 配置、软链两个包、用独立端口引导真正的 web profile，然后断言

```
  ✓ boot manifest lists dsh-codex-bridge-client
  ✓ entry graph row present (rev …, inject [@deepseek-ai/dsh-client-ui-settings])
  ✓ served application batch carries the bundle (10.6 MB composite)
  ✓ settings namespace codex-bridge published by the host row
```

退出时删掉临时 home（`DSH_CODEX_BRIDGE_CHECK_KEEP=1` 可留下排查）。
运行时目录默认取 `~/Library/Application Support/DeepSeekHarness/runtime`，可用 `DSH_RUNTIME_ROOT` 覆盖。

本机实测 `node tools/panel-check.mjs .` → `skills ✅88 ◌15 ❌6 · mcp ✅2 ◌3 ❌0`
（`◌` = 你自己在 Codex 里关掉的，不是缺陷；`❌` = 源文件本身有问题）。

> **视觉尚未人工确认**：卡片在本机真实 GUI 里还没点开看过（那需要重启当前后端）。
> 代码路径（包解析 → 组合 → 供给 → 命名空间 → 组件在注入与未注入两种 props 下的渲染）都已验证，
> 但「在设置页里长得对不对」请以你刷新后的眼睛为准。

### 副作用：它会往设置文档里写

面板值走的是 `settings.update('codex-bridge', …)`，所以重启后端后**你的 `~/.dsh/settings.yaml`
里会多出一个 `codex-bridge:` 段**（1 个状态头 + 24 条原因）。这是本设计唯一的写入面：
设置服务是浏览器本来就能读、且本来就承载宿主值的通道，而带类型的 remote 需要本部署没有的生成工具链。
不想看到它就把 `codex-panel` / `codex-panel-client` 两行按 id 禁掉——面板消失，写入也消失。

### 数据集形状

```js
{
  authState: 'ok' | 'expired' | 'missing' | 'apikey' | 'unknown',
  authMode: 'chatgpt' | '',
  authDetail: 'Codex login present (auth_mode: chatgpt), access token valid until …',
  skillsUsable: 88, skillsSkipped: 21,
  mcpServers: 2, mcpSkipped: 3,
  skillsSkippedReasons: ['<path>: <reason>', …],   // 与后端日志同一批；含 'enabled = false' 的画灰，其余画红
  mcpSkippedReasons: ['<server>: <reason>', …],
  generatedAt: '2026-09-16T07:16:31.811Z'
}
```

# 五、整体边界

- 本包是**桥**，不是移植：Codex 侧的文件、配置、MCP 进程都保持原样，DSH 只读。
- 想跨 agent 双向共享知识，往 `~/.agents/skills/` 写 skill —— Codex 与 DSH 都会实时发现（实测验证）。
- 两个自检脚本的 `process.exitCode`（而非 `process.exit()`）是刻意的：后者会在管道下截断大 JSON 输出。
- 浏览器半边的包名与宿主包名刻意分开，`cordis.patch.yml` 里五行各自保留 id，可以单独禁用。
