/* cloudinary.js — X Club Image Upload
   Compresses aggressively with context-aware presets before uploading. */
'use strict';

const CLOUDINARY = {
  cloudName:    'dbgxllxdb',
  uploadPreset: 'efootball_screenshots',
};

/* Compression presets per upload context */
const COMPRESS_PRESETS = {
  x_profiles:  { maxW: 400,  maxH: 400,  quality: 0.72, maxKB: 150 },
  x_banners:   { maxW: 1000, maxH: 400,  quality: 0.70, maxKB: 300 },
  x_posts:     { maxW: 900,  maxH: 900,  quality: 0.70, maxKB: 400 },
  dm_images:   { maxW: 600,  maxH: 600,  quality: 0.65, maxKB: 200 },
  x_kyc:       { maxW: 1200, maxH: 1200, quality: 0.75, maxKB: 600 },
  default:     { maxW: 800,  maxH: 800,  quality: 0.68, maxKB: 350 },
};

async function xUploadImage(file, folder = 'x_uploads', onProgress = () => {}) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Not an image file.');
  const preset = COMPRESS_PRESETS[folder] || COMPRESS_PRESETS.default;
  onProgress(5);
  const compressed = await compressImage(file, preset);
  onProgress(40);
  const fd = new FormData();
  fd.append('file',          compressed);
  fd.append('upload_preset', CLOUDINARY.uploadPreset);
  fd.append('folder',        folder);
  fd.append('tags',          'xclub');
  onProgress(50);
  const res = await uploadWithProgress(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/image/upload`,
    fd,
    pct => onProgress(50 + Math.round(pct * 0.5))
  );
  onProgress(100);
  return { url: res.secure_url, publicId: res.public_id, width: res.width, height: res.height, bytes: res.bytes, format: res.format };
}

async function compressImage(file, preset) {
  const { maxW, maxH, maxKB } = preset;
  const maxBytes = maxKB * 1024;
  // Try progressively lower quality until under maxKB (min quality 0.20)
  const qualities = [preset.quality, 0.60, 0.50, 0.40, 0.30, 0.20];
  // Also try at half dimensions if quality alone isn't enough
  const dimensionScales = [1.0, 0.75, 0.5];

  for (const scale of dimensionScales) {
    const scaledMaxW = Math.round(maxW * scale);
    const scaledMaxH = Math.round(maxH * scale);
    for (const quality of qualities) {
      const result = await _compressOnce(file, scaledMaxW, scaledMaxH, quality);
      if (result.size <= maxBytes) return result;
    }
  }
  // Last resort: smallest scale + lowest quality — upload whatever we have
  return await _compressOnce(file, Math.round(maxW * 0.4), Math.round(maxH * 0.4), 0.20);
}

async function _compressOnce(file, maxW, maxH, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const tryWebP = () => {
        canvas.toBlob(blob => {
          if (blob && blob.size > 0) {
            resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' }));
          } else { tryJPEG(); }
        }, 'image/webp', quality);
      };
      const tryJPEG = () => {
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error('Compression failed')); return; }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      };
      tryWebP();
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Could not load image')); };
    img.src = objectUrl;
  });
}

/* Raw (non-image) file upload — DM file-sharing. Unlike xUploadImage, no
   compression step (these aren't images), and posts to Cloudinary's
   /raw/upload endpoint rather than /image/upload — resource_type on
   Cloudinary is determined by which endpoint you POST to, not a form
   field. use_filename + unique_filename keep the original name/extension
   (raw files need the extension in their public_id for correct
   delivery/content-type) while avoiding collisions between uploads.
   ─────────────────────────────────────────────────────────────────────
   Free-plan caveat: Cloudinary blocks public delivery of PDF and ZIP
   files by default for security reasons, even though the upload itself
   succeeds — see Cloudinary dashboard → Settings → Security → "Allow
   delivery of PDF and ZIP files". Without that enabled, a PDF/ZIP sent
   here uploads fine but the recipient's download link 401s. Other raw
   types (DOCX, TXT, etc.) aren't affected by this restriction. */
async function xUploadFile(file, folder = 'dm_files', onProgress = () => {}) {
  if (!file) throw new Error('No file provided.');
  const fd = new FormData();
  fd.append('file',          file);
  fd.append('upload_preset', CLOUDINARY.uploadPreset);
  fd.append('folder',        folder);
  fd.append('tags',          'xclub_file');
  // NOT sending use_filename/unique_filename — this preset's unsigned-
  // upload allowlist rejects them outright ("Use filename parameter is
  // not allowed when using unsigned upload"). Not a problem: Cloudinary
  // will just generate a random public_id instead of one based on the
  // original filename, which is fine here — the app already stores the
  // real filename separately in the message doc (msg.fileName) for
  // display, so nothing downstream actually depends on Cloudinary's own
  // generated ID matching it.
  onProgress(5);
  const res = await uploadWithProgress(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/raw/upload`,
    fd,
    pct => onProgress(5 + Math.round(pct * 0.95))
  );
  onProgress(100);
  return { url: res.secure_url, publicId: res.public_id, bytes: res.bytes, format: res.format };
}

function uploadWithProgress(url, formData, onPct) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.addEventListener('progress', e => { if (e.lengthComputable) onPct(e.loaded / e.total); });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('Invalid response from Cloudinary')); }
        return;
      }
      // Cloudinary's error responses are JSON with a specific reason at
      // error.message (e.g. "Upload preset must be whitelisted for
      // unsigned uploads" or "Invalid resource_type") — parse it out
      // instead of just reporting the bare status code, since the
      // specific reason is exactly what's needed to fix a misconfigured
      // preset, and guessing blind from "400" alone isn't enough.
      let detail = '';
      try { detail = JSON.parse(xhr.responseText)?.error?.message || ''; } catch {}
      reject(new Error(`Cloudinary ${xhr.status}${detail ? ' — ' + detail : ' — upload failed'}`));
    });
    xhr.addEventListener('error',  () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort',  () => reject(new Error('Upload was cancelled')));
    xhr.send(formData);
  });
}

function xThumb(url, w = 200, h = 200) {
  if (!url || !url.includes('cloudinary.com')) return url;
  return url.replace('/upload/', `/upload/c_fill,w_${w},h_${h},q_auto,f_auto/`);
}

async function xDeleteImage(publicId) {
  console.warn('[XCloud] Client-side delete requires a signed API call.', publicId);
}

window.XCloud = { upload: xUploadImage, uploadFile: xUploadFile, deleteImage: xDeleteImage, thumb: xThumb };
