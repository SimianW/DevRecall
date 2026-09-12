# DevRecall CI and review workflow

DevRecall currently has automated CI and AI review, but no automated deployment or Chrome Web Store publishing workflow.

## Files and responsibilities

| File or setting | Responsibility |
| --- | --- |
| `.github/workflows/ci.yml` | Selects CI events, provisions Ubuntu/Node/pnpm, and runs checks in order. |
| `.github/workflows/jbot-review.yml` | Selects review events, validates the target PR, checks GLM configuration, and runs J-Bot. |
| `package.json` | Defines what each `pnpm` script executes and declares dependencies. |
| `pnpm-lock.yaml` | Locks dependency resolution; CI installs with `--frozen-lockfile`. |
| `tsconfig.json` | TypeScript compiler settings. |
| `eslint.config.js` | Lint rules. |
| `vite.config.ts` | Extension build configuration. |
| `AGENTS.md` | Project invariants and review guidance for agents; it is not an executable workflow. |
| `CONTEXT.md` | Domain vocabulary used by agents. |
| Repository Actions secrets | Supplies `ZAI_API_KEY` at runtime. GitHub supplies `GITHUB_TOKEN` automatically. |
| Repository Actions variables | Optional `JBOT_GLM_MODEL` and `JBOT_GLM_BASE_URL` overrides. |

## CI

Pushes to `main` or `dev`, and PR events targeting either branch, run CI.
The `checks` job installs pnpm 9 and Node 20 on a GitHub-hosted Ubuntu runner,
checks out the source, and installs dependencies from the lockfile.
It then runs these steps sequentially:

1. `pnpm typecheck`: `tsc --noEmit` checks TypeScript without emitting code.
2. `pnpm lint`: `eslint .` checks source against lint rules.
3. `pnpm test`: `vitest --run` executes the test suite once.
4. `pnpm build`: `tsc --noEmit && vite build` checks types again and builds the extension.

A failed step normally prevents later steps from running. A passing build shows the
extension can be built; it does not publish it or prove every browser interaction works.
The workflow does not upload a release artifact. Runner-local build output is temporary.
The `format:check` script exists in package.json but is not invoked by this CI workflow.
Tests requiring real OpenAI calls are expected to skip without `OPENAI_API_KEY`.

## J-Bot

PR opened/reopened/ready-for-review/new-commit events trigger review. An exact `/jbot`
comment or a manual workflow run with a PR number can also trigger it once the workflow
is present on the default branch.

The `gate` job resolves the current PR head and rejects closed, draft, fork, and
Dependabot PRs. It also rejects superseded automatic push events. Comment commands
require the author's current repository write, maintain, or admin permission.

The dependent `review` job checks GLM configuration, checks out the resolved head SHA,
and runs J-Bot in a Docker container. GitHub may download the action's image during job
preparation before executing the first configured step. Reviews share a per-PR concurrency
group so a new accepted run cancels the older one.

J-Bot sends the diff and requested code context to the configured GLM endpoint. The
mainland Coding Plan endpoint and `glm-5.3` are the defaults. The action posts review
feedback using GitHub's token. It cannot push code, approve a PR, or merge it in this setup.
The workflow requests finding verification, prior-comment context, one review pass,
and up to ten P0–P2 findings. Docs-only PRs are reviewed as well.

CI and J-Bot are independent workflows and can run in parallel. A CI success means
its configured checks passed. A J-Bot success means the review completed; read the
review itself to see whether it found problems. Neither status guarantees bug-free code.
Repository rulesets, not the YAML alone, decide whether a failed check blocks merging.

## Daily use

1. Create a feature branch and push changes.
2. Open a non-draft PR targeting `main` or `dev` to run both workflows.
3. Inspect PR checks and J-Bot's review. Open the Actions job logs for failures.
4. Push corrections: the workflows run again on the PR update.
5. Merge when satisfied and when repository merge requirements are met.
6. The merge push runs CI again on the target branch. Publishing the extension remains manual.

See [J-Bot setup](jbot-review.md) for credentials, region switching, runtime versioning,
and trial instructions. Adding a secret alone does not start a workflow run.
