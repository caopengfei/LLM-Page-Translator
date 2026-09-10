(function (global) {
  'use strict';
  const EXT_CONSTANTS = {
    MSG: {
      TOGGLE: 'TOGGLE',
      TRANSLATE_BATCH: 'TRANSLATE_BATCH',
      DETECT_LANGUAGE: 'DETECT_LANGUAGE',
      TEST_CONNECTION: 'TEST_CONNECTION'
    },
    DEFAULT_CONFIG: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      targetLang: 'zh-CN'
    },
    BATCH_MAX_ITEMS: 50,
    BATCH_MAX_CHARS: 2000,
    DEBOUNCE_MS: 500,
    STORAGE_KEYS: { CONFIG: 'config', CACHE_PREFIX: 'tc:' }
  };
  global.EXT_CONSTANTS = EXT_CONSTANTS;
  if (typeof module !== 'undefined' && module.exports) module.exports = EXT_CONSTANTS;
})(typeof globalThis !== 'undefined' ? globalThis : self);
