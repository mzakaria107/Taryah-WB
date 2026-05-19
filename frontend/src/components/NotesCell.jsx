import React, { useState } from 'react';
import { useNotes } from '../hooks/useNotes';

export default function NotesCell({ invoiceId, initialText = '' }) {
  const [text, setText] = useState(initialText);
  const { saving, saveNote } = useNotes();
  const state = saving[invoiceId];

  const handleChange = (e) => {
    setText(e.target.value);
    saveNote(invoiceId, e.target.value);
  };

  return (
    <div className="relative min-w-[160px]">
      <textarea
        value={text}
        onChange={handleChange}
        rows={2}
        placeholder="أضف ملاحظة..."
        className="w-full text-xs rounded border border-gray-200 bg-gray-50 px-2 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-blue-400 focus:bg-white transition-colors"
      />
      {state === 'saving' && (
        <span className="absolute bottom-1 left-1 text-[10px] text-gray-400">جاري الحفظ...</span>
      )}
      {state === 'saved' && (
        <span className="absolute bottom-1 left-1 text-[10px] text-green-500">محفوظ ✓</span>
      )}
      {state === 'error' && (
        <span className="absolute bottom-1 left-1 text-[10px] text-red-500">خطأ!</span>
      )}
    </div>
  );
}
