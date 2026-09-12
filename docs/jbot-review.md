# J-Bot review setup

J-Bot reviews PR diffs and posts findings. It cannot push fixes or generate documentation commits.
The initial configuration reports P0–P2 findings, up to 10 per run, with one review pass and
verification enabled. Verification reduces false positives; it does not prove correctness.
Documentation-only PRs are reviewed too.

## Activate

1. Add a repository Actions secret named `ZAI_API_KEY` containing your GLM Coding Plan key:
   https://github.com/SimianW/DevRecall/settings/secrets/actions
   Never paste the key in an issue, PR, workflow, or chat.
2. The default assumes a **mainland BigModel account** and `glm-5.3`.
   For an international Z.AI account, add Actions variable `JBOT_GLM_BASE_URL` =
   `https://api.z.ai/api/coding/paas/v4`.
   Variables: https://github.com/SimianW/DevRecall/settings/variables/actions
3. If your plan has a different model, set `JBOT_GLM_MODEL` to its actual API model ID
   (for example `glm-5.3`, without a provider prefix).
4. Merge the setup PR after inspecting the configuration. Comment and manual triggers
   become available once this workflow exists on the default branch.

Both regions use J-Bot's documented OpenAI-compatible adapter so the Coding Plan endpoint
is explicit. The secret name is retained for convenience; the workflow passes it only to
`openai-compatible-api-key`. It does not route through the generic pay-as-you-go endpoint.
Model availability and subscription access still require a real run with your account.

## Try it

Open a non-draft PR from a branch in this repository or push to an existing one.
Alternatively, comment exactly `/jbot` (no flags) on an eligible PR, or select
Actions → J-Bot Code Review → Run workflow and enter the PR number.

The comment trigger checks the comment author's current write/maintain/admin permission.
All triggers reject forks, drafts, closed PRs, and Dependabot PRs before exposing the model
key. Unrelated or rejected comments never enter the review concurrency group.
A newer accepted run cancels an older review of the same PR.

Look for a completed review in the PR and a successful action run. Missing credentials,
an unavailable model, provider errors, or permission failures must not be interpreted as
a clean review. The initial setup PR may need **Re-run all jobs** after adding the secret;
adding a secret does not automatically rerun an existing workflow.

For an effectiveness trial, choose a small real code PR. Check that findings identify
changed lines and concrete consequences, inspect false positives, then push a fix and
see whether J-Bot recognizes it. No artificial bug is added by this setup.

## Scope and limits

- Existing CI continues to typecheck, lint, test, and build independently.
- J-Bot cannot approve or merge PRs and has no repository contents write permission.
- Source context is sent to the configured GLM service using your key.
- The action is free software; GitHub Actions minutes and your provider quota still apply.
- Prior finding tracking is enabled. GitHub's default token may not be able to resolve
  review threads even when it can post an addressed reply; check logs before adding any
  extra credentials.
- Checkout and github-script are pinned to verified commit SHAs. Upstream J-Bot is beta:
  its `slim@v0` entry point uses a floating Docker image. Pinning only the action SHA
  would not freeze the runtime. This trial follows upstream updates; for reproducibility,
  migrate to an audited image digest. Keep this review optional during the trial.
- The extension version is unchanged because this changes CI and review guidance only.

## Sources

- [J-Bot action and adapter inputs](https://github.com/pgup-ai/jbot-review-action)
- [J-Bot model catalog](https://github.com/pgup-ai/jbot-review/blob/main/MODEL_CATALOG.md)
- [BigModel Coding Plan endpoints](https://docs.bigmodel.cn/cn/coding-plan/quick-start)
- [Z.AI and BigModel endpoint comparison](https://zcode.z.ai/en/docs/configuration)
