// 服务端 HEIC -> JPG 转换模块（iPhone HDR 10-bit 照片的兜底转换）
const libheif = require('libheif-js/wasm-bundle');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

let readyPromise = null;
const readCString = (ptr) => { let s = ''; for (let i = ptr; libheif.HEAPU8[i] !== 0; i++) s += String.fromCharCode(libheif.HEAPU8[i]); return s; };
const checkErr = (errPtr, action) => {
  const code = libheif.HEAPU32[errPtr >> 2];
  if (code !== 0) {
    const msgPtr = libheif.HEAPU32[(errPtr + 8) >> 2];
    throw new Error(action + ': ' + (msgPtr ? readCString(msgPtr) : 'code ' + code));
  }
};

async function ensureReady() {
  if (!readyPromise) readyPromise = libheif.ready;
  await readyPromise;
}

// 转换 filePath 指向的 .heic 文件，同目录生成 .jpg，返回新文件名；失败抛异常
async function convertToJpg(filePath) {
  await ensureReady();
  const buf = fs.readFileSync(filePath);
  const mem = libheif._malloc(buf.length);
  libheif.HEAPU8.set(buf, mem);
  const ctx = libheif._heif_context_alloc();
  const err = libheif._malloc(16);
  const out = libheif._malloc(8);
  try {
    libheif._heif_context_read_from_memory(err, ctx, mem, buf.length, 0);
    checkErr(err, '读取HEIC');
    libheif._heif_context_get_primary_image_handle(err, ctx, out);
    checkErr(err, '获取主图');
    const h = libheif.HEAPU32[out >> 2];
    let img = null, rgba = false;
    try {
      libheif._heif_decode_image(err, h, out, 1 /*RGB*/, 11 /*RGBA*/, 0);
      checkErr(err, '解码');
      img = libheif.HEAPU32[out >> 2]; rgba = true;
    } catch (e) {
      libheif._heif_decode_image(err, h, out, 1, 10, 0);
      checkErr(err, '解码RGB');
      img = libheif.HEAPU32[out >> 2];
    }
    const w = libheif._heif_image_get_width(img, 10);
    const h2 = libheif._heif_image_get_height(img, 10);
    const stridePtr = libheif._malloc(4);
    const plane = libheif._heif_image_get_plane_readonly(img, 10, stridePtr);
    const stride = libheif.HEAPU32[stridePtr >> 2];
    const ch = rgba ? 4 : 3;
    const rows = [];
    for (let y = 0; y < h2; y++) rows.push(Buffer.from(libheif.HEAPU8.subarray(plane + y * stride, plane + y * stride + w * ch)));
    libheif._free(stridePtr);
    libheif._heif_image_release(img);
    libheif._heif_image_handle_release(h);
    let pipe = sharp(Buffer.concat(rows), { raw: { width: w, height: h2, channels: ch } });
    if (rgba) pipe = pipe.removeAlpha();
    const newName = path.basename(filePath).replace(/\.heic$/i, '.jpg');
    await pipe.jpeg({ quality: 88 }).toFile(path.join(path.dirname(filePath), newName));
    return newName;
  } finally {
    libheif._heif_context_free(ctx);
    libheif._free(mem); libheif._free(err); libheif._free(out);
  }
}

module.exports = { convertToJpg };
