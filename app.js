(() => {
  "use strict";

  const LARGE_FILE_BYTES = 200 * 1024 * 1024;
  const UNSUPPORTED_FORMATS = new Set(["7z", "rar"]);
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
    "zip-password": { extension: ".zip", label: "ZIP" },
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
      .replace(/\.(zip|tar\.gz|tgz|tar|gz)$/i, "")
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
    hideMessage();
    hideProgress();
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    const text = button.querySelector(".button-label");
    if (text) text.textContent = busy ? label : button.id === "compress-button" ? "开始压缩" : "解压并下载全部";
    button.style.opacity = busy ? "0.72" : "1";
  }

  function showMessage(text, type = "success") {
    elements.messageText.textContent = text;
    elements.message.classList.toggle("error", type === "error");
    elements.messageIcon.textContent = type === "error" ? "!" : "✓";
    elements.message.classList.remove("hidden");
  }

  function hideMessage() {
    elements.message.classList.add("hidden");
  }

  function showProgress(label, detail) {
    elements.progressLabel.textContent = label;
    elements.progressDetail.textContent = detail || "请稍候，浏览器正在本地处理文件。";
    elements.progress.classList.remove("hidden");
    elements.cancelButton.classList.remove("hidden");
    setProgress(0);
  }

  function setProgress(percent) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    elements.progressPercent.textContent = `${value}%`;
    elements.progressBar.style.width = `${value}%`;
  }

  function hideProgress() {
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

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
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
    return { zip: "ZIP", gzip: "GZIP", "tar-gz": "TAR.GZ", tar: "TAR" }[format] || format.toUpperCase();
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
        <button class="file-action" type="button" data-entry-index="${index}">下载</button>
      `;
      row.querySelector(".file-action").addEventListener("click", () => extractSingle(index));
      elements.extractList.appendChild(row);
    });
  }

  function syncCompressArea() {
    elements.compressArea.classList.toggle("hidden", state.files.length === 0);
    const totalBytes = state.files.reduce((sum, file) => sum + file.size, 0);
    elements.largeFileNotice.classList.toggle("hidden", totalBytes < LARGE_FILE_BYTES);
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
    }
    return entries;
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
      if (password.length < 4) {
        showMessage("密码至少需要 4 个字符。", "error");
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
    try {
      const entries = await readFiles();
      checkCancelled();
      const level = Number(elements.compressionLevel.value);
      const setCancel = (cancel) => { state.operationCancel = cancel; };
      let bytes;
      let extension = formatInfo[format].extension;
      if (format === "zip-password") {
        bytes = await window.LightPressureCodecs.createPasswordZip(entries, password, level, setCancel, (percent) => {
          setProgress(27 + percent * 0.73);
        });
      } else if (format === "zip") {
        bytes = await window.LightPressureCodecs.createZip(entries, level, setCancel);
        setProgress(100);
      } else if (format === "tar") {
        bytes = window.LightPressureCodecs.createTar(entries);
        setProgress(100);
      } else if (format === "tar-gz") {
        const tarBytes = window.LightPressureCodecs.createTar(entries);
        setProgress(35);
        bytes = await window.LightPressureCodecs.createGzip(tarBytes, `${safeArchiveName(elements.archiveName.value)}.tar`, level, setCancel);
        setProgress(100);
      } else {
        bytes = await window.LightPressureCodecs.createGzip(entries[0].data, entries[0].name, level, setCancel);
        extension = ".gz";
        setProgress(100);
      }
      checkCancelled();
      createDownload(bytes, `${safeArchiveName(elements.archiveName.value)}${extension}`, "application/octet-stream");
      showMessage(`压缩完成，已准备下载 ${formatLabel(format)} 文件（${formatBytes(bytes.length)}）。`);
    } catch (error) {
      if (error.code !== "CANCELLED") showMessage(`压缩失败：${error.message || "请稍后重试"}`, "error");
    } finally {
      setBusy(elements.compressButton, false, "开始压缩");
      finishOperation();
      if (!state.cancelled) window.setTimeout(hideProgress, 1100);
    }
  }

  function resetArchive() {
    state.archive = null;
    elements.extractList.replaceChildren();
    elements.extractPassword.value = "";
    elements.extractPasswordBox.classList.add("hidden");
    syncExtractArea();
    hideMessage();
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
      const bytes = new Uint8Array(await file.arrayBuffer());
      setProgress(12);
      const detected = window.LightPressureCodecs.detectFormat(bytes, file.name);
      if (UNSUPPORTED_FORMATS.has(detected)) {
        const name = detected === "7z" ? "7Z" : "RAR";
        throw Object.assign(new Error(`检测到 ${name} 格式；当前离线版已支持 ZIP、TAR、TAR.GZ 和 GZIP，${name} 需要额外的 WASM 引擎。`), { code: "UNSUPPORTED_FORMAT" });
      }
      if (detected === "unknown") throw Object.assign(new Error("暂不认识这个文件格式，请选择 ZIP、TAR、TAR.GZ 或 GZIP。"), { code: "UNSUPPORTED_FORMAT" });
      const archive = { file, bytes, innerBytes: null, format: detected, entries: [] };
      if (detected === "zip") {
        archive.entries = window.LightPressureCodecs.parseZip(bytes);
        setProgress(100);
      } else if (detected === "tar") {
        archive.entries = window.LightPressureCodecs.parseTar(bytes);
        setProgress(100);
      } else {
        archive.innerBytes = await window.LightPressureCodecs.gunzip(bytes, (cancel) => { state.operationCancel = cancel; });
        archive.format = window.LightPressureCodecs.isTar(archive.innerBytes) ? "tar-gz" : "gzip";
        if (archive.format === "tar-gz") {
          archive.entries = window.LightPressureCodecs.parseTar(archive.innerBytes);
        } else {
          const fallbackName = file.name.replace(/\.gz$/i, "") || "解压文件";
          archive.entries = [{ name: window.LightPressureCodecs.parseGzipFilename(bytes) || fallbackName, size: archive.innerBytes.length, data: archive.innerBytes, kind: "raw", directory: false, encryption: "none" }];
        }
        setProgress(100);
      }
      if (!archive.entries.some((entry) => !entry.directory)) throw new Error("这个压缩包里没有可解压的文件。");
      state.archive = archive;
      elements.selectedArchive.textContent = file.name;
      elements.selectedArchive.dataset.format = archive.format;
      renderExtractFiles();
      elements.extractPasswordBox.classList.toggle("hidden", !archive.entries.some((entry) => entry.encryption === "zipcrypto"));
      syncExtractArea();
      const encrypted = archive.entries.some((entry) => entry.encryption === "zipcrypto");
      const aes = archive.entries.some((entry) => entry.encryption === "aes");
      if (aes) showMessage("已读取压缩包，但其中包含 AES 加密条目；当前离线版支持 ZipCrypto 密码 ZIP。", "error");
      else showMessage(`已读取 ${archiveEntries().length} 个文件${encrypted ? "，请输入密码后解压" : "，可以开始解压"}。`);
    } catch (error) {
      if (error.code !== "CANCELLED") showMessage(error.message || "无法读取这个压缩包。", "error");
      resetArchive();
    } finally {
      finishOperation();
      window.setTimeout(hideProgress, 650);
    }
  }

  async function readArchiveEntry(entry) {
    checkCancelled();
    const setCancel = (cancel) => { state.operationCancel = cancel; };
    if (entry.kind === "raw") return entry.data;
    if (entry.kind === "tar") return state.archive.innerBytes ? state.archive.innerBytes.slice(entry.dataOffset, entry.dataOffset + entry.size) : state.archive.bytes.slice(entry.dataOffset, entry.dataOffset + entry.size);
    return window.LightPressureCodecs.extractZipEntry(state.archive.bytes, entry, elements.extractPassword.value, setCancel);
  }

  async function writeToDirectory(rootHandle, path, data) {
    const parts = safePathParts(path);
    if (!parts.length) return;
    const fileName = parts.pop();
    let directory = rootHandle;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(new Blob([data]));
    await writable.close();
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
      if (error.code !== "CANCELLED") showMessage(error.message || "这个文件无法解压。", "error");
    } finally {
      finishOperation();
      window.setTimeout(hideProgress, 900);
    }
  }

  async function extractAll(toFolder = false) {
    const entries = archiveEntries();
    if (!entries.length) return;
    if (state.archive.entries.some((entry) => entry.encryption === "zipcrypto") && !elements.extractPassword.value) {
      showMessage("请输入 ZIP 密码后再解压。", "error");
      elements.extractPassword.focus();
      return;
    }
    beginOperation();
    setBusy(elements.extractButton, true, "正在解压…");
    showProgress("正在解压文件…", "正在读取压缩包内容，全程在本地完成。");
    let rootHandle = null;
    try {
      if (toFolder) {
        rootHandle = await window.showDirectoryPicker({ mode: "readwrite", id: "light-pressure-output" });
      }
      for (let index = 0; index < entries.length; index += 1) {
        checkCancelled();
        const entry = entries[index];
        const data = await readArchiveEntry(entry);
        if (rootHandle) {
          await writeToDirectory(rootHandle, entry.name, data);
        } else {
          createDownload(data, safeFileName(entry.name));
          await wait(120);
        }
        setProgress(((index + 1) / entries.length) * 100);
        elements.progressDetail.textContent = `已处理 ${index + 1} / ${entries.length} 个文件`;
      }
      showMessage(rootHandle ? "解压完成，文件已保存到你选择的文件夹。" : "解压完成，文件已开始分别下载。");
    } catch (error) {
      if (error.name === "AbortError") showMessage("已取消选择保存文件夹。", "error");
      else if (error.code !== "CANCELLED") showMessage(error.message || "解压失败，请检查密码或文件完整性。", "error");
    } finally {
      setBusy(elements.extractButton, false, "解压并下载全部");
      finishOperation();
      window.setTimeout(hideProgress, 1100);
    }
  }

  function togglePassword(input, button) {
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    button.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
    button.textContent = visible ? "◉" : "◌";
  }

  function wireDropZone(zone, input, onFiles) {
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
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });
  }

  elements.tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));
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
  updateFormatUI();

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
