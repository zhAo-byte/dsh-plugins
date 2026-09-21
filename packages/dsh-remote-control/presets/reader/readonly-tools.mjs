/**
 * readonly-tools —— 把这个 preset 的工具面收成「只读白名单」。
 *
 * 为什么需要这个插件（两层，各自解决一件事）：
 *
 * 1. tool-fs 是一套四个工具（read / read_image / write / edit），它的 Config
 *    只有读上限，**没有**"只挂 read"的开关 —— preset 要么整套挂，要么整套不挂。
 *    想要"能读不能写"，只能在运行时把能写的那两个摘掉。
 *
 * 2. 更要紧的一条：**"不挂 mutating 工具"并不等于只读**。host 层（base + web +
 *    本机的插件 bundle）会有工具注册进 ToolRuntime 的 **global 层**，而 global 层
 *    的工具是**每个 agent 都继承**的。本机就有一个现成的例子：
 *    `dsh-codex-bridge/mcp`（inject: ['tools']）会把 Codex 的 MCP 服务器工具
 *    注册进 ctx.tools —— 那些 `mcp__<server>__<tool>` 对一个只读 preset 来说是
 *    完全没见过的能力面，可能包含写文件、跑命令、操作浏览器。
 *    所以只读不能靠"我没挂"，必须靠**白名单收口**：不在清单里的一律拒。
 *
 * 两层机制：
 *
 *   A. guard（在 preset 的 standing scope 上注册）—— 硬闸，fail-closed。
 *      ToolRuntime.guardReason() 走 global + **整条 scope 链**，没有"自己的层豁免"，
 *      而且它**只看调用名、不看注册表**：凡是不在 ALLOWED_TOOLS 里的名字，不分来源
 *      一律拒掉。就算哪天有人重新打开 host 的 tool-bash、或者又接进来一个 MCP 服务器，
 *      这个 preset 的 agent 也调不动它。
 *
 *   B. restrict（在**每个 agent 自己的 scope** 上注册，agent/created 时打）—— 目录收口。
 *      ToolRuntime.view() 里 restriction 只过滤**继承来的**工具，自己层注册的不受
 *      自己层 restriction 约束。本 preset 的工具（含 write/edit、含 global 的 MCP
 *      工具）对 agent 都是**继承来的**，所以在 agent 自己的 scope 上 restrict 有效：
 *      模型看到的目录里只剩白名单那一批，不会去试不该试的东西。
 *
 *      反过来，**在 preset 层直接 restrict 是错的**：那一层正是注册 read/write 的层，
 *      restriction 对它是"自己的层"而被豁免；而且 restrict() 的 known-name 校验只认
 *      继承来的名字，会当场抛 `names unknown global tool`。（已用真实 ToolRuntime
 *      实测：preset 层 restrict 被拒，agent 层 restrict 生效。）
 *
 *   restrict 为什么包 try/catch：它在 agent/created 的同步监听里跑，监听抛错会否决
 *   agent 发布、把会话卡住。restrict 只在"某个名字不存在"时才会抛（例如部署里没有
 *   attachments、read_image 没注册），那只是目录不够干净；A 层硬闸不受影响，所以降级成
 *   一条警告而不是崩掉。
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'reader-readonly'

/** 需要 tools 注册表就位才能注册 guard。 */
export const inject = ['tools']

/**
 * 允许执行的模型可见工具 —— 白名单，其余一律拒。
 * 名字必须与各工具注册的名字一致（read / read_image / glob / grep / skill /
 * ask_user_question / todo_write），改动 preset 的工具行时要同步改这里。
 *
 * `run_code` 是 PTC 呈现模式的保留传输名，不是能力本身（它递送的是同一张白名单），
 * 所以放进允许集、但不放进目录收口（restrict 也禁止点名它）。
 */
const ALLOWED_TOOLS = ['read', 'read_image', 'glob', 'grep', 'skill', 'ask_user_question', 'todo_write', 'run_code']

/** 明确会改文件的工具名 —— 只为了让拒绝信息说人话，拒的是"不在白名单里"这件事。 */
const MUTATING_TOOLS = ['write', 'edit', 'str_replace_editor', 'apply_patch', 'bash', 'pwsh']

/** 收口后模型应该在目录里看到的工具（去掉保留传输名）。 */
const VISIBLE_TOOLS = ALLOWED_TOOLS.filter((tool) => tool !== 'run_code')

/**
 * 注册只读白名单。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 本 preset standing scope 上的上下文。
 */
export function apply(ctx) {
  ctx.tools.guard((exec) => {
    if (ALLOWED_TOOLS.includes(exec.name)) return undefined
    return MUTATING_TOOLS.includes(exec.name)
      ? `工具 "${exec.name}" 在本只读 preset 里不可用：这个 agent 改不了任何文件。请把建议的改动写在回复里，交给有写权限的人。`
      : `工具 "${exec.name}" 不在本只读 preset 的允许清单里（只允许 ${VISIBLE_TOOLS.join(' / ')}）。`
  })

  ctx.on('agent/created', ({ agent }) => {
    try {
      agent.ctx.tools.restrict({ allow: VISIBLE_TOOLS })
    } catch (error) {
      ctx.logger?.warn?.(`reader-readonly: 无法为 agent "${agent.id}" 收口工具目录（guard 仍然生效）：${String(error)}`)
    }
  })
}
