(() => {
  "use strict";

  const LARGE_FILE_BYTES = 200 * 1024 * 1024;
  const state = {
    mode: "compress",
    files: [],
    archive: null,
    cancelled: false,
    operationCancel: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    tabs: document.querySelectorAll(".mode-tab"),
    panels: { compress: $("#compress-panel"), extract: $("#extract-panel") },
    compressDrop: $("#compress-drop-zone"),
    extractDrop: $("#extract-drop-zone"),
    compressInput: $("#compress-input"),
    folderInput: $("#folder-input"),
    extractInput: $("#extract-input"),
    chooseFiles: $("#choose-files"),
    chooseFolder: $("#choose-folder"),
    chooseArchive: $("#choose-archive"),
    compressArea: $("#compress-file-area"),
    extractArea: $("#extract-file-area"),
    compressList: $("#compress-file-list"),
    extractList: $("#extract-file-list"),
    compressCount: $("#compress-count"),
    extractCount: $("#extract-count"),
    compressSummary: $("#compress-summary"),
    extractSummary: $("#extract-summary"),
    archiveFormat: $("#archive-format"),
    archiveName: $("#archive-name"),
    archiveExtension: $("#archive-extension"),
    compressionLevel: $("#compression-level"),
    passwordBox: $("#password-box"),
    archivePassword: $("#archive-password"),
    archivePasswordConfirm: $("#archive-password-confirm"),
    toggleArchivePassword: $("#toggle-archive-password"),
    largeFileNotice: $("#large-file-notice"),
    largeFileCopy: $("#large-file-copy"),
    compressButton: $("#compress-button"),
    selectedArchive: $("#selected-archive"),
    extractPasswordBox: $("#extract-password-box"),
    extractPassword: $("#extract-password"),
    toggleExtractPassword: $("#toggle-extract-password"),
    extractButton: $("#extract-button"),
    extractFolderButton: $("#extract-folder-button"),
    progress: $("#progress-area"),
    progressLabel: $("#progress-label"),
    progressPercent: $("#progress-percent"),
    progressBar: $("#progress-bar"),
    progressDetail: $("#progress-detail"),
    cancelButton: $("#cancel-button"),
    message: $("#message"),
    messageText: $("#message-text"),
    messageIcon: $(".message-icon"),
    messageClose: $("#message-close"),
    clearCompress: $("#clear-compress"),
    clearExtract: $("#clear-extract"),
  };

  const formatInfo = {
    zip: { extension: ".zip", label: "ZIP" },
    "zip-password": { extension: ".zip", label: "ZIP AES-256" },
    "tar-gz": { extension: ".tar.gz", label: "TAR.GZ" },
    tar: { extension: ".tar", label: "TAR" },
    gzip: { extension: ".gz", label: "GZIP" },
  };

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** index;
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  function filePath(file) {
    return file.webkitRelativePath || file.name;
  }

  function safeArchiveName(name) {
    const cleaned = String(name || "")
      .trim()
      .replace(/\.(zip|7z|rar|tar\.gz|tgz|tar|gz)$/i, "")
      .replace(/[\\/:*?"<>|]/g, "-");
    return cleaned || "轻压文件";
  }

  function safeFileName(path, fallback = "未命名文件") {
    const clean = String(path || fallback)
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..");
    const flattened = clean.join("_").replace(/[\0\x00-\x1f<>:"/\\|?*]/g, "-").trim();
    return flattened || fallback;
  }

  function safePathParts(path) {
    return String(path || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .map((part) => part.replace(/[\0\x00-\x1f<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "") || "_");
  }

  function safeArchiveEntryName(path, fallback = "未命名文件") {
    const safe = safePathParts(path).join("/");
    return safe || fallback;
  }

  function archiveNeedsPassword(archive) {
    return Boolean(archive?.encrypted || archive?.entries.some((entry) => entry.encryption && entry.encryption !== "none"));
  }

  function closeArchiveEngine(archive) {
    if (!archive) return;
    if (archive.zipReader && typeof archive.zipReader.close === "function") archive.zipReader.close().catch(() => {});
    if (archive.advancedArchive && typeof archive.advancedArchive.close === "function") archive.advancedArchive.close().catch(() => {});
  }

  function normalizeArchiveError(error) {
    if (error?.name === "AbortError" || error?.code === "ERR_ABORTED") {
      const cancelled = new Error("操作已取消");
      cancelled.code = "CANCELLED";
      return cancelled;
    }
    const message = String(error?.message || error || "");
    if (/invalid password|incorrect password|wrong password|bad password|invalid passphrase|incorrect passphrase|wrong passphrase/i.test(message)) {
      const passwordError = new Error("密码不正确，或这个压缩包使用了不兼容的加密方式");
      passwordError.code = "PASSWORD_INVALID";
      return passwordError;
    }
    return error;
  }

  function setMode(mode) {
    state.mode = mode;
    elements.tabs.forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    Object.entries(elements.panels).forEach(([key, panel]) => {
      const active = key === mode;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
    elements.tabs.forEach((tab) => tab.setAttribute("tabindex", tab.dataset.mode === mode ? "0" : "-1"));
    hideMessage();
    hideProgress();
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    const text = button.querySelector(".button-label");
    if (text) text.textContent = busy ? label : button.id === "compress-button" ? "开始压缩" : "解压并下载 ZIP";
    button.style.opacity = busy ? "0.72" : "1";
    if (button.id === "extract-button") {
      elements.extractFolderButton.disabled = busy;
      elements.extractFolderButton.setAttribute("aria-busy", String(busy));
      elements.extractFolderButton.style.opacity = busy ? "0.72" : "1";
    }
  }

  function showMessage(text, type = "success") {
    elements.messageText.textContent = text;
    elements.message.classList.toggle("error", type === "error");
    elements.messageIcon.textContent = type === "error" ? "!" : "✓";
    elements.message.setAttribute("role", type === "error" ? "alert" : "status");
    elements.message.classList.remove("hidden");
  }

  function hideMessage() {
    elements.message.classList.add("hidden");
  }

  function showProgress(label, detail) {
    elements.progressLabel.textContent = label;
    elements.progressDetail.textContent = detail || "请稍候，浏览器正在本地处理文件。";
    elements.progress.setAttribute("aria-busy", "true");
    elements.progress.classList.remove("hidden");
    elements.cancelButton.classList.remove("hidden");
    setProgress(0);
  }

  function setProgress(percent) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    elements.progressPercent.textContent = `${value}%`;
    elements.progressBar.style.width = `${value}%`;
    elements.progressBar.setAttribute("aria-valuenow", String(value));
  }

  function hideProgress() {
    elements.progress.setAttribute("aria-busy", "false");
    elements.progress.classList.add("hidden");
    elements.cancelButton.classList.add("hidden");
  }

  function beginOperation() {
    state.cancelled = false;
    state.operationCancel = null;
  }

  function finishOperation() {
    state.operationCancel = null;
    state.cancelled = false;
  }

  function checkCancelled() {
    if (state.cancelled) {
      const error = new Error("操作已取消");
      error.code = "CANCELLED";
      throw error;
    }
  }

  function yieldToBrowser() {
    return new Promise((resolve) => {
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(resolve, { timeout: 120 });
      else window.setTimeout(resolve, 0);
    });
  }

  function releaseEntries(entries) {
    entries.forEach((entry) => { entry.data = null; });
    entries.length = 0;
  }

  function cancelOperation() {
    if (!elements.progress.classList.contains("hidden")) {
      state.cancelled = true;
      if (typeof state.operationCancel === "function") state.operationCancel();
      hideProgress();
      showMessage("已取消当前操作。", "error");
    }
  }

  function createDownload(data, filename, type = "application/octet-stream") {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[character]);
  }

  function renderCompressFiles() {
    const totalBytes = state.files.reduce((sum, file) => sum + file.size, 0);
    elements.compressCount.textContent = String(state.files.length);
    elements.compressSummary.textContent = `${state.files.length} 个文件 · ${formatBytes(totalBytes)}`;
    elements.compressList.replaceChildren();
    state.files.forEach((file, index) => {
      const path = filePath(file);
      const hasFolder = path.includes("/");
      const row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = `
        <span class="file-icon ${hasFolder ? "folder" : ""}" aria-hidden="true">${hasFolder ? "⌁" : "▱"}</span>
        <div class="file-meta">
          <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
          ${hasFolder ? `<div class="file-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>` : ""}
        </div>
        <span class="file-size">${formatBytes(file.size)}</span>
        <button class="remove-file" type="button" data-index="${index}" aria-label="移除 ${escapeHtml(file.name)}">×</button>
      `;
      row.querySelector(".remove-file").addEventListener("click", () => {
        state.files.splice(index, 1);
        renderCompressFiles();
        syncCompressArea();
      });
      elements.compressList.appendChild(row);
    });
  }

  function archiveEntries() {
    return state.archive ? state.archive.entries.filter((entry) => !entry.directory) : [];
  }

  function entrySize(entry) {
    return entry.size ?? entry.uncompressedSize ?? (entry.data ? entry.data.length : 0);
  }

  function formatLabel(format) {
    return { zip: "ZIP", "zip-password": "ZIP AES-256", gzip: "GZIP", "tar-gz": "TAR.GZ", tar: "TAR" }[format] || format.toUpperCase();
  }

  function renderExtractFiles() {
    if (!state.archive) return;
    const entries = archiveEntries();
    const totalSize = entries.reduce((sum, entry) => sum + entrySize(entry), 0);
    elements.extractCount.textContent = String(entries.length);
    elements.extractSummary.textContent = `${entries.length} 个文件 · 解压后约 ${formatBytes(totalSize)}`;
    elements.extractList.replaceChildren();
    entries.forEach((entry, index) => {
      const name = entry.name.split("/").filter(Boolean).pop() || entry.name;
      const locked = entry.encryption && entry.encryption !== "none";
      const row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = `
        <span class="file-icon" aria-hidden="true">${locked ? "⌑" : "▱"}</span>
        <div class="file-meta">
          <div class="file-name" title="${escapeHtml(entry.name)}">${escapeHtml(name)}</div>
          <div class="file-path" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
        </div>
        <span class="file-size">${formatBytes(entrySize(entry))}</span>
        <button class="file-action" type="button" data-entry-index="${index}" aria-label="下载 ${escapeHtml(entry.name)}">下载</button>
      `;
      row.querySelector(".file-action").addEventListener("click", () => extractSingle(index));
      elements.extractList.appendChild(row);
    });
  }

  function syncCompressArea() {
    elements.compressArea.classList.toggle("hidden", state.files.length === 0);
    const totalBytes = state.files.reduce((sum, file) => sum + file.size, 0);
    const large = totalBytes >= LARGE_FILE_BYTES;
    elements.largeFileNotice.classList.toggle("hidden", !large);
    if (large) {
      const deviceMemory = Number(navigator.deviceMemory);
      const deviceHint = Number.isFinite(deviceMemory) && deviceMemory > 0 ? `当前设备约有 ${deviceMemory} GB 内存可供浏览器使用。` : "不同浏览器可用内存不同。";
      const format = elements.archiveFormat.value;
      const processingHint = format === "zip" || format === "zip-password" ? "ZIP 会逐文件读取并在后台压缩；" : "当前格式需要暂存更多数据；";
      elements.largeFileCopy.textContent = `文件总量较大，${processingHint}请保持页面打开，最终文件仍会占用一定内存。${deviceHint}`;
    }
  }

  function syncExtractArea() {
    const visible = Boolean(state.archive && archiveEntries().length);
    elements.extractArea.classList.toggle("hidden", !visible);
    elements.extractDrop.classList.toggle("hidden", visible);
    const canChooseFolder = typeof window.showDirectoryPicker === "function";
    elements.extractFolderButton.classList.toggle("hidden", !visible || !canChooseFolder);
  }

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []).filter((file) => file instanceof File);
    const existing = new Set(state.files.map((file) => `${filePath(file)}:${file.size}:${file.lastModified}`));
    incoming.forEach((file) => {
      const key = `${filePath(file)}:${file.size}:${file.lastModified}`;
      if (!existing.has(key)) {
        state.files.push(file);
        existing.add(key);
      }
    });
    renderCompressFiles();
    syncCompressArea();
    hideMessage();
  }

  async function readFiles() {
    const entries = [];
    for (let index = 0; index < state.files.length; index += 1) {
      checkCancelled();
      const file = state.files[index];
      elements.progressDetail.textContent = `正在读取：${file.name}`;
      const data = new Uint8Array(await file.arrayBuffer());
      entries.push({ name: filePath(file), data });
      setProgress(5 + ((index + 1) / state.files.length) * 22);
      await yieldToBrowser();
    }
    return entries;
  }

  async function createZipWithZipJs(files, password, level) {
    if (!window.zip) throw new Error("安全 ZIP 引擎还没有加载完成，请刷新页面后重试");
    const outputWriter = new window.zip.BlobWriter("application/zip");
    const zipWriter = new window.zip.ZipWriter(outputWriter, { useWebWorkers: true });
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    let closed = false;
    state.operationCancel = () => abortController?.abort();
    try {
      for (let index = 0; index < files.length; index += 1) {
        checkCancelled();
        const file = files[index];
        const entryName = safeArchiveEntryName(filePath(file), file.name);
        elements.progressDetail.textContent = `正在压缩：${entryName}`;
        const options = {
          level,
          onprogress: (current, maximum) => {
            const fraction = maximum > 0 ? current / maximum : 0.5;
            setProgress(8 + ((index + Math.min(1, fraction)) / files.length) * 84);
          },
        };
        if (abortController) options.signal = abortController.signal;
        if (password) {
          options.password = password;
          options.encryptionStrength = 3;
        }
        await zipWriter.add(entryName, new window.zip.BlobReader(file), options);
        setProgress(8 + ((index + 1) / files.length) * 84);
        await yieldToBrowser();
      }
      await zipWriter.close();
      closed = true;
      return outputWriter.getData();
    } catch (error) {
      if (!closed) await zipWriter.close().catch(() => {});
      throw normalizeArchiveError(error);
    }
  }

  function updateFormatUI() {
    const format = elements.archiveFormat.value;
    const info = formatInfo[format];
    elements.archiveExtension.textContent = info.extension;
    elements.passwordBox.classList.toggle("hidden", format !== "zip-password");
    if (format === "gzip") {
      elements.archiveName.placeholder = "例如：照片";
    } else {
      elements.archiveName.placeholder = "例如：轻压文件";
    }
    if (state.files.length) syncCompressArea();
  }

  async function compressFiles() {
    if (!state.files.length) return;
    const format = elements.archiveFormat.value;
    const password = elements.archivePassword.value;
    if (format === "gzip" && state.files.length !== 1) {
      showMessage("GZIP 只适用于单个文件；多个文件请使用 ZIP 或 TAR.GZ。", "error");
      return;
    }
    if (format === "zip-password") {
      if (password.length < 8) {
        showMessage("AES-256 密码至少需要 8 个字符。", "error");
        elements.archivePassword.focus();
        return;
      }
      if (password !== elements.archivePasswordConfirm.value) {
        showMessage("两次输入的密码不一致。", "error");
        elements.archivePasswordConfirm.focus();
        return;
      }
    }
    if (!window.LightPressureCodecs) {
      showMessage("本地压缩引擎还没有加载完成，请刷新页面后重试。", "error");
      return;
    }
    beginOperation();
    hideMessage();
    setBusy(elements.compressButton, true, "正在压缩…");
    showProgress("正在准备文件…", "文件不会上传，压缩过程在本地浏览器中完成。");
    let entries = [];
    try {
      const level = Number(elements.compressionLevel.value);
      const setCancel = (cancel) => { state.operationCancel = cancel; };
      let output;
      let extension = formatInfo[format].extension;
      if (format === "zip" || format === "zip-password") {
        output = await createZipWithZipJs(state.files, format === "zip-password" ? password : "", level);
        setProgress(100);
      } else {
        entries = await readFiles();
        checkCancelled();
        if (format === "tar") {
          output = window.LightPressureCodecs.createTar(entries);
          releaseEntries(entries);
          setProgress(100);
        } else if (format === "tar-gz") {
          const tarBytes = window.LightPressureCodecs.createTar(entries);
          releaseEntries(entries);
          setProgress(35);
          output = await window.LightPressureCodecs.createGzip(tarBytes, `${safeArchiveName(elements.archiveName.value)}.tar`, level, setCancel);
          setProgress(100);
        } else {
          output = await window.LightPressureCodecs.createGzip(entries[0].data, entries[0].name, level, setCancel);
          releaseEntries(entries);
          extension = ".gz";
          setProgress(100);
        }
      }
      checkCancelled();
      const outputSize = output instanceof Blob ? output.size : output.length;
      createDownload(output, `${safeArchiveName(elements.archiveName.value)}${extension}`, "application/octet-stream");
      showMessage(`压缩完成，已准备下载 ${formatLabel(format)} 文件（${formatBytes(outputSize)}）。`);
    } catch (error) {
      const normalizedError = normalizeArchiveError(error);
      if (normalizedError.code !== "CANCELLED") showMessage(`压缩失败：${normalizedError.message || "请稍后重试"}`, "error");
    } finally {
      const wasCancelled = state.cancelled;
      releaseEntries(entries);
      setBusy(elements.compressButton, false, "开始压缩");
      finishOperation();
      if (!wasCancelled) window.setTimeout(hideProgress, 1100);
    }
  }

  function resetArchive() {
    closeArchiveEngine(state.archive);
    state.archive = null;
    elements.extractList.replaceChildren();
    elements.extractPassword.value = "";
    elements.extractPasswordBox.classList.add("hidden");
    syncExtractArea();
    hideMessage();
  }

  async function openZipArchive(file) {
    if (!window.zip) throw new Error("ZIP 引擎还没有加载完成，请刷新页面后重试");
    const zipReader = new window.zip.ZipReader(new window.zip.BlobReader(file), { strictness: "balanced" });
    try {
      const sourceEntries = await zipReader.getEntries();
      const entries = sourceEntries.map((source) => ({
        name: safeArchiveEntryName(source.filename),
        size: source.uncompressedSize ?? 0,
        source,
        kind: "zipjs",
        directory: Boolean(source.directory),
        encryption: source.encrypted ? "zip" : "none",
      }));
      return { zipReader, entries, encrypted: entries.some((entry) => entry.encryption !== "none") };
    } catch (error) {
      await zipReader.close().catch(() => {});
      throw normalizeArchiveError(error);
    }
  }

  async function openAdvancedArchive(file) {
    if (!window.LightPressureAdvanced) throw new Error("7Z/RAR 解码引擎还没有加载完成，请刷新页面后重试");
    elements.progressDetail.textContent = "正在加载 7Z/RAR 解码引擎（首次使用可能需要一点时间）";
    const advancedArchive = await window.LightPressureAdvanced.open(file);
    try {
      const sourceEntries = await advancedArchive.getFilesArray();
      const encrypted = await advancedArchive.hasEncryptedData();
      const entries = sourceEntries.map(({ file: source, path }) => ({
        name: safeArchiveEntryName(`${path || ""}${source.name}`),
        size: source.size ?? 0,
        source,
        kind: "libarchive",
        directory: false,
        encryption: encrypted === true ? "advanced" : "none",
      }));
      return { advancedArchive, entries, encrypted: encrypted === true };
    } catch (error) {
      await advancedArchive.close().catch(() => {});
      throw normalizeArchiveError(error);
    }
  }

  async function loadArchive(file) {
    if (!file) return;
    if (!window.LightPressureCodecs) {
      showMessage("本地压缩引擎还没有加载完成，请刷新页面后重试。", "error");
      return;
    }
    resetArchive();
    beginOperation();
    showProgress("正在读取压缩包…", "正在检查压缩包内容，全程在本地完成。");
    try {
      const header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
      setProgress(5);
      const detected = window.LightPressureCodecs.detectFormat(header, file.name);
      if (detected === "unknown") throw Object.assign(new Error("暂不认识这个文件格式，请选择 ZIP、7Z、RAR、TAR、TAR.GZ 或 GZIP。"), { code: "UNSUPPORTED_FORMAT" });
      const archive = { file, bytes: null, innerBytes: null, format: detected, entries: [], encrypted: false, engine: "native" };
      if (detected === "zip") {
        const zipArchive = await openZipArchive(file);
        archive.engine = "zipjs";
        archive.zipReader = zipArchive.zipReader;
        archive.entries = zipArchive.entries;
        archive.encrypted = zipArchive.encrypted;
        setProgress(100);
      } else if (detected === "7z" || detected === "rar") {
        const advanced = await openAdvancedArchive(file);
        archive.engine = "libarchive";
        archive.advancedArchive = advanced.advancedArchive;
        archive.entries = advanced.entries;
        archive.encrypted = advanced.encrypted;
        setProgress(100);
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        archive.bytes = bytes;
        setProgress(12);
        if (detected === "tar") {
          archive.entries = window.LightPressureCodecs.parseTar(bytes);
        } else {
          archive.innerBytes = await window.LightPressureCodecs.gunzip(bytes, (cancel) => { state.operationCancel = cancel; });
          archive.format = window.LightPressureCodecs.isTar(archive.innerBytes) ? "tar-gz" : "gzip";
          if (archive.format === "tar-gz") {
            archive.entries = window.LightPressureCodecs.parseTar(archive.innerBytes);
          } else {
            const fallbackName = file.name.replace(/\.gz$/i, "") || "解压文件";
            archive.entries = [{ name: safeArchiveEntryName(window.LightPressureCodecs.parseGzipFilename(bytes) || fallbackName), size: archive.innerBytes.length, data: archive.innerBytes, kind: "raw", directory: false, encryption: "none" }];
          }
        }
        setProgress(100);
      }
      if (!archive.entries.some((entry) => !entry.directory)) throw new Error("这个压缩包里没有可解压的文件。");
      state.archive = archive;
      elements.selectedArchive.textContent = file.name;
      elements.selectedArchive.dataset.format = archive.format;
      renderExtractFiles();
      const encrypted = archiveNeedsPassword(archive);
      elements.extractPasswordBox.classList.toggle("hidden", !encrypted);
      syncExtractArea();
      showMessage(`已读取 ${archiveEntries().length} 个文件${encrypted ? "，这个压缩包需要密码才能解压" : "，可以开始解压"}。`);
    } catch (error) {
      const normalizedError = normalizeArchiveError(error);
      if (normalizedError.code !== "CANCELLED") showMessage(normalizedError.message || "无法读取这个压缩包。", "error");
      resetArchive();
    } finally {
      const wasCancelled = state.cancelled;
      finishOperation();
      if (!wasCancelled) window.setTimeout(hideProgress, 650);
    }
  }

  async function readArchiveEntry(entry) {
    checkCancelled();
    if (entry.kind === "raw") return entry.data;
    if (entry.kind === "tar") return state.archive.innerBytes ? state.archive.innerBytes.slice(entry.dataOffset, entry.dataOffset + entry.size) : state.archive.bytes.slice(entry.dataOffset, entry.dataOffset + entry.size);
    if (entry.kind === "zipjs") {
      const password = archiveEntryPassword(entry);
      try {
        return new Uint8Array(await entry.source.arrayBuffer({ password }));
      } catch (error) {
        throw normalizeArchiveError(error);
      }
    }
    if (entry.kind === "libarchive") {
      const file = await extractAdvancedFile(entry);
      return new Uint8Array(await file.arrayBuffer());
    }
    return window.LightPressureCodecs.extractZipEntry(state.archive.bytes, entry, elements.extractPassword.value, (cancel) => { state.operationCancel = cancel; });
  }

  function archiveEntryPassword(entry) {
    if (entry.encryption === "none") return undefined;
    const password = elements.extractPassword.value;
    if (!password) throw Object.assign(new Error("请输入压缩包密码后再解压。"), { code: "PASSWORD_REQUIRED" });
    return password;
  }

  async function extractAdvancedFile(entry) {
    try {
      if (entry.encryption !== "none") await state.archive.advancedArchive.usePassword(archiveEntryPassword(entry));
      return await entry.source.extract();
    } catch (error) {
      throw normalizeArchiveError(error);
    }
  }

  async function getDirectoryFileHandle(rootHandle, path) {
    const parts = safePathParts(path);
    if (!parts.length) return null;
    const fileName = parts.pop();
    let directory = rootHandle;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
    return directory.getFileHandle(fileName, { create: true });
  }

  function entryProgress(index, total, current, maximum) {
    const fraction = maximum > 0 ? Math.min(1, current / maximum) : 0.5;
    setProgress(((index + fraction) / total) * 90);
  }

  async function writeArchiveEntryToDirectory(rootHandle, entry, index, total, abortController) {
    const fileHandle = await getDirectoryFileHandle(rootHandle, entry.name);
    if (!fileHandle) return;
    const writable = await fileHandle.createWritable();
    let closed = false;
    try {
      if (entry.kind === "zipjs" && typeof WritableStream === "function") {
        const stream = new WritableStream({
          write: (chunk) => writable.write(chunk),
          close: async () => {
            await writable.close();
            closed = true;
          },
          abort: async (reason) => {
            try {
              await writable.abort(reason);
            } finally {
              closed = true;
            }
          },
        });
        await entry.source.getData(stream, {
          password: archiveEntryPassword(entry),
          onprogress: (current, maximum) => entryProgress(index, total, current, maximum),
          ...(abortController ? { signal: abortController.signal } : {}),
        });
      } else if (entry.kind === "libarchive") {
        const file = await extractAdvancedFile(entry);
        await writable.write(file);
        await writable.close();
        closed = true;
      } else {
        const data = await readArchiveEntry(entry);
        await writable.write(new Blob([data]));
        await writable.close();
        closed = true;
      }
    } catch (error) {
      if (!closed) await writable.abort(error).catch(() => {});
      throw normalizeArchiveError(error);
    }
  }

  async function addArchiveEntryToZip(zipWriter, entry, index, total, abortController) {
    const filename = safeArchiveEntryName(entry.name);
    const addOptions = {
      level: 0,
      onprogress: (current, maximum) => entryProgress(index, total, current, maximum),
      ...(abortController ? { signal: abortController.signal } : {}),
    };
    if (entry.kind === "zipjs" && typeof TransformStream === "function") {
      const transform = new TransformStream();
      let readPromise;
      try {
        readPromise = entry.source.getData(transform.writable, {
          password: archiveEntryPassword(entry),
          onprogress: (current, maximum) => entryProgress(index, total, current, maximum),
          ...(abortController ? { signal: abortController.signal } : {}),
        });
        await Promise.all([
          zipWriter.add(filename, transform.readable, addOptions),
          readPromise,
        ]);
        return;
      } catch (error) {
        await transform.writable.abort(error).catch(() => {});
        if (readPromise) await readPromise.catch(() => {});
        throw normalizeArchiveError(error);
      }
    }
    if (entry.kind === "libarchive") {
      const file = await extractAdvancedFile(entry);
      const reader = typeof file.stream === "function" ? file.stream() : new window.zip.Uint8ArrayReader(new Uint8Array(await file.arrayBuffer()));
      await zipWriter.add(filename, reader, addOptions);
      return;
    }
    const data = await readArchiveEntry(entry);
    await zipWriter.add(filename, new window.zip.Uint8ArrayReader(data), addOptions);
  }

  async function createBatchZip(entries) {
    if (!window.zip) throw new Error("ZIP 打包引擎还没有加载完成，请刷新页面后重试");
    const outputWriter = new window.zip.BlobWriter("application/zip");
    const zipWriter = new window.zip.ZipWriter(outputWriter, { useWebWorkers: true });
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    let closed = false;
    state.operationCancel = () => abortController?.abort();
    try {
      for (let index = 0; index < entries.length; index += 1) {
        checkCancelled();
        const entry = entries[index];
        await addArchiveEntryToZip(zipWriter, entry, index, entries.length, abortController);
        setProgress(((index + 1) / entries.length) * 90);
        elements.progressDetail.textContent = `已打包 ${index + 1} / ${entries.length} 个文件`;
        await yieldToBrowser();
      }
      await zipWriter.close();
      closed = true;
      setProgress(100);
      return outputWriter.getData();
    } catch (error) {
      if (!closed) await zipWriter.close().catch(() => {});
      throw normalizeArchiveError(error);
    }
  }

  async function extractSingle(index) {
    const entries = archiveEntries();
    const entry = entries[index];
    if (!entry) return;
    beginOperation();
    showProgress("正在解压文件…", `正在处理：${entry.name}`);
    try {
      const data = await readArchiveEntry(entry);
      checkCancelled();
      createDownload(data, safeFileName(entry.name));
      setProgress(100);
      showMessage(`已开始下载：${entry.name}`);
    } catch (error) {
      const normalizedError = normalizeArchiveError(error);
      if (normalizedError.code !== "CANCELLED") showMessage(normalizedError.message || "这个文件无法解压。", "error");
    } finally {
      const wasCancelled = state.cancelled;
      finishOperation();
      if (!wasCancelled) window.setTimeout(hideProgress, 900);
    }
  }

  async function extractAll(toFolder = false) {
    const entries = archiveEntries();
    if (!entries.length) return;
    if (archiveNeedsPassword(state.archive) && !elements.extractPassword.value) {
      showMessage("请输入压缩包密码后再解压。", "error");
      elements.extractPassword.focus();
      return;
    }
    beginOperation();
    setBusy(elements.extractButton, true, "正在解压…");
    showProgress("正在解压文件…", "正在读取压缩包内容，全程在本地完成。");
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    state.operationCancel = () => abortController?.abort();
    let rootHandle = null;
    try {
      if (toFolder) {
        rootHandle = await window.showDirectoryPicker({ mode: "readwrite", id: "light-pressure-output" });
        for (let index = 0; index < entries.length; index += 1) {
          checkCancelled();
          const entry = entries[index];
          await writeArchiveEntryToDirectory(rootHandle, entry, index, entries.length, abortController);
          setProgress(((index + 1) / entries.length) * 100);
          elements.progressDetail.textContent = `已保存 ${index + 1} / ${entries.length} 个文件`;
          await yieldToBrowser();
        }
        showMessage("解压完成，文件已保存到你选择的文件夹。");
      } else {
        const output = await createBatchZip(entries);
        checkCancelled();
        createDownload(output, `${safeArchiveName(state.archive.file.name)}-解压结果.zip`, "application/zip");
        showMessage(`解压完成，已将 ${entries.length} 个文件打包为一个 ZIP 下载。`);
      }
    } catch (error) {
      if (error.name === "AbortError") showMessage("已取消选择保存文件夹。", "error");
      else {
        const normalizedError = normalizeArchiveError(error);
        if (normalizedError.code !== "CANCELLED") showMessage(normalizedError.message || "解压失败，请检查密码或文件完整性。", "error");
      }
    } finally {
      const wasCancelled = state.cancelled;
      setBusy(elements.extractButton, false, "解压并下载 ZIP");
      finishOperation();
      if (!wasCancelled) window.setTimeout(hideProgress, 1100);
    }
  }

  function togglePassword(input, button) {
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    button.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
    button.textContent = visible ? "◉" : "◌";
  }

  function wireDropZone(zone, input, onFiles) {
    zone.tabIndex = 0;
    ["dragenter", "dragover"].forEach((eventName) => zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add("drag-over");
    }));
    ["dragleave", "drop"].forEach((eventName) => zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove("drag-over");
    }));
    zone.addEventListener("drop", (event) => onFiles(event.dataTransfer.files));
    zone.addEventListener("click", (event) => {
      if (!event.target.closest("button")) input.click();
    });
    zone.addEventListener("keydown", (event) => {
      if (event.target !== zone || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      input.click();
    });
  }

  elements.tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? elements.tabs.length - 1 : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + elements.tabs.length) % elements.tabs.length;
      const nextTab = elements.tabs[nextIndex];
      setMode(nextTab.dataset.mode);
      nextTab.focus();
    });
  });
  elements.chooseFiles.addEventListener("click", () => elements.compressInput.click());
  elements.chooseFolder.addEventListener("click", () => elements.folderInput.click());
  elements.chooseArchive.addEventListener("click", () => elements.extractInput.click());
  elements.compressInput.addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
  elements.folderInput.addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
  elements.extractInput.addEventListener("change", (event) => { loadArchive(event.target.files[0]); event.target.value = ""; });
  elements.archiveFormat.addEventListener("change", updateFormatUI);
  elements.compressButton.addEventListener("click", compressFiles);
  elements.extractButton.addEventListener("click", () => extractAll(false));
  elements.extractFolderButton.addEventListener("click", () => extractAll(true));
  elements.cancelButton.addEventListener("click", cancelOperation);
  elements.clearCompress.addEventListener("click", () => {
    state.files = [];
    renderCompressFiles();
    syncCompressArea();
    hideMessage();
  });
  elements.clearExtract.addEventListener("click", resetArchive);
  elements.messageClose.addEventListener("click", hideMessage);
  elements.toggleArchivePassword.addEventListener("click", () => togglePassword(elements.archivePassword, elements.toggleArchivePassword));
  elements.toggleExtractPassword.addEventListener("click", () => togglePassword(elements.extractPassword, elements.toggleExtractPassword));

  wireDropZone(elements.compressDrop, elements.compressInput, addFiles);
  wireDropZone(elements.extractDrop, elements.extractInput, (files) => loadArchive(files[0]));
  setMode(state.mode);
  updateFormatUI();

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
