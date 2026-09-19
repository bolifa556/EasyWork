const IMAGE_EXTENSIONS = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml", avif: "image/avif", heic: "image/heic", ico: "image/x-icon" };

export function imageMimeType(name = "", mime = "") {
  const declared = String(mime).split(";", 1)[0].trim().toLowerCase();
  return declared.startsWith("image/") ? declared : IMAGE_EXTENSIONS[String(name).split(".").at(-1)?.toLowerCase()] || "";
}

export function isImageFile(file) {
  return Boolean(imageMimeType(file?.name || file?.filename, file?.type || file?.mime));
}
