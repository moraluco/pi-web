# PiWeb 语音版部署与配置指南

> 本指南供**另一台电脑上的 AI Agent** 使用。目标:在这台机器上跑起带**语音输入**的 PiWeb。
> 仓库: `https://github.com/moraluco/pi-web`(fork 自 agegr/pi-web,`main` 分支已包含语音集成)

---

## 0. 重要认知(先读)

- **PiWeb 不是 pi 扩展**。它是独立的 Next.js 网页应用。**不要**用 `pi install` 安装它,也不要把 `pi-web` 当插件放进 `~/.pi/agent/extensions/`。
- PiWeb = 网页界面(聊天/会话/文件浏览)。**语音能力来自单独的本地语音服务**(pi-voice),两者通过 HTTP 接口协作:
  - PiWeb(端口 30141)→ `/api/voice/status`、`/api/voice/transcribe` → 语音服务(端口 8765)
- **麦克风按钮是"探测式"显示的**:语音服务没在运行,按钮就**不显示**。这是设计行为,不是 bug。

## 1. 前置条件

| 依赖 | 版本要求 | 检查命令 |
|---|---|---|
| Node.js | >= 22.19 | `node --version` |
| Python | 3.10+ | `python --version` |
| faster-whisper 环境 | 见步骤 3 | — |

## 2. 安装 PiWeb(语音版)

```bash
git clone https://github.com/moraluco/pi-web.git
cd pi-web
npm install
npm run build          # 首次约 1-3 分钟
npx next start -H 127.0.0.1 -p 30141
```

启动后访问 **http://127.0.0.1:30141**。

## 3. 安装语音服务(pi-voice)—— 关键步骤

PiWeb 的麦克风按钮依赖本地语音服务。需要:

```bash
# 1. 准备 Python 环境(推荐 miniconda3)
conda create -n pi-voice python=3.10 -y
conda activate pi-voice
pip install faster-whisper edge-tts sounddevice numpy opencc-python-reimplemented

# 2. 获取语音服务代码(voice_service.py + voice_agent.py)
#    从原电脑的 ~/.pi/agent/extensions/pi-voice/ 目录拷贝,
#    或运行: gh repo clone moraluco/pi-voice(若已发布)

# 3. 启动服务(监听 127.0.0.1:8765)
python voice_service.py
```

- 首次启动会**自动下载模型** `large-v3-turbo`(约 1.6GB),之后秒级加载。
- 启动成功的标志:日志出现 `[pi-voice] service listening on http://127.0.0.1:8765`。
- 也可用 `service.bat`(Windows)一键启动。

## 4. 验证是否就绪

```bash
# PiWeb 存活
curl http://127.0.0.1:30141/                      # 期望 200

# 语音服务存活 + 模型就绪(经 PiWeb 探测)
curl http://127.0.0.1:30141/api/voice/status
# 期望: {"ok":true, "ready":"ready", "model":"large-v3-turbo", ...}

# 若 ready 为 "loading",等模型加载完再试;若返回 ok:false,说明语音服务没起来
```

全部就绪后,刷新 PiWeb 页面,**聊天输入框右侧会出现蓝色麦克风按钮 🎙**。

## 5. 使用方式

- **点麦克风按钮**或按 **Alt+M**:开始录音(按钮变蓝,随音量放大/发光)→ 再点一下结束 → 识别文本自动插入输入框(带标点、繁体自动转简体)。
- 转写中按钮显示旋转图标;识别失败会通过悬停气泡提示。
- 语音服务地址默认 `127.0.0.1:8765`,可用环境变量覆盖:`PI_VOICE_SERVICE_URL`(在启动 PiWeb 时设置)。

## 6. 常见问题排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 页面没有麦克风按钮 | 语音服务没运行 | 启动 voice_service.py,`curl /api/voice/status` 确认 ok |
| 按钮有,点击没反应 | 浏览器未授权麦克风 | 浏览器地址栏/设置里允许麦克风(需 localhost 或 HTTPS) |
| 转写提示"模型加载中" | large-v3-turbo 还在下载/加载 | 等 `ready` 变 `ready`(约 1.6GB,视网速) |
| 转写结果乱码/英文 | faster-whisper 未装到当前 python | 确认用的是装了 faster-whisper 的解释器启动 voice_service.py |
| 端口被占 | 30141 / 8765 被其他程序占用 | 换端口:`npx next start -p 8080` / `PI_VOICE_SERVICE_PORT=8766` |

## 7. 代码结构(改动过的地方,供维护)

```
app/api/voice/status/route.ts      # 能力探测代理(2s 超时,失败返回 ok:false)
app/api/voice/transcribe/route.ts  # wav 上传转写代理(120s 超时)
components/useVoiceInput.ts        # 前端 Hook:探测/录音/音量仪表/转16k WAV/转写
components/ChatInput.tsx           # 麦克风按钮 + Alt+M 快捷键 + 音量动画
```

语音服务接口规范见 pi-voice 目录的 `API.md`。
