# dsh-git-repos

DSH 的**多仓库 Git 工具窗**：像 Rider / WebStorm 的 Git 面板那样，把一个工作台
下的**所有** Git 仓库列成一棵树，逐个下钻到变更、历史、分支、远程，并识别
**GitLab** 托管仓（合并请求、流水线、深链）。

装在官方右侧栏（`ctx.sidebarRightTabs` + `sidebar.right.pane.tab`），
可以拉到全屏；不依赖任何第三方 UI 插件。

```
packages/dsh-git-repos/
  lib/index.js     宿主行：/dsh-git-repos/api/* 的 JSON RPC + 两道守卫
  lib/git.js       git 引擎：只走 spawn(argv)，机器可解析格式
  lib/gitlab.js    GitLab：远端 URL 解析、深链、v4 REST
  lib/client.js    浏览器半边：右侧栏 tab（手写 bundle，无需打包器）
  cordis.patch.yml 一行 insert（随 bundle 自动合并）
  tools/           自检
```

## 安装

```sh
npm i -g pnpm                                  # dsh plugin 依赖 pnpm
dsh plugin --profile web add <本仓>/packages/dsh-git-repos
```

装完**重启一次后端**（macOS 外壳：`Harness → 重启后端`，⇧⌘R）。
`dsh plugin add` 会把包加进 `dsh.profile.bundles` 并软链到 profile 的
`node_modules`，所以之后改代码只要重启后端就能生效（宿主半边不吃 HMR）。

> 不要把这一行再手写进 `~/.dsh/profiles/web/cordis.patch.yml`：
> 同一个 `id: git-repos` 出现两次会让**整个 profile 启动失败**
> （`duplicate loader entry id`）。走 bundle 通道就够了。

打开方式：右侧栏 → 折叠时点会话标题栏右端的展开按钮 → 引导页里的
**「Git 仓库」** 胶囊；之后它就是一个普通标签页，可以和 Files、Diff 并排/分屏。

## 它做什么

**仓库列表**（顶部，可折叠）

- 扫描当前会话工作目录下的所有仓库（含子目录里的嵌套仓库、submodule），
  深度与数量有预算（默认 8 层 / 60 个 / 40000 个目录），每次都带时间戳。
  预算**从不静默生效**，但两种预算的报法不同，因为它们性质不同：
  深度是策略边界（深目录树上出现很正常），只在列表下方给一行浅色说明；
  目录数上限是保护阀被顶开（扫描可能停在半路），给黄色警示条。
  两者都说清该调哪个配置项。
  8 层覆盖的是各类常见容器布局：Unity 工程的同级 checkout 在
  `Assets/<Group>/<Module>`（第 5 层，旧默认值 4 层正好把整层藏掉），
  monorepo 的 `packages/<group>/<pkg>` 是第 3 层，其余多在 2–4 层。
- 每行：脏/干净圆点、相对路径、当前分支、`↑ahead ↓behind`、变更数、`GL` 标记。
- 悬停即出快捷动作：抓取 / 拉取 / 推送。
- 顶部工具栏：工作台切换（跟随 DSH 工作区注册表）、刷新、**全部抓取**、设置。
- 目录下没有仓库时提供「在此初始化仓库」（`git init`）。

**仓库详情**（下半，master–detail）

| 页签 | 内容 |
| --- | --- |
| 变更 | 冲突 / 已暂存 / 未暂存 三组；单文件暂存、取消暂存、放弃改动、查看差异；底部提交框（⌘/Ctrl+Enter 提交）+ Stash 列表（pop / drop） |
| 历史 | 时间轴提交树、ref 徽标、分页加载；点任意提交看该次改动 |
| 分支 | 新建并切换、切换、删除；远程分支一键检出；Worktree 列表 |
| 远程 | 每个 remote 的抓取/推送 URL、GitLab 判定、深链（仓库/分支/提交/MR/新建 MR/流水线）、抓取/推送/设为上游 |
| GitLab | 令牌状态；读取当前分支的**打开中合并请求**与**最近流水线** |

差异视图支持单栏 unified、按行着色、未跟踪文件也能看（走 `git diff --no-index`
对空树），超大 diff 截断到 4000 行。

## 配置

全部可选，写在 `packages/dsh-git-repos/cordis.patch.yml`，或在你自己的
`~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: git-repos
  config:
    discover:
      maxDepth: 8            # 1–24；每多一层，多 readdir 一层目录
      limit: 60              # 1–400；列出的仓库个数上限
      maxEntries: 40000      # 1000–2000000；访问目录数上限，防病态目录树
    extraRoots: []            # 工作区注册表之外还允许碰的目录
    allowHome: true           # 允许 $HOME 下的任何仓库
    gitlabHosts: []           # 自建 GitLab 主机名（含 "gitlab" 的自动识别）
    timeouts: { read: 20000, network: 180000 }
```

三个预算各自的失效方式不同，因此面板分开报告：`limit` 用仓库计数上的 `+`
表示（`truncated`）；`maxEntries` 顶开时是黄色条
（`discovery.entryLimited`）；`maxDepth` 触边时是列表下方一行浅色说明
（`discovery.depthLimited`）。三者都带本次访问目录数 `discovery.visited`
（在提示的悬停 title 里），并写明该改哪个字段。

**为什么不把深度默认值取得更大以求「一次扫完」**：实测这个 200 GB 的 Unity
工作台（22 个嵌套仓库）在 8 层时访问约 6.5k 个目录、耗时 0.64 秒，就已经把
22 个仓库全部列出；继续加深到 24 层要访问约 13.9 万个目录、耗时 2.9 秒，
而 `depthLimited` 依然为真——这棵树本身就比 24 层更深。既然任何可承受的固定
深度都扫不完，默认值就该取「覆盖所有常见容器布局」的那一档，把边界如实说出来，
而不是假装扫完了。`maxDepth` 的成本是每层一次 `readdir`，`Library`、
`node_modules`、`build`、`dist`、`Pods` 等重型目录已被剪掉；`limit` 的成本高
得多——每个仓库都要跑一次 `git status`——所以它保持 60，仓库特别多时再调大。

GitLab 令牌（只读即可，`read_api`）按优先级取：

1. 配置里的 `gitlabToken` / `token`
2. 环境变量 `GITLAB_TOKEN`、`GL_TOKEN`、`GITLAB_PRIVATE_TOKEN`
3. `~/.dsh/settings.yaml` 的 `git-repos.gitlabToken`

没令牌时面板照常工作：仓库、分支、差异、深链都在，只有 MR 与流水线读取会
提示缺令牌。**令牌永远不进浏览器**——只有宿主半边知道它，返回给页面的仅是
GitLab 自己的响应体。

## 安全边界

这是一个本地 HTTP 端点，因此有两道守卫（见 `lib/index.js`）：

1. **拒绝跨站**：只接受 `content-type: application/json` 的 POST，
   `Sec-Fetch-Site: cross-site` 直接 403，带 `Origin` 时只允许 loopback。
   浏览器里的任意网页因此无法驱动 git。
2. **限制目录**：payload 里的每个路径都要 `realpath` 后落在允许根之内
   （DSH 工作区注册表 ∪ `extraRoots` ∪ `allowHome` 时的 `$HOME`），
   否则 403。符号链接逃逸同样被这一步挡住。

破坏性动作（放弃改动、删除未跟踪文件、删分支、drop stash）在 UI 上**必须二次确认**，
宿主侧也要求显式路径：`repo.discard` 没有路径时直接拒绝。
所有 git 调用都是 `spawn('git', argv)`，从不拼 shell 字符串；分支名/路径按白名单校验，
路径一律跟在 `--` 之后。

## 自检

四道，按前提从轻到重；前三道只要 Node 和真仓库，第四道要一个浏览器。

```sh
cd packages/dsh-git-repos
npm run check          # 1. git 引擎：解析、发现、只读操作（对着真仓库跑）
npm run check:client   # 2. 浏览器半边：捕获 bundle、假 React+DOM，断言注册与渲染辅助
npm run check:host     # 3. 宿主路由：真 http server 起 RPC，断言两道守卫
npm run check:gui      # 4. 端到端：真 Chromium 打开真 GUI，开右侧栏、点胶囊、断言面板
```

第 4 道需要一个 `playwright-core`：

```sh
PLAYWRIGHT_CORE=/path/to/playwright-core \
  node tools/gui-check.mjs --url "http://127.0.0.1:PORT/?token=…" --session <会话标题> \
  --out /tmp/panel.png
```

它值得存在：`unpackDetail` 那类「宿主封套 vs 面板数组」的胶水错误，前三道全绿、
第四道一跑就红（`object.find is not a function`），而这是面板白屏级的 bug。

## 已知限制

- 提交文件树视图、多 worktree 选择器、blame、冲突解决 UI 尚未实现。
- diff 是文本视图，没有并排（split）模式与字符级高亮。
- 自动刷新只在面板可见时轮询（默认 10s，可调 3–120s），不是 `fs.watch`。
- 只读 GitLab：不在面板里创建/合并 MR（只给「新建 MR」的网页深链）。

## 授权

MIT。
