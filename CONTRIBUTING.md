# Contributing to Personal Workbench

Personal Workbench 当前处于外部 Beta 阶段。贡献代码前，请先阅读隐私、安全和本地文件处理边界。

## 开发环境

- Windows x64 是主要目标平台。
- Node.js 24 或兼容版本。
- pnpm 11.7.0。
- Python 3，用于 Research Memory 测试。

安装依赖并运行桌面应用源码：

```powershell
cd apps\personal-workbench
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

常用验证命令：

```powershell
pnpm test -- --run
pnpm run build
pnpm run desktop:build
```

从仓库根目录运行 Research Memory 和文件工具测试：

```powershell
python -m unittest discover -s memory\tests -p "test*.py" -v
node --test tests\research-memory.test.mjs
node --test tests\personal-safe-fs.test.mjs
```

提交前运行源码安全审计：

```powershell
node scripts\release-source-audit.mjs --staged
```

## 提交边界

- 不要提交数据库、日志、诊断包、用户输出、模型、媒体运行环境、验证目录或安装器。
- 超过 100 MiB 的文件禁止进入普通 Git 历史；安装器只能作为 GitHub Release Asset 发布。
- 不要提交凭据、私人路径或开发者本机配置。
- 不要修改或复制 DeepSeek Harness 官方 Git 仓库。需要的集成能力应通过 Personal Workbench 自身的生产配置和适配代码实现。
- 测试必须使用无敏感夹具，且不能依赖开发电脑的绝对路径。

当前仓库为 `UNLICENSED`。贡献行为不会自动改变项目许可状态。
