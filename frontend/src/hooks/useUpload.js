import { useState } from 'react';
import axios from 'axios';

export function useUpload() {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const uploadFile = async (file, endpoint) => {
    setUploading(true);
    setProgress(0);
    setResult(null);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const { data } = await axios.post(endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          if (e.total) setProgress(Math.round((e.loaded / e.total) * 100));
        },
      });
      setResult(data);
      return data;
    } catch (err) {
      const msg = err.response?.data?.error || 'فشل الرفع';
      setError(msg);
      return null;
    } finally {
      setUploading(false);
    }
  };

  return { uploading, progress, result, error, uploadFile };
}
