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
    'gpu.localEnvs': '本机已就绪 {n} 个 GPU 环境',
    'gpu.dropHere': '松开以上传文件',
    'gpu.notifyDone': '{tool} 已完成，结果可下载',
    'gpu.notifyFailed': '{tool} 运行失败',
    'gpu.notifyCancelled': '{tool} 已取消',
    'gpu.downloadFailed': '下载失败：{msg}',
    'gpu.uploading': '上传中…',
    'gpu.uploaded': '已上传：{path}',
    'gpu.loadingTools': '加载工具…',
    'gpu.noAuthShort': '未登录',
    'gpu.hostStatus': '主机状态…',
    'gpu.free': '{gb}GB 空闲',
    'gpu.uploadFailed': '上传失败：{msg}',
    'gpu.submitFailed': '提交失败',
    'gpu.noOutputFiles': '无输出文件。',
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
    'hub.loadFailed': '加载失败：{msg}',
    'hub.section.projects': '项目',
    'hub.section.datasets': '数据集',
    'hub.section.papers': '论文摘要',
    'hub.section.shares': '我的分享',
    'hub.share.create': '分享当前对话',
    'hub.share.creating': '创建中…',
    'hub.share.created': '已创建分享链接：{url}',
    'hub.share.createFailed': '创建分享失败',
    'hub.share.revoke': '撤销',
    'hub.section.contacts': '联系人',
    'hub.section.lab': '实验室动态',
    'hub.section.manageOverview': '概览',
    'hub.section.manageStatus': '状态',
    'hub.section.adminOverview': '管理概览',
    'hub.section.users': '用户',
    'hub.account': '账户',
    'hub.noProfile': '暂无资料。',
    'hub.serverConfig': '服务器配置',
    'hub.feedback': '反馈',
    'hub.feedbackPlaceholder': '告诉我们哪里可以做得更好…',
    'hub.feedbackSent': '已发送，谢谢！',
    'hub.quotaTitle': '配额请求',
    'hub.noQuota': '暂无配额请求记录。',
    'hub.quotaReasonPlaceholder': '申请更多额度的理由',
    'hub.requestQuota': '申请额度',
    'hub.submitted': '已提交。',
    'hub.kbTitle': '知识库搜索',
    'hub.kbPlaceholder': '搜索你工作区里的文件 / 笔记…',
    'hub.noHits': '没有命中。',
    'hub.result': '结果',
    'hub.skillsTitle': '技能库（云端）',
    'hub.noCloudSkills': '暂无云端技能。',
    'offline.banner':
      '离线 — 云端功能（GPU 工具、工作台）暂不可用。本地聊天、技能与 Python 环境仍可使用。',
    'app.startupFailed': '启动失败',
    'app.initializing': '正在初始化 BioClaw…',
    'settings.language': '语言',
    'settings.account': '账户',
    'account.notSignedIn': '未登录',
    'account.signedIn': '已登录',
    'account.processing': '处理中…',
    'account.logout': '登出',
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
    'gpu.localEnvs': '{n} GPU envs ready on this machine',
    'gpu.dropHere': 'Drop to upload file',
    'gpu.notifyDone': '{tool} finished — results ready to download',
    'gpu.notifyFailed': '{tool} failed',
    'gpu.notifyCancelled': '{tool} cancelled',
    'gpu.downloadFailed': 'Download failed: {msg}',
    'gpu.uploading': 'Uploading…',
    'gpu.uploaded': 'Uploaded: {path}',
    'gpu.loadingTools': 'Loading tools…',
    'gpu.noAuthShort': 'Not signed in',
    'gpu.hostStatus': 'Host status…',
    'gpu.free': '{gb}GB free',
    'gpu.uploadFailed': 'Upload failed: {msg}',
    'gpu.submitFailed': 'Submit failed',
    'gpu.noOutputFiles': 'No output files.',
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
    'hub.loadFailed': 'Failed to load: {msg}',
    'hub.section.projects': 'Projects',
    'hub.section.datasets': 'Datasets',
    'hub.section.papers': 'Paper Digest',
    'hub.section.shares': 'My Shares',
    'hub.share.create': 'Share current chat',
    'hub.share.creating': 'Creating…',
    'hub.share.created': 'Share link created: {url}',
    'hub.share.createFailed': 'Failed to create share',
    'hub.share.revoke': 'Revoke',
    'hub.section.contacts': 'Contacts',
    'hub.section.lab': 'Lab Feed',
    'hub.section.manageOverview': 'Overview',
    'hub.section.manageStatus': 'Status',
    'hub.section.adminOverview': 'Admin Overview',
    'hub.section.users': 'Users',
    'hub.account': 'Account',
    'hub.noProfile': 'No profile yet.',
    'hub.serverConfig': 'Server config',
    'hub.feedback': 'Feedback',
    'hub.feedbackPlaceholder': 'Tell us what could be better…',
    'hub.feedbackSent': 'Sent — thank you!',
    'hub.quotaTitle': 'Quota requests',
    'hub.noQuota': 'No quota requests yet.',
    'hub.quotaReasonPlaceholder': 'Reason for requesting more quota',
    'hub.requestQuota': 'Request quota',
    'hub.submitted': 'Submitted.',
    'hub.kbTitle': 'Knowledge search',
    'hub.kbPlaceholder': 'Search files / notes in your workspace…',
    'hub.noHits': 'No matches.',
    'hub.result': 'Result',
    'hub.skillsTitle': 'Skills (cloud)',
    'hub.noCloudSkills': 'No cloud skills yet.',
    'offline.banner':
      'Offline — cloud features (GPU Tools, Workspace) are unavailable. Local chat, skills and the Python env still work.',
    'app.startupFailed': 'Startup failed',
    'app.initializing': 'Initializing BioClaw…',
    'settings.language': 'Language',
    'settings.account': 'Account',
    'account.notSignedIn': 'Not signed in',
    'account.signedIn': 'Signed in',
    'account.processing': 'Working…',
    'account.logout': 'Sign out',
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
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
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
