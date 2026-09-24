import React, { createContext, useContext, useState } from 'react';
import { SHELL_STRINGS } from '../data/shellStrings';

const LanguageContext = createContext(null);

// Arabic is the default for every user — the shell only switches to
// English when a user explicitly picks it, and that choice is
// per-browser (localStorage), not a server-side account setting.
export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => localStorage.getItem('app_lang') || 'ar');

  const setLang = (l) => {
    localStorage.setItem('app_lang', l);
    setLangState(l);
  };

  const t = (key, ...args) => {
    const dict = SHELL_STRINGS[lang] || SHELL_STRINGS.ar;
    const val = dict[key] ?? SHELL_STRINGS.ar[key] ?? key;
    return typeof val === 'function' ? val(...args) : val;
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
