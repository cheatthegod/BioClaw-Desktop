/**
 * Minimal i18n for the desktop UI (goal M4.2).
 *
 * A flat key → string dictionary per locale (zh-CN default, en), a zustand
 * store holding the active locale (initialised from the persisted choice or
 * the system locale), and a `useT()` hook returning a bound `t(key)`.
 *
 * New panels (GPU, 工作台, offline banner, settings toggle) go through `t()`.
 * Legacy components carry inline zh strings and migrate incrementally — `t()`
 * falls back to the zh dictionary then the key itself, so nothing breaks.
 */
import { create } from 'zustand';

export type Locale = 'zh' | 'en';

const STORAGE_KEY = 'bioclaw.locale';

const dict: Record<Locale, Record<string, string>> = {
  zh: {
    'common.close': '关闭',
    'common.back': '← 返回',
    'common.cancel': '取消',
    'common.run': '运行',
    'common.loading': '加载中…',
    'common.send': '发送',
    'common.search': '搜索',
    'common.noAuth': '未登录，请在设置中重新登录。',
    'nav.gpu': 'GPU 工具',
    'nav.hub': '工作台',
    'gpu.title': 'GPU 工具',
    'gpu.pickTool': '从左侧选择一个 GPU 工具。',
    'gpu.estimate': '约 {min} 分钟 · 约 {gb} GB 显存',
    'gpu.results': '结果文件（{n}）',
    'gpu.noOutputs': '无输出文件。',
    'gpu.gpuAvailable': 'GPU 可用',
    'gpu.gpuUnreachable': 'GPU 主机不可达',
    'gpu.uploading': '上传中…',
    'gpu.uploaded': '已上传：{path}',
    'hub.title': 'BioClaw 工作台',
    'hub.tab.account': '账户',
    'hub.tab.quota': '配额',
    'hub.tab.kb': '知识库',
    'hub.tab.skills': '技能',
    'hub.tab.projects': '项目与数据',
    'hub.tab.papers': '论文摘要',
    'hub.tab.shares': '分享',
    'hub.tab.contacts': '联系人',
    'hub.tab.lab': '实验室',
    'hub.tab.manage': '管理',
    'hub.tab.admin': '管理员',
    'hub.noAdmin': '此账户没有管理员权限。',
    'hub.empty': '暂无内容。',
    'offline.banner':
      '离线 — 云端功能（GPU 工具、工作台）暂不可用。本地聊天、技能与 Python 环境仍可使用。',
    'settings.language': '语言',
  },
  en: {
    'common.close': 'Close',
    'common.back': '← Back',
    'common.cancel': 'Cancel',
    'common.run': 'Run',
    'common.loading': 'Loading…',
    'common.send': 'Send',
    'common.search': 'Search',
    'common.noAuth': 'Not signed in — please sign in again in Settings.',
    'nav.gpu': 'GPU Tools',
    'nav.hub': 'Workspace',
    'gpu.title': 'GPU Tools',
    'gpu.pickTool': 'Pick a GPU tool on the left.',
    'gpu.estimate': '~{min} min · ~{gb} GB VRAM',
    'gpu.results': 'Result files ({n})',
    'gpu.noOutputs': 'No output files.',
    'gpu.gpuAvailable': 'GPU available',
    'gpu.gpuUnreachable': 'GPU host unreachable',
    'gpu.uploading': 'Uploading…',
    'gpu.uploaded': 'Uploaded: {path}',
    'hub.title': 'BioClaw Workspace',
    'hub.tab.account': 'Account',
    'hub.tab.quota': 'Quota',
    'hub.tab.kb': 'Knowledge',
    'hub.tab.skills': 'Skills',
    'hub.tab.projects': 'Projects & Data',
    'hub.tab.papers': 'Paper Digest',
    'hub.tab.shares': 'Shares',
    'hub.tab.contacts': 'Contacts',
    'hub.tab.lab': 'Lab',
    'hub.tab.manage': 'Manage',
    'hub.tab.admin': 'Admin',
    'hub.noAdmin': 'This account has no admin access.',
    'hub.empty': 'Nothing here yet.',
    'offline.banner':
      'Offline — cloud features (GPU Tools, Workspace) are unavailable. Local chat, skills and the Python env still work.',
    'settings.language': 'Language',
  },
};

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* localStorage may be unavailable */
  }
  const sys = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
  return sys.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  locale: detectLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* ignore */
    }
    set({ locale });
  },
}));

/** Translate `key` for `locale`, interpolating `{name}` params. zh → key fallback. */
export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  let s = dict[locale][key] ?? dict.zh[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** Hook returning a `t` bound to the active locale (re-renders on change). */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const locale = useI18nStore((s) => s.locale);
  return (key, params) => translate(locale, key, params);
}
