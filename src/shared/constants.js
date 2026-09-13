(function (global) {
  'use strict';

  // 常量对象先声明:下面的 pickTargetLang/defaultTargetLang 会引用它。
  // 早先把它放在函数之后,依赖"这两个函数只在初始化完成后才被调用"才侥幸可用,
  // 任何加载期调用都会踩 TDZ 报错;这里把声明提到前面彻底消除隐患。
  const EXT_CONSTANTS = {
    MSG: {
      TOGGLE: 'TOGGLE',
      TOGGLE_TAB: 'TOGGLE_TAB',
      GET_STATE: 'GET_STATE',
      TRANSLATE_BATCH: 'TRANSLATE_BATCH',
      DETECT_LANGUAGE: 'DETECT_LANGUAGE',
      TEST_CONNECTION: 'TEST_CONNECTION',
      // background 按批推送译文给 content:每批完成即发,不等全部批次返回
      RESULT_BATCH: 'RESULT_BATCH'
    },
    // 页面翻译状态。取代早先的 active 布尔值:同语言跳过必须与"已翻译"区分开,
    // 否则再次点击会走进还原分支并提示"已还原 0 处"
    STATE: {
      IDLE: 'idle',
      TRANSLATED: 'translated',
      SKIPPED_SAME_LANGUAGE: 'skipped-same-language'
    },
    DEFAULT_CONFIG: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      // 最后兜底值。首次使用按浏览器 UI 语言推导(defaultTargetLang),
      // 推导不出来时用 en,而不是写死 zh-CN——否则非中文用户会把整页翻成看不懂的中文
      targetLang: 'en',
      // 单次请求超时。翻译负载远大于 Test connection 的探测请求,
      // 30s 对真实批次偏短(自建/慢模型常见),默认放宽到 120s 并允许设置页调整
      timeoutMs: 120000,
      // 失败后额外重发的次数(不含首次请求)。仅对可重试错误生效(5xx/429);
      // 0 表示不重试。默认 3 次:瞬时限流下多给一次机会,又不至于把用户拖太久
      retries: 3
    },
    // 重试次数上下限:退避单次封顶 10s,再多的重试只会把 MV3 存活窗口拖长,
    // 且对限流接口越打越死。0 是合法值(明确表示不重试)
    RETRY_MIN: 0,
    RETRY_MAX: 5,
    // 目标语言清单:popup 与 options 页共用同一份,保证两处可选项一致。
    // label 一律用该语言的母语自称(English / 日本語 / Deutsch…),语言选择器不随界面语言翻译
    LANGUAGES: [
      { code: 'zh-CN', label: '简体中文' },
      { code: 'zh-TW', label: '繁體中文' },
      { code: 'en', label: 'English' },
      { code: 'ja', label: '日本語' },
      { code: 'ko', label: '한국어' },
      { code: 'de', label: 'Deutsch' },
      { code: 'fr', label: 'Français' },
      { code: 'es', label: 'Español' },
      { code: 'ru', label: 'Русский' },
      { code: 'pt', label: 'Português' },
      { code: 'it', label: 'Italiano' },
      { code: 'ar', label: 'العربية' },
      { code: 'hi', label: 'हिन्दी' },
      { code: 'vi', label: 'Tiếng Việt' },
      { code: 'th', label: 'ไทย' },
      { code: 'nl', label: 'Nederlands' },
      { code: 'pl', label: 'Polski' },
      { code: 'tr', label: 'Türkçe' }
    ],
    // 批次上限:调小让单次请求更快返回(慢接口下单批耗时随文本量线性增长)
    BATCH_MAX_ITEMS: 8,
    BATCH_MAX_CHARS: 400,
    // 并发批次数:串行等待是"翻译很久"的主因,并发后总时长约为 1/N
    BATCH_CONCURRENCY: 3,
    DEBOUNCE_MS: 500,
    // 缓存容量水位：按运行时配额推导，不写死字节数——旧版 Chrome 的 local 配额只有 5MB，
    // 写死 8MB 会让触发水位高于配额，淘汰永不发生、set() 照旧失败
    CACHE_MAX_RATIO: 0.9,          // 高水位 = 配额 × 0.9（超过才触发淘汰）
    CACHE_EVICT_RATIO: 0.8,        // 低水位 = 高水位 × 0.8（一次淘汰到此为止，留出滞后区间）
    CACHE_FALLBACK_QUOTA_BYTES: 5 * 1024 * 1024, // QUOTA_BYTES 读不到时按最小常见配额保守兜底
    STORAGE_KEYS: { CONFIG: 'config', CACHE_PREFIX: 'tc:' },
    uiLanguage,
    pickTargetLang,
    defaultTargetLang,
    normalizeRetries
  };

  // 浏览器 UI 语言(如 'zh-CN'、'en-US')。非扩展环境/无该 API 时返回空串,
  // 让调用方走兜底分支,测试里因此保持确定性
  function uiLanguage() {
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.i18n &&
        typeof chrome.i18n.getUILanguage === 'function') {
        return chrome.i18n.getUILanguage() || '';
      }
    } catch (e) { /* 读取失败按未知语言处理 */ }
    return '';
  }

  // 把浏览器 UI 语言映射到受支持的目标语言:先精确匹配,再按主语言子标签匹配。
  // 中文需要区分简繁(zh-Hant/zh-TW/zh-HK → zh-TW),其余语言直接取主标签(es-419 → es)。
  function pickTargetLang(rawUiLang, fallback) {
    const raw = String(rawUiLang || '').replace(/_/g, '-').toLowerCase();
    if (!raw) return fallback;
    const codes = EXT_CONSTANTS.LANGUAGES.map((l) => l.code);
    const exact = codes.find((c) => c.toLowerCase() === raw);
    if (exact) return exact;
    const primary = raw.split('-')[0];
    if (primary === 'zh') return /hant|tw|hk|mo/.test(raw) ? 'zh-TW' : 'zh-CN';
    return codes.find((c) => c.toLowerCase() === primary) || fallback;
  }

  // 首次使用(用户尚未选择过目标语言)时的默认值
  function defaultTargetLang() {
    return pickTargetLang(uiLanguage(), EXT_CONSTANTS.DEFAULT_CONFIG.targetLang);
  }

  // 把任意来源(旧版本配置、手工改写的 storage、表单输入)的重试次数夹到合法区间。
  // 缺失/非数字一律回落到默认值;越界值夹紧而不是报错,避免一个坏值让翻译整体不可用
  function normalizeRetries(value) {
    if (value === undefined || value === null || value === '') return EXT_CONSTANTS.DEFAULT_CONFIG.retries;
    const n = Number(value);
    if (!Number.isFinite(n)) return EXT_CONSTANTS.DEFAULT_CONFIG.retries;
    const clamped = Math.min(EXT_CONSTANTS.RETRY_MAX, Math.max(EXT_CONSTANTS.RETRY_MIN, Math.floor(n)));
    return clamped;
  }

  global.EXT_CONSTANTS = EXT_CONSTANTS;
  if (typeof module !== 'undefined' && module.exports) module.exports = EXT_CONSTANTS;
})(typeof globalThis !== 'undefined' ? globalThis : self);
