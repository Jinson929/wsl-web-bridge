# WSL Web Bridge (v3.0)

模型无关的轻量级 **Chrome/Edge 浏览器扩展（Manifest V3）+ WSL 本地 Go 桥接服务 + Skill 协作规范文档**，可在 Gemini 等网页聊天界面中安全浏览 WSL 项目文件、使用 `git ls-files` 全局搜索、自动执行只读探索（L2 闭环），并在手动确认后应用代码修改或一键撤销。

## 目录结构

```text
wsl-web-bridge/
├── README.md
├── wsl-bridge-go/            # 纯标准库 Go v3.0 服务端（行号切片、宽松补丁、一键撤销、全局搜索）
│   ├── go.mod
│   ├── main.go
│   └── main_test.go
├── chrome-extension/         # Chrome / Edge Manifest V3 扩展（L2 悬浮暂停条、批量执行、撤销按钮）
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── content.css
│   ├── sidepanel.html
│   ├── sidepanel.js
│   └── sidepanel.css
└── skill/
    └── wsl-bridge/
        └── SKILL.md          # 可直接导入或复用的 WSL Bridge 协作技能文档
```

## v3.0 新增与改进

- **正式更名为 WSL Web Bridge**：去除单一模型名称前缀，适用于网页端任意模型。
- **服务端行号切片读取（`POST /api/read`）**：Go 端原生解析 `path:start-end`，仅传输目标行区间并返回总行数，避免大文件传输与浏览器卡顿。
- **补丁行级宽松匹配（`POST /api/patch`）**：严格匹配失败时自动回退到行级归一化匹配（兼容 `\r\n` 与行尾空白差异），显著降低 409 冲突率。
- **修改前自动快照与一键撤销（`POST /api/undo`）**：每次 `write` / `patch` 自动保存内存快照，卡片执行后提供 **“撤销本次修改”** 按钮（恢复原文件或删除新建文件）。
- **右下角 L2 悬浮暂停/恢复胶囊**：无需打开侧边栏即可一键暂停或恢复 L2 只读自动闭环。
- **多卡片暂存与批量顺序执行**：单条回复含多个修改时逐项暂存到输入框，最后一项完成时统一发送，也支持底部“按顺序全部执行（遇错即停）”。

## 编译与升级步骤

### 1. 在 WSL 中编译并重启 Go v3.0 服务端

```bash
cd wsl-bridge-go
go test -v ./...
go build -o wsl-web-bridge .
./wsl-web-bridge --root ~/你的项目目录
```

支持环境变量 `WSL_BRIDGE_TOKEN` 或 `--token` 指定固定密钥（留空自动生成）。

### 2. 在 Chrome / Edge 中更新扩展

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启 **开发者模式**。
2. 用新包里的 `chrome-extension/` 覆盖原目录后点击扩展卡片的 **刷新（🔄）**，或移除旧版后点击 **加载已解压的扩展程序** 选择新的 `chrome-extension/`。
3. 刷新当前聊天网页即可看到右下角悬浮状态条和 `3.0.0` 新功能。

### 3. 导入或复用 Skill 文档

`skill/wsl-bridge/SKILL.md` 为配套的技能定义文件，可直接通过技能管理界面上传导入，或在其他模型/平台中作为系统提示词复用。
