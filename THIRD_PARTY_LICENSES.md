# Personal Workbench 第三方组件清单

本清单覆盖 Windows 发行版直接包含的生产依赖，以及首次运行界面能够检测、但不会随安装包分发的可选组件。完整许可文本由各 npm 包或对应官方分发包提供。

| 组件 | 用途 | 分发状态 | 许可证 |
|---|---|---|---|
| Electron | Windows 桌面宿主与内置 Node.js 运行时 | 随应用分发 | MIT |
| Chromium / Node.js | Electron 运行时组成部分 | 随 Electron 分发 | Chromium BSD 类许可 / MIT |
| React / React DOM | 用户界面 | 编译进入静态资源 | MIT |
| jsdom 及 npm 生产依赖 | 公开网页安全解析 | 随应用分发 | MIT 及各依赖包声明的许可 |
| PDF.js (`pdfjs-dist` 6.3.289) | 本机 PDF 文本提取 | 随应用分发 | Apache-2.0 |
| `@napi-rs/canvas` | PDF.js 可选本机渲染依赖 | 随 npm 生产依赖分发 | MIT |
| DeepSeek Harness 0.1.0-rc.5 | 本机任务运行时 | 仅分发生产运行闭包，官方 Git 源码仓库未打包 | MIT |
| personal-safe-fs | Harness 只读文件工具 | 随生产运行闭包分发 | 本项目组件，当前仓库为 UNLICENSED |
| FFmpeg / ffprobe | 可选媒体处理 | 安装包未分发 | LGPL/GPL，取决于用户安装的构建版本 |
| yt-dlp | 可选公开视频获取 | 安装包未分发 | Unlicense |
| RapidOCR / ONNX Runtime | 可选本机文字识别 | 安装包未分发 | Apache-2.0 / MIT |
| faster-whisper / CTranslate2 | 可选本机语音识别 | 安装包未分发 | MIT |
| Ollama | 本地模型服务 | 安装包未分发 | MIT |

Personal Workbench 安装包不包含 Ollama 模型、开发数据库、个人输出或验证资料。
