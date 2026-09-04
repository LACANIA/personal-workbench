# Personal Workbench

这个项目的想法开始于半个月前。当时我想为朋友做一个容易上手的智能体。如今各类智能体不断出现，部署和使用却经常伴随着现实门槛，例如需要 VPN、境外账号，或者需要配置开发环境。于是，我想做一款更加简单、贴近日常需要的工具。它的性能未必能与成熟的商业产品相比，不过我希望它可以帮助普通用户整理和分类文件，为数据归纳与表格制作提供辅助，整理期末复习资料，也能从网页或视频链接中提取知识点并生成摘要。

Personal Workbench 使用本地模型，目前涵盖的功能有限，整体设计也尽量保持简洁。我希望用户无需理解 Node、命令行和复杂配置，完成安装以后，按照首次运行向导准备好本地 AI，便可以开始处理自己的日常资料。

Personal Workbench 是面向 Windows 的本地优先个人智能工作台。它把本地 AI、文档学习、视频资料整理、本地检索和可撤销文件整理放在同一个桌面应用中。

> **Beta Software · 0.3.0-beta.1**
> 当前 Windows 安装器尚未进行代码签名，SmartScreen 可能显示“未知发布者”。这是外部测试版本，不应视为正式生产版本。

## 下载

普通测试人员请从 [GitHub Releases](https://github.com/LACANIA/personal-workbench/releases/tag/v0.3.0-beta.1) 下载 `Personal-Workbench-Setup-0.3.0-beta.1-x64.exe`。安装器只作为 Release Asset 发布，不会存入源码仓库。

下载完成后可以在 PowerShell 中校验：

```powershell
Get-FileHash .\Personal-Workbench-Setup-0.3.0-beta.1-x64.exe -Algorithm SHA256
```

预期 SHA-256：

```text
c403996e5166ed676bede613d0bd24ea361e8e3146197a65fe62d4f1d5761dc4
```

## 核心能力

- 使用本机 Ollama 完成通用对话、分类和 Embedding。
- 解析 TXT、Markdown、PDF、DOCX、PPTX 与 XLSX，并生成 Word 学习资料。
- 对已经导入的资料进行本地问答和检索。
- 从视频、本地媒体、网页和公开 GitHub 仓库整理学习资料。
- 扫描用户明确选择的文件夹，预览整理计划，确认后执行，并支持撤销。

Local-first 表示私人文件处理与模型推理优先留在本机。网页获取、GitHub 公开仓库、视频 URL 获取、Ollama 模型下载以及 GitHub Release 下载仍可能访问网络。详细说明见 [隐私说明](docs/PRIVACY.md)。

## 系统要求

- Windows x64。
- 推荐 16 GB RAM 或更多内存。
- 本地 AI 服务：Ollama。
- 核心模型：`qwen3:8b`。
- 推荐检索模型：`qwen3-embedding:0.6b`。
- 可选代码模型：`qwen2.5-coder:7b`。
- NVIDIA GPU 可以提升部分任务速度；没有 NVIDIA GPU 时仍可使用 CPU 模式。

## 文件整理安全提示

文件整理遵循扫描、建议、预览、确认、执行和撤销流程。当前版本不会永久删除文件，不会覆盖目标文件，也不会自动跨磁盘移动文件。第一轮测试请使用新建的测试文件夹，并自行保留重要资料备份。软件仍处于 Beta 阶段，无法承诺完全消除数据风险。

## 文档

- [首次运行说明](apps/personal-workbench/distribution/README-FIRST-RUN.md)
- [外部 Beta 测试指南](docs/BETA-TESTING.md)
- [隐私说明](docs/PRIVACY.md)
- [安全问题报告](SECURITY.md)
- [源码贡献指南](CONTRIBUTING.md)
- [0.3.0-beta.1 发布说明](docs/releases/v0.3.0-beta.1.md)

## 开发

开发环境与测试命令见 [CONTRIBUTING.md](CONTRIBUTING.md)。DeepSeek Harness 官方仓库保持独立，Personal Workbench 只维护自身的生产集成代码和配置。

## 许可状态

当前仓库声明为 `UNLICENSED`。公开可见只代表任何人可以阅读源码，不自动授予复制、修改或再分发权利。第三方组件的许可信息见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
