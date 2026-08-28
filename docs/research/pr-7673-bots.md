# PR #7673 上的 bots 和 agents

研究对象：[pingdotgg/t3code#7673](https://github.com/pingdotgg/t3code/pull/7673)，查看日期为 2026-08-24。本文只使用 PR 本身、该提交的源码与工作流配置、GitHub check-run 输出等一手资料。

## 先说结论

这页上的自动化并不是一群拥有同等权限的“机器人程序员”。它们分工很清楚：

1. **Claude Code** 是作者用来写这次修改的 coding agent，不是 PR 上的 reviewer bot。
2. **MacroscopeApp、Cursor Bugbot、CodeRabbit** 是 AI review 系统。前两个在这次 PR 上真的读了 diff，CodeRabbit 没有，因为仓库关闭了它的自动 review。
3. **GitHub Actions** 跑测试、类型检查、构建、移动端检查，并自动打大小和作者信任标签。它不是 LLM reviewer。
4. **[code]smith** 是 CI 自动修复服务，但这次没有启用，也没有修改代码。

PR 目前只有一个提交，仍为 open。自动 review 的重要结论是：Macroscope 不批准，Cursor 也发现了其中一个相同问题。CI 全绿不等于这次改动正确。

## Claude Code / Claude Opus 5

它做了什么：PR 作者在描述末尾声明，这次修改由 `Claude Opus 5 (1M) via Claude Code` 生成。修改解决 T3 Code 输入框把不能真正执行的 skills 和 slash commands 也展示出来的问题。[$` 菜单会提及可由模型调用的 skill，`/` 菜单会直接启动命令；PR 对两条路径分别过滤](https://github.com/pingdotgg/t3code/pull/7673#issue-3477746558)。

触发和输入：这是作者在本地或自己的 agent 环境中主动启动的，不是 GitHub 收到 PR 后自动触发。可确认的输入包括仓库代码、作者给 agent 的任务，以及 Claude skills / settings 行为；PR 没有公开完整 prompt 或完整 agent transcript，因此不能还原更细的编排。

输出：一个提交 `05c5100`、源码和测试改动、PR 描述及验证记录。[具体 diff 新增 `userInvocationOnly`，读取 `skillOverrides`，并在 web/mobile composer 中过滤菜单](https://github.com/pingdotgg/t3code/pull/7673/files)。

限制：PR footer 是作者提供的 provenance 声明，只说明使用了哪个模型和工具，不能证明每一行都由模型独立完成。Claude Code 也没有在此 PR 上留下 GitHub bot review。

## MacroscopeApp

Macroscope 在这里其实跑了四个相互配合的检查，并把结果汇总到 PR。

### Correctness Check

它做什么：读取 merge base 到 head 的代码变化，寻找实际正确性问题。此次输出是“检查 13 个 code objects，找到 3 个问题”，并发布三条 inline comments：[遗漏组织 managed settings](https://github.com/pingdotgg/t3code/pull/7673#discussion_r3821671814)、[把 `user-invocable-only` 错当成 enabled](https://github.com/pingdotgg/t3code/pull/7673#discussion_r3821671815)，以及[文档把 provider 命令限制错误地写成所有 `/` 命令的限制](https://github.com/pingdotgg/t3code/pull/7673#discussion_r3821671846)。前两个是 High，第三个是 Low。

触发、输入、输出：它在 head commit `05c5100` 出现后自动运行；输入是 PR diff 和可浏览的仓库代码，输出是一个 neutral check、三条带文件位置和建议修复 prompt 的 review comments。[对应 check-run](https://github.com/pingdotgg/t3code/runs/96429492427)。

### Effect Service Conventions

它做什么：这是仓库自己定义的专用 review agent，只审查 TypeScript/TSX 中 Effect service 的导入、service/layer 结构、依赖获取、错误建模和迁移纪律。配置明确指定 `claude-opus-5`、`high` effort、`full_diff` 输入、文件 include patterns，以及读代码、git、只读 GitHub API 和修改 PR 的工具。[完整 agent 定义](https://github.com/pingdotgg/t3code/blob/05c5100ec5a90948e9aecbaa9ee8a8ecf86eea93/.macroscope/check-run-agents/effect-service-conventions.md)。

输出：这次是 `All clear`，check conclusion 为 success。[对应 check-run](https://github.com/pingdotgg/t3code/runs/96429502723)。这只说明没有触犯该 agent 的 Effect service 规则，不代表整个 PR 正确。

### UI Consistency

它做什么：另一个仓库自定义 review agent，只看 `apps/web/src` 下符合 include pattern 的 TS、TSX 和 CSS。它检查共享 UI primitives、Tailwind/CSS 所有权、theme、scroll、layout 和交互回归。它同样使用 `claude-opus-5`、high effort 和 full diff。[完整 agent 定义](https://github.com/pingdotgg/t3code/blob/05c5100ec5a90948e9aecbaa9ee8a8ecf86eea93/.macroscope/check-run-agents/ui-consistency.md)。

输出：这次也是 `All clear` 和 success。[对应 check-run](https://github.com/pingdotgg/t3code/runs/96429504489)。它的文件过滤器不覆盖 mobile、server 或 docs，因此不会发现那里的问题。

### Approvability Check 和摘要

它做什么：Approvability 把 correctness 和仓库的最低 blocking severity 等资格规则汇总成能否批准的判断。此次因两个 High correctness findings，结果是 `Not approved`。[汇总评论](https://github.com/pingdotgg/t3code/pull/7673#issuecomment-5356133912)；[对应 check-run](https://github.com/pingdotgg/t3code/runs/96429494158)。Macroscope 也在 PR 描述中插入了 commit summary，说明它审了 7 个文件、评估 3 个问题并发出 3 条评论。[PR conversation 中的 summary](https://github.com/pingdotgg/t3code/pull/7673#issuecomment-5356060036)。

编排关系可以简化为：专用 convention checks 与 correctness check 并行读取同一 PR；correctness 产出 inline findings；Approvability 再根据 blocking findings 给出总 verdict。专用 checks 的 `All clear` 没有抵消 correctness 的 High findings。

## Cursor Bugbot

它做什么：对 commit `05c5100` 做 high-effort bug review。它发现一个 Medium 问题：`skillOverrides` 没有保留 `user-invocable-only` 模式，导致 `$` 菜单仍可能列出模型看不到的 skill。[inline finding](https://github.com/pingdotgg/t3code/pull/7673#discussion_r3821694078)。这与 Macroscope 的第二个 High finding 是同一个核心缺陷，只是严重程度评级不同。

触发、输入、输出：PR head 出现后自动读取 PR context 和代码变化，check-run 记录了三个阶段：收集 PR context、bug detection、发布分析；输出一个 neutral check、一条 review summary 和一条 inline finding。[check-run](https://github.com/pingdotgg/t3code/runs/96429506641)；[review summary](https://github.com/pingdotgg/t3code/pull/7673#pullrequestreview-4982872039)。

修复能力和限制：评论提供“Fix in Cursor”和“Fix in Web”入口，但 PR 明确显示 Autofix 为 OFF，所以 Bugbot 只报告问题，没有提交代码。neutral 也不是“通过”；它表示 review 完成并留下潜在问题，而不是阻止合并。

## CodeRabbit

它通常做什么：这是另一个 AI code reviewer，可对 PR 生成 review，也支持评论命令。

这次实际做了什么：没有审代码。仓库关闭了 automatic reviews，所以它只发布 `Review skipped` 状态消息。[CodeRabbit 评论](https://github.com/pingdotgg/t3code/pull/7673#issuecomment-5356060036)。

触发和输出：可以在评论中输入 `@coderabbitai review` 手动触发一次 review，也可以勾选它给出的 retry checkbox；`@coderabbitai help` 会显示命令。当前配置来自 Repository UI，profile 是 CHILL。因为没有触发 review，这次没有 CodeRabbit findings，不能把它的出现理解成“CodeRabbit 认为 PR 没问题”。

## GitHub Actions

页面上的 `github-actions[bot]` 是工作流执行身份。它没有用 LLM 理解代码，而是按仓库 YAML 执行固定脚本。

### CI

触发：任何 `pull_request`，以及 push 到 `main`。[CI workflow](https://github.com/pingdotgg/t3code/blob/05c5100ec5a90948e9aecbaa9ee8a8ecf86eea93/.github/workflows/ci.yml)。

输入和输出：checkout PR 代码后运行 `vp check`、typecheck、desktop build/preload 验证、全套测试、Rust tests、mobile native lint 和 release smoke。此次 `Check`、`Test`、`Mobile Native Static Analysis`、`Release Smoke` 都成功，例如 [Test job](https://github.com/pingdotgg/t3code/actions/runs/32370428661/job/96429488742)。这些检查擅长发现可重复的构建、类型、lint 和测试失败，但不会替代对遗漏配置来源等语义问题的 review。

### PR Size

触发：PR opened、reopened、synchronize、ready for review 或转 draft。工作流计算有效 changed lines，在混合 PR 中排除测试文件行数，再同步 `size:XS` 到 `size:XXL` 标签。[PR Size workflow](https://github.com/pingdotgg/t3code/blob/05c5100ec5a90948e9aecbaa9ee8a8ecf86eea93/.github/workflows/pr-size.yml)。这次输出 `size:L`，即 100 到 499 行；它只是规模分类，不是质量评分。

### PR Vouch

触发：同一组 PR 生命周期事件、包含 `/recheck-vouch` 的 issue comment，或 `main` 上 VOUCHED 文件 / workflow 变化。它查询作者的 vouch 状态，并同步 `vouch:trusted`、`vouch:unvouched` 或 `vouch:denounced` 标签。[PR Vouch workflow](https://github.com/pingdotgg/t3code/blob/05c5100ec5a90948e9aecbaa9ee8a8ecf86eea93/.github/workflows/pr-vouch.yml)。这次作者得到 `vouch:unvouched`。这表示作者尚未在信任名单中，不是说代码恶意或错误。

### 移动端相关 checks

`Native fingerprint diff` 在相关 mobile/client/contracts 路径改变时比较 PR 合并结果和 base 的 iOS/Android Expo fingerprints，并按结果同步 `📱 Native Change` 标签。它按设计永远 advisory。[workflow](https://github.com/pingdotgg/t3code/blob/05c5100ec5a90948e9aecbaa9ee8a8ecf86eea93/.github/workflows/mobile-fingerprint-check.yml)。此次成功。

`EAS Preview` 只在 PR 有 `🚀 Mobile Continuous Deployment` 标签时部署 preview；这次没有该标签，因此 skipped。[workflow](https://github.com/pingdotgg/t3code/blob/05c5100ec5a90948e9aecbaa9ee8a8ecf86eea93/.github/workflows/mobile-eas-preview.yml)。

## [code]smith / Blacksmith

它做什么：check 输出称它可以在启用后自动修复 CI。

这次实际状态：`[code]smith is not active on this PR`，conclusion 是 skipped，因此它没有读取失败、生成 patch 或改 PR。[check-run](https://github.com/pingdotgg/t3code/runs/96429480656)。不要把它和 Blacksmith-hosted CI runners 混为一谈：仓库的普通 GitHub Actions jobs 使用 `blacksmith-*` runners，但 `[code]smith` 是另外一个可选的 CI autofix check。

## PR 里那些名字不是 bots

`re-release-version`、`release-version`、`grill-with-docs`、`improve-codebase-architecture`、`slack` 和 `grilling` 是 Claude skills 或 slash commands 的例子，不是 GitHub review bots。这个 PR 的 bug 正是把三种不同调用语义混在菜单里：

- `$skill` 只是把 skill 名称作为 mention 放进 prompt，仍由模型决定是否调用；因此模型不可见或 disabled 的 skill 不应出现。
- `/command` 由 provider CLI 展开，且 provider command 必须位于整条消息开头。
- `/model` 和 `/plan` 是 T3 Code 客户端本地处理的 built-ins，不受 provider CLI 的开头限制。

这些行为分别由 [PR 描述](https://github.com/pingdotgg/t3code/pull/7673#issue-3477746558)、[shared filtering helper](https://github.com/pingdotgg/t3code/blob/05c5100ec5a90948e9aecbaa9ee8a8ecf86eea93/packages/client-runtime/src/providerSkills.ts) 和 [web composer diff](https://github.com/pingdotgg/t3code/blob/05c5100ec5a90948e9aecbaa9ee8a8ecf86eea93/apps/web/src/components/chat/ChatComposer.tsx) 体现。

## 怎么读这次结果

最有价值的是交叉验证：Macroscope 和 Cursor 独立指出 `user-invocable-only` 的同一个漏洞，可信度比单个 bot 的评级更高。Macroscope 另外发现 managed settings 遗漏，足以让组织策略与 UI 展示不一致。另一方面，CI 全绿只证明现有测试、类型、构建和静态检查通过。CodeRabbit 与 [code]smith 都没有实际 review。以当前证据，这个 PR 还不应仅凭“多数 checks 绿色”就合并。
