# 轻压 · 本地文件压缩工具

一个可以部署到 GitHub Pages 的纯静态网页工具。文件和密码只在浏览器本地处理，不需要后端服务。

## 当前功能

- 多文件压缩为 ZIP
- ZIP 密码保护（ZipCrypto，兼容 7-Zip、WinRAR 等常见工具）
- GZIP、TAR、TAR.GZ 压缩与解压
- 选择文件夹并保留目录结构
- ZIP、TAR、GZIP 内容预览
- 单个文件下载、批量下载、支持 File System Access API 的浏览器中选择目标文件夹保存
- 本地依赖和 Service Worker 缓存，首次打开后可离线使用
- 大文件提示、后台压缩/解压和取消操作

## 格式说明

ZIP 密码功能使用 ZipCrypto，重点是跨软件兼容性；它不是 AES-256，不适合高敏感资料。AES 加密 ZIP、分卷 ZIP 暂不支持。

当前页面会识别 7Z 和 RAR，并给出明确提示，但没有把大型 WASM 解码引擎塞进基础页面，因此这两个格式暂未解压。后续可以作为单独的可选模块加入。

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

`vendor/jszip.min.js` 和 `vendor/JSZIP-LICENSE.markdown` 来自 JSZip；`vendor/fflate.min.js` 和 `vendor/FFLATE-LICENSE` 来自 fflate。两者均随项目本地提供，页面不依赖 CDN 才能完成核心处理。
