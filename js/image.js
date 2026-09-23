// Resizes and re-encodes a photo in the browser before upload, so a 5 MB
// phone photo becomes a ~150 KB JPEG plus a small thumbnail.
import { PHOTO_FULL, PHOTO_THUMB } from './constants.js';

async function decode(file) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file (JPEG, PNG, or WebP).');
  }
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to the <img> path, which handles a few more formats.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error(
      "That photo couldn't be read. Try a JPEG or PNG — iPhone HEIC photos may need to be exported as JPEG first."
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function render(source, { maxSize, quality }) {
  const w0 = source.width;
  const h0 = source.height;
  const scale = Math.min(1, maxSize / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * scale));
  const height = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // flatten transparent PNGs onto white
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't process that photo."))),
      'image/jpeg',
      quality
    );
  });
}

export async function preparePhoto(file) {
  const source = await decode(file);
  try {
    const [full, thumb] = await Promise.all([render(source, PHOTO_FULL), render(source, PHOTO_THUMB)]);
    return { full, thumb };
  } finally {
    source.close?.();
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
