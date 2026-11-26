# GitHub Issues for Cindy

[简体中文](README.zh-CN.md)

A desktop Cindy workspace for issues across GitHub.com repositories. It uses the active login in your local GitHub CLI.

## Install and use

1. Install GitHub CLI and run `gh auth login --hostname github.com` if you are not signed in. Restart Cindy if you installed `gh` while Cindy was running.
2. Download the `.cindy` package from the [latest release](https://github.com/wztlink1013/cindy-github-issues/releases/latest) and import it into Cindy 0.1.148 or later.
3. Open **GitHub Issues** from the left navigation. Open **选择仓库**, check the repositories you want, mark one **设为默认** and save. The workspace starts in that repository.
4. Filter issues by repository, state or label. The label menu reads the selected repositories' labels on demand. Title and issue-number searches cover loaded items. Use **加载更多 Issues** at the bottom of the list to fetch the next page.
5. Open an issue to read its body and comments in Markdown, edit its labels or assignees, or close and reopen it. Use **新建 Issue** to create an issue in a selected repository.
6. To have Cindy review an issue, select **交给 Cindy** and confirm. Find the task in Cindy's task list and continue the discussion there.

Your repository selection and default are stored in Cindy per GitHub user ID on this device. Run `gh auth switch --hostname github.com` to switch accounts and use **重新检测** to refresh immediately. GitHub enforces repository permissions and organization SSO. Archived repositories are read-only. Long comments can be read in full on GitHub.

## Local access

Cindy runs the bundled Node worker on demand. The worker calls the installed `gh` executable, which authenticates its own GitHub API requests. The plugin does not retrieve or store tokens. The install prompt shows native Node execution access. Review the [source](node/github.cjs) for the commands and endpoints used.

## GitHub API quota

The workspace header shows the current account's REST API quota, remaining requests, and reset time. Regular requests update the display. Select **刷新额度** to refresh it manually. Other tools using the same GitHub account can also draw from this quota.

The workspace reuses a fully loaded repository list for five minutes. The repository picker offers a manual refresh. Creating or editing an issue updates that issue in the workspace. If GitHub rate-limits the workspace, requests pause until the retry time shown.

## Development

For fast UI iteration, run `npm run dev`. Open the local URL printed by Vite to preview simulated issues, comments, and repository settings. Changes made in the preview last until the dev server restarts. To try real GitHub data, build and update the installed plugin in Cindy.

Use Node.js 22.12 or newer. Run `npm ci`, `npm test`, and `npm run build`. The build creates both plugin pages in `dist/`. Package the built project with Cindy Forge. The UI uses Vite, React, TypeScript, official shadcn/ui components, and an adapted shadcn/studio theme.

Licensed under [Apache 2.0](LICENSE). This is an independent project.
