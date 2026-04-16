// Fetch runtime config from server, then boot the app.
(async function boot() {
  var cfg = {};
  try {
    var r = await fetch('/api/config');
    cfg = await r.json();
  } catch (e) { console.warn('Failed to load /api/config, using defaults', e); }

  var DEFAULT_CHAT_JID = cfg.chatJid || 'local-web@local.web';
  var chatJid = DEFAULT_CHAT_JID;
  var assistantName = cfg.assistantName || 'Bioclaw';
  var AUTH_TOKEN = cfg.authToken || '';
  var STREAM_QS = cfg.streamQs || '';
  var THREAD_KEY = 'bioclaw-web-thread-jid';
  var THEME_KEY = 'bioclaw-theme';
  var COMPOSER_HEIGHT_KEY = 'bioclaw-composer-height';
  var ARTIFACT_STAGE_HEIGHT_KEY = 'bioclaw-artifact-stage-height';
  var MAIN_SPLIT_KEY = 'bioclaw-main-left-size';
  var THREAD_SPLIT_KEY = 'bioclaw-thread-rail-width';
  var THREAD_SECTION_OPEN_KEY = 'bioclaw-thread-section-open';
  var FILES_SECTION_OPEN_KEY = 'bioclaw-files-section-open';
  var threads = [];
  var currentMessages = [];
  var artifacts = [];
  var selectedArtifact = null;
  var currentView = 'conversation';
  var preArtifactComposerHeight = null;
  var artifactGroupOpen = { pdf: true, image: true, file: true };
  var threadSectionOpen = true;
  var filesSectionOpen = true;

  // Set session JID in settings drawer
  var jidEl = document.getElementById('sessionJid');
  if (jidEl) jidEl.textContent = chatJid;

const LANG_KEY = 'bioclaw-web-lang';

    const unifiedRoot = document.getElementById('unifiedRoot');
    const unifiedLayout = document.getElementById('unifiedLayout');
    const tabTraceBtn = document.getElementById('tabTraceBtn');
    const tabChatBtn = document.getElementById('tabChatBtn');
    const panelTrace = document.getElementById('panelTrace');
    const panelChat = document.getElementById('panelChat');
    const mainPanelResizer = document.getElementById('mainPanelResizer');
    const chatShell = document.querySelector('.chat-shell');
    const threadRail = document.querySelector('.thread-rail');
    const threadRailResizer = document.getElementById('threadRailResizer');
    const threadSection = document.getElementById('threadSection');
    const threadSectionToggle = document.getElementById('threadSectionToggle');
    const recentFilesSection = document.getElementById('recentFilesSection');
    const recentFilesSectionToggle = document.getElementById('recentFilesSectionToggle');
    const threadListEl = document.getElementById('threadList');
    const newThreadBtn = document.getElementById('newThreadBtn');
    const recentFileListEl = document.getElementById('recentFileList');
    const messagesEl = document.getElementById('messages');
    const artifactStage = document.getElementById('artifactStage');
    const artifactPreviewEl = document.getElementById('artifactPreview');
    const artifactEmptyEl = document.getElementById('artifactEmpty');
    const welcomeShell = document.getElementById('welcomeShell');
    const welcomeTitleEl = document.getElementById('welcomeTitle');
    const welcomeSubtitleEl = document.getElementById('welcomeSubtitle');
    const welcomeSuggestionsEl = document.getElementById('welcomeSuggestions');
    const viewConversationBtn = document.getElementById('viewConversationBtn');
    const viewArtifactBtn = document.getElementById('viewArtifactBtn');
    const resultListEl = document.getElementById('resultList');
    const workspaceEyebrowEl = document.getElementById('workspaceEyebrow');
    const chatMain = document.querySelector('.chat-main');
    const workspaceTopbar = document.querySelector('.workspace-topbar');
    const subtitleEl = document.getElementById('chatHint');
    const form = document.getElementById('composer');
    const input = document.getElementById('text');
    const composerResizer = document.getElementById('composerResizer');
    const artifactStageResizer = document.getElementById('artifactStageResizer');
    const fileInput = document.getElementById('file');
    const fileNameEl = document.getElementById('filename');
    const sendBtn = document.getElementById('send');
    const statusEl = document.getElementById('status');
    const composerCard = document.querySelector('.composer-card');
    const connDot = document.getElementById('connDot');
    const connLabel = document.getElementById('connLabel');
    const connPill = document.getElementById('connPill');
    const traceConnDot = document.getElementById('traceConnDot');
    const traceConnLabel = document.getElementById('traceConnLabel');
    const traceConnPill = document.getElementById('traceConnPill');
    const themeBtn = document.getElementById('themeBtn');
    const langBtn = document.getElementById('langBtn');
    const settingsBackdrop = document.getElementById('settingsBackdrop');
    const settingsDrawer = document.getElementById('settingsDrawer');
    const openSettingsBtn = document.getElementById('openSettings');
    const closeSettingsBtn = document.getElementById('closeSettings');
    const settingsConnValue = document.getElementById('settingsConnValue');
    const settingsTraceConnValue = document.getElementById('settingsTraceConnValue');
    const manageRefreshBtn = document.getElementById('manageRefreshBtn');
    const manageCommandInput = document.getElementById('manageCommandInput');
    const manageCommandBtn = document.getElementById('manageCommandBtn');
    const manageCommandOutput = document.getElementById('manageCommandOutput');
    const manageStatusPanel = document.getElementById('manageStatusPanel');
    const manageDoctorPanel = document.getElementById('manageDoctorPanel');
    const railProject = document.getElementById('railProject');
    const railResults = document.getElementById('railResults');
    const railStatus = document.getElementById('railStatus');
    const threadsPanelTitle = document.getElementById('threadsPanelTitle');
    const recentFilesTitle = document.getElementById('recentFilesTitle');
    const recentFilesHint = document.getElementById('recentFilesHint');
    const progressTitle = document.getElementById('progressTitle');
    const resultsTitle = document.getElementById('resultsTitle');
    const resultsHint = document.getElementById('resultsHint');

    const timeline = document.getElementById('timeline');
    const groupSel = document.getElementById('group');
    const traceStreamCb = document.getElementById('traceShowStream');

    var traceShowStream = false;
    try { traceShowStream = localStorage.getItem('bioclaw-trace-stream') === '1'; } catch (e) {}

    let lastSignature = '';
    let pollTimer = null;
    let chatEs = null;
    let lastConnMode = null;
    let traceEs = null;
    let traceBooted = false;
    var lang = 'zh';
    var currentTab = 'chat';

    var I18N = {
      zh: {
        pageTitle: 'BioClaw 工作台',
        tabChat: '工作台',
        tabTrace: '进度',
        connPillTitle: '新消息',
        connConnecting: '连接中…',
        tracePillTitle: '任务进度',
        traceIdle: '未连接',
        settingsTitle: '设置',
        settingsAria: '打开设置',
        closeSettingsAria: '关闭',
        threadsTitle: '任务',
        threadsHint: '保存的任务。',
        newThread: '新建',
        newThreadPrompt: '输入新任务标题（可留空）',
        threadUntitled: '新任务',
        threadEmpty: '还没有任务。点击右上角创建一个新的分析线程。',
        recentFilesTitle: '最近文件',
        recentFilesHint: '上传与结果。',
        recentFilesEmpty: '还没有可展示的文件。',
        progressTitle: '进度',
        resultsTitle: '结果',
        resultsHint: '任务结果文件。',
        resultsEmpty: '还没有结果文件。',
        artifactGroupPdf: 'PDF',
        artifactGroupImage: '图像',
        artifactGroupFile: '文件',
        workspaceEyebrow: '任务',
        viewConversation: '对话',
        viewArtifact: '结果',
        artifactEmpty: '点击左侧或右侧的文件，在这里预览结果。',
        welcomeTitleTpl: '你好，{name}',
        welcomeSubtitle: '先说任务目标，或直接上传数据。开始分析后，界面会切换到工作台视图。',
        welcomeSuggestions: ['分析 SEC 数据并生成 PDF', '阅读上传文件并总结重点', '比较不同构建体的表现', '设计下一步实验计划'],
        welcomePlaceholder: '今天想一起处理什么任务？',
        messageUploadSummary: '上传文件',
        messageEmptySummary: '消息',
        previewInStage: '查看',
        railProject: '项目',
        railResults: '结果',
        railStatus: '工作台',
        secDisplay: '显示',
        secConnection: '连接',
        secControl: '控制台',
        lblLang: '界面语言',
        lblTheme: '外观',
        lblConn: '对话列表',
        lblTraceConn: '追踪列表',
        lblSession: '会话 ID',
        lblControlCommand: '控制命令',
        lblStatusPanel: '状态',
        lblDoctorPanel: '诊断',
        langToggle: 'English',
        themeLight: '浅色主题',
        themeDark: '深色主题',
        themeSwitchToLight: '切换到浅色主题',
        themeSwitchToDark: '切换到深色主题',
        resizeInputAria: '调整输入框高度',
        resizeInputTitle: '拖动这里调整输入框高度，双击恢复默认高度',
        resizePanelsAria: '调整主舞台和右侧栏宽度',
        resizePanelsTitle: '拖动这里调整主舞台和右侧进度栏的宽度',
        resizeThreadsAria: '调整对话列表宽度',
        resizeThreadsTitle: '拖动这里调整左侧任务栏宽度',
        resizeArtifactAria: '调整结果舞台高度',
        resizeArtifactTitle: '拖动这里调整中间结果预览区域的高度，双击恢复默认高度',
        manageRefresh: '刷新',
        manageRunCommand: '执行',
        manageCommandPlaceholder: '例如：/status 或 /workspace list',
        manageEmpty: '暂无数据。',
        manageLoading: '加载中…',
        manageCommandError: '命令执行失败',
        manageFetchError: '加载失败',
        threadCreateFail: '创建对话失败',
        threadRenamePrompt: '输入新的对话标题',
        threadRenameFail: '重命名对话失败',
        threadArchiveConfirm: '确认归档这个对话？',
        threadArchiveFail: '归档对话失败',
        threadRenameAction: '重命名',
        threadArchiveAction: '归档',
        chatTitle: '任务',
        chatHintTpl: '继续提问或上传文件。',
        traceSub: '查看当前任务的步骤摘要与运行过程。',
        groupLabel: '群组',
        allGroups: '全部',
        reloadTrace: '刷新',
        traceStreamLabel: '显示流式片段（调试）',
        evtRunStart: '开始处理',
        evtRunEnd: '运行结束',
        evtRunError: '运行异常',
        evtStream: '模型输出片段',
        evtContainer: '容器启动',
        evtIpc: '跨群发送',
        evtThinking: '思考',
        evtToolUse: '工具调用',
        evtUnknown: '事件',
        traceMsgCount: '待处理消息',
        tracePromptLen: '提示长度',
        traceOutChars: '本段输出字符',
        traceSession: '会话 ID',
        traceContainer: '容器名',
        traceIpcKind: '类型',
        traceRawJson: '原始 JSON',
        placeholder: '例如：分析这个压缩包，并生成一份简洁的报告…',
        uploadLabel: '上传文件',
        noFile: '未选择',
        send: '发送',
        sseLive: '实时更新',
        poll2s: '约 2 秒刷新',
        offline: '离线',
        sseWait: '连接中…',
        sseOk: '已连接',
        sseBad: '已断开',
        roleAssistant: '助手',
        roleYou: '你',
        userFallback: '用户',
        uploadedPrefix: '已上传 · ',
        openFile: '打开',
        download: '下载',
        copy: '复制',
        copied: '已复制',
        copyFail: '复制失败',
        downloadFile: '下载文件',
        uploading: '正在上传…',
        uploadFail: '上传失败',
        sendFail: '发送失败',
        sidebarTitle: '工作区树',
        sidebarHint: '选择上方群组后加载 groups/&lt;folder&gt;',
        treePick: '请选择群组',
        treeEmpty: '（空）',
        loadFail: '加载失败',
      },
      en: {
        pageTitle: 'BioClaw Workspace',
        tabChat: 'Workspace',
        tabTrace: 'Progress',
        connPillTitle: 'Messages',
        connConnecting: 'Connecting…',
        tracePillTitle: 'Progress',
        traceIdle: 'Idle',
        settingsTitle: 'Settings',
        settingsAria: 'Open settings',
        closeSettingsAria: 'Close',
        threadsTitle: 'Tasks',
        threadsHint: 'Saved threads.',
        newThread: 'New',
        newThreadPrompt: 'Enter a title for the new task (optional)',
        threadUntitled: 'New task',
        threadEmpty: 'No tasks yet. Create a new analysis thread from the button above.',
        recentFilesTitle: 'Recent files',
        recentFilesHint: 'Uploads and outputs.',
        recentFilesEmpty: 'No files to show yet.',
        progressTitle: 'Progress',
        resultsTitle: 'Results',
        resultsHint: 'Task files.',
        resultsEmpty: 'No result files yet.',
        artifactGroupPdf: 'PDF',
        artifactGroupImage: 'Images',
        artifactGroupFile: 'Files',
        workspaceEyebrow: 'Task',
        viewConversation: 'Conversation',
        viewArtifact: 'Results',
        artifactEmpty: 'Pick a file from the left or right to preview it here.',
        welcomeTitleTpl: 'Hello, {name}',
        welcomeSubtitle: 'Start with a clear request or upload data first. Once the task begins, the workspace view will take over.',
        welcomeSuggestions: ['Analyze SEC data and generate a PDF', 'Read uploaded files and summarize them', 'Compare construct performance', 'Plan the next experiment'],
        welcomePlaceholder: 'What would you like to work on today?',
        messageUploadSummary: 'Uploaded file',
        messageEmptySummary: 'Message',
        previewInStage: 'Preview',
        railProject: 'Project',
        railResults: 'Results',
        railStatus: 'Workspace',
        secDisplay: 'Display',
        secConnection: 'Connection',
        secControl: 'Control',
        lblLang: 'Language',
        lblTheme: 'Appearance',
        lblConn: 'Chat list',
        lblTraceConn: 'Trace feed',
        lblSession: 'Session ID',
        lblControlCommand: 'Control command',
        lblStatusPanel: 'Status',
        lblDoctorPanel: 'Doctor',
        langToggle: '中文',
        themeLight: 'Light theme',
        themeDark: 'Dark theme',
        themeSwitchToLight: 'Switch to light theme',
        themeSwitchToDark: 'Switch to dark theme',
        resizeInputAria: 'Resize composer',
        resizeInputTitle: 'Drag to resize the composer. Double-click to reset.',
        resizePanelsAria: 'Resize main panels',
        resizePanelsTitle: 'Drag to resize the stage and inspector columns.',
        resizeThreadsAria: 'Resize thread list',
        resizeThreadsTitle: 'Drag to resize the task list column.',
        resizeArtifactAria: 'Resize results stage',
        resizeArtifactTitle: 'Drag to resize the middle results preview area. Double-click to reset.',
        manageRefresh: 'Refresh',
        manageRunCommand: 'Run',
        manageCommandPlaceholder: 'For example: /status or /workspace list',
        manageEmpty: 'No data yet.',
        manageLoading: 'Loading…',
        manageCommandError: 'Command failed',
        manageFetchError: 'Load failed',
        threadCreateFail: 'Failed to create thread',
        threadRenamePrompt: 'Enter a new title',
        threadRenameFail: 'Failed to rename thread',
        threadArchiveConfirm: 'Archive this thread?',
        threadArchiveFail: 'Failed to archive thread',
        threadRenameAction: 'Rename',
        threadArchiveAction: 'Archive',
        chatTitle: 'Task',
        chatHintTpl: 'Ask follow-ups or upload files.',
        traceSub: 'Review step summaries and runtime progress for the current task.',
        groupLabel: 'Group',
        allGroups: 'All',
        reloadTrace: 'Refresh',
        traceStreamLabel: 'Show stream chunks (debug)',
        evtRunStart: 'Run started',
        evtRunEnd: 'Run finished',
        evtRunError: 'Run failed',
        evtStream: 'Model output chunk',
        evtContainer: 'Container started',
        evtIpc: 'IPC send',
        evtThinking: 'Thinking',
        evtToolUse: 'Tool call',
        evtUnknown: 'Event',
        traceMsgCount: 'Messages batched',
        tracePromptLen: 'Prompt length',
        traceOutChars: 'Chunk chars',
        traceSession: 'Session',
        traceContainer: 'Container',
        traceIpcKind: 'Kind',
        traceRawJson: 'Raw JSON',
        placeholder: 'For example: analyze this dataset and generate a concise report…',
        uploadLabel: 'Upload file',
        noFile: 'No file chosen',
        send: 'Send',
        sseLive: 'Live',
        poll2s: '~2s refresh',
        offline: 'Offline',
        sseWait: 'Connecting…',
        sseOk: 'Connected',
        sseBad: 'Disconnected',
        roleAssistant: 'Assistant',
        roleYou: 'You',
        userFallback: 'User',
        uploadedPrefix: 'Uploaded · ',
        openFile: 'Open',
        download: 'Download',
        copy: 'Copy',
        copied: 'Copied',
        copyFail: 'Copy failed',
        downloadFile: 'Download file',
        uploading: 'Uploading…',
        uploadFail: 'Upload failed',
        sendFail: 'Send failed',
        sidebarTitle: 'Workspace tree',
        sidebarHint: 'Pick a group above to load groups/&lt;folder&gt;',
        treePick: 'Select a group',
        treeEmpty: '(empty)',
        loadFail: 'Load failed',
      },
    };

    function T() { return I18N[lang]; }

    function applyLang(next) {
      lang = next === 'en' ? 'en' : 'zh';
      try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
      var t = T();
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      document.title = t.pageTitle;
      tabTraceBtn.textContent = t.tabTrace;
      tabChatBtn.textContent = t.tabChat;
      connPill.title = t.connPillTitle;
      traceConnPill.title = t.tracePillTitle;
      document.getElementById('settingsHeading').textContent = t.settingsTitle;
      openSettingsBtn.setAttribute('aria-label', t.settingsAria);
      closeSettingsBtn.setAttribute('aria-label', t.closeSettingsAria);
      document.getElementById('threadsTitle').textContent = t.threadsTitle;
      document.getElementById('threadsHint').textContent = t.threadsHint;
      if (threadsPanelTitle) threadsPanelTitle.textContent = t.threadsTitle;
      newThreadBtn.textContent = t.newThread;
      recentFilesTitle.textContent = t.recentFilesTitle;
      recentFilesHint.textContent = t.recentFilesHint;
      progressTitle.textContent = t.progressTitle;
      resultsTitle.textContent = t.resultsTitle;
      resultsHint.textContent = t.resultsHint;
      workspaceEyebrowEl.textContent = t.workspaceEyebrow;
      viewConversationBtn.textContent = t.viewConversation;
      viewArtifactBtn.textContent = t.viewArtifact;
      artifactEmptyEl.textContent = t.artifactEmpty;
      railProject.textContent = t.railProject;
      railResults.textContent = t.railResults;
      railStatus.textContent = t.railStatus;
      document.getElementById('secDisplay').textContent = t.secDisplay;
      document.getElementById('secConnection').textContent = t.secConnection;
      document.getElementById('secControl').textContent = t.secControl;
      document.getElementById('lblLang').textContent = t.lblLang;
      document.getElementById('lblTheme').textContent = t.lblTheme;
      document.getElementById('lblConn').textContent = t.lblConn;
      document.getElementById('lblTraceConn').textContent = t.lblTraceConn;
      document.getElementById('lblSession').textContent = t.lblSession;
      document.getElementById('lblControlCommand').textContent = t.lblControlCommand;
      document.getElementById('lblStatusPanel').textContent = t.lblStatusPanel;
      document.getElementById('lblDoctorPanel').textContent = t.lblDoctorPanel;
      langBtn.textContent = t.langToggle;
      manageRefreshBtn.textContent = t.manageRefresh;
      manageCommandBtn.textContent = t.manageRunCommand;
      manageCommandInput.placeholder = t.manageCommandPlaceholder;
      document.getElementById('chatHint').textContent = t.chatHintTpl.replace('{name}', assistantName);
      document.getElementById('traceSub').textContent = t.traceSub;
      document.getElementById('i18n-group-label').textContent = t.groupLabel;
      document.getElementById('opt-all').textContent = t.allGroups;
      document.getElementById('reloadTrace').textContent = t.reloadTrace;
      document.getElementById('traceStreamLabel').textContent = t.traceStreamLabel;
      input.placeholder = t.placeholder;
      document.getElementById('uploadLabel').textContent = t.uploadLabel;
      sendBtn.textContent = t.send;
      if (threadSectionToggle) threadSectionToggle.title = t.threadsTitle;
      if (recentFilesSectionToggle) recentFilesSectionToggle.title = t.recentFilesTitle;
      if (composerResizer) {
        composerResizer.setAttribute('aria-label', t.resizeInputAria);
        composerResizer.title = t.resizeInputTitle;
      }
      if (artifactStageResizer) {
        artifactStageResizer.setAttribute('aria-label', t.resizeArtifactAria);
        artifactStageResizer.title = t.resizeArtifactTitle;
      }
      if (mainPanelResizer) {
        mainPanelResizer.setAttribute('aria-label', t.resizePanelsAria);
        mainPanelResizer.title = t.resizePanelsTitle;
      }
      if (threadRailResizer) {
        threadRailResizer.setAttribute('aria-label', t.resizeThreadsAria);
        threadRailResizer.title = t.resizeThreadsTitle;
      }
      var hasFile = fileInput.files && fileInput.files[0];
      fileNameEl.textContent = hasFile ? fileInput.files[0].name : t.noFile;
      if (manageStatusPanel && !manageStatusPanel.textContent) manageStatusPanel.textContent = t.manageEmpty;
      if (manageDoctorPanel && !manageDoctorPanel.textContent) manageDoctorPanel.textContent = t.manageEmpty;
      renderWelcomeShell();
      syncThemeUi();
      syncWorkspaceMode();
      renderThreads();
      renderArtifactLists();
      renderArtifactStage();
      render(currentMessages);
      if (lastConnMode === null) {
        connDot.classList.remove('live', 'poll');
        connLabel.textContent = t.connConnecting;
        settingsConnValue.textContent = t.connConnecting;
      } else setChatConn(lastConnMode);
      syncTracePillText();
    }

    function syncTracePillText() {
      if (traceEs) return;
      var t = T();
      traceConnLabel.textContent = t.traceIdle;
      settingsTraceConnValue.textContent = t.traceIdle;
    }

    (function initLang() {
      var saved = null;
      try {
        saved = localStorage.getItem(LANG_KEY) || localStorage.getItem('bioclaw-local-web-lang') || localStorage.getItem('bioclaw-dashboard-lang');
      } catch (e) {}
      applyLang(saved === 'en' ? 'en' : 'zh');
    })();

    function setChatConn(mode) {
      lastConnMode = mode;
      var t = T();
      connDot.classList.remove('live', 'poll');
      var label = t.offline;
      if (mode === 'sse') { connDot.classList.add('live'); label = t.sseLive; }
      else if (mode === 'poll') { connDot.classList.add('poll'); label = t.poll2s; }
      connLabel.textContent = label;
      settingsConnValue.textContent = label;
    }

    function stopTraceSse() {
      if (traceEs) { traceEs.close(); traceEs = null; }
      traceConnDot.classList.remove('live');
      traceConnPill.classList.remove('ok', 'bad');
      var t = T();
      traceConnLabel.textContent = t.traceIdle;
      settingsTraceConnValue.textContent = traceConnLabel.textContent;
    }

    function startTraceSse() {
      if (traceEs) return;
      var t = T();
      traceConnLabel.textContent = t.sseWait;
      settingsTraceConnValue.textContent = t.sseWait;
      traceConnPill.classList.remove('ok', 'bad');
      var url = '/api/trace/stream' + STREAM_QS;
      traceEs = new EventSource(url);
      traceEs.onopen = function () {
        traceConnLabel.textContent = T().sseOk;
        settingsTraceConnValue.textContent = traceConnLabel.textContent;
        traceConnDot.classList.add('live');
        traceConnPill.classList.add('ok');
        traceConnPill.classList.remove('bad');
      };
      traceEs.onmessage = function () { loadTrace(); };
      traceEs.onerror = function () {
        traceConnLabel.textContent = T().sseBad;
        settingsTraceConnValue.textContent = traceConnLabel.textContent;
        traceConnDot.classList.remove('live');
        traceConnPill.classList.add('bad');
        traceConnPill.classList.remove('ok');
      };
    }

    function authHeaders() {
      var h = {};
      if (AUTH_TOKEN) h['Authorization'] = 'Bearer ' + AUTH_TOKEN;
      return h;
    }

    function prettyJson(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value, null, 2);
      } catch (e) {
        return String(value);
      }
    }

    function formatManageStatus(status) {
      if (!status) return T().manageEmpty;
      var channels = Array.isArray(status.channels) ? status.channels : [];
      var tasks = Array.isArray(status.tasks) ? status.tasks : [];
      var lines = [
        'Chat: ' + (status.chatJid || 'unknown'),
        'Workspace: ' + (status.workspaceFolder || 'unbound'),
        'Agent: ' + (status.agentId || 'unbound') + (status.agentName ? ' (' + status.agentName + ')' : ''),
        'Provider: ' + (status.provider || 'unknown'),
        'Model: ' + (status.model || 'unknown'),
        'Memory: ' + (status.memoryConfigured ? 'configured' : 'empty'),
        'Channels: ' + (channels.length ? channels.map(function (channel) {
          return channel.name + '=' + (channel.connected ? 'up' : 'down');
        }).join(', ') : 'none'),
        'Tasks: ' + tasks.length,
      ];
      if (tasks.length) {
        lines.push('');
        lines.push('Scheduled tasks:');
        tasks.slice(0, 8).forEach(function (task) {
          lines.push('- ' + task.id + ' [' + task.status + ']' + (task.label ? ' ' + task.label : '') + (task.nextRun ? ' next=' + task.nextRun : ''));
        });
      }
      return lines.join('\n');
    }

    function formatManageDoctor(doctor) {
      if (!doctor) return T().manageEmpty;
      var checks = Array.isArray(doctor.checks) ? doctor.checks : [];
      var lines = [
        'Runtime: ' + (doctor.runtime || 'unknown'),
      ];
      if (!checks.length) return lines.join('\n');
      lines.push('');
      checks.forEach(function (check) {
        lines.push('- [' + check.status + '] ' + check.name + ': ' + check.detail);
      });
      return lines.join('\n');
    }

    async function refreshManagementPanels() {
      var t = T();
      if (manageStatusPanel) manageStatusPanel.textContent = t.manageLoading;
      if (manageDoctorPanel) manageDoctorPanel.textContent = t.manageLoading;
      try {
        var [statusRes, doctorRes] = await Promise.all([
          fetch('/api/manage/status?chatJid=' + encodeURIComponent(chatJid), { headers: authHeaders() }),
          fetch('/api/manage/doctor?chatJid=' + encodeURIComponent(chatJid), { headers: authHeaders() }),
        ]);
        if (!statusRes.ok || !doctorRes.ok) throw new Error(t.manageFetchError);
        var statusData = await statusRes.json();
        var doctorData = await doctorRes.json();
        if (manageStatusPanel) manageStatusPanel.textContent = formatManageStatus(statusData.status);
        if (manageDoctorPanel) manageDoctorPanel.textContent = formatManageDoctor(doctorData.doctor);
      } catch (e) {
        var message = e && e.message ? e.message : t.manageFetchError;
        if (manageStatusPanel) manageStatusPanel.textContent = message;
        if (manageDoctorPanel) manageDoctorPanel.textContent = message;
      }
    }

    async function runManageCommand(text) {
      var t = T();
      if (!text) return;
      if (manageCommandBtn) manageCommandBtn.disabled = true;
      if (manageCommandOutput) manageCommandOutput.textContent = t.manageLoading;
      try {
        var res = await fetch('/api/manage/command', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ chatJid: chatJid, text: text }),
        });
        if (!res.ok) throw new Error(t.manageCommandError);
        var data = await res.json();
        if (manageCommandOutput) {
          manageCommandOutput.textContent = data.response || prettyJson(data.data) || t.manageEmpty;
        }
        await refreshManagementPanels();
      } catch (e) {
        if (manageCommandOutput) {
          manageCommandOutput.textContent = e && e.message ? e.message : t.manageCommandError;
        }
      } finally {
        if (manageCommandBtn) manageCommandBtn.disabled = false;
      }
    }

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function escAttr(s) {
      return String(s)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
    }

    (function setupMarkdownSanitize() {
      if (typeof DOMPurify !== 'undefined' && !globalThis.__bioclawDpHook) {
        globalThis.__bioclawDpHook = true;
        DOMPurify.addHook('afterSanitizeAttributes', function (node) {
          if (node.tagName === 'A' && node.hasAttribute('href')) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noreferrer noopener');
          }
        });
      }
    })();

    function linkifyBareFilePaths(t) {
      return String(t).replace(/(^|\s|[>\u00a0])(\/files\/[\w./%-]+)/g, function (_, sep, p) {
        return sep + '[' + p + '](' + p + ')';
      });
    }

    function markdownToSafeHtml(raw) {
      if (typeof marked === 'undefined' || typeof marked.parse !== 'function' || typeof DOMPurify === 'undefined') {
        return esc(raw).replace(/(\/files\/[\w./%-]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>').replace(/\n/g, '<br>');
      }
      try {
        if (typeof marked.setOptions === 'function') marked.setOptions({ gfm: true, breaks: true });
        var linked = linkifyBareFilePaths(raw);
        var html = marked.parse(linked, { async: false });
        return DOMPurify.sanitize(html, {
          ALLOWED_TAGS: ['p','br','strong','em','b','i','code','pre','ul','ol','li','h1','h2','h3','h4','h5','h6','blockquote','a','hr','del','ins','sub','sup','table','thead','tbody','tr','th','td','img'],
          ALLOWED_ATTR: ['href','title','class','colspan','rowspan','align','src','alt','width','height','loading'],
          ALLOW_DATA_ATTR: false,
        });
      } catch (e2) {
        return esc(raw).replace(/\n/g, '<br>');
      }
    }

    function extractFileLinks(text) {
      var matches = String(text).match(/\/files\/[\w./%-]+/g);
      if (!matches) return [];
      var seen = {};
      var list = [];
      for (var i = 0; i < matches.length; i++) {
        var item = matches[i];
        if (seen[item]) continue;
        seen[item] = true;
        list.push(item);
      }
      return list;
    }

    function renderFileActions(paths) {
      if (!paths || paths.length === 0) return '';
      var t = T();
      return '<div class="file-action-list">' + paths.map(function (p) {
        var name = p.split('/').pop() || p;
        return '<div class="file-action-item">' +
          '<div class="file-action-name">' + esc(name) + '</div>' +
          '<div class="file-actions">' +
          '<button type="button" class="file-button file-button-accent" data-artifact-url="' + escAttr(p) + '">' + esc(t.previewInStage) + '</button>' +
          '<a class="file-button" href="' + escAttr(p) + '" target="_blank" rel="noreferrer">' + esc(t.openFile) + '</a>' +
          '<a class="file-button" href="' + escAttr(p) + '" download>' + esc(t.downloadFile) + '</a>' +
          '</div></div>';
      }).join('') + '</div>';
    }

    function traceTypeTitle(type, t) {
      switch (type) {
        case 'run_start': return t.evtRunStart;
        case 'agent_query_start': return t.evtRunStart;
        case 'run_end': return t.evtRunEnd;
        case 'run_error': return t.evtRunError;
        case 'stream_output': return t.evtStream;
        case 'container_spawn': return t.evtContainer;
        case 'ipc_send': return t.evtIpc;
        case 'agent_thinking': return t.evtThinking;
        case 'agent_tool_use': return t.evtToolUse;
        default: return t.evtUnknown + ' · ' + type;
      }
    }
    function traceParsedPayload(payloadStr) {
      try { return JSON.parse(payloadStr); } catch (e) { return null; }
    }
    function traceRawPretty(payloadStr) {
      try { return JSON.stringify(JSON.parse(payloadStr), null, 2); } catch (e) { return String(payloadStr); }
    }
    function traceExtraEvtClass(r, parsed) {
      if (r.type === 'run_end' && parsed && parsed.status === 'error') return ' evt-trace-run_end_err';
      if (r.type === 'run_end') return ' evt-trace-run_end_ok';
      return '';
    }
    /* ── Process step icon class ── */
    function pstepIconClass(type) {
      switch (type) {
        case 'agent_thinking': return 'think';
        case 'agent_tool_use': return 'tool';
        case 'ipc_send': return 'ipc';
        case 'run_error': return 'err';
        case 'container_spawn': return 'spawn';
        default: return 'spawn';
      }
    }
    function pstepIconLabel(type) {
      switch (type) {
        case 'agent_thinking': return 'T';
        case 'agent_tool_use': return '⚙';
        case 'ipc_send': return '↗';
        case 'container_spawn': return '▶';
        case 'run_error': return '!';
        default: return '·';
      }
    }

    function renderProcessStep(r, t) {
      var parsed = traceParsedPayload(r.payload);
      var cls = pstepIconClass(r.type);
      var icon = pstepIconLabel(r.type);
      var label = '';
      var detail = '';
      var time = r.created_at ? new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

      if (r.type === 'agent_thinking' && parsed) {
        label = t.evtThinking;
        detail = parsed.text || '';
      } else if (r.type === 'agent_tool_use' && parsed) {
        label = '<span class="pstep-tool-name">' + esc(String(parsed.toolName || '')) + '</span>';
        detail = parsed.toolInput || '';
      } else if (r.type === 'container_spawn' && parsed) {
        label = t.evtContainer;
        detail = parsed.containerName || '';
      } else if (r.type === 'ipc_send' && parsed) {
        label = t.evtIpc;
        detail = parsed.preview || parsed.caption || parsed.filePath || '';
      } else if (r.type === 'run_error' && parsed) {
        label = t.evtRunError;
        detail = parsed.message || JSON.stringify(parsed);
      } else {
        label = traceTypeTitle(r.type, t);
        detail = r.payload ? traceRawPretty(r.payload) : '';
      }

      var detailHtml = '';
      if (detail) {
        var detailStr = String(detail);
        if (detailStr.length <= 80) {
          detailHtml = '<div class="pstep-detail short">' + esc(detailStr) + '</div>';
        } else {
          var summary = esc(detailStr.slice(0, 60).replace(/\n/g, ' ')) + '…';
          detailHtml = '<details class="pstep-collapse"><summary>' + summary + '</summary>' +
            '<div class="pstep-collapse-body">' + esc(detailStr) + '</div></details>';
        }
      }
      return '<div class="pstep">' +
        '<div class="pstep-icon ' + cls + '">' + icon + '</div>' +
        '<div class="pstep-body"><span class="pstep-label">' + label + '</span>' +
        (time ? '<span class="pstep-time">' + esc(time) + '</span>' : '') +
        detailHtml +
        '</div></div>';
    }

    /**
     * Build response bubbles from steps.
     * Each stream_output becomes a response bubble; preceding thinking/tool steps
     * are grouped as collapsible process steps INSIDE that bubble.
     * If there are trailing steps with no stream_output, they form a bubble with
     * just the process steps (in-progress state).
     */
    function buildResponseBubbles(steps, endEvent, t) {
      var bubbles = [];
      var pending = []; // accumulates non-output steps

      for (var i = 0; i < steps.length; i++) {
        var s = steps[i];
        if (s.type === 'stream_output') {
          bubbles.push({ process: pending.slice(), output: s });
          pending = [];
        } else {
          pending.push(s);
        }
      }
      // Trailing steps without output yet (running or error)
      if (pending.length > 0 || bubbles.length === 0) {
        bubbles.push({ process: pending.slice(), output: null });
      }

      var html = '';
      for (var b = 0; b < bubbles.length; b++) {
        var bub = bubbles[b];
        var parsed = bub.output ? traceParsedPayload(bub.output.payload) : null;
        var outputText = parsed && parsed.preview ? String(parsed.preview) : '';
        var isError = parsed && parsed.status === 'error';
        var isLastBubble = (b === bubbles.length - 1);

        html += '<div class="response-bubble">';

        // Process steps (collapsible)
        if (bub.process.length > 0) {
          var stepsHtml = '';
          for (var p = 0; p < bub.process.length; p++) {
            stepsHtml += renderProcessStep(bub.process[p], t);
          }
          var processLabel = bub.process.length + (bub.process.length === 1 ? ' step' : ' steps');
          html += '<details class="process-steps"' + (isLastBubble && !bub.output ? ' open' : '') + '>';
          html += '<summary>' + esc(processLabel) + '</summary>';
          html += '<div class="process-steps-list">' + stepsHtml + '</div>';
          html += '</details>';
        }

        // Message content
        if (bub.output && outputText) {
          html += '<div class="response-content">' + markdownToSafeHtml(outputText) + '</div>';
        } else if (bub.output && isError) {
          html += '<div class="response-error">✗ ' + esc(parsed && parsed.preview ? String(parsed.preview) : 'Error') + '</div>';
        }

        html += '</div>';
      }

      // run_end error (distinct from stream_output error)
      if (endEvent) {
        var endParsed = traceParsedPayload(endEvent.payload);
        if (endParsed && endParsed.error) {
          html += '<div class="response-bubble"><div class="response-error">✗ ' + esc(String(endParsed.error)) + '</div></div>';
        }
      }

      return html;
    }

    function stripXmlTags(s) {
      return String(s)
        .replace(/<\/?(messages|message|system)[^>]*>/gi, '')
        .replace(/\s*sender="[^"]*"/gi, '')
        .replace(/\s*time="[^"]*"/gi, '')
        .trim();
    }

    function renderList(rows) {
      var t = T();
      // API returns newest-first (ORDER BY id DESC); reverse to chronological
      rows = rows.slice().reverse();
      var tasks = [];
      var current = null;

      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.type === 'run_start' || r.type === 'agent_query_start') {
          // agent_query_start = follow-up query within same container session
          // Treat it as a new task card so each user message is separate.
          current = { start: r, steps: [], end: null };
          tasks.push({ type: 'task', task: current });
        } else if (r.type === 'run_end' && current) {
          current.end = r;
          current = null;
        } else if (current) {
          current.steps.push(r);
        } else {
          tasks.push({ type: 'standalone', event: r });
        }
      }

      var html = '';
      for (var g = 0; g < tasks.length; g++) {
        var grp = tasks[g];
        if (grp.type === 'standalone') {
          var ev = grp.event;
          var evParsed = traceParsedPayload(ev.payload);
          var evTitle = traceTypeTitle(ev.type, t);
          var evTime = ev.created_at ? new Date(ev.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          var evCls = pstepIconClass(ev.type);
          var evIcon = pstepIconLabel(ev.type);
          var evLabel = evTitle;
          var evDetail = '';
          if (ev.type === 'agent_thinking' && evParsed) {
            evDetail = evParsed.text || '';
          } else if (ev.type === 'agent_tool_use' && evParsed) {
            evLabel = evTitle + ': <span class="pstep-tool-name">' + esc(String(evParsed.toolName || '')) + '</span>';
            evDetail = typeof evParsed.toolInput === 'object' ? JSON.stringify(evParsed.toolInput, null, 2) : String(evParsed.toolInput || '');
          } else if (ev.type === 'stream_output' && evParsed) {
            evDetail = evParsed.result || evParsed.text || evParsed.preview || '';
          } else if (ev.type === 'container_spawn' && evParsed) {
            evDetail = evParsed.containerName || '';
          } else if (ev.type === 'ipc_send' && evParsed) {
            evDetail = evParsed.preview || evParsed.caption || evParsed.filePath || '';
          } else if (ev.type === 'run_error' && evParsed) {
            evDetail = evParsed.message || JSON.stringify(evParsed);
          } else if (evParsed) {
            evDetail = evParsed.preview || (ev.payload ? traceRawPretty(ev.payload) : '');
          }
          html += '<div class="evt-standalone">';
          html += '<div class="evt-s-header">';
          html += '<span class="evt-s-icon pstep-icon ' + evCls + '">' + evIcon + '</span>';
          html += '<span class="evt-s-title">' + evLabel + '</span>';
          if (evTime) html += '<span class="evt-s-time">' + esc(evTime) + '</span>';
          html += '</div>';
          if (evDetail) {
            var evShort = evDetail.length <= 60;
            if (evShort) {
              html += '<div class="evt-s-detail">' + esc(evDetail) + '</div>';
            } else {
              var evSummaryText = esc(evDetail.slice(0, 60).replace(/\n/g, ' ')) + '…';
              html += '<details class="evt-s-collapse"><summary>' + evSummaryText + '</summary>';
              html += '<div class="evt-s-collapse-body">' + esc(evDetail) + '</div>';
              html += '</details>';
            }
          }
          html += '</div>';
        } else {
          var task = grp.task;
          var parsed = traceParsedPayload(task.start.payload);
          // run_start uses "preview", agent_query_start uses "text"
          var rawPreview = parsed ? (parsed.preview || parsed.text || '') : '';
          var preview = rawPreview ? stripXmlTags(String(rawPreview)).slice(0, 200) : '';
          var statusClass = task.end ? (traceParsedPayload(task.end.payload)?.status === 'error' ? 'err' : 'ok') : '';
          var statusLabel = task.end ? (statusClass === 'err' ? '✗ ' + t.evtRunError : '✓ ' + t.evtRunEnd) : '';
          var time = task.start.created_at ? new Date(task.start.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          var folder = task.start.group_folder || '';
          var isLast = (g === tasks.length - 1);
          var cardClass = 'task-card' + (statusClass === 'err' ? ' is-error' : '');

          html += '<details class="' + cardClass + '" ' + (isLast ? 'open' : '') + '>';
          html += '<summary class="task-header">';
          html += '<div class="task-status ' + statusClass + '"></div>';
          html += '<div class="task-info">';
          html += '<div class="task-prompt">' + (preview ? esc(preview) : t.evtRunStart) + '</div>';
          html += '<div class="task-meta">';
          html += '<span>' + esc(time) + '</span>';
          html += '<span>' + esc(folder) + '</span>';
          html += '<span>' + statusLabel + '</span>';
          html += '</div></div>';
          html += '<svg class="task-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';
          html += '</summary>';
          html += '<div class="task-body">';
          html += buildResponseBubbles(task.steps, task.end, t);
          html += '</div></details>';
        }
      }

      timeline.innerHTML = html;
      timeline.scrollTop = timeline.scrollHeight;
    }

    async function loadGroups() {
      var res = await fetch('/api/workspace/groups', { headers: authHeaders() });
      if (!res.ok) return;
      var data = await res.json();
      var prev = groupSel.value;
      while (groupSel.options.length > 1) groupSel.remove(1);
      (data.folders || []).forEach(function (f) {
        var o = document.createElement('option');
        o.value = f; o.textContent = f;
        groupSel.appendChild(o);
      });
      if (prev && Array.prototype.some.call(groupSel.options, function (o) { return o.value === prev; })) groupSel.value = prev;
    }

    function traceListQuery() {
      var g = groupSel.value;
      var q = '/api/trace/list?limit=400' + (g ? '&group_folder=' + encodeURIComponent(g) : '');
      if (!traceShowStream) q += '&compact=1';
      return q;
    }

    async function loadTrace() {
      var res = await fetch(traceListQuery(), { headers: authHeaders() });
      if (!res.ok) { timeline.textContent = T().loadFail; return; }
      var data = await res.json();
      renderList(data.events || []);
    }

    function ensureTrace() {
      if (traceBooted) { startTraceSse(); return; }
      traceBooted = true;
      loadGroups().then(function () {
        syncGroupSelectionToActiveThread(true);
        loadTrace();
        startTraceSse();
      });
    }

    function isWide() { return window.matchMedia('(min-width: 1400px)').matches; }

    function applyLayout() {
      var wide = isWide();
      unifiedRoot.classList.toggle('unified-wide', wide);
      applyStoredPanelSizes();
      if (wide) {
        panelChat.classList.remove('hidden-narrow');
        panelTrace.classList.remove('hidden-narrow');
        ensureTrace();
      } else {
        if (currentTab === 'chat') {
          panelChat.classList.remove('hidden-narrow');
          panelTrace.classList.add('hidden-narrow');
          stopTraceSse();
        } else {
          panelChat.classList.add('hidden-narrow');
          panelTrace.classList.remove('hidden-narrow');
          ensureTrace();
        }
        tabTraceBtn.setAttribute('aria-selected', currentTab === 'trace' ? 'true' : 'false');
        tabChatBtn.setAttribute('aria-selected', currentTab === 'chat' ? 'true' : 'false');
      }
    }

    function setTab(tab) {
      currentTab = tab;
      var u = new URL(window.location.href);
      u.searchParams.set('tab', tab === 'trace' ? 'trace' : 'chat');
      window.history.replaceState({}, '', u.pathname + u.search);
      applyLayout();
    }

    tabTraceBtn.addEventListener('click', function () { setTab('trace'); });
    tabChatBtn.addEventListener('click', function () { setTab('chat'); });
    window.matchMedia('(min-width: 1400px)').addEventListener('change', applyLayout);
    window.matchMedia('(min-width: 981px)').addEventListener('change', applyStoredPanelSizes);
    window.addEventListener('resize', function () {
      applyStoredPanelSizes();
      setArtifactStageHeight(artifactStage.getBoundingClientRect().height || 520, false);
    });

    (function bootTabFromUrl() {
      var p = new URLSearchParams(window.location.search);
      if (p.get('tab') === 'trace') currentTab = 'trace';
      applyLayout();
    })();

    document.getElementById('reloadTrace').onclick = function () { loadTrace(); };
    groupSel.onchange = function () { loadTrace(); };
    if (traceStreamCb) {
      traceStreamCb.checked = traceShowStream;
      traceStreamCb.addEventListener('change', function () {
        traceShowStream = !!traceStreamCb.checked;
        try { localStorage.setItem('bioclaw-trace-stream', traceShowStream ? '1' : '0'); } catch (e) {}
        loadTrace();
      });
    }

    langBtn.addEventListener('click', function () {
      applyLang(lang === 'zh' ? 'en' : 'zh');
      lastSignature = '';
      refreshMessages();
    });

    function currentTheme() {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    function syncThemeUi() {
      var t = T();
      var isLight = currentTheme() === 'light';
      themeBtn.textContent = isLight ? t.themeLight : t.themeDark;
      themeBtn.title = isLight ? t.themeSwitchToDark : t.themeSwitchToLight;
      themeBtn.setAttribute('aria-label', themeBtn.title);
    }

    function setTheme(theme, persist) {
      if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
      if (persist) {
        try { localStorage.setItem(THEME_KEY, theme === 'dark' ? 'dark' : 'light'); } catch (e) {}
      }
      syncThemeUi();
    }

    function loadTheme() {
      var th = null;
      try { th = localStorage.getItem(THEME_KEY); } catch (e) {}
      if (!th) th = 'light';
      setTheme(th === 'dark' ? 'dark' : 'light', false);
    }
    loadTheme();
    themeBtn.addEventListener('click', function () {
      setTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
    });

    function readStoredOpenState(key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        return raw !== '0';
      } catch (e) {
        return fallback;
      }
    }

    function syncRailSections() {
      if (threadSection) threadSection.classList.toggle('is-open', threadSectionOpen);
      if (threadSectionToggle) threadSectionToggle.setAttribute('aria-expanded', threadSectionOpen ? 'true' : 'false');
      if (recentFilesSection) recentFilesSection.classList.toggle('is-open', filesSectionOpen);
      if (recentFilesSectionToggle) recentFilesSectionToggle.setAttribute('aria-expanded', filesSectionOpen ? 'true' : 'false');
    }

    threadSectionOpen = readStoredOpenState(THREAD_SECTION_OPEN_KEY, true);
    filesSectionOpen = readStoredOpenState(FILES_SECTION_OPEN_KEY, true);
    syncRailSections();

    function clampComposerHeight(value) {
      var viewportMax = Math.floor(window.innerHeight * 0.48);
      return Math.max(76, Math.min(viewportMax, Math.round(value || 0)));
    }

    function setComposerHeight(value, persist) {
      var height = clampComposerHeight(value);
      input.style.height = height + 'px';
      if (persist) {
        try { localStorage.setItem(COMPOSER_HEIGHT_KEY, String(height)); } catch (e) {}
      }
    }

    (function loadComposerHeight() {
      var stored = null;
      try { stored = localStorage.getItem(COMPOSER_HEIGHT_KEY); } catch (e) {}
      var initial = stored ? Number(stored) : 96;
      if (!isFinite(initial) || initial > 116) initial = 96;
      setComposerHeight(initial, false);
    })();

    function compactWorkspaceLabel(value) {
      var raw = String(value || '').trim();
      if (!raw) return '';
      if (raw.length <= 28) return raw;
      return raw.slice(0, 12) + '…' + raw.slice(-10);
    }

    function summarizePlainText(text, maxLen) {
      var raw = String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .replace(/[#>*_~-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!raw) return '';
      return raw.length > maxLen ? raw.slice(0, maxLen - 1) + '…' : raw;
    }

    function hasWorkspaceConversation(messages) {
      return (messages || []).some(function (msg) {
        var text = String((msg && msg.content) || '');
        if (parseUploadMessage(text)) return false;
        return summarizePlainText(text, 24).length > 0;
      });
    }

    function syncWorkspaceMode() {
      var hasConversation = hasWorkspaceConversation(currentMessages);
      if (!hasConversation && !artifacts.length) currentView = 'conversation';
      var isWelcomeMode = !hasConversation && currentView !== 'artifact';
      unifiedRoot.classList.toggle('is-welcome-mode', isWelcomeMode);
      if (welcomeShell) welcomeShell.setAttribute('aria-hidden', isWelcomeMode ? 'false' : 'true');
      input.placeholder = isWelcomeMode ? T().welcomePlaceholder : T().placeholder;
      syncViewModeButtons();
      return isWelcomeMode;
    }

    function renderWelcomeShell() {
      if (!welcomeTitleEl || !welcomeSubtitleEl || !welcomeSuggestionsEl) return;
      var t = T();
      welcomeTitleEl.textContent = t.welcomeTitleTpl.replace('{name}', assistantName);
      welcomeSubtitleEl.textContent = t.welcomeSubtitle;
      var suggestions = Array.isArray(t.welcomeSuggestions) ? t.welcomeSuggestions : [];
      welcomeSuggestionsEl.innerHTML = suggestions.map(function (item) {
        return '<button type="button" class="welcome-suggestion" data-prompt="' + escAttr(item) + '">' + esc(item) + '</button>';
      }).join('');
    }

    function messageSummaryText(content) {
      var upload = parseUploadMessage(content);
      if (upload) return T().messageUploadSummary + ' · ' + upload.filename;
      var summary = summarizePlainText(content, 96);
      return summary || T().messageEmptySummary;
    }

    function artifactGroupLabel(kind) {
      var t = T();
      if (kind === 'pdf') return t.artifactGroupPdf;
      if (kind === 'image') return t.artifactGroupImage;
      return t.artifactGroupFile;
    }

    function buildMessageSignature(messages) {
      return (messages || []).map(function (msg) {
        return [
          msg && msg.id ? String(msg.id) : '',
          msg && msg.timestamp ? String(msg.timestamp) : '',
          msg && msg.is_from_me ? '1' : '0',
          String((msg && msg.content) || '').length,
        ].join(':');
      }).join('|');
    }

    function clampArtifactStageHeight(value) {
      if (!chatMain || !composerCard || !workspaceTopbar || !subtitleEl) {
        return Math.max(320, Math.min(760, Math.round(value || 520)));
      }
      var total = chatMain.getBoundingClientRect().height;
      var top = workspaceTopbar.getBoundingClientRect().height + subtitleEl.getBoundingClientRect().height;
      var composer = composerCard.getBoundingClientRect().height;
      var min = Math.max(320, Math.min(460, Math.floor(total * 0.42)));
      var max = Math.max(min, total - top - composer - 52);
      return Math.max(min, Math.min(max, Math.round(value || Math.max(min, 520))));
    }

    function setArtifactStageHeight(value, persist) {
      var height = clampArtifactStageHeight(value);
      unifiedRoot.style.setProperty('--artifact-stage-size', height + 'px');
      if (persist) {
        try { localStorage.setItem(ARTIFACT_STAGE_HEIGHT_KEY, String(height)); } catch (e) {}
      }
    }

    function resetArtifactStageHeight() {
      unifiedRoot.style.removeProperty('--artifact-stage-size');
      try { localStorage.removeItem(ARTIFACT_STAGE_HEIGHT_KEY); } catch (e) {}
      setArtifactStageHeight(520, false);
    }

    (function loadArtifactStageHeight() {
      var stored = null;
      try { stored = localStorage.getItem(ARTIFACT_STAGE_HEIGHT_KEY); } catch (e) {}
      setArtifactStageHeight(stored ? Number(stored) : 520, false);
    })();

    if (composerResizer) {
      var resizeState = null;

      function finishComposerResize(event) {
        if (!resizeState) return;
        if (event && resizeState.pointerId != null && event.pointerId != null && event.pointerId !== resizeState.pointerId) return;
        document.body.classList.remove('is-resizing-composer');
        setComposerHeight(input.getBoundingClientRect().height, true);
        resizeState = null;
      }

      composerResizer.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        resizeState = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: input.getBoundingClientRect().height,
        };
        composerResizer.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-composer');
      });

      composerResizer.addEventListener('pointermove', function (event) {
        if (!resizeState || event.pointerId !== resizeState.pointerId) return;
        setComposerHeight(resizeState.startHeight + (event.clientY - resizeState.startY), false);
      });

      composerResizer.addEventListener('pointerup', finishComposerResize);
      composerResizer.addEventListener('pointercancel', finishComposerResize);
      composerResizer.addEventListener('dblclick', function () {
        setComposerHeight(96, true);
      });
      composerResizer.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home') return;
        event.preventDefault();
        if (event.key === 'Home') {
          setComposerHeight(96, true);
          return;
        }
        var delta = event.key === 'ArrowDown' ? 18 : -18;
        setComposerHeight(input.getBoundingClientRect().height + delta, true);
      });
      window.addEventListener('pointerup', finishComposerResize);
    }

    if (artifactStageResizer) {
      var stageResizeState = null;

      function finishStageResize(event) {
        if (!stageResizeState) return;
        if (event && stageResizeState.pointerId != null && event.pointerId != null && event.pointerId !== stageResizeState.pointerId) return;
        document.body.classList.remove('is-resizing-composer');
        setArtifactStageHeight(artifactStage.getBoundingClientRect().height, true);
        stageResizeState = null;
      }

      artifactStageResizer.addEventListener('pointerdown', function (event) {
        if (currentView !== 'artifact') return;
        event.preventDefault();
        stageResizeState = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: artifactStage.getBoundingClientRect().height,
        };
        artifactStageResizer.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-composer');
      });

      artifactStageResizer.addEventListener('pointermove', function (event) {
        if (!stageResizeState || event.pointerId !== stageResizeState.pointerId) return;
        setArtifactStageHeight(stageResizeState.startHeight + (event.clientY - stageResizeState.startY), false);
      });

      artifactStageResizer.addEventListener('pointerup', finishStageResize);
      artifactStageResizer.addEventListener('pointercancel', finishStageResize);
      artifactStageResizer.addEventListener('dblclick', function () {
        if (currentView !== 'artifact') return;
        resetArtifactStageHeight();
      });
      artifactStageResizer.addEventListener('keydown', function (event) {
        if (currentView !== 'artifact') return;
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home') return;
        event.preventDefault();
        if (event.key === 'Home') {
          resetArtifactStageHeight();
          return;
        }
        var delta = event.key === 'ArrowDown' ? 28 : -28;
        setArtifactStageHeight(artifactStage.getBoundingClientRect().height + delta, true);
      });
      window.addEventListener('pointerup', finishStageResize);
    }

    function readStoredNumber(key) {
      try {
        var raw = localStorage.getItem(key);
        if (!raw) return null;
        var value = Number(raw);
        return Number.isFinite(value) ? value : null;
      } catch (e) {
        return null;
      }
    }

    function writeStoredNumber(key, value) {
      try { localStorage.setItem(key, String(Math.round(value))); } catch (e) {}
    }

    function clearStoredNumber(key) {
      try { localStorage.removeItem(key); } catch (e) {}
    }

    function clampMainPanelWidth(value) {
      if (!unifiedLayout) return 0;
      var total = Math.max(0, unifiedLayout.getBoundingClientRect().width - 84);
      var min = 320;
      var max = Math.max(min, total - 560);
      return Math.max(min, Math.min(max, Math.round(value || min)));
    }

    function clampThreadRailWidth(value) {
      if (!chatShell) return 244;
      var total = Math.max(0, chatShell.getBoundingClientRect().width - 12);
      var min = 188;
      var max = Math.max(min, Math.min(420, total - 360));
      return Math.max(min, Math.min(max, Math.round(value || 244)));
    }

    function setMainPanelWidth(value, persist) {
      var width = clampMainPanelWidth(value);
      unifiedRoot.style.setProperty('--main-left-size', width + 'px');
      if (persist) writeStoredNumber(MAIN_SPLIT_KEY, width);
    }

    function resetMainPanelWidth() {
      unifiedRoot.style.removeProperty('--main-left-size');
      clearStoredNumber(MAIN_SPLIT_KEY);
    }

    function setThreadRailWidth(value, persist) {
      var width = clampThreadRailWidth(value);
      unifiedRoot.style.setProperty('--thread-rail-w', width + 'px');
      if (persist) writeStoredNumber(THREAD_SPLIT_KEY, width);
    }

    function resetThreadRailWidth() {
      unifiedRoot.style.removeProperty('--thread-rail-w');
      clearStoredNumber(THREAD_SPLIT_KEY);
    }

    function applyStoredPanelSizes() {
      var mainWidth = readStoredNumber(MAIN_SPLIT_KEY);
      if (mainWidth != null && isWide()) setMainPanelWidth(mainWidth, false);

      var railWidth = readStoredNumber(THREAD_SPLIT_KEY);
      if (railWidth != null && window.matchMedia('(min-width: 981px)').matches) setThreadRailWidth(railWidth, false);
    }

    function installHorizontalResizer(handle, opts) {
      if (!handle) return;
      var state = null;

      function finishResize(event) {
        if (!state) return;
        if (event && state.pointerId != null && event.pointerId != null && event.pointerId !== state.pointerId) return;
        document.body.classList.remove('is-resizing-layout');
        opts.persist(opts.current());
        state = null;
      }

      handle.addEventListener('pointerdown', function (event) {
        if (!opts.enabled()) return;
        event.preventDefault();
        state = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startValue: opts.current(),
        };
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-layout');
      });

      handle.addEventListener('pointermove', function (event) {
        if (!state || event.pointerId !== state.pointerId) return;
        opts.setFromDrag(state.startValue, event.clientX - state.startX);
      });

      handle.addEventListener('pointerup', finishResize);
      handle.addEventListener('pointercancel', finishResize);
      handle.addEventListener('dblclick', function () {
        if (!opts.enabled()) return;
        opts.reset();
      });
      handle.addEventListener('keydown', function (event) {
        if (!opts.enabled()) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
        event.preventDefault();
        if (event.key === 'Home') {
          opts.reset();
          return;
        }
        var delta = event.key === 'ArrowRight' ? 24 : -24;
        opts.setFromKeyboard(delta);
      });
      window.addEventListener('pointerup', finishResize);
    }

    installHorizontalResizer(mainPanelResizer, {
      enabled: function () { return isWide(); },
      current: function () { return panelTrace.getBoundingClientRect().width; },
      setFromDrag: function (startValue, delta) { setMainPanelWidth(startValue - delta, false); },
      setFromKeyboard: function (delta) { setMainPanelWidth(panelTrace.getBoundingClientRect().width - delta, true); },
      persist: function (value) { setMainPanelWidth(value, true); },
      reset: resetMainPanelWidth,
    });

    installHorizontalResizer(threadRailResizer, {
      enabled: function () { return window.matchMedia('(min-width: 981px)').matches; },
      current: function () { return threadRail.getBoundingClientRect().width; },
      setFromDrag: function (startValue, delta) { setThreadRailWidth(startValue + delta, false); },
      setFromKeyboard: function (delta) { setThreadRailWidth(threadRail.getBoundingClientRect().width + delta, true); },
      persist: function (value) { setThreadRailWidth(value, true); },
      reset: resetThreadRailWidth,
    });

    function setSettingsOpen(open) {
      settingsBackdrop.classList.toggle('is-open', open);
      settingsDrawer.classList.toggle('is-open', open);
      settingsBackdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
      settingsDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    openSettingsBtn.addEventListener('click', function () {
      setSettingsOpen(true);
      refreshManagementPanels();
    });
    closeSettingsBtn.addEventListener('click', function () { setSettingsOpen(false); });
    settingsBackdrop.addEventListener('click', function () { setSettingsOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && settingsDrawer.classList.contains('is-open')) setSettingsOpen(false);
    });

    function formatThreadTime(value) {
      if (!value) return '';
      try {
        return new Date(value).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch (e) {
        return String(value);
      }
    }

    function getActiveThread() {
      return threads.find(function (thread) { return thread.chatJid === chatJid; }) || null;
    }

    function updateWorkspaceHeader() {
      var t = T();
      var active = getActiveThread();
      var title = active && active.title ? active.title : t.chatTitle;
      var hint = active && active.workspaceFolder
        ? compactWorkspaceLabel(active.workspaceFolder)
        : t.chatHintTpl.replace('{name}', assistantName);
      document.getElementById('chatTitle').textContent = title;
      document.getElementById('chatHint').textContent = hint;
      if (workspaceEyebrowEl) workspaceEyebrowEl.textContent = t.workspaceEyebrow;
    }

    function syncGroupSelectionToActiveThread(force) {
      if (!groupSel) return;
      var active = getActiveThread();
      var desired = active && active.workspaceFolder ? active.workspaceFolder : '';
      if (!desired) return;
      var exists = Array.prototype.some.call(groupSel.options, function (o) { return o.value === desired; });
      if (!exists) return;
      if (force || !groupSel.value) groupSel.value = desired;
    }

    function artifactKind(nameOrUrl) {
      var value = String(nameOrUrl || '').toLowerCase();
      if (/\.(png|jpe?g|gif|webp|svg)(?:$|[?#])/.test(value)) return 'image';
      if (/\.pdf(?:$|[?#])/.test(value)) return 'pdf';
      return 'file';
    }

    function collectArtifacts(messages) {
      var seen = {};
      var list = [];

      function pushArtifact(url, name, timestamp, source) {
        if (!url || seen[url]) return;
        seen[url] = true;
        list.push({
          url: url,
          name: name || (url.split('/').pop() || url),
          kind: artifactKind(name || url),
          timestamp: timestamp || '',
          source: source || 'message',
        });
      }

      for (var i = messages.length - 1; i >= 0; i--) {
        var msg = messages[i];
        var text = String(msg.content || '');
        var upload = parseUploadMessage(text);
        if (upload) pushArtifact(upload.previewUrl, upload.filename, msg.timestamp, 'upload');
        var files = extractFileLinks(text);
        for (var f = 0; f < files.length; f++) {
          pushArtifact(files[f], files[f].split('/').pop() || files[f], msg.timestamp, 'message');
        }
      }

      return list;
    }

    function syncViewModeButtons() {
      var artifactActive = currentView === 'artifact';
      unifiedRoot.classList.toggle('view-artifact', artifactActive);
      if (viewConversationBtn) viewConversationBtn.setAttribute('aria-selected', artifactActive ? 'false' : 'true');
      if (viewArtifactBtn) viewArtifactBtn.setAttribute('aria-selected', artifactActive ? 'true' : 'false');
    }

    function renderArtifactLists() {
      var t = T();

      function renderItem(artifact, compact) {
        var active = selectedArtifact && selectedArtifact.url === artifact.url ? ' is-active' : '';
        var meta = artifact.timestamp ? esc(formatThreadTime(artifact.timestamp)) : '';
        return '<button type="button" class="artifact-item' + active + '" data-artifact-url="' + escAttr(artifact.url) + '">' +
          '<span class="artifact-item-main">' +
          '<span class="artifact-item-name">' + esc(artifact.name) + '</span>' +
          (compact ? '' : '<span class="artifact-item-meta">' + meta + '</span>') +
          '</span>' +
          '<span class="artifact-item-kind">' + esc(artifact.kind.toUpperCase()) + '</span>' +
          '</button>';
      }

      function renderItems(list, emptyText, compact) {
        if (!list || !list.length) return '<div class="artifact-list-empty">' + esc(emptyText) + '</div>';
        return list.map(function (artifact) { return renderItem(artifact, compact); }).join('');
      }

      function renderGroups(list) {
        if (!list || !list.length) return '<div class="artifact-list-empty">' + esc(t.resultsEmpty) + '</div>';
        var order = ['pdf', 'image', 'file'];
        return order.map(function (kind) {
          var items = list.filter(function (artifact) { return artifact.kind === kind; });
          if (!items.length) return '';
          var open = artifactGroupOpen[kind] !== false ? ' open' : '';
          return '<details class="artifact-group" data-kind="' + escAttr(kind) + '"' + open + '>' +
            '<summary><span class="artifact-group-title">' + esc(artifactGroupLabel(kind)) + '</span>' +
            '<span class="artifact-group-meta">' + esc(String(items.length)) + '</span></summary>' +
            '<div class="artifact-group-body">' + items.map(function (artifact) { return renderItem(artifact, false); }).join('') + '</div>' +
            '</details>';
        }).join('');
      }

      if (recentFileListEl) recentFileListEl.innerHTML = renderItems(artifacts.slice(0, 4), t.recentFilesEmpty, true);
      if (resultListEl) resultListEl.innerHTML = renderGroups(artifacts);
    }

    function renderArtifactStage() {
      var t = T();
      if (!artifactStage || !artifactPreviewEl || !artifactEmptyEl) return;
      syncViewModeButtons();
      if (currentView !== 'artifact') {
        artifactStage.classList.remove('is-active');
        artifactPreviewEl.innerHTML = '';
        artifactEmptyEl.classList.remove('is-hidden');
        artifactEmptyEl.textContent = t.artifactEmpty;
        return;
      }
      artifactStage.classList.add('is-active');
      if (!selectedArtifact && artifacts.length) selectedArtifact = artifacts[0];
      if (!selectedArtifact) {
        artifactPreviewEl.innerHTML = '';
        artifactEmptyEl.classList.remove('is-hidden');
        artifactEmptyEl.textContent = t.artifactEmpty;
        return;
      }

      artifactEmptyEl.classList.add('is-hidden');
      artifactEmptyEl.textContent = '';
      if (selectedArtifact.kind === 'image') {
        artifactPreviewEl.innerHTML = '<div class="artifact-frame artifact-frame-image"><img src="' + escAttr(selectedArtifact.url) + '" alt="' + escAttr(selectedArtifact.name) + '"></div>';
        return;
      }
      if (selectedArtifact.kind === 'pdf') {
        artifactPreviewEl.innerHTML = '<div class="artifact-frame artifact-frame-pdf"><iframe src="' + escAttr(selectedArtifact.url) + '" title="' + escAttr(selectedArtifact.name) + '"></iframe></div>';
        return;
      }
      artifactPreviewEl.innerHTML =
        '<div class="artifact-generic-card">' +
        '<div class="artifact-generic-title">' + esc(selectedArtifact.name) + '</div>' +
        '<div class="file-actions">' +
        '<a class="file-button" href="' + escAttr(selectedArtifact.url) + '" target="_blank" rel="noreferrer">' + esc(t.openFile) + '</a>' +
        '<a class="file-button" href="' + escAttr(selectedArtifact.url) + '" download>' + esc(t.downloadFile) + '</a>' +
        '</div>' +
        '</div>';
    }

    function setViewMode(mode) {
      var nextView = mode === 'artifact' ? 'artifact' : 'conversation';
      if (currentView !== 'artifact' && nextView === 'artifact') {
        preArtifactComposerHeight = input.getBoundingClientRect().height;
        if (preArtifactComposerHeight > 88) setComposerHeight(74, false);
      } else if (currentView === 'artifact' && nextView !== 'artifact' && preArtifactComposerHeight) {
        setComposerHeight(preArtifactComposerHeight, false);
      }
      currentView = nextView;
      syncWorkspaceMode();
      renderArtifactLists();
      renderArtifactStage();
    }

    function selectArtifact(url) {
      if (!url) return;
      selectedArtifact = artifacts.find(function (artifact) { return artifact.url === url; }) || {
        url: url,
        name: url.split('/').pop() || url,
        kind: artifactKind(url),
      };
      setViewMode('artifact');
    }

    function stopChatSse() {
      if (chatEs) {
        chatEs.close();
        chatEs = null;
      }
    }

    function renderThreads() {
      if (!threadListEl) return;
      var t = T();
      updateWorkspaceHeader();
      if (!threads.length) {
        threadListEl.innerHTML = '<div class="thread-empty">' + esc(t.threadEmpty) + '</div>';
        return;
      }
      threadListEl.innerHTML = threads.map(function (thread) {
        var active = thread.chatJid === chatJid ? ' is-active' : '';
        var title = thread.title || t.threadUntitled;
        var metaTime = formatThreadTime(thread.lastActivity || thread.addedAt);
        var workspaceLabel = compactWorkspaceLabel(thread.workspaceFolder || '');
        var meta = workspaceLabel
          ? ('<span title="' + escAttr(thread.workspaceFolder || '') + '">' + esc(workspaceLabel) + '</span><span>' + esc(metaTime) + '</span>')
          : ('<span></span><span>' + esc(metaTime) + '</span>');
        return '<div class="thread-item' + active + '" data-chat-jid="' + esc(thread.chatJid) + '" role="button" tabindex="0">' +
          '<div class="thread-item-row">' +
          '<div class="thread-item-main">' +
          '<div class="thread-item-title">' + esc(title) + '</div>' +
          '<div class="thread-item-meta">' + meta + '</div>' +
          '</div>' +
          '<div class="thread-item-actions">' +
          '<button type="button" class="thread-action" data-thread-action="rename" data-chat-jid="' + esc(thread.chatJid) + '" title="' + esc(t.threadRenameAction) + '">✎</button>' +
          '<button type="button" class="thread-action" data-thread-action="archive" data-chat-jid="' + esc(thread.chatJid) + '" title="' + esc(t.threadArchiveAction) + '">×</button>' +
          '</div>' +
          '</div>' +
          '</div>';
      }).join('');
    }

    async function refreshThreads() {
      try {
        var res = await fetch('/api/threads', { headers: authHeaders() });
        if (!res.ok) return;
        var data = await res.json();
        threads = Array.isArray(data.threads) ? data.threads : [];
        if (!threads.some(function (thread) { return thread.chatJid === chatJid; }) && chatJid !== DEFAULT_CHAT_JID && threads[0]) {
          chatJid = threads[0].chatJid;
        }
        if (jidEl) jidEl.textContent = chatJid;
        syncGroupSelectionToActiveThread(true);
        renderThreads();
      } catch (e) {}
    }

    async function setActiveThread(nextChatJid) {
      if (!nextChatJid || nextChatJid === chatJid) return;
      chatJid = nextChatJid;
      lastSignature = '';
      messagesEl.innerHTML = '';
      if (jidEl) jidEl.textContent = chatJid;
      try { localStorage.setItem(THREAD_KEY, chatJid); } catch (e) {}
      renderThreads();
      syncGroupSelectionToActiveThread(true);
      stopPolling();
      stopChatSse();
      await refreshMessages();
      loadTrace();
      await refreshManagementPanels();
      connectChatSse();
    }

    async function renameThread(threadChatJid) {
      var current = threads.find(function (thread) { return thread.chatJid === threadChatJid; });
      var nextTitle = window.prompt(T().threadRenamePrompt, current && current.title ? current.title : '');
      if (nextTitle === null) return;
      nextTitle = nextTitle.trim();
      if (!nextTitle) return;
      try {
        var res = await fetch('/api/threads/' + encodeURIComponent(threadChatJid), {
          method: 'PATCH',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ title: nextTitle }),
        });
        if (!res.ok) throw new Error(T().threadRenameFail);
        await refreshThreads();
      } catch (e) {
        setStatus(e && e.message ? e.message : T().threadRenameFail);
      }
    }

    async function archiveThread(threadChatJid) {
      if (!window.confirm(T().threadArchiveConfirm)) return;
      try {
        var wasActive = chatJid === threadChatJid;
        var res = await fetch('/api/threads/' + encodeURIComponent(threadChatJid), {
          method: 'DELETE',
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error(T().threadArchiveFail);
        var data = await res.json();
        await refreshThreads();
        if (data.nextChatJid && wasActive) {
          chatJid = '';
          await setActiveThread(data.nextChatJid);
        } else if (wasActive && threads[0]) {
          chatJid = '';
          await setActiveThread(threads[0].chatJid);
        }
      } catch (e) {
        setStatus(e && e.message ? e.message : T().threadArchiveFail);
      }
    }

    function render(messages) {
      var signature = buildMessageSignature(messages);
      if (signature === lastSignature) return;
      lastSignature = signature;
      var t = T();
      messagesEl.innerHTML = messages.map(function (msg) {
        var kind = msg.is_from_me ? 'bot' : 'user';
        var name = msg.is_from_me ? assistantName : (msg.sender_name || t.userFallback);
        var role = msg.is_from_me ? t.roleAssistant : t.roleYou;
        var copyBtn = msg.is_from_me
          ? '<button type="button" class="copy-btn" data-copy="' + escAttr(encodeURIComponent(String(msg.content))) + '">' + esc(t.copy) + '</button>'
          : '';
        return '<article class="bubble ' + kind + '"><div class="meta"><span class="badge">' + esc(role) + '</span>' +
          esc(name) + ' · ' + esc(msg.timestamp) + copyBtn + '</div><div class="content">' + renderBody(msg.content) + '</div></article>';
      }).join('');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderBody(text) {
      var upload = parseUploadMessage(text);
      if (upload) return renderUploadCard(upload);
      var html = markdownToSafeHtml(String(text));
      var files = extractFileLinks(text);
      return html + renderFileActions(files);
    }

    function parseUploadMessage(text) {
      var lines = String(text).split('\n');
      var fileLine = lines.find(function (line) { return line.startsWith('Uploaded file: '); });
      var workspaceLine = lines.find(function (line) { return line.startsWith('Workspace path: '); });
      var previewLine = lines.find(function (line) { return line.startsWith('Preview URL: '); });
      if (!fileLine || !workspaceLine || !previewLine) return null;
      return {
        filename: fileLine.slice('Uploaded file: '.length),
        workspacePath: workspaceLine.slice('Workspace path: '.length),
        previewUrl: previewLine.slice('Preview URL: '.length),
      };
    }

    function renderUploadCard(file) {
      var t = T();
      var escapedName = esc(file.filename);
      var escapedPath = esc(file.workspacePath);
      var escapedPreview = esc(file.previewUrl);
      var isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(file.filename);
      var preview = isImage ? '<img class="preview" src="' + escapedPreview + '" alt="' + escapedName + '">' : '';
      return '<section class="file-card"><div class="file-title">' + esc(t.uploadedPrefix) + escapedName + '</div><div class="file-path">' + escapedPath + '</div>' + preview +
        '<div class="file-actions"><button type="button" class="file-button file-button-accent" data-artifact-url="' + escapedPreview + '">' + esc(t.previewInStage) + '</button>' +
        '<a class="file-button" href="' + escapedPreview + '" target="_blank" rel="noreferrer">' + esc(t.openFile) + '</a>' +
        '<a class="file-button" href="' + escapedPreview + '" download>' + esc(t.download) + '</a></div></section>';
    }

    async function refreshMessages() {
      try {
        var res = await fetch('/api/messages?scope=chat&chatJid=' + encodeURIComponent(chatJid));
        if (!res.ok) return;
        var data = await res.json();
        currentMessages = data.messages || [];
        artifacts = collectArtifacts(currentMessages);
        if (selectedArtifact && !artifacts.some(function (artifact) { return artifact.url === selectedArtifact.url; })) {
          selectedArtifact = artifacts[0] || null;
        }
        syncWorkspaceMode();
        renderArtifactLists();
        renderArtifactStage();
        render(currentMessages);
      } catch (e) {}
    }

    if (messagesEl) {
      messagesEl.addEventListener('click', async function (event) {
        var artifactTrigger = event.target && event.target.closest ? event.target.closest('[data-artifact-url]') : null;
        if (artifactTrigger) {
          event.preventDefault();
          selectArtifact(artifactTrigger.getAttribute('data-artifact-url'));
          return;
        }
        var btn = event.target && event.target.closest ? event.target.closest('.copy-btn') : null;
        if (!btn) return;
        event.preventDefault();
        var payload = btn.getAttribute('data-copy') || '';
        var raw = '';
        try { raw = decodeURIComponent(payload); } catch (e) { raw = payload; }
        var t = T();
        try {
          await navigator.clipboard.writeText(raw);
          btn.textContent = t.copied;
          setTimeout(function () { btn.textContent = t.copy; }, 1200);
        } catch (e2) {
          btn.textContent = t.copyFail;
          setTimeout(function () { btn.textContent = t.copy; }, 1200);
        }
      });
    }

    function bindArtifactListClicks(container) {
      if (!container) return;
      container.addEventListener('click', function (event) {
        var button = event.target && event.target.closest ? event.target.closest('[data-artifact-url]') : null;
        if (!button) return;
        event.preventDefault();
        selectArtifact(button.getAttribute('data-artifact-url'));
      });
    }

    bindArtifactListClicks(recentFileListEl);
    bindArtifactListClicks(resultListEl);

    if (resultListEl) {
      resultListEl.addEventListener('toggle', function (event) {
        var details = event.target;
        if (!details || !details.classList || !details.classList.contains('artifact-group')) return;
        artifactGroupOpen[details.getAttribute('data-kind') || 'file'] = details.open;
      }, true);
    }

    if (welcomeSuggestionsEl) {
      welcomeSuggestionsEl.addEventListener('click', function (event) {
        var button = event.target && event.target.closest ? event.target.closest('[data-prompt]') : null;
        if (!button) return;
        event.preventDefault();
        input.value = button.getAttribute('data-prompt') || '';
        input.focus();
      });
    }

    if (viewConversationBtn) {
      viewConversationBtn.addEventListener('click', function () { setViewMode('conversation'); });
    }
    if (viewArtifactBtn) {
      viewArtifactBtn.addEventListener('click', function () { setViewMode('artifact'); });
    }
    if (threadSectionToggle) {
      threadSectionToggle.addEventListener('click', function () {
        threadSectionOpen = !threadSectionOpen;
        try { localStorage.setItem(THREAD_SECTION_OPEN_KEY, threadSectionOpen ? '1' : '0'); } catch (e) {}
        syncRailSections();
      });
    }
    if (recentFilesSectionToggle) {
      recentFilesSectionToggle.addEventListener('click', function () {
        filesSectionOpen = !filesSectionOpen;
        try { localStorage.setItem(FILES_SECTION_OPEN_KEY, filesSectionOpen ? '1' : '0'); } catch (e) {}
        syncRailSections();
      });
    }

    function startPolling() {
      if (pollTimer) return;
      setChatConn('poll');
      pollTimer = setInterval(refreshMessages, 2000);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function connectChatSse() {
      try {
        chatEs = new EventSource('/api/events?chatJid=' + encodeURIComponent(chatJid));
        chatEs.onopen = function () { setChatConn('sse'); stopPolling(); };
        chatEs.onmessage = function () { refreshMessages(); };
        chatEs.onerror = function () {
          if (chatEs) { chatEs.close(); chatEs = null; }
          setChatConn('poll');
          startPolling();
        };
      } catch (e) { startPolling(); }
    }

    if (threadListEl) {
      threadListEl.addEventListener('click', async function (event) {
        var actionButton = event.target && event.target.closest ? event.target.closest('[data-thread-action]') : null;
        if (actionButton) {
          event.preventDefault();
          event.stopPropagation();
          var action = actionButton.getAttribute('data-thread-action');
          var actionChatJid = actionButton.getAttribute('data-chat-jid');
          if (!action || !actionChatJid) return;
          if (action === 'rename') {
            await renameThread(actionChatJid);
          } else if (action === 'archive') {
            await archiveThread(actionChatJid);
          }
          return;
        }
        var button = event.target && event.target.closest ? event.target.closest('.thread-item') : null;
        if (!button) return;
        var nextChatJid = button.getAttribute('data-chat-jid');
        if (nextChatJid) await setActiveThread(nextChatJid);
      });
      threadListEl.addEventListener('keydown', async function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var item = event.target && event.target.closest ? event.target.closest('.thread-item') : null;
        if (!item) return;
        event.preventDefault();
        var nextChatJid = item.getAttribute('data-chat-jid');
        if (nextChatJid) await setActiveThread(nextChatJid);
      });
    }

    if (newThreadBtn) {
      newThreadBtn.addEventListener('click', async function () {
        var title = window.prompt(T().newThreadPrompt, '');
        if (title === null) return;
        newThreadBtn.disabled = true;
        try {
          var res = await fetch('/api/threads', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
            body: JSON.stringify({ title: title }),
          });
          if (!res.ok) throw new Error('THREAD_CREATE_FAIL');
          var data = await res.json();
          await refreshThreads();
          if (data.thread && data.thread.chatJid) {
            await setActiveThread(data.thread.chatJid);
          }
        } catch (e) {
          setStatus(T().threadCreateFail);
        } finally {
          newThreadBtn.disabled = false;
        }
      });
    }

    if (manageRefreshBtn) {
      manageRefreshBtn.addEventListener('click', function () {
        refreshManagementPanels();
      });
    }

    if (manageCommandBtn) {
      manageCommandBtn.addEventListener('click', function () {
        runManageCommand((manageCommandInput && manageCommandInput.value || '').trim());
      });
    }

    if (manageCommandInput) {
      manageCommandInput.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        runManageCommand(manageCommandInput.value.trim());
      });
    }

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileNameEl.textContent = file ? file.name : T().noFile;
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var text = input.value.trim();
      var file = fileInput.files && fileInput.files[0];
      if (!text && !file) return;
      sendBtn.disabled = true;
      try {
        if (file) {
          setStatus(T().uploading);
          var upRes = await fetch('/api/upload?chatJid=' + encodeURIComponent(chatJid), {
            method: 'POST',
            headers: { 'x-file-name': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' },
            body: file,
          });
          if (!upRes.ok) throw new Error('UPLOAD_FAIL');
          fileInput.value = '';
          fileNameEl.textContent = T().noFile;
        }
        if (text) {
          var res2 = await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatJid: chatJid, text: text }),
          });
          if (!res2.ok) throw new Error('SEND_FAIL');
          input.value = '';
        }
        setStatus('');
        await refreshMessages();
      } catch (e) {
        var msg = e && e.message;
        if (msg === 'UPLOAD_FAIL') setStatus(T().uploadFail);
        else if (msg === 'SEND_FAIL') setStatus(T().sendFail);
        else setStatus(String(msg || ''));
      } finally {
        sendBtn.disabled = false;
      }
    });

    function setStatus(text) { statusEl.textContent = text || ''; }

    (async function initThreadsAndChat() {
      try {
        await refreshThreads();
        if (jidEl) jidEl.textContent = chatJid;
        renderThreads();
      } catch (e) {}
      refreshMessages();
      refreshManagementPanels();
      connectChatSse();
    })();
})();
