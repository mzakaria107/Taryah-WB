import React, { useRef, useState, useEffect } from 'react';
import axios from 'axios';
import { useUpload } from '../hooks/useUpload';

function UploadRow({ label, endpoint, accept = '.xlsx,.xls', onSuccess }) {
  const fileRef = useRef();
  const { uploading, progress, result, error, uploadFile } = useUpload();
  const [batches, setBatches] = useState([]);
  const [selectedFileName, setSelectedFileName] = useState('');

  const fetchBatches = () => {
    axios.get('/api/upload/batches')
      .then(({ data }) => setBatches(data.slice(0, 3)))
      .catch(() => {});
  };

  useEffect(() => { fetchBatches(); }, []);

  useEffect(() => {
    if (result?.success) {
      fetchBatches();
      if (onSuccess) onSuccess();
    }
  }, [result]);

  const handleFileChange = (e) => {
    setSelectedFileName(e.target.files[0]?.name || '');
  };

  const handleUpload = async () => {
    const file = fileRef.current?.files[0];
    if (!file) return;
    await uploadFile(file, endpoint);
    if (fileRef.current) fileRef.current.value = '';
    setSelectedFileName('');
  };

  // Estimate: 187k rows ≈ 30–60s upload + parse time
  const isLargeFile = selectedFileName?.toLowerCase().includes('balance');

  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-gray-50">
      <h3 className="font-semibold text-gray-700 mb-3 text-sm">{label}</h3>

      {/* File picker */}
      <div className="flex gap-2 items-center flex-wrap">
        <label className="cursor-pointer flex-1">
          <div className={`flex items-center gap-2 border-2 border-dashed rounded-lg px-3 py-2 text-sm transition-colors ${
            selectedFileName ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-400 hover:border-blue-300'
          }`}>
            <span className="text-lg">📎</span>
            <span className="truncate">{selectedFileName || 'اختر ملف Excel...'}</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            onChange={handleFileChange}
            className="hidden"
          />
        </label>

        <button
          onClick={handleUpload}
          disabled={uploading || !selectedFileName}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {uploading ? `جاري الرفع ${progress}%` : 'رفع الملف'}
        </button>
      </div>

      {/* Progress bar */}
      {uploading && (
        <div className="mt-2">
          <div className="bg-gray-200 rounded-full h-2 overflow-hidden">
            <div
              className="bg-blue-500 h-full rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1 text-center">
            {isLargeFile
              ? `${progress}% — الملف كبير، قد يستغرق 1-2 دقيقة...`
              : `${progress}%`}
          </p>
        </div>
      )}

      {/* Result */}
      {result && !uploading && (
        <div className="mt-2 bg-green-50 border border-green-200 rounded-lg p-2">
          <p className="text-xs text-green-700 font-semibold">
            ✓ تمت المعالجة: {Number(result.rowsProcessed).toLocaleString()} صف
          </p>
          {result.rowsSkipped > 0 && (
            <p className="text-xs text-amber-600 mt-0.5">
              تخطي: {result.rowsSkipped} صف (بدون رقم فاتورة)
            </p>
          )}
          {result.errors?.length > 0 && (
            <details className="mt-1">
              <summary className="text-xs text-red-500 cursor-pointer">
                {result.errors.length} أخطاء ▾
              </summary>
              <div className="mt-1 max-h-24 overflow-y-auto">
                {result.errors.map((e, i) => (
                  <p key={i} className="text-[10px] text-red-400">صف {e.row}: {e.error}</p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {error && !uploading && (
        <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          ✗ {error}
        </div>
      )}

      {/* Recent upload history */}
      {batches.length > 0 && (
        <div className="mt-3 border-t border-gray-100 pt-2">
          <p className="text-[10px] text-gray-400 mb-1 uppercase tracking-wide">آخر الرفعات</p>
          {batches.map((b) => (
            <div key={b.id} className="flex items-center justify-between text-[11px] text-gray-500 py-0.5">
              <span className="truncate max-w-[160px]">{b.file_name}</span>
              <span className={`font-medium ${b.status === 'success' ? 'text-green-500' : b.status === 'processing' ? 'text-blue-400' : 'text-red-500'}`}>
                {b.status === 'success'
                  ? `✓ ${Number(b.row_count).toLocaleString()}`
                  : b.status === 'processing' ? '⟳' : '✗'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function UploadPanel({ onUploadSuccess }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-bold text-gray-800">رفع ملفات Excel</h2>
        <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">
          يدعم .xlsx حتى 50 MB
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UploadRow
          label="أرصدة العملاء — customerBalanceDues.xlsx"
          endpoint="/api/upload/customer-balance"
          onSuccess={onUploadSuccess}
        />
        <UploadRow
          label="دليل المسارات — RouteMaster.xlsx"
          endpoint="/api/upload/route-master"
          onSuccess={onUploadSuccess}
        />
      </div>
    </div>
  );
}
