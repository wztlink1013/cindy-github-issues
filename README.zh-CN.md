# Cindy GitHub Issues 工作台

在一个页面查看和处理个人、组织仓库的 Issues，直接使用本机 GitHub CLI 的登录状态。

## 安装和使用

1. 安装 GitHub CLI。首次使用可运行 `gh auth login --hostname github.com`。如果 Cindy 已打开，请在装好 `gh` 后重启 Cindy。
2. 从 [GitHub Release](https://github.com/wztlink1013/cindy-github-issues/releases/latest) 下载最新的 `.cindy` 安装包，导入 Cindy 0.1.148 或更新版本。
3. 从左侧导航打开 **GitHub Issues**，点击 **选择仓库**，按仓库名搜索并勾选，最后保存。插件按 GitHub 用户 ID 保存你的选择。
4. 按仓库、状态、标签或指派人筛选。标题和编号只搜索已加载的 Issue，可点击 **加载更多 Issues** 继续加载。
5. 打开 Issue，查看正文和评论、增删标签和指派人、关闭或重开，也可在工作台新建 Issue。归档仓库可只读查看，内容以纯文本显示，长评论可打开 GitHub 查看全文。

## 账号与访问权限

插件通过本机 `gh` 执行 GitHub API 请求，令牌由 GitHub CLI 保管。安装时，Cindy 会说明插件的本机 Node 后台权限。切换账号可在终端运行 `gh auth switch --hostname github.com`，再在工作台点击 **重新检测**。写入权限由 GitHub 决定，组织仓库可能还需要完成 SSO 授权。

## GitHub API 额度

工作台顶部显示当前账号的 REST API 剩余次数、额度上限和重置时间。普通请求会顺带更新数字，也可点击「刷新额度」。同账号的其他工具也可能消耗这份额度。

在同一工作台中，已完整加载的仓库列表会复用 5 分钟，可在选择器中手动刷新。创建或修改 Issue 后只更新该条记录。GitHub 限流期间，工作台会停发请求并提示何时可重试。

## 开发

使用 Node.js 22.12 或更高版本，依次运行 `npm ci`、`npm test` 和 `npm run build`。主视图和设置页构建到 `dist/` 后，用 Cindy Forge 打包项目。前端使用 Vite、React、TypeScript、官方 shadcn/ui 组件和适配过的 shadcn/studio 主题。

源码采用 [Apache 2.0](LICENSE) 协议。这是独立开发的插件。
