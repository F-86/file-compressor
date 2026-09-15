(function attachArchiveCodecs(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.LightPressureCodecs = api;
  }
})(typeof self !== "undefined" ? self : globalThis, (root) => {
  "use strict";

  const fflate = root.fflate || (typeof require === "function" ? require("./vendor/fflate.min.js") : null);
  const textEncoder = new TextEncoder();
  const isNodeRuntime = typeof process !== "undefined" && Boolean(process.versions && process.versions.node);

  if (!fflate) {
    throw new Error("fflate 未加载");
  }

  const ZIP_LOCAL_SIGNATURE = 0x04034b50;
  const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
  const ZIP_END_SIGNATURE = 0x06054b50;
  const ZIP64_LIMIT = 0xffffffff;

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  function errorWithCode(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function readU32(bytes, offset) {
    return (
      (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>> 0
    );
  }

  function writeU16(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeU32(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      result.set(part, offset);
      offset += part.length;
    });
    return result;
  }

  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
  }

  function crc32UpdateByte(value, byte) {
    return (crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
  }

  function encodeName(name) {
    return textEncoder.encode(name);
  }

  function decodeName(bytes, utf8) {
    if (utf8) return new TextDecoder("utf-8").decode(bytes);
    let result = "";
    for (const byte of bytes) result += String.fromCharCode(byte);
    return result;
  }

  function trimNulls(bytes) {
    let end = bytes.indexOf(0);
    if (end < 0) end = bytes.length;
    return new TextDecoder("utf-8").decode(bytes.slice(0, end)).replace(/\s+$/, "");
  }

  function normalizePath(path) {
    const parts = String(path)
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..");
    return parts.join("/") || "未命名文件";
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    if (root.crypto && typeof root.crypto.getRandomValues === "function") {
      root.crypto.getRandomValues(bytes);
      return bytes;
    }
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
    return bytes;
  }

  function createZipCryptoKeys(password) {
    const keys = [0x12345678, 0x23456789, 0x34567890];
    for (const byte of encodeName(password)) updateZipCryptoKeys(keys, byte);
    return keys;
  }

  function updateZipCryptoKeys(keys, byte) {
    keys[0] = crc32UpdateByte(keys[0], byte);
    keys[1] = (Math.imul((keys[1] + (keys[0] & 0xff)) >>> 0, 0x08088405) + 1) >>> 0;
    keys[2] = crc32UpdateByte(keys[2], keys[1] >>> 24);
  }

  function zipCryptoByte(keys) {
    const value = (keys[2] | 2) >>> 0;
    return (Math.imul(value, value ^ 1) >>> 8) & 0xff;
  }

  function zipCryptoTransform(bytes, keys, encrypt) {
    const output = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
      const value = bytes[index];
      const keyByte = zipCryptoByte(keys);
      output[index] = value ^ keyByte;
      updateZipCryptoKeys(keys, encrypt ? value : output[index]);
    }
    return output;
  }

  function encryptZipCrypto(data, password, checkByte) {
    const header = randomBytes(12);
    header[11] = checkByte;
    const plain = concatBytes([header, data]);
    return zipCryptoTransform(plain, createZipCryptoKeys(password), true);
  }

  function decryptZipCrypto(data, password, checkByte) {
    if (data.length < 12) throw errorWithCode("BAD_ARCHIVE", "密码 ZIP 的数据不完整");
    const plain = zipCryptoTransform(data, createZipCryptoKeys(password), false);
    if (plain[11] !== checkByte) {
      throw errorWithCode("PASSWORD_INVALID", "密码不正确，或这个 ZIP 使用了不兼容的加密方式");
    }
    return plain.slice(12);
  }

  function setCancel(setCancelCallback, cancel) {
    if (typeof setCancelCallback === "function") setCancelCallback(cancel);
  }

  function runAsyncFflate(start, setCancelCallback, onDone) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = start((error, data) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
        } else {
          onDone(data, resolve);
        }
      });
      setCancel(setCancelCallback, () => {
        if (settled) return;
        settled = true;
        if (typeof cancel === "function") cancel();
        reject(errorWithCode("CANCELLED", "操作已取消"));
      });
    });
  }

  function runSyncFflate(start, setCancelCallback) {
    let cancelled = false;
    setCancel(setCancelCallback, () => {
      cancelled = true;
    });
    return Promise.resolve().then(() => {
      if (cancelled) throw errorWithCode("CANCELLED", "操作已取消");
      return start();
    });
  }

  function deflateAsync(data, level, setCancelCallback) {
    if (isNodeRuntime && typeof fflate.deflateSync === "function") {
      return runSyncFflate(() => fflate.deflateSync(data, { level }), setCancelCallback);
    }
    return runAsyncFflate(
      (callback) => fflate.deflate(data, { level }, callback),
      setCancelCallback,
      (result, resolve) => resolve(result),
    );
  }

  function inflateAsync(data, setCancelCallback) {
    if (isNodeRuntime && typeof fflate.inflateSync === "function") {
      return runSyncFflate(() => fflate.inflateSync(data), setCancelCallback);
    }
    return runAsyncFflate(
      (callback) => fflate.inflate(data, callback),
      setCancelCallback,
      (result, resolve) => resolve(result),
    );
  }

  function gzipAsync(data, filename, level, setCancelCallback) {
    if (isNodeRuntime && typeof fflate.gzipSync === "function") {
      return runSyncFflate(() => fflate.gzipSync(data, { level, filename, mtime: 0 }), setCancelCallback);
    }
    return runAsyncFflate(
      (callback) => fflate.gzip(data, { level, filename, mtime: 0 }, callback),
      setCancelCallback,
      (result, resolve) => resolve(result),
    );
  }

  function zipAsync(entries, level, setCancelCallback) {
    const archive = Object.create(null);
    entries.forEach((entry) => {
      archive[normalizePath(entry.name)] = [entry.data, { level }];
    });
    return runAsyncFflate(
      (callback) => fflate.zip(archive, { level, mtime: new Date("1980-01-01T00:00:00Z") }, callback),
      setCancelCallback,
      (result, resolve) => resolve(result),
    );
  }

  function writeField(bytes, offset, length, value) {
    const encoded = typeof value === "string" ? encodeName(value) : value;
    bytes.set(encoded.slice(0, length), offset);
  }

  function writeOctal(bytes, offset, length, value) {
    const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0").slice(-(length - 1));
    writeField(bytes, offset, length, text);
  }

  function splitTarName(name) {
    const cleanName = normalizePath(name);
    const nameBytes = encodeName(cleanName);
    if (nameBytes.length <= 100) return { name: cleanName, prefix: "" };
    const slash = cleanName.lastIndexOf("/");
    if (slash > 0 && encodeName(cleanName.slice(slash + 1)).length <= 100 && encodeName(cleanName.slice(0, slash)).length <= 155) {
      return { name: cleanName.slice(slash + 1), prefix: cleanName.slice(0, slash) };
    }
    return { name: new TextDecoder().decode(nameBytes.slice(-100)), prefix: "" };
  }

  function createTar(entries) {
    const blocks = [];
    entries.forEach((entry) => {
      const parts = splitTarName(entry.name);
      const header = new Uint8Array(512);
      writeField(header, 0, 100, parts.name);
      writeOctal(header, 100, 8, 0o644);
      writeOctal(header, 108, 8, 0);
      writeOctal(header, 116, 8, 0);
      writeOctal(header, 124, 12, entry.data.length);
      writeOctal(header, 136, 12, 0);
      header[156] = 0x30;
      writeField(header, 257, 6, "ustar\0");
      writeField(header, 263, 2, "00");
      writeField(header, 265, 32, "light-pressure");
      writeField(header, 297, 32, "light-pressure");
      writeField(header, 345, 155, parts.prefix);
      header.fill(0x20, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      writeOctal(header, 148, 8, checksum);
      blocks.push(header, entry.data);
      const padding = (512 - (entry.data.length % 512)) % 512;
      if (padding) blocks.push(new Uint8Array(padding));
    });
    blocks.push(new Uint8Array(1024));
    return concatBytes(blocks);
  }

  function parseOctal(bytes) {
    const text = new TextDecoder().decode(bytes).replace(/[\0\s]/g, "");
    return text ? Number.parseInt(text, 8) || 0 : 0;
  }

  function isZeroBlock(bytes, offset) {
    for (let index = 0; index < 512; index += 1) {
      if (bytes[offset + index] !== 0) return false;
    }
    return true;
  }

  function tarHeaderChecksum(bytes, offset) {
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : bytes[offset + index];
    }
    return sum;
  }

  function isTar(bytes) {
    if (bytes.length < 512) return false;
    if (new TextDecoder().decode(bytes.slice(257, 262)) === "ustar") return true;
    const checksum = parseOctal(bytes.slice(148, 156));
    return checksum > 0 && checksum === tarHeaderChecksum(bytes, 0);
  }

  function parsePaxAttributes(bytes) {
    const attributes = {};
    let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(0x20, offset);
      if (space < 0) break;
      const length = Number.parseInt(new TextDecoder().decode(bytes.slice(offset, space)), 10);
      if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > bytes.length) break;
      const record = new TextDecoder().decode(bytes.slice(space + 1, offset + length)).replace(/\n$/, "");
      const equals = record.indexOf("=");
      if (equals > 0) attributes[record.slice(0, equals)] = record.slice(equals + 1);
      offset += length;
    }
    return attributes;
  }

  function parseTar(bytes) {
    if (!isTar(bytes)) throw errorWithCode("BAD_ARCHIVE", "不是有效的 TAR 文件");
    const entries = [];
    let globalPax = {};
    let nextPax = {};
    let nextLongName = "";
    let offset = 0;
    while (offset + 512 <= bytes.length && !isZeroBlock(bytes, offset)) {
      const headerName = trimNulls(bytes.slice(offset, offset + 100));
      const prefix = trimNulls(bytes.slice(offset + 345, offset + 500));
      const headerPath = prefix ? `${prefix}/${headerName}` : headerName;
      const headerSize = parseOctal(bytes.slice(offset + 124, offset + 136));
      const type = bytes[offset + 156];
      const dataOffset = offset + 512;
      const paddedSize = Math.ceil(headerSize / 512) * 512;
      if (dataOffset + paddedSize > bytes.length) throw errorWithCode("BAD_ARCHIVE", "TAR 文件内容不完整");
      const data = bytes.slice(dataOffset, dataOffset + headerSize);
      if (type === 0x67) {
        globalPax = { ...globalPax, ...parsePaxAttributes(data) };
      } else if (type === 0x78) {
        nextPax = parsePaxAttributes(data);
      } else if (type === 0x4c) {
        nextLongName = trimNulls(data);
      } else if (type === 0x4b) {
        // GNU long-link metadata is not needed for extracting regular files.
      } else {
        const attributes = { ...globalPax, ...nextPax };
        const fullName = attributes.path || nextLongName || headerPath;
        const size = Object.prototype.hasOwnProperty.call(attributes, "size") ? Number(attributes.size) : headerSize;
        if (!Number.isSafeInteger(size) || size < 0) throw errorWithCode("UNSUPPORTED_ARCHIVE", "TAR 文件过大，当前浏览器无法安全处理");
        const directory = type === 0x35 || fullName.endsWith("/");
        const regular = type === 0 || type === 0x30 || directory;
        if (dataOffset + size > bytes.length) throw errorWithCode("BAD_ARCHIVE", "TAR 文件内容不完整");
        if (regular) entries.push({ name: normalizePath(fullName), size, dataOffset, directory, kind: "tar" });
        nextPax = {};
        nextLongName = "";
      }
      offset = dataOffset + paddedSize;
    }
    const names = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.name));
    return entries.filter((entry) => {
      const separator = entry.name.lastIndexOf("/");
      const baseName = entry.name.slice(separator + 1);
      if (!baseName.startsWith("._")) return true;
      const sibling = `${separator >= 0 ? entry.name.slice(0, separator + 1) : ""}${baseName.slice(2)}`;
      return !names.has(sibling);
    });
  }

  function parseGzipFilename(bytes) {
    if (bytes.length < 10 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return "";
    const flags = bytes[3];
    let offset = 10;
    if (flags & 4) {
      if (offset + 2 > bytes.length) return "";
      offset += 2 + readU16(bytes, offset);
    }
    if (flags & 8) {
      const start = offset;
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1;
      return new TextDecoder().decode(bytes.slice(start, offset));
    }
    return "";
  }

  function hasExtraField(extra, wantedId) {
    let offset = 0;
    while (offset + 4 <= extra.length) {
      const id = readU16(extra, offset);
      const length = readU16(extra, offset + 2);
      if (id === wantedId) return true;
      offset += 4 + length;
    }
    return false;
  }

  function findEndOfCentralDirectory(bytes) {
    const start = Math.max(0, bytes.length - 22 - 0xffff);
    for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
      if (readU32(bytes, offset) === ZIP_END_SIGNATURE) return offset;
    }
    throw errorWithCode("BAD_ARCHIVE", "找不到 ZIP 目录");
  }

  function parseZip(bytes) {
    const endOffset = findEndOfCentralDirectory(bytes);
    const disk = readU16(bytes, endOffset + 4);
    const centralDisk = readU16(bytes, endOffset + 6);
    const total = readU16(bytes, endOffset + 10);
    const centralSize = readU32(bytes, endOffset + 12);
    const centralOffset = readU32(bytes, endOffset + 16);
    if (disk !== 0 || centralDisk !== 0) throw errorWithCode("UNSUPPORTED_ARCHIVE", "暂不支持分卷 ZIP");
    if (total === 0xffff || centralSize === ZIP64_LIMIT || centralOffset === ZIP64_LIMIT) {
      throw errorWithCode("UNSUPPORTED_ARCHIVE", "暂不支持 ZIP64 压缩包");
    }
    const entries = [];
    let offset = centralOffset;
    for (let index = 0; index < total; index += 1) {
      if (readU32(bytes, offset) !== ZIP_CENTRAL_SIGNATURE) throw errorWithCode("BAD_ARCHIVE", "ZIP 目录损坏");
      const flags = readU16(bytes, offset + 8);
      const method = readU16(bytes, offset + 10);
      const modTime = readU16(bytes, offset + 12);
      const crc = readU32(bytes, offset + 16);
      const compressedSize = readU32(bytes, offset + 20);
      const uncompressedSize = readU32(bytes, offset + 24);
      const nameLength = readU16(bytes, offset + 28);
      const extraLength = readU16(bytes, offset + 30);
      const commentLength = readU16(bytes, offset + 32);
      const localOffset = readU32(bytes, offset + 42);
      const nameStart = offset + 46;
      const nameBytes = bytes.slice(nameStart, nameStart + nameLength);
      const extra = bytes.slice(nameStart + nameLength, nameStart + nameLength + extraLength);
      const encrypted = Boolean(flags & 1);
      const aes = method === 99 || hasExtraField(extra, 0x9901);
      entries.push({
        name: normalizePath(decodeName(nameBytes, Boolean(flags & 0x800))),
        originalName: decodeName(nameBytes, Boolean(flags & 0x800)),
        flags,
        method,
        modTime,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        localOffset,
        encrypted,
        encryption: aes ? "aes" : encrypted ? "zipcrypto" : "none",
        directory: decodeName(nameBytes, Boolean(flags & 0x800)).endsWith("/"),
        kind: "zip",
      });
      offset = nameStart + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function extractZipEntry(bytes, entry, password, setCancelCallback) {
    if (entry.directory) return new Uint8Array();
    if (entry.encryption === "aes") {
      throw errorWithCode("UNSUPPORTED_ENCRYPTION", "这个 ZIP 使用 AES 加密，当前离线版暂不支持");
    }
    if (entry.encryption === "zipcrypto" && !password) {
      throw errorWithCode("PASSWORD_REQUIRED", "请输入 ZIP 密码");
    }
    const localOffset = entry.localOffset;
    if (readU32(bytes, localOffset) !== ZIP_LOCAL_SIGNATURE) throw errorWithCode("BAD_ARCHIVE", "ZIP 文件头损坏");
    const nameLength = readU16(bytes, localOffset + 26);
    const extraLength = readU16(bytes, localOffset + 28);
    const dataOffset = localOffset + 30 + nameLength + extraLength;
    const compressed = bytes.slice(dataOffset, dataOffset + entry.compressedSize);
    let data = compressed;
    if (entry.encryption === "zipcrypto") {
      const checkByte = entry.flags & 8 ? (entry.modTime >>> 8) & 0xff : (entry.crc32 >>> 24) & 0xff;
      data = decryptZipCrypto(compressed, password, checkByte);
    }
    let output;
    if (entry.method === 0) {
      output = data;
    } else if (entry.method === 8) {
      output = await inflateAsync(data, setCancelCallback);
    } else if (entry.method === 99) {
      throw errorWithCode("UNSUPPORTED_ENCRYPTION", "这个 ZIP 使用 AES 加密，当前离线版暂不支持");
    } else {
      throw errorWithCode("UNSUPPORTED_COMPRESSION", `暂不支持 ZIP 压缩方法 ${entry.method}`);
    }
    if (entry.uncompressedSize !== ZIP64_LIMIT && output.length !== entry.uncompressedSize) {
      throw errorWithCode("BAD_ARCHIVE", `文件 ${entry.name} 的大小校验失败`);
    }
    if (crc32(output) !== entry.crc32) throw errorWithCode("BAD_ARCHIVE", `文件 ${entry.name} 的校验失败`);
    return output;
  }

  async function createPasswordZip(entries, password, level, setCancelCallback, onProgress) {
    if (!password) throw errorWithCode("PASSWORD_REQUIRED", "请输入压缩密码");
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const name = normalizePath(entry.name);
      const nameBytes = encodeName(name);
      const raw = entry.data;
      const crc = crc32(raw);
      const method = level === 0 ? 0 : 8;
      const compressed = method === 0 ? raw : await deflateAsync(raw, level, setCancelCallback);
      const encrypted = encryptZipCrypto(compressed, password, (crc >>> 24) & 0xff);
      const flags = 0x0801;
      const local = new Uint8Array(30 + nameBytes.length + encrypted.length);
      writeU32(local, 0, ZIP_LOCAL_SIGNATURE);
      writeU16(local, 4, 20);
      writeU16(local, 6, flags);
      writeU16(local, 8, method);
      writeU16(local, 10, 0);
      writeU16(local, 12, 33);
      writeU32(local, 14, crc);
      writeU32(local, 18, encrypted.length);
      writeU32(local, 22, raw.length);
      writeU16(local, 26, nameBytes.length);
      writeU16(local, 28, 0);
      local.set(nameBytes, 30);
      local.set(encrypted, 30 + nameBytes.length);
      localParts.push(local);

      const central = new Uint8Array(46 + nameBytes.length);
      writeU32(central, 0, ZIP_CENTRAL_SIGNATURE);
      writeU16(central, 4, 20);
      writeU16(central, 6, 20);
      writeU16(central, 8, flags);
      writeU16(central, 10, method);
      writeU16(central, 12, 0);
      writeU16(central, 14, 33);
      writeU32(central, 16, crc);
      writeU32(central, 20, encrypted.length);
      writeU32(central, 24, raw.length);
      writeU16(central, 28, nameBytes.length);
      writeU16(central, 30, 0);
      writeU16(central, 32, 0);
      writeU16(central, 34, 0);
      writeU16(central, 36, 0);
      writeU32(central, 38, 0);
      writeU32(central, 42, offset);
      central.set(nameBytes, 46);
      centralParts.push(central);
      offset += local.length;
      if (typeof onProgress === "function") onProgress(((index + 1) / entries.length) * 90);
    }
    const centralBytes = concatBytes(centralParts);
    const end = new Uint8Array(22);
    writeU32(end, 0, ZIP_END_SIGNATURE);
    writeU16(end, 8, entries.length);
    writeU16(end, 10, entries.length);
    writeU32(end, 12, centralBytes.length);
    writeU32(end, 16, offset);
    if (typeof onProgress === "function") onProgress(100);
    return concatBytes([...localParts, centralBytes, end]);
  }

  function detectFormat(bytes, filename = "") {
    const lower = filename.toLowerCase();
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
    if (isTar(bytes) || lower.endsWith(".tar")) return "tar";
    if (bytes.length >= 6 && bytes.slice(0, 6).every((byte, index) => byte === [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c][index])) return "7z";
    const rarMagic = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];
    if (bytes.length >= rarMagic.length && rarMagic.every((byte, index) => bytes[index] === byte)) return "rar";
    if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".gz")) return "gzip";
    if (lower.endsWith(".zip")) return "zip";
    return "unknown";
  }

  return {
    crc32,
    createTar,
    createPasswordZip,
    createZip: zipAsync,
    createGzip: gzipAsync,
    detectFormat,
    extractZipEntry,
    gunzip: (bytes, setCancelCallback) => {
      if (isNodeRuntime && typeof fflate.gunzipSync === "function") {
        return runSyncFflate(() => fflate.gunzipSync(bytes), setCancelCallback);
      }
      return runAsyncFflate(
        (callback) => fflate.gunzip(bytes, callback),
        setCancelCallback,
        (result, resolve) => resolve(result),
      );
    },
    isTar,
    normalizePath,
    parseGzipFilename,
    parseTar,
    parseZip,
  };
});
