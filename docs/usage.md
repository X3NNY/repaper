# re:paper 使用与开发参考

一个本地优先的论文研究工作台。使用 Electron、React、TypeScript 和 electron-vite 构建。

## 开始使用

需要 Node.js 22.12 或更新版本。

```bash
npm install
npm run dev
```

运行 `npm run build` 可进行类型检查并生成生产构建；`npm run preview` 可预览构建后的桌面应用。

## 当前功能

- 论文项目：新建时输入题目并选择本地工作文件夹；简称、阶段、简介和标签可在进入项目后补充。支持搜索和阶段筛选。进入论文后，左侧切换为这篇论文的专属导航，完成工作后可返回论文库。
- 会话：论文导航中的“概况”排第一，“会话”排第二。会话页按 Codex 和 Claude Code 分组列出所选文件夹的已有会话；点击会话后，在应用内分别启动对应的 CLI 终端。顶部用一个组合按钮新建会话，主按钮使用全局默认 Agent（初始为 Codex），下拉菜单可临时选择另一种；全局“设置”页可修改默认值。切换会话时，已打开的终端继续运行，直到手动关闭或退出应用。Codex 默认读取会话索引；点击“扫描会话”会同时扫描 Codex 本地旧日志和 Claude Code 的全部本地分页会话。
- 研究路线：每条路线有自己的目标、状态与实现记录。
- 实验：论文工作目录的 `.repaper/experiments/` 保存“实验组 → 实验 → 运行记录”。实验页左侧列出实验目录，右侧先展示设计原因、关键设置、文字／表格／图片结果和对论文的结论；下方运行记录提供命令、指标、Git 快照、关联会话、产物路径与日志。外部 CLI 写入后页面自动刷新。论文库外的全局“设置”页检测 Codex 和 Claude Code 的 SKILL 安装状态及版本，并可分别一键安装或更新。
- 写作：论文工作目录内使用 `.paper/` 作为手稿目录。首次进入选择 IEEE 单栏、IEEE 双栏或空模板；空模板只创建 `manuscript.tex`。选择后自动初始化该目录的 Git。文件树可收起，文本编辑自动保存；编辑 TeX 时右侧连续滚动显示编译后的 PDF，可查看最近一次编译日志或打开 PDF 所在目录。按住 Ctrl 点击 PDF 页面可跳到对应的 TeX 文件和行（macOS 使用 ⌘）；旧 PDF 若没有 SyncTeX 映射，需要在应用内重新编译。编译按钮默认使用 pdfLaTeX，可从按钮下拉菜单切换 XeLaTeX；普通改动快速编译，参考文献、样式、引用等依赖变化时完整编译。版本历史和记录版本放在同一操作组；选择历史提交后，以该提交为基准对比当前工作区，左侧标出新增、修改、删除文件，右侧只读编辑器用绿色和红色显示文本差异。记录版本时先预览各文件及总增删行数，没有改动时无法提交。
- 投稿：左侧“投稿”页按首次投递日期倒序展示各次投稿；每次投稿内按时间线记录审稿、编辑决定、rebuttal、修订稿等多个事件。可手动编辑，也可让 Agent 从邮件、OpenReview 页面或系统导出材料整理。关联上一轮投稿后可追溯转投过程。
- 修改任务：关联投稿轮次，记录进度和截止日期。
- 论文、路线、投稿和修改任务可在界面创建、编辑和删除，变更自动保存。实验由 CLI 和 Agent 维护；投稿也可通过 CLI 和 Agent 增量维护。

首次使用时工作区为空。界面上的“载入示例项目”会新建一篇标有“示例”的论文，用于查看各模块如何关联。

## 数据与代码结构

桌面应用将论文项目数据保存为用户数据目录中的 `workspace.json`。Windows 默认位置是 `%APPDATA%\repaper\workspace.json`。写作文件直接保存在论文工作文件夹的 `.paper/` 下，Git 历史也在该目录；编译产物保存在 `.paper/.build/`，不会加入新提交。实验记录保存在论文文件夹的 `.repaper/experiments/`，每次运行对应独立 JSON 与日志文件。投稿尝试、事件和原始附件保存在 `.repaper/submissions/`。Codex 和 Claude Code 会话仍保存在各自的本地数据目录中，论文项目仅关联工作文件夹。已有项目没有文件夹时，可通过“编辑项目”补选。开发时直接在普通浏览器打开 Vite 页面，会改用浏览器 localStorage，便于预览界面；写作、实验、投稿与会话连接只在 Electron 桌面应用中可用。

## 初始化已有目录

全局“设置”页为 Codex 和 Claude Code 安装 `repaper-init`、`repaper-experiments` 与 `repaper-submissions` 三个 SKILL。关联论文目录后，可让 Agent 使用 `repaper-init` 接入该目录。初始化会先检查目录内容，再运行 `repaper init --paper <目录>`：创建 `.repaper/`，并在根目录创建 `AGENTS.md` 或向已有文件追加可重复更新的 re:paper 说明。空目录到此为止，不会提前生成文稿或虚构实验记录。

已有内容时，初始化 SKILL 会判断最新的可编辑 LaTeX 主文件，使用 `repaper writing import <主文件> --paper <目录>` 把所选源目录中的 LaTeX 文件和相关图表资源复制到 `.paper/`，以 `manuscript.tex` 作为写作入口，并初始化该目录的 Git。原文件不会移动或覆盖；已有非空 `.paper/` 不会被自动替换。若只有 PDF、Word 等格式而没有 LaTeX 源文件，SKILL 会说明限制并保留原文件。

历史实验结果可通过 `repaper run import <组>/<实验> --source <已有结果文件> --summary <说明>` 导入。写作主文件和历史证据的相对路径均相对于论文工作目录。同一条历史证据可重复提供 `--source`，已核实的指标可用 `--metric 名称=数值`；顶层数值字段也会从 JSON 证据中读取。历史条目显示为“历史导入”，保留原文件路径与文件时间，不会伪装成新执行的成功运行。相同路径与内容重复导入不会增加条目。

## 实验命令与 SKILL

应用启动时会为内嵌 Codex／Claude Code 终端准备 `repaper` 命令，并注入当前论文目录与会话来源。外部终端可执行 `node out/cli/repaper.cjs`，在论文目录中运行 `repaper init`，或通过全局选项 `--paper <论文目录>` 指定项目。构建 CLI 使用 `npm run build:cli`。

```bash
repaper group ensure benchmark --title "跨数据集评测" --goal "检验泛化能力" --metric accuracy:max
repaper experiment ensure benchmark/data-a --title "A 数据集" --subtitle "检验 A 上是否优于基线" --design "在同一训练预算下比较方法与基线" --setting "数据集=A" --setting "主指标=accuracy"
repaper run benchmark/data-a --label "A 数据集 · seed 1" --metrics results/a.json --artifact results/a.json -- python eval.py --dataset A
repaper run annotate <运行ID> --summary "本次结果摘要"
repaper experiment update benchmark/data-a --paragraph "核对后的结果段落" --source-run <运行ID> --conclusion "本实验对论文的简短结论"
repaper experiment overview benchmark/data-a --file overview.json
repaper experiment revisions benchmark/data-a
repaper status --json
repaper list runs --json
repaper show <运行ID> --log
```

实验页只把已发布的概览显示为正式的设计原因、关键设置、结果和结论。旧的 `--question`、`--factor`、`--result` 等字段保留在折叠的“原始记录”中，不自动当成新结果；旧实验可复制整理指令交给 Agent 核对后发布。运行状态来自实际记录，运行历史可以展开；带来源的结果可直接打开证据详情。`--setting 名称=值` 可重复使用，简单结果可用 `--paragraph` 和 `--source-run` 更新。修改结果而未提供新结论时，旧结论会清空，避免与新结果错误组合。

更完整的概览用 `repaper experiment overview <组>/<实验> --file <JSON文件>` 一次提交。JSON 对象包含 `subtitle`、`designReason`、`keySettings`、`results`、`conclusion`；结果块支持 `text`、`table`、`figure`，每块都需用 `sourceRunIds` 关联已结束或历史导入的运行，结论需由这些结果支持。图片路径相对论文工作目录，支持 PNG、JPEG、WebP 和 GIF。每次发布都会保留概览修订快照，可从页面“更新记录”或 CLI 查看。运行启动时记下当时的概览版本；历史导入的证据不假定属于当前版本。表格、图片与运行状态各有独立来源，页面不自动推导科研结论。

`ensure` 对同一标识更新记录；`run` 每次创建新运行并实时透传输出，保留命令、起止时间、退出码、日志、Git 提交与工作区状态。`--metrics` 接受包含顶层数值字段的 JSON 文件，路径相对命令启动目录。`--artifact` 可重复使用，记录产物路径。CLI 直接执行 `--` 后的程序和参数；需要管道或多步操作时可先写成脚本再包装执行。

## 投稿记录与材料导入

一次投稿对应一个会议或期刊、投递日期，以及当时提交的论文版本或已核实的 `.paper/` Git 提交。审稿、编辑决定、rebuttal 和修订稿分别记作该次投稿中的事件，因此同一次投稿可以有多轮审稿和多次决定。拒绝后转投另一 venue 时新建投稿，并用 `previousSubmissionId` 连接上一轮。页面按投稿日期倒序展示，每张卡片内展示事件时间线；发生日期尚未提取时会标明录入日期并暂按录入时间排序。旧版工作区中的投稿会保留显示，点击“继续记录”可复制为可追加事件的新记录，原始旧记录仍保留。

记录进展时只需选择状态，再粘贴文本、链接或图片，也可附加 PDF／邮件等文件；原始材料会追加到这条进展。点击“保存并让 Agent 整理”会先准备所选 Agent 的投稿 SKILL，再打开关联终端并自动发送整理指令；以后继续编辑同一进展、补贴新材料时会优先沿用该终端。确认会话已保存后，后续按会话 ID 续接；若首次启动未成功，重新点击可再次发送。没有会话 ID 的旧记录会先查找原会话；旧版误标“已发送”但缺少可靠送达标记时可重新发送，有确认标记却找不到原会话时则会提示。Agent 可读取用户提供的邮件、公开的 OpenReview 内容、投稿系统导出的 PDF／网页／文本及截图，再整理投稿进展。事件外层的摘要可由 AI 撰写；审稿人标签、评分和完整意见正文，以及展示为编辑原话的结论，必须逐字保留原文，不翻译、改写或重组。原文、链接和附件作为来源保留，并与审稿内容关联。不同 venue 的评分保持原始标签和量表，不跨平台换算；缺失日期、决定或截止时间不推测。对于需要登录的 Elsevier 或自建系统，使用用户提供的导出文件或粘贴内容。

全局“设置”页用一个下拉框选择“自动审批”或“完全访问”，同时应用于 Codex 和 Claude Code；该选项用于之后启动或恢复的终端，运行中的终端继续使用原权限。Codex 分别使用 `--approve-for-me` 与 `--dangerously-bypass-approvals-and-sandbox`，Claude Code 分别使用 `--permission-mode auto` 与 `--permission-mode bypassPermissions`。

```bash
repaper submission list --json
repaper submission show <投稿ID> --json
repaper submission create --file submission.json
repaper submission update <投稿ID> --file submission.json
repaper submission event <投稿ID> --file event.json
repaper submission event <投稿ID> --file event.json --id <事件ID>
```

JSON 草稿文件需位于论文工作目录中。投稿草稿使用 `venue`、`submittedAt`（`YYYY-MM-DD`）与 `versionLabel` 或 `gitCommit`；旧版写作记录还可用稳定的 `versionId` 关联，并可填写 `track`、`previousSubmissionId`、`notes`。事件草稿至少要有 `kind`（`reviews`、`decision`、`rebuttal`、`revision`、`note`）；编辑决定事件还需 `decision` 分类，并用 `rawDecision` 保留原始文字。`occurredAt` 不确定时可留空。事件级 `summary` 可以是 AI 概括；每条 `reviews` 用 `reviewer`、`rawScore` 和 `rawText` 逐字保存审稿人标签、完整原始评分及意见正文。可选的 `displayMarkdown` 只负责将已核对的 `rawText` 按 Markdown 和 `$...$`／`$$...$$` LaTeX 公式排版，不得改变文字、数值和含义，且必须保留 `rawText` 并关联原始材料。旧 `score`、`summary`、`strengths`、`concerns`、`requests` 可能是 AI 整理内容，不可直接当作原文。`sources` 可保存邮件或网页原文与链接，原始文件路径放在顶层 `sourceFilePaths` 或带 `key` 的 `sourceFiles` 中，CLI 会复制附件。来源的 `key` 可通过审稿条目的 `sourceKeys` 关联；稳定的 `importKey` 可定位同一事件。更新事件时需先读取其最新 `revision` 并作为 `expectedRevision` 提交，冲突后重新整理，避免覆盖手动补充。详见 `repaper-submissions` SKILL。

全局“设置”页按提供方检查三个 SKILL 与 CLI，并比较安装版本与内置内容。一键安装会同时复制三个 SKILL 和 CLI；更新已有 SKILL 时会先备份原 `SKILL.md`。从投稿页启动整理时也会自动准备对应 Agent 的投稿 SKILL。安装一次对所有论文生效；新建或重启 Agent 会话后可加载新安装的 SKILL。源码位于 `skills/repaper-init/`、`skills/repaper-experiments/` 与 `skills/repaper-submissions/`。

Codex 功能需要本机已[安装并登录 Codex CLI](https://developers.openai.com/codex/cli/)。应用会从 `PATH` 查找可执行文件；Windows 上还会查找 Codex 桌面安装目录和 npm 全局安装包。如果自动查找失败，可将 `CODEX_CLI_PATH` 设置为 `codex.exe` 的完整路径。应用通过 CLI 的 app-server 协议只读取 Codex 会话索引，交互使用嵌入的原生 Codex CLI 终端。

Claude Code 功能需要本机已安装并登录 Claude Code CLI。应用从 `PATH` 或 Windows 的 `~/.local/bin` 查找原生 `claude.exe`，也支持 npm 安装的启动脚本；若自动查找失败，可将 `CLAUDE_CLI_PATH` 设置为可执行文件的完整路径。会话扫描读取 `~/.claude/projects` 下与论文文件夹对应的日志；若使用自定义配置目录，也会读取 `CLAUDE_CONFIG_DIR`。点击已有会话时通过 `claude --resume <会话 ID>` 在论文文件夹内恢复。论文管理系统不实现自己的 Agent 对话或审批逻辑。终端使用 Windows PTY，因此需要安装项目依赖中的 `node-pty` 原生模块。

写作功能需要本机安装 Git 与 TeX 发行版，并让 `git`、`pdflatex`、`xelatex`、`bibtex`、`synctex` 可从 `PATH` 调用。IEEE 模板还需要发行版提供 `IEEEtran.cls`。编译失败时可在写作页展开日志查看具体错误。

- `electron/main/`：窗口、文件读写、写作编译与 Git、会话扫描、CLI 终端和 Electron IPC。
- `electron/preload/`：仅向界面暴露有限的桌面 API。
- `shared/`：论文项目、写作、实验和投稿的数据类型。
- `cli/`：独立实验与投稿命令入口；`electron/main/experiments.ts`、`electron/main/submissions.ts` 提供文件读写与记录逻辑。
- `src/`：React 页面、表单及样式。

当前是基础框架，数据格式版本为 `1`。后续可在此基础上增加附件管理、全文检索、导入导出与备份。
