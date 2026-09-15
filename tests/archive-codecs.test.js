const test = require("node:test");
const assert = require("node:assert/strict");

const codecs = require("../archive-codecs.js");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("creates and extracts a regular ZIP", async () => {
  const entries = [
    { name: "docs/你好.txt", data: encoder.encode("hello from light pressure") },
    { name: "empty.txt", data: new Uint8Array() },
  ];
  const bytes = await codecs.createZip(entries, 6);
  const parsed = codecs.parseZip(bytes);

  assert.deepEqual(parsed.map((entry) => entry.name), ["docs/你好.txt", "empty.txt"]);
  const extracted = await codecs.extractZipEntry(bytes, parsed[0], "");
  assert.equal(decoder.decode(extracted), "hello from light pressure");
});

test("creates and extracts a ZipCrypto archive", async () => {
  const entries = [{ name: "secret.txt", data: encoder.encode("private note") }];
  const bytes = await codecs.createPasswordZip(entries, "secret", 6);
  const parsed = codecs.parseZip(bytes);

  assert.equal(parsed[0].encryption, "zipcrypto");
  assert.equal(decoder.decode(await codecs.extractZipEntry(bytes, parsed[0], "secret")), "private note");
  await assert.rejects(() => codecs.extractZipEntry(bytes, parsed[0], "wrong"), { code: "PASSWORD_INVALID" });
});

test("round-trips TAR.GZ and identifies common archive signatures", async () => {
  const entries = [{ name: "folder/file.txt", data: encoder.encode("tar content") }];
  const tar = codecs.createTar(entries);
  assert.equal(codecs.parseTar(tar)[0].name, "folder/file.txt");

  const gzip = await codecs.createGzip(tar, "archive.tar", 6);
  const restoredTar = await codecs.gunzip(gzip);
  assert.equal(decoder.decode(restoredTar.slice(512, 512 + entries[0].data.length)), "tar content");
  assert.equal(codecs.detectFormat(gzip, "archive.tar.gz"), "gzip");
  assert.equal(codecs.detectFormat(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), "archive.7z"), "7z");
  assert.equal(codecs.detectFormat(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]), "archive.rar"), "rar");
});
