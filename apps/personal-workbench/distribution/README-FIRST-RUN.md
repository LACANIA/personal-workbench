# Personal Workbench 0.3.0-beta.1 使用说明

Personal Workbench 是 Windows x64 外部测试版本。安装器尚未签名，Windows SmartScreen 可能显示“未知发布者”。

## 安装与校验

1. 下载 `Personal-Workbench-Setup-0.3.0-beta.1-x64.exe` 和 `SHA256SUMS.txt`。
2. 在安装器所在目录打开 PowerShell，执行：

```powershell
Get-FileHash .\Personal-Workbench-Setup-0.3.0-beta.1-x64.exe -Algorithm SHA256
```

预期 SHA-256：

```text
c403996e5166ed676bede613d0bd24ea361e8e3146197a65fe62d4f1d5761dc4
```

3. 双击安装器并按照安装向导完成安装，然后从桌面快捷方式或开始菜单启动 Personal Workbench。

## 首次运行

首次运行向导会检查 Ollama、本地模型、文档能力和可选媒体组件。缺少可选组件时仍可进入工作台；Ollama 缺失时，文档和文件整理等非 AI 能力仍然可以使用。

推荐模型：

- 通用模型：`qwen3:8b`
- 文档检索：`qwen3-embedding:0.6b`
- 代码模型：`qwen2.5-coder:7b`（可选）

应用只有在用户点击安装按钮以后才会下载模型，不会删除已有模型，也不会修改 Ollama 模型目录。

## 基本使用

- 知识导入：选择 TXT、Markdown、PDF、DOCX、PPTX 或 XLSX，也可以输入公开网页、GitHub 仓库或视频链接。
- 文档学习：完成解析后查看摘要、知识点、检索结果，并按页面提示生成学习资料。
- 文件整理：先新建一个测试文件夹，依次完成扫描、预览、确认执行和撤销。首次测试不要选择整个 Downloads、Desktop 或其他重要资料目录。
- 本地问答：资料完成导入后，在工作台中选择已有资料并提出问题。
- 视频学习：需要本机媒体组件；组件缺失时可以稍后在设置中安装。

## 退出、数据与卸载

关闭主窗口后，应用默认隐藏到 Windows 托盘。需要完全结束应用时，请打开托盘菜单并点击“退出”。

用户数据默认保存在：

```text
%LOCALAPPDATA%\PersonalWorkbench
```

其中包括数据库、配置、学习资料、整理历史、日志和备份。卸载程序默认保留这些数据，重新安装后仍可继续使用。若要清理用户数据，请先备份需要保留的内容，再手动删除上述目录。

## 问题反馈

可以在 GitHub Issues 中提交安装或使用问题，并附上 Personal Workbench 版本、Windows 版本、复现步骤和错误提示。设置页面可以导出诊断 ZIP；提交前请先解压检查，避免上传私人文档、账号、文件目录截图、API Key 或其他敏感信息。
