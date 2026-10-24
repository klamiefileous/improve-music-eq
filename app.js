const defaults = {
  low: -0.5,
  lowmid: 0,
  highmid: 1,
  air: 1.5,
  reverb: 8,
  decay: 1.8,
  width: 105,
  threshold: -18,
  normalize: true,
  sampleRate: "48000"
};

const presets = {
  sunlight: { ...defaults },
  color: { ...defaults, low: 0.5, lowmid: -0.5, highmid: 1.5, air: 2, reverb: 12, decay: 2.3, width: 112 },
  club: { ...defaults, low: 1, lowmid: 0.5, highmid: 0.5, air: 0.5, reverb: 4, decay: 1.2, width: 100, threshold: -15 },
  vocal: { ...defaults, low: -1, lowmid: -0.5, highmid: 1.5, air: 2, reverb: 10, decay: 2, width: 108, threshold: -20 }
};

const eqBands = [
  { key: "low", frequency: 125, q: 0.85, type: "lowshelf" },
  { key: "lowmid", frequency: 500, q: 0.9 },
  { key: "highmid", frequency: 2500, q: 0.8 },
  { key: "air", frequency: 8000, q: 0.7, type: "highshelf" }
];
const audioExtensions = /\.(mp3|wav|flac|aac|m4a|ogg|opus|weba|aiff?|caf)$/i;
const tracks = [];
const elements = {
  fileInput: document.getElementById("file-input"),
  folderInput: document.getElementById("folder-input"),
  dropzone: document.getElementById("dropzone"),
  trackList: document.getElementById("track-list"),
  count: document.getElementById("track-count"),
  emptyState: document.getElementById("empty-state"),
  processButton: document.getElementById("process-button"),
  processLabel: document.getElementById("process-label"),
  preset: document.getElementById("preset-select"),
  toast: document.getElementById("toast")
};

let toastTimer;
let processing = false;
const previewState = {
  trackId: null,
  audio: null,
  context: null,
  source: null,
  url: null,
  nodes: null
};

function setToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3400);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function displayName(file) {
  return file.webkitRelativePath || file.name;
}

function addFiles(fileList) {
  const incoming = Array.from(fileList).filter(file =>
    file.type.startsWith("audio/") || audioExtensions.test(file.name)
  );
  if (!incoming.length) {
    setToast("没有识别到可处理的音频文件。");
    return;
  }
  let added = 0;
  for (const file of incoming) {
    const duplicate = tracks.some(track =>
      track.file.name === file.name && track.file.size === file.size && track.file.lastModified === file.lastModified
    );
    if (!duplicate) {
      const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      tracks.push({ id, file, status: "ready", url: null, error: "" });
      added++;
    }
  }
  renderTracks();
  if (added) setToast(`已添加 ${added} 首曲目${incoming.length > added ? `，跳过 ${incoming.length - added} 个重复文件` : ""}。`);
  else setToast("这些曲目已经在清单里了。");
}

function renderTracks() {
  elements.trackList.replaceChildren();
  elements.count.textContent = String(tracks.length);
  elements.emptyState.hidden = tracks.length > 0;
  if (!tracks.length) elements.trackList.append(elements.emptyState);
  for (const track of tracks) {
    const row = document.createElement("div");
    row.className = "track-row";
    const art = document.createElement("div");
    art.className = "track-art";
    art.textContent = "♫";
    const details = document.createElement("div");
    details.className = "track-details";
    const name = document.createElement("div");
    name.className = "track-name";
    name.textContent = displayName(track.file);
    name.title = displayName(track.file);
    const meta = document.createElement("div");
    meta.className = "track-meta";
    meta.textContent = formatBytes(track.file.size);
    details.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "track-actions";
    const previewButton = document.createElement("button");
    previewButton.className = "preview-track";
    previewButton.type = "button";
    previewButton.title = previewState.trackId === track.id && previewState.audio && !previewState.audio.paused ? "停止试听" : "试听当前参数";
    previewButton.setAttribute("aria-label", `${previewState.trackId === track.id && previewState.audio && !previewState.audio.paused ? "停止试听" : "试听"} ${track.file.name}`);
    previewButton.textContent = previewState.trackId === track.id && previewState.audio && !previewState.audio.paused ? "Ⅱ" : "▶";
    previewButton.addEventListener("click", () => togglePreview(track));
    actions.append(previewButton);
    const status = document.createElement("span");
    status.className = `track-status ${track.status === "done" ? "done" : track.status === "error" ? "error" : ""}`;
    status.textContent = track.status === "done" ? "已完成" : track.status === "processing" ? "处理中…" : track.status === "error" ? "处理失败" : "待处理";
    if (track.error) status.title = track.error;
    if (track.status === "done" && track.url) {
      const download = document.createElement("a");
      download.className = "download-track";
      download.href = track.url;
      download.download = `${safeBaseName(track.file.name)}-afterglow.wav`;
      download.title = "下载处理后的 WAV";
      download.setAttribute("aria-label", `下载 ${track.file.name}`);
      download.textContent = "↓";
      actions.append(download);
    }
    const remove = document.createElement("button");
    remove.className = "remove-track";
    remove.type = "button";
    remove.title = "移除此曲目";
    remove.setAttribute("aria-label", `移除 ${track.file.name}`);
    remove.textContent = "×";
    remove.disabled = processing;
    remove.addEventListener("click", () => removeTrack(track.id));
    actions.append(status, remove);
    row.append(art, details, actions);
    elements.trackList.append(row);
  }
  elements.processButton.disabled = processing || tracks.length === 0;
  elements.processLabel.textContent = processing ? "正在渲染曲目…" : tracks.length ? `处理全部曲目 · ${tracks.length}` : "先添加一些曲目";
}

function safeBaseName(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 140) || "track";
}

function removeTrack(id) {
  const index = tracks.findIndex(track => track.id === id);
  if (index < 0) return;
  if (previewState.trackId === id) stopPreview(false);
  const [track] = tracks.splice(index, 1);
  if (track.url) URL.revokeObjectURL(track.url);
  renderTracks();
}

function setParam(key, value) {
  const input = document.getElementById(key === "sampleRate" ? "sample-rate" : key);
  if (!input) return;
  if (input.type === "checkbox") input.checked = Boolean(value);
  else input.value = String(value);
  updateControlDisplay(key, false);
}

function currentSettings() {
  return {
    eq: eqBands.map(band => ({
      frequency: band.frequency,
      q: band.q,
      gain: Number(document.getElementById(`eq-${band.key}`).value)
    })),
    reverb: Number(document.getElementById("reverb").value) / 100,
    decay: Number(document.getElementById("decay").value),
    width: Number(document.getElementById("width").value) / 100,
    threshold: Number(document.getElementById("threshold").value),
    normalize: document.getElementById("normalize").checked,
    sampleRate: document.getElementById("sample-rate").value
  };
}

function makePreviewImpulse(context, duration) {
  const length = Math.floor(context.sampleRate * duration);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2);
    }
  }
  return impulse;
}

function buildPreviewGraph(context, source, settings) {
  let chain = source;
  const filters = eqBands.map((band, index) => {
    const filter = context.createBiquadFilter();
    filter.type = band.type || "peaking";
    filter.frequency.value = band.frequency;
    filter.Q.value = band.q;
    filter.gain.value = settings.eq[index].gain;
    chain.connect(filter);
    chain = filter;
    return filter;
  });

  const sum = context.createGain();
  const dry = context.createGain();
  const convolver = context.createConvolver();
  const wet = context.createGain();
  dry.gain.value = 1;
  convolver.buffer = makePreviewImpulse(context, settings.decay);
  wet.gain.value = settings.reverb;
  chain.connect(dry);
  dry.connect(sum);
  chain.connect(convolver);
  convolver.connect(wet);
  wet.connect(sum);

  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = settings.threshold;
  compressor.knee.value = 12;
  compressor.ratio.value = 2.2;
  compressor.attack.value = 0.008;
  compressor.release.value = 0.18;

  const splitter = context.createChannelSplitter(2);
  const merger = context.createChannelMerger(2);
  const ll = context.createGain();
  const lr = context.createGain();
  const rl = context.createGain();
  const rr = context.createGain();
  sum.connect(compressor);
  compressor.connect(splitter);
  splitter.connect(ll, 0); ll.connect(merger, 0, 0);
  splitter.connect(lr, 1); lr.connect(merger, 0, 0);
  splitter.connect(rl, 0); rl.connect(merger, 0, 1);
  splitter.connect(rr, 1); rr.connect(merger, 0, 1);
  merger.connect(context.destination);

  const nodes = { filters, wet, convolver, compressor, ll, lr, rl, rr };
  updatePreviewNodes(nodes, settings, context);
  return nodes;
}

function updatePreviewNodes(nodes, settings, context, refreshImpulse = false) {
  const now = context.currentTime;
  const time = 0.025;
  settings.eq.forEach((band, index) => nodes.filters[index].gain.setTargetAtTime(band.gain, now, time));
  nodes.wet.gain.setTargetAtTime(settings.reverb, now, time);
  if (refreshImpulse || !nodes.convolver.buffer) {
    nodes.convolver.buffer = makePreviewImpulse(context, settings.decay);
  }
  nodes.compressor.threshold.setTargetAtTime(settings.threshold, now, time);
  nodes.ll.gain.setTargetAtTime((1 + settings.width) / 2, now, time);
  nodes.rr.gain.setTargetAtTime((1 + settings.width) / 2, now, time);
  nodes.lr.gain.setTargetAtTime((1 - settings.width) / 2, now, time);
  nodes.rl.gain.setTargetAtTime((1 - settings.width) / 2, now, time);
}

function refreshPreviewSettings(key) {
  if (!previewState.context || !previewState.nodes || previewState.audio?.paused) return;
  updatePreviewNodes(previewState.nodes, currentSettings(), previewState.context, key === "decay");
}

function stopPreview(updateRows = true) {
  const { audio, context, source, url } = previewState;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (source) source.disconnect();
  if (url) URL.revokeObjectURL(url);
  if (context && context.state !== "closed") {
    context.close().catch(error => console.error("Unable to close preview audio context:", error));
  }
  previewState.trackId = null;
  previewState.audio = null;
  previewState.context = null;
  previewState.source = null;
  previewState.url = null;
  previewState.nodes = null;
  if (updateRows) renderTracks();
}

async function togglePreview(track) {
  if (previewState.trackId === track.id && previewState.audio && !previewState.audio.paused) {
    stopPreview();
    return;
  }
  stopPreview(false);
  try {
    const context = new AudioContext();
    const audio = new Audio();
    const url = URL.createObjectURL(track.file);
    audio.preload = "auto";
    audio.src = url;
    const source = context.createMediaElementSource(audio);
    const nodes = buildPreviewGraph(context, source, currentSettings());
    Object.assign(previewState, { trackId: track.id, audio, context, source, url, nodes });
    audio.onended = () => stopPreview();
    audio.onerror = () => {
      stopPreview();
      setToast("浏览器无法解码这首歌用于试听；如果需要，请转换为 WAV、MP3、FLAC 或 M4A 后重试。");
    };
    await context.resume();
    await audio.play();
    renderTracks();
  } catch (error) {
    stopPreview();
    console.error(`Unable to preview ${track.file.name}:`, error);
    setToast("无法启动试听，请确认浏览器支持此音频格式。");
  }
}

function updateControlDisplay(key, markCustom = true) {
  const input = document.getElementById(key === "sampleRate" ? "sample-rate" : key);
  if (!input) return;
  if (key.startsWith("eq-")) {
    const value = Number(input.value);
    document.getElementById(`${key}-value`).innerHTML = `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value)} <small>dB</small>`;
    const fill = document.getElementById(`${key}-fill`);
    fill.style.height = `${Math.max(0, Math.abs(value) / 6 * 50)}%`;
    fill.style.top = value >= 0 ? `${50 - Math.abs(value) / 6 * 50}%` : "50%";
    fill.style.background = value >= 0 ? "#a9c2a5" : "#d3b7a5";
    input.setAttribute("aria-valuetext", `${value} dB`);
  } else if (key === "reverb") {
    document.getElementById("reverb-value").innerHTML = `${input.value}<span>%</span>`;
  } else if (key === "decay") {
    document.getElementById("decay-value").innerHTML = `${Number(input.value).toFixed(1)}<span>s</span>`;
  } else if (key === "width") {
    document.getElementById("width-value").innerHTML = `${input.value}<span>%</span>`;
  } else if (key === "threshold") {
    document.getElementById("threshold-value").innerHTML = `${Number(input.value) < 0 ? "−" : ""}${Math.abs(Number(input.value))}<span> dB</span>`;
  }
  if (markCustom) elements.preset.value = "custom";
}

function applyPreset(name) {
  const preset = presets[name];
  if (!preset) return;
  for (const band of eqBands) setParam(`eq-${band.key}`, preset[band.key]);
  setParam("reverb", preset.reverb);
  setParam("decay", preset.decay);
  setParam("width", preset.width);
  setParam("threshold", preset.threshold);
  setParam("normalize", preset.normalize);
  setParam("sampleRate", preset.sampleRate);
  refreshPreviewSettings("decay");
}

async function exportAudio(file, settings) {
  const formData = new FormData();
  formData.append("audio", file, file.name);
  formData.append("parameters", JSON.stringify(settings));

  let response;
  try {
    response = await fetch("/api/exports", { method: "POST", body: formData });
  } catch (error) {
    throw new Error("无法连接本地音频服务。请按 README 启动 FastAPI 后端。", { cause: error });
  }

  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error("音频服务返回了无法读取的响应。请检查后端是否正常启动。", { cause: error });
  }
  if (!response.ok) {
    const detail = Array.isArray(result.detail)
      ? result.detail.map(issue => issue.msg).join("；")
      : result.detail || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (typeof result.download_url !== "string" || !result.download_url.startsWith("/api/exports/")) {
    throw new Error("音频服务没有返回有效的下载链接。");
  }
  return result;
}

async function processAll() {
  if (processing || !tracks.length) return;
  const pending = tracks.filter(track => track.status !== "done");
  if (!pending.length) {
    setToast("所有曲目都已处理完成，可点击曲目旁的下载按钮保存。");
    return;
  }
  const settings = currentSettings();
  processing = true;
  elements.processButton.disabled = true;
  elements.processLabel.textContent = `准备渲染 0 / ${pending.length}`;
  for (let index = 0; index < pending.length; index++) {
    const track = pending[index];
    track.status = "processing";
    track.error = "";
    elements.processLabel.textContent = `正在渲染 ${index + 1} / ${pending.length}`;
    renderTracks();
    try {
      const result = await exportAudio(track.file, settings);
      track.url = result.download_url;
      track.status = "done";
    } catch (error) {
      track.status = "error";
      track.error = error instanceof Error ? error.message : String(error);
      console.error(`Unable to process ${track.file.name}:`, error);
    }
    renderTracks();
  }
  processing = false;
  renderTracks();
  const failed = tracks.filter(track => track.status === "error").length;
  setToast(failed ? `处理结束：${pending.length - failed} 首成功，${failed} 首失败。鼠标悬停在失败曲目的状态上可查看原因。` : `处理完成！${pending.length} 首 WAV 已准备好，点击曲目旁的下载图标保存。`);
}

document.getElementById("choose-files").addEventListener("click", () => elements.fileInput.click());
document.getElementById("choose-folder").addEventListener("click", () => elements.folderInput.click());
elements.fileInput.addEventListener("change", event => {
  addFiles(event.target.files);
  event.target.value = "";
});
elements.folderInput.addEventListener("change", event => {
  addFiles(event.target.files);
  event.target.value = "";
});

elements.dropzone.addEventListener("click", event => {
  if (!event.target.closest("button")) elements.fileInput.click();
});
elements.dropzone.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements.fileInput.click();
  }
});
for (const eventName of ["dragenter", "dragover"]) {
  elements.dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    elements.dropzone.classList.add("is-over");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    elements.dropzone.classList.remove("is-over");
  });
}
elements.dropzone.addEventListener("drop", event => addFiles(event.dataTransfer.files));

for (const band of eqBands) {
  const input = document.getElementById(`eq-${band.key}`);
  input.addEventListener("input", () => {
    updateControlDisplay(`eq-${band.key}`);
    refreshPreviewSettings();
  });
  updateControlDisplay(`eq-${band.key}`, false);
}
for (const key of ["reverb", "decay", "width", "threshold"]) {
  const input = document.getElementById(key);
  input.addEventListener("input", () => {
    updateControlDisplay(key);
    refreshPreviewSettings(key);
  });
}

elements.preset.addEventListener("change", event => {
  if (event.target.value === "custom") return;
  applyPreset(event.target.value);
  setToast(`已应用「${event.target.selectedOptions[0].textContent}」参数，可继续手动调整。`);
});

document.querySelectorAll("[data-reset]").forEach(button => {
  button.addEventListener("click", () => {
    for (const band of eqBands) setParam(`eq-${band.key}`, defaults[band.key]);
    elements.preset.value = "custom";
    refreshPreviewSettings();
  });
});

document.getElementById("reset-button").addEventListener("click", () => {
  applyPreset("sunlight");
  elements.preset.value = "sunlight";
  setToast("参数已恢复为「雨后晴日」初始设置。");
});
document.getElementById("clear-list").addEventListener("click", () => {
  if (processing) return;
  stopPreview(false);
  for (const track of tracks) if (track.url) URL.revokeObjectURL(track.url);
  tracks.length = 0;
  renderTracks();
});
elements.processButton.addEventListener("click", processAll);
renderTracks();
