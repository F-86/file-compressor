(() => {
  "use strict";

  const state = {
    mode: "compress",
    files: [],
    zipFile: null,
    zipEntries: [],
  };

  const $ = (selector) => document.querySelector(selector);

  const elements = {
    tabs: document.querySelectorAll(".mode-tab"),
    panels: {
      compress: $("#compress-panel"),
      extract: $("#extract-panel"),
    },
    compressDrop: $("#compress-drop-zone"),
    extractDrop: $("#extract-drop-zone"),
    compressInput: $("#compress-input"),
    folderInput: $("#folder-input"),
    extractInput: $("#extract-input"),
    chooseFiles: $("#choose-files"),
    chooseFolder: $("#choose-folder"),
    chooseZip: $("#choose-zip"),
    compressArea: $("#compress-file-area"),
    extractArea: $("#extract-file-area"),
    compressList: $("#compress-file-list"),
    extractList: $("#extract-file-list"),
    compressCount: $("#compress-count"),
    extractCount: $("#extract-count"),
    archiveName: $("#archive-name"),
    compressionLevel: $("#compression-level"),
    compressButton: $("#compress-button"),
    extractButton: $("#extract-button"),
    selectedArchive: $("#selected-archive"),
    progress: $("#progress-area"),
    progressLabel: $("#progress-label"),
    progressPercent: $("#progress-percent"),
    progressBar: $("#progress-bar"),
    progressDetail: $("#progress-detail"),
    message: $("#message"),
    messageText: $("#message-text"),
    messageClose: $("#message-close"),
    clearCompress: $("#clear-compress"),
    clearExtract: $("#clear-extract"),
  };

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** index);
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  function getFilePath(file) {
    return file.webkitRelativePath || file.name;
  }

  function safeArchiveName(name) {
    const cleaned = name.trim().replace(/\.zip$/i, "").replace(/[\\/:*?"<>|]/g, "-");
    return cleaned || "轻压文件";
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
    button.querySelector(".button-label").textContent = busy ? label : button.id === "compress-button" ? "开始压缩" : "解压全部文件";
    button.style.opacity = busy ? "0.72" : "1";
  }

  function showMessage(text, type = "success") {
    elements.messageText.textContent = text;
    elements.message.classList.toggle("error", type === "error");
    elements.message.querySelector(".message-icon").textContent = type === "error" ? "!" : "✓";
    elements.message.classList.remove("hidden");
  }

  function hideMessage() {
    elements.message.classList.add("hidden");
  }

  function showProgress(label, detail = "请稍候，浏览器正在本地处理文件。") {
    elements.progressLabel.textContent = label;
    elements.progressDetail.textContent = detail;
    elements.progress.classList.remove("hidden");
    setProgress(0);
  }

  function setProgress(percent) {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    elements.progressPercent.textContent = `${safePercent}%`;
    elements.progressBar.style.width = `${safePercent}%`;
  }

  function hideProgress() {
    elements.progress.classList.add("hidden");
  }

  function createDownload(blob, filename) {
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

  function renderCompressFiles() {
    elements.compressCount.textContent = String(state.files.length);
    elements.compressList.replaceChildren();
    state.files.forEach((file, index) => {
      const row = document.createElement("div");
      row.className = "file-row";
      const path = getFilePath(file);
      const hasFolder = path.includes("/");
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

  function renderExtractFiles() {
    const entries = state.zipEntries;
    elements.extractCount.textContent = String(entries.filter((entry) => !entry.dir).length);
    elements.extractList.replaceChildren();
    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "file-row";
      const fileName = entry.name.split("/").filter(Boolean).pop() || entry.name;
      row.innerHTML = `
        <span class="file-icon" aria-hidden="true">${entry.dir ? "⌁" : "▱"}</span>
        <div class="file-meta">
          <div class="file-name" title="${escapeHtml(entry.name)}">${escapeHtml(fileName)}${entry.dir ? " /" : ""}</div>
          <div class="file-path" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
        </div>
        <span class="file-size">${entry.dir ? "文件夹" : formatBytes(entry.uncompressedSize)}</span>
      `;
      elements.extractList.appendChild(row);
    });
  }

  function syncCompressArea() {
    elements.compressArea.classList.toggle("hidden", state.files.length === 0);
    if (state.files.length === 0) {
      elements.compressDrop.classList.remove("hidden");
    }
  }

  function syncExtractArea() {
    elements.extractArea.classList.toggle("hidden", !state.zipFile);
    elements.extractDrop.classList.toggle("hidden", Boolean(state.zipFile));
  }

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []).filter((file) => file instanceof File);
    const existing = new Set(state.files.map((file) => `${getFilePath(file)}:${file.size}:${file.lastModified}`));
    incoming.forEach((file) => {
      const key = `${getFilePath(file)}:${file.size}:${file.lastModified}`;
      if (!existing.has(key)) {
        state.files.push(file);
        existing.add(key);
      }
    });
    renderCompressFiles();
    syncCompressArea();
    hideMessage();
  }

  async function loadZip(file) {
    if (!file || !/\.zip$/i.test(file.name)) {
      showMessage("请选择 ZIP 格式的压缩包。", "error");
      return;
    }
    if (!window.JSZip) {
      showMessage("压缩组件还没有加载完成，请检查网络后重试。", "error");
      return;
    }
    try {
      showProgress("正在读取 ZIP…", "正在检查压缩包内容，全程在本地完成。 ");
      const zip = await window.JSZip.loadAsync(file, { createFolders: true });
      // 保留 JSZip 原始对象；async() 等方法位于对象原型上，不能用展开运算符复制。
      const entries = Object.values(zip.files);
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        entry.uncompressedSize = 0;
        if (!entry.dir) {
          entry.uncompressedSize = await getEntrySize(entry);
        }
        setProgress(((index + 1) / Math.max(entries.length, 1)) * 100);
      }
      state.zipFile = file;
      state.zipEntries = entries;
      elements.selectedArchive.textContent = file.name;
      renderExtractFiles();
      syncExtractArea();
      hideProgress();
      showMessage(`已读取 ${entries.filter((entry) => !entry.dir).length} 个文件，可以开始解压。`);
    } catch (error) {
      hideProgress();
      showMessage(`无法读取这个 ZIP 文件：${error.message || "文件可能已损坏"}`, "error");
    }
  }

  async function getEntrySize(entry) {
    try {
      const blob = await entry.async("blob");
      return blob.size;
    } catch {
      return 0;
    }
  }

  async function compressFiles() {
    if (!state.files.length || !window.JSZip) return;
    hideMessage();
    setBusy(elements.compressButton, true, "正在压缩…");
    showProgress("正在压缩文件…", "文件不会上传，压缩过程在本地浏览器中完成。");
    try {
      const zip = new window.JSZip();
      state.files.forEach((file) => {
        zip.file(getFilePath(file), file);
      });
      const blob = await zip.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: Number(elements.compressionLevel.value) },
        },
        (metadata) => {
          setProgress(metadata.percent);
          elements.progressDetail.textContent = `正在处理：${metadata.currentFile || "文件"}`;
        },
      );
      createDownload(blob, `${safeArchiveName(elements.archiveName.value)}.zip`);
      setProgress(100);
      showMessage(`压缩完成，已准备下载 ${formatBytes(blob.size)} 的 ZIP 文件。`);
    } catch (error) {
      showMessage(`压缩失败：${error.message || "请稍后重试"}`, "error");
    } finally {
      setBusy(elements.compressButton, false, "开始压缩");
      window.setTimeout(hideProgress, 900);
    }
  }

  function normalizePath(path) {
    return path.split("/").filter((part) => part && part !== "." && part !== "..");
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function extractFiles() {
    const entries = state.zipEntries.filter((entry) => !entry.dir);
    if (!entries.length) {
      showMessage("这个 ZIP 压缩包里没有可解压的文件。", "error");
      return;
    }
    hideMessage();
    setBusy(elements.extractButton, true, "正在解压…");
    showProgress("正在解压文件…", "正在读取 ZIP 内容，全程在本地完成。");
    try {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const blob = await entry.async("blob");
        createDownload(blob, normalizePath(entry.name).join("_") || `文件-${index + 1}`);
        await wait(120);
        setProgress(((index + 1) / entries.length) * 100);
        elements.progressDetail.textContent = `已处理 ${index + 1} / ${entries.length} 个文件`;
      }
      showMessage("解压完成，文件已开始分别下载。");
    } catch (error) {
      showMessage(`解压失败：${error.message || "请稍后重试"}`, "error");
    } finally {
      setBusy(elements.extractButton, false, "解压全部文件");
      window.setTimeout(hideProgress, 900);
    }
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

  function wireDropZone(zone, onFiles) {
    ["dragenter", "dragover"].forEach((eventName) => {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        zone.classList.add("drag-over");
      });
    });
    ["dragleave", "drop"].forEach((eventName) => {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        zone.classList.remove("drag-over");
      });
    });
    zone.addEventListener("drop", (event) => onFiles(event.dataTransfer.files));
    zone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        zone.querySelector("input")?.click();
      }
    });
  }

  elements.tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));
  elements.chooseFiles.addEventListener("click", () => elements.compressInput.click());
  elements.chooseFolder.addEventListener("click", () => elements.folderInput.click());
  elements.chooseZip.addEventListener("click", () => elements.extractInput.click());
  elements.compressInput.addEventListener("change", (event) => {
    addFiles(event.target.files);
    event.target.value = "";
  });
  elements.folderInput.addEventListener("change", (event) => {
    addFiles(event.target.files);
    event.target.value = "";
  });
  elements.extractInput.addEventListener("change", (event) => {
    loadZip(event.target.files[0]);
    event.target.value = "";
  });
  elements.compressButton.addEventListener("click", compressFiles);
  elements.extractButton.addEventListener("click", extractFiles);
  elements.clearCompress.addEventListener("click", () => {
    state.files = [];
    renderCompressFiles();
    syncCompressArea();
    hideMessage();
  });
  elements.clearExtract.addEventListener("click", () => {
    state.zipFile = null;
    state.zipEntries = [];
    elements.extractList.replaceChildren();
    syncExtractArea();
    hideMessage();
  });
  elements.messageClose.addEventListener("click", hideMessage);

  wireDropZone(elements.compressDrop, addFiles);
  wireDropZone(elements.extractDrop, (files) => loadZip(files[0]));
})();
