# Personal Workbench 隐私说明

Personal Workbench 采用本地优先设计。用户选择的文档、图片、音频、视频和文件夹由本机组件处理，应用不会把本地文件内容发送给云端大模型。

## 本机处理内容

- PDF、DOCX、PPTX、XLSX、TXT 和 Markdown 文档解析。
- 通过本机 Ollama 完成对话、摘要、分类和 Embedding。
- 通过本机 RapidOCR 处理受控的文字图片或扫描文档。
- 通过本机 ASR 运行环境处理用户明确选择的音视频。
- Research Memory、Personal Inbox、Organizer 历史、配置和输出文件。
- 文件整理扫描、计划、确认、执行与撤销记录。

生产数据默认保存在 `%LOCALAPPDATA%\PersonalWorkbench`。用户在首次运行中选择其他数据目录时，应用会使用经过验证的本机目录。

## 可能访问网络的功能

- 获取用户明确提交的网页。
- 读取公开 GitHub 仓库内容。
- 获取用户明确提交的视频 URL 或媒体资源。
- 连接 `127.0.0.1` 上的 Ollama 服务。
- 用户明确操作时下载 Ollama 或模型。
- 下载 GitHub Release，或在未来版本中检查更新。

网络资源可能由相应网站、GitHub、视频平台、Ollama 或下载服务按照其隐私政策处理。Personal Workbench 不会把本地文件名、目录树或文档正文作为云端分类请求发送。

## 诊断包

诊断包用于定位安装和运行问题，只应包含版本、系统能力、组件状态、匿名化配置、有限运行事件和最近错误。诊断包设计上排除文档正文、完整 Prompt、Research Memory 正文、Organizer 文件内容、认证令牌和完整文件树。

提交诊断包前仍应自行检查其中内容。若发现姓名、账号、私人路径、凭据或私人文档内容，请停止上传并在本机删除该诊断包。

## 截图与 Issue

提交截图或 GitHub Issue 前，请遮盖姓名、学校或公司账号、私人目录、聊天记录、文档内容、API Key、Cookie 和其他凭据。不要把原始私人文件作为复现附件。
