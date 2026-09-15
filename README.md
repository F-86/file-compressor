# 轻压 · 本地文件压缩工具

一个可以部署到 GitHub Pages 的纯静态网页工具。文件和密码只在浏览器本地处理，不需要后端服务。

## 当前功能

- 多文件压缩为 ZIP
- AES-256 ZIP 密码保护（兼容 7-Zip、WinRAR、WinZip 等常见工具）
- GZIP、TAR、TAR.GZ 压缩与解压
- 7Z、RAR 解压（本地 WASM 引擎，首次使用时按需加载）
- 选择文件夹并保留目录结构
- ZIP、TAR、GZIP 内容预览
- 单个文件下载、批量打包为一个 ZIP 下载；支持 File System Access API 的浏览器中选择目标文件夹保存
- 本地依赖和 Service Worker 缓存；7Z/RAR 解码引擎按需加载，使用后可离线复用
- 大文件提示；ZIP 读写使用 Blob/Worker 流式路径，7Z/RAR 解码放在 Worker 中；支持逐项处理和取消操作

## 格式说明

新建密码 ZIP 默认使用 WinZip AES-256（AE-2），密码不会写入文件名或明文校验值。页面仍可读取历史 ZipCrypto ZIP，但 ZipCrypto 本身不安全，不建议用于敏感资料。

7Z 和 RAR 使用本地 libarchive WASM 引擎解压，文件不会上传。WASM 只在选择这两类文件时按需加载；支持 RAR v4/v5、常见 7Z 压缩方法。分卷 ZIP/RAR、带密码的加密文件以及极端大的归档仍受浏览器可用内存限制。

批量解压默认生成一个新的 ZIP 下载，避免浏览器拦截多个自动下载。Chromium 系浏览器在支持 File System Access API 时，还可以直接选择目标文件夹保存；其他浏览器请使用批量 ZIP 下载。

## 本地运行

直接用浏览器打开 `index.html` 即可；如果浏览器限制本地文件加载，可以在项目根目录启动静态服务器：

```bash
python3 -m http.server 8080
```

然后访问 <http://localhost:8080>。

## 部署到 GitHub Pages

仓库已经包含 `.github/workflows/pages.yml`。推送到 `main` 分支后，GitHub Actions 会自动部署静态站点。

线上地址：<https://f-86.github.io/file-compressor/>

## 依赖许可

`vendor/zip.min.js` 和 `vendor/ZIPJS-LICENSE` 来自 zip.js；`vendor/libarchive.js`、`vendor/libarchive-worker.js`、`vendor/libarchive.wasm` 和 `vendor/LIBARCHIVE-LICENSE` 来自 libarchive.js；`vendor/fflate.min.js` 和 `vendor/FFLATE-LICENSE` 来自 fflate。依赖均随项目本地提供，页面不依赖 CDN 才能完成处理。
