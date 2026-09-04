# Personal Workbench 外部 Beta 测试指南

感谢参与 Personal Workbench 0.3.0-beta.1 外部测试。当前安装器尚未签名，Windows SmartScreen 可能显示“未知发布者”。请从 GitHub Releases 下载，并在安装前核对 SHA-256。

```powershell
Get-FileHash .\Personal-Workbench-Setup-0.3.0-beta.1-x64.exe -Algorithm SHA256
```

预期值：`c403996e5166ed676bede613d0bd24ea361e8e3146197a65fe62d4f1d5761dc4`

## 建议测试清单

### A. 安装

- Setup 是否可以完成安装。
- SmartScreen 显示了什么信息。
- 开始菜单和桌面快捷方式是否符合预期。

### B. First Run

- 是否检测到本机 Ollama。
- 是否正确识别已经安装的模型。
- 是否错误要求重新下载已有模型。
- 可选组件缺失时，核心界面是否仍可进入。

### C. 文档

从 TXT、PDF、DOCX、PPTX 和 XLSX 中任选两到三种无敏感测试文件，检查导入、解析、学习资料生成和问答。

### D. 视频

媒体组件可用时，可以使用无敏感短视频测试。组件尚未安装时，记录“组件未安装”即可。

### E. 文件整理

第一次测试请新建一个测试文件夹，不要直接选择真实 Downloads 或其他重要资料目录。依次检查扫描、预览、确认执行和撤销，确认目录和文件结果符合预期。

### F. 退出

关闭主窗口，确认应用进入托盘；从托盘恢复窗口；最后通过托盘菜单退出，并观察是否还有 Personal Workbench 后台进程。

## 测试报告模板

```text
Personal Workbench版本：
Windows版本：
CPU：
RAM：
GPU：
VRAM：
Ollama版本：
模型：
安装：
First Run：
文档：
Organizer：
托盘退出：
发现问题：
诊断包：
```

## 提交 Issue 前

请检查截图和附件，避免暴露姓名、学校或公司账号、私人目录、私人文档、聊天记录、API Key 和其他凭据。诊断 ZIP 应先在本机解压检查；不要上传未经检查的诊断包。
