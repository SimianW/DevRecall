# Claude Code 与 Codex 的 skill 安装范围

调查日期：2026-08-25

> 迁移后状态，2026-08-25：本文下方记录的是迁移前的安装布局。当前 38 个个人 skill 已由 CC Switch 管理，实体主副本位于 `~/.cc-switch/skills/`，并通过软链接发布到 `~/.claude/skills/` 和 `~/.codex/skills/`。旧的 `~/.agents/skills`、DevRecall 项目级 skill、项目级 `skills-lock.json` 和 Claude 的 Matt Pocock 插件均已移除。Codex 自带的 `.system` skill 保留。

## 结论

这台机器确实把 Matt Pocock 的 37 个 skill 安装到了用户级 `~/.agents/skills`。对 Codex 来说，这些是全局 skill，可以在任意仓库中发现。对 Claude Code 则不能仅凭这个目录下结论，因为 Claude Code 官方的个人 skill 目录是 `~/.claude/skills`，不是 `~/.agents/skills`。

不过，Claude Code 也能在任意目录使用 Matt 的主要 skill。原因是这台机器另行安装并启用了用户级 `mattpocock-skills` 插件。它不是在复用 Codex 的那份全局目录。

所以，简短回答是：

- Codex：37 个 Matt skill 都有用户级副本，作用于任意仓库。
- Claude Code：用户级插件在所有项目中生效，但当前插件清单只公开 25 个稳定 skill。
- DevRecall：仓库内又安装了一套 37 个 skill，并用 `.claude/skills` symlink 交给 Claude Code。这个仓库因此有一套额外的项目级副本。
- `~/.agents/skills` 不是两者官方约定的共同用户目录。两者在本机都能使用 Matt skill，是两种安装机制叠加后的结果。

## 本机安装现状

### Codex 的用户级安装

`/home/simon/.agents/.skill-lock.json` 记录了 37 个条目。每个条目的 `source` 都是 `mattpocock/skills`，`sourceUrl` 是 `https://github.com/mattpocock/skills.git`，安装时间为 2026-08-24。对应的实体目录位于 `/home/simon/.agents/skills/<name>`。检查 `find` 输出后，没有一个顶层 skill 是 symlink。

这 37 个 skill 中，15 个允许模型自动调用，22 个带有 `disable-model-invocation: true`。后者不是没安装，而是设计成由用户明确调用。当前 Codex 会话公布的 Matt skill 恰好是前述 15 个，这与各 `SKILL.md` 的 frontmatter 一致。

15 个可自动调用的 skill 是 `code-review`、`codebase-design`、`diagnosing-bugs`、`domain-modeling`、`git-guardrails-claude-code`、`grilling`、`migrate-to-shoehorn`、`prototype`、`research`、`resolving-merge-conflicts`、`scaffold-exercises`、`setup-pre-commit`、`tdd`、`wizard`、`writing-for-agents`。

22 个仅由用户明确调用的 skill 是 `ask-matt`、`claude-handoff`、`grill-me`、`grill-with-docs`、`handoff`、`implement`、`implement-spec`、`improve-codebase-architecture`、`loop-me`、`retro`、`setup-matt-pocock-skills`、`setup-ts-deep-modules`、`teach`、`to-questionnaire`、`to-spec`、`to-tickets`、`triage`、`wait-what`、`wayfinder`、`writing-beats`、`writing-fragments`、`writing-shape`。

Codex 官方文档把 `$HOME/.agents/skills` 定义为 `USER` 作用域，并明确说该目录中的 skill 适用于任意仓库。仓库级 skill 则从当前工作目录到仓库根目录逐层扫描 `.agents/skills`。[OpenAI Docs: Build skills](https://learn.chatgpt.com/docs/build-skills)

本机 Codex 版本为 `codex-cli 0.149.1`。它还会读取 `~/.codex/skills`，当前会话中的 `unslop` 和系统 skill 就来自那里。`/home/simon/.codex/skills/.system/skill-installer/SKILL.md` 也仍把 `$CODEX_HOME/skills` 作为默认安装位置。因此，本机同时兼容 Codex 自有目录与 Agent Skills 的共享约定；Matt 这批安装在后者。

### Claude Code 的用户级安装

`claude plugin list` 显示：

```text
mattpocock-skills@claude-plugins-official
Version: 1.2.3
Scope: user
Status: enabled
```

同样的信息记录在 `/home/simon/.claude/plugins/installed_plugins.json`。安装目录是 `/home/simon/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3`，commit 是 `0ab1b63a410a03d3627979a109c8695de27af954`。`/home/simon/.claude/settings.json` 也将该插件标为启用。

插件的 `/home/simon/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3/.claude-plugin/plugin.json` 明确列出 25 个公开 skill。缓存仓库中还有 10 个 `in-progress` 或 `misc` skill 文件，但未列入插件清单。相比 `~/.agents/skills` 的 37 个文件，插件缓存少了 `implement-spec` 和 `retro`，而且不会因为文件存在就自动公开未列入清单的内容。

Claude Code 官方文档把个人 skill 目录定义为 `~/.claude/skills`，作用于所有项目；项目目录是 `.claude/skills`，并从启动目录向仓库根目录发现。官方文档没有把 `~/.agents/skills` 列为 Claude Code 的个人目录。[Claude Code: Extend Claude with skills](https://code.claude.com/docs/en/slash-commands)

这台机器的 `~/.claude/skills` 只有 `unslop`，没有 Matt skill symlink。因此，离开 DevRecall 后，Claude Code 能用 Matt skill 的直接依据是用户级插件，而不是 `~/.agents/skills`。

### DevRecall 的项目级重复安装

仓库内的 `/home/simon/Dev/DevRecall/.agents/skills` 有同样的 37 个 skill。`diff -qr` 确认它们与 `/home/simon/.agents/skills` 的当前内容逐字相同，但 inode 和安装时间不同，所以是独立副本，不是 symlink。

仓库的 `/home/simon/Dev/DevRecall/.claude/skills` 则有 37 个 symlink。比如：

```text
.claude/skills/ask-matt -> ../../.agents/skills/ask-matt
```

`/home/simon/Dev/DevRecall/skills-lock.json` 记录了这套项目安装，来源同样是 `mattpocock/skills`。因此 DevRecall 中至少存在三条 Matt skill 来源：Codex 用户级副本、仓库级副本，以及 Claude Code 用户级插件。Claude Code 还会经由仓库 symlink 看到项目副本。重复安装可能造成同名 skill 的来源或版本不直观。

## 能否在任意目录使用

| 场景                                       | 结论                                  | 实际来源                                                 |
| ------------------------------------------ | ------------------------------------- | -------------------------------------------------------- |
| Codex，在任意仓库                          | 可以使用 37 个用户级 Matt skill       | `~/.agents/skills`                                       |
| Claude Code，在任意仓库                    | 可以使用插件公开的 25 个 Matt skill   | 用户级 `mattpocock-skills` 插件                          |
| Claude Code，要用另外 12 个本机 Matt skill | 不能仅依赖当前用户级插件保证          | 需要项目级 `.claude/skills`，或另装到 `~/.claude/skills` |
| DevRecall 中的 Codex                       | 可以，但用户级与项目级来源重复        | `~/.agents/skills` 与仓库 `.agents/skills`               |
| DevRecall 中的 Claude Code                 | 可以，但插件与项目级 symlink 来源重复 | 用户级插件与仓库 `.claude/skills`                        |

## Matt 仓库自身如何看这两种安装

已安装插件的 README 也把它们分开：Claude Code 用托管插件；Codex 与其他 agent 用 `skills.sh` 写入普通 skill 文件。它还提醒同时安装会得到重复 skill。见 `/home/simon/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3/README.md` 第 27 至 70 行。

同一仓库的 `scripts/link-skills.sh` 将两个目的地分别写成 `~/.claude/skills` 与 `~/.agents/skills`。这进一步说明“共享”指同一种 skill 格式与同一来源仓库，不代表 Claude Code 与 Codex 原生读取完全相同的用户目录。

## 建议

如果目标是简单、可预测的全局使用，保留下面两条就够了：

- Claude Code 保留用户级 Matt 插件。
- Codex 保留 `~/.agents/skills` 中的 Matt 安装。

仓库内 `.agents/skills` 和 `.claude/skills` 是重复副本。除非你有意在 DevRecall 中修改或固定不同版本，否则可以另开一次清理任务，先确认版本与优先级，再决定是否移除。本文只调查，没有删除或重装任何 skill。
