# 构建与发布

re:paper 使用 electron-vite 编译代码、electron-builder 生成桌面安装包，并通过 GitHub Actions 在对应系统和 CPU 架构上构建。

## 发布产物

| 平台 | 架构 | 文件 |
| --- | --- | --- |
| Windows | x64 | NSIS `.exe` 安装包 |
| macOS | Intel x64 | `.dmg` 和 `.zip` |
| macOS | Apple Silicon arm64 | `.dmg` 和 `.zip` |
| Linux | x64 | `.AppImage` 和 `.tar.gz` |

每个 Release 草稿包含七个安装包或压缩包，以及 `SHA256SUMS.txt` 校验文件。CLI、Agent Skill 和 Electron 运行环境会随应用打包；Git、TeX、Codex / Claude Code 和实验环境由用户按需安装。

## 本地打包

需要 Node.js 22.12+。请在目标系统上构建；项目包含 `node-pty` 原生模块，跨系统构建不作为默认发布方式。

```bash
npm ci
npm run test:experiments
npm run pack
npm run test:package
```

`pack` 生成 `dist/` 下的解包应用，便于检查。`test:package` 使用打包后的 Electron 运行实验 CLI，并加载打包后的 node-pty 启动真实终端，检查原生模块和资源文件是否可用。

生成安装包时，按本机平台选择一条命令：

```bash
# Windows x64
npm run dist -- --win --x64

# macOS Apple Silicon
npm run dist -- --mac --arm64

# macOS Intel
npm run dist -- --mac --x64

# Linux x64
npm run dist -- --linux --x64
```

node-pty 1.1 使用 Node-API：Windows 和 macOS 使用包内预编译文件，Linux 由 npm 安装脚本从源码构建。打包器关闭了重复的 Electron ABI 重编译，最终由打包检查验证实际兼容性。Linux 需要编译工具链与 Python；如果主动要求 Windows 源码构建，还需要包含 Spectre 库的 Visual Studio C++ Build Tools。GitHub Runner 已提供基础工具，工作流会补充 Linux 依赖。

## GitHub Actions

工作流位于 [release.yml](../.github/workflows/release.yml)。

- **手动运行主分支**：在 Actions 中选择 “Build desktop releases” → “Run workflow”。只生成 Actions artifacts，保留 14 天，适合预检。
- **推送版本标签**：标签必须为 `v` 加 `package.json` 中的完整版本号。四个构建任务及打包检查全部通过后，创建 GitHub Release 草稿。
- **重跑失败任务**：可以补齐同一标签的草稿资源；工作流拒绝覆盖已公开发布的 Release。

首次发布现有版本：

```bash
git tag v0.1.0
git push origin v0.1.0
```

后续发布：

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.1.1"
git push origin main
git tag v0.1.1
git push origin v0.1.1
```

示例中的版本号需要与更新后的 `package.json` 一致。已推送的版本标签不要重新指向其他提交；需要修改代码时使用新版本号。

工作流使用仓库自带的 `GITHUB_TOKEN`，仅发布任务授予 `contents: write`，无需保存个人访问令牌。如果仓库或组织禁用了 Actions，需要先在仓库设置中允许工作流运行。

到 [Releases](https://github.com/X3NNY/repaper/releases) 打开草稿，确认各平台安装、应用启动、终端会话和写作功能，再编辑发布说明并点击 “Publish release”。构建与打包检查不替代各平台完整交互测试。

## 签名与安装提示

当前配置用于初期分发：Windows 未使用发行商证书；macOS 使用 ad-hoc 签名，尚未做 Apple notarization。Windows 可能出现 SmartScreen 提示；从网络下载的 macOS 应用可能被 Gatekeeper 阻止。

面向普通用户正式分发时，应接入 Windows 代码签名，以及 macOS Developer ID 签名和 notarization。届时需要调整 `electron-builder.yml` 中的 macOS 签名配置，并通过 GitHub Secrets 提供证书和凭据。当前配置没有自动更新功能。

Linux AppImage 依赖系统提供的运行库；如果环境不支持 FUSE，可使用 `.tar.gz` 版本。桌面启动时找不到 Git、TeX 或 AI CLI，可先从配置好 PATH 的终端启动应用，检查这些工具是否可用；Codex 和 Claude Code 还支持 `CODEX_CLI_PATH` / `CLAUDE_CLI_PATH` 指定路径。

## 资源与数据

应用代码位于 `app.asar`；node-pty 及辅助程序解包到 `app.asar.unpacked`；实验 CLI 和 Skill 放在 `resources/` 内，通过 Electron 的 `process.resourcesPath` 定位。打包钩子会在签名前为 Unix 终端辅助程序恢复执行权限，打包检查还会验证该权限和实际终端启动。

本地 `.paper/`、`.repaper/`、环境变量文件、证书和构建产物被排除在 Git 提交之外。用户项目数据不会作为安装包内容分发。
