import client from './client';

/**
 * Upload an XLSX file. Reports progress via onProgress(pct 0–100).
 * Returns the final { recordsImported, uploadedAt } object.
 */
export const uploadFile = (file, onProgress) => {
  const formData = new FormData();
  formData.append('file', file);
  return client
    .post('/upload/customer-balance', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e) => {
        if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100));
      },
    })
    .then((r) => r.data);
};

export const getUploadHistory = (_limit = 10) =>
  client.get('/upload/batches').then((r) => r.data);
