# Afterglow Studio

一个纯本地运行的电子音乐批量音色处理工作台。曲目旁的试听按钮通过 Web Audio API 实时预览当前 EQ、混响、动态和立体声参数；最终导出时，前端通过本机 FastAPI 服务将原始文件和参数发送给 Pedalboard 渲染。数据只在本机回环地址处理，不会上传到外部服务器。

## 启动

需要 Python 3.10 或更新版本。在项目目录执行：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt --index-url https://pypi.org/simple
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

然后在现代 Chromium 浏览器（推荐 Chrome 或 Edge）中访问 `http://127.0.0.1:8000`。通过 FastAPI 提供前端和 API，勿直接双击打开 `index.html`。

## 使用

1. 选择一个或多个音频文件，或导入一个文件夹。
2. 选择预设，再按需调整四段均衡、混响、尾音、立体声宽度、压缩阈值和导出采样率。
3. 点击“处理全部曲目”。前端逐首将原始音频及当前参数发送到本机 API；处理完成后，逐首点击下载图标保存 24-bit PCM WAV。

每首曲目独立处理；失败的曲目会标记出来，鼠标悬停可查看错误信息。处理结果是新的文件，不会覆盖原曲。导出链接保留 1 小时；单文件上限 500 MB、45 分钟，同一时间只处理一首。临时上传文件会在渲染完成后删除，导出文件在服务退出或过期时清理。

## 关于音质

均衡、混响、动态处理与重新编码会改变音色和文件格式，但不能恢复源文件本身已经丢失的细节。24-bit WAV 是无损 PCM 输出格式，不代表低码率或削波的源音频会因此还原成录音室母带。48 kHz 选项也只是输出采样率，不会凭空增加源音频的信息量。建议从轻微 EQ、少量混响开始，并保留原文件供 A/B 对比。

音频解码能力取决于 Pedalboard / FFmpeg 支持的格式；遇到无法解码的文件，请先转换为 WAV、MP3、FLAC 或 M4A。

## 本地 API

- `POST /api/exports`：以 `multipart/form-data` 接收 `audio` 文件和 `parameters` JSON 字符串，响应含 `download_url`、输出采样率和时长。
- `GET /api/exports/{id}/download`：下载渲染完成的 24-bit PCM WAV。
- `GET /api/health`：本地服务健康检查。

服务默认只绑定 `127.0.0.1`；勿将其改为公开网络服务，因为这里没有配置身份验证或外部访问防护。
