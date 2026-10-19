/**
 * Cat Café Lab · 前端主程序
 *
 * - 零框架 / 零构建 / 原生 ESM
 * - 初始化 GET /api/state，之后靠 SSE /api/events 收全量快照（{seq, state}）
 * - 所有内容都来自服务端，不在前端伪造消息
 *
 * 渲染策略：状态很小，按 section 做签名缓存；timeline 增量 append（保留动画和滚动位置）。
 */

import { avatarSvg, userAvatarSvg, brandMarkSvg } from "./avatars.js";

// ── 常量 ────────────────────────────────────────────────────────────────

const STAGES = [
  { id: "intake", label: "接单" },
  { id: "planning", label: "规划" },
  { id: "working", label: "实现" },
  { id: "reviewing", label: "评审" },
  { id: "revising", label: "修订" },
  { id: "done", label: "完成" },
];

const STAGE_INDEX = new Map(STAGES.map((stage, index) => [stage.id, index]));
const STAGE_LABEL = new Map(STAGES.map((stage) => [stage.id, stage.label]));

const HANDOFF_FIELDS = [
  { key: "what", label: "做什么", wide: true },
  { key: "why", label: "为什么" },
  { key: "tradeoff", label: "取舍" },
  { key: "openQuestions", label: "未决问题" },
  { key: "nextAction", label: "下一步" },
];

const ARTIFACT_KIND_LABEL = {
  spec: "规格",
  design: "设计",
  patch: "实现",
  review: "评审",
  decision: "决策",
};

const MEMORY_KIND_LABEL = {
  decision: "决策",
  lesson: "教训",
  preference: "偏好",
};

const MEMORY_GROUPS = ["decision", "lesson", "preference"];

const TOOL_META = {
  read_file: { icon: "📄", verb: "读取文件" },
  write_file: { icon: "✍️", verb: "写入文件" },
  list_files: { icon: "📁", verb: "列出文件" },
  run_command: { icon: "▶️", verb: "运行命令" },
};

const TOOL_OUTPUT_MAX = 4000;

/** toolCallId → 已渲染的 .tool-card 节点（补位卡与真实消息卡复用，保证原地更新）。 */
const toolCardNodes = new Map();

const FALLBACK_STALL_MS = 12000;
const MAX_INPUT = 2000;
const TAB_IDS = ["chat", "cats", "work"];

const TIME_FMT = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const FULL_FMT = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// ── 状态 ────────────────────────────────────────────────────────────────

const app = {
  state: null,
  lastSeq: -1,
  conn: "connecting", // connecting | online | offline
  roomId: "room_cafe",
  tab: "chat",
  selectedTaskId: null,
  sending: false,
  creating: false,
  composing: false,
  unread: 0,
  /** artifactId -> 是否展开（重建右栏后恢复用户的展开状态） */
  expanded: new Set(),
  timeline: { ids: [], lastTaskId: null, initialized: false },
  sig: {
    roster: null,
    tasks: null,
    progress: null,
    handoffs: null,
    artifacts: null,
    memory: null,
    rooms: null,
    currentWorkspace: null,
  },
  mention: { open: false, items: [], index: 0, tokenStart: -1, lastKey: "" },
  sse: null,
  sseOpened: false,
  ticker: null,
  /** 卡住判定的时间阈值，优先取 /api/health 的 stallMs。 */
  stallMs: FALLBACK_STALL_MS,
  /** 全局 LLM 模型名（来自 /api/settings），用于「跟随全局」标签。 */
  globalModel: "",
  /** /api/tools 工具目录（用于来源徽标与每猫权限）。 */
  toolCatalog: [],
  /** /api/skills 技能目录。 */
  skillCatalog: [],
  /** 当前选中/打开的房间选择弹窗状态。 */
  roomPickerOpen: false,
};

/** 设置面板的临时状态（打开时才加载，关闭即丢弃草稿）。 */
const settingsState = {
  streamingAvailable: null,
  loading: false,
  ready: false,
  data: null,
  saving: false,
  testing: false,
  resetting: false,
  resetConfirm: false,
  clearKeyRequested: false,
};

/** 猫猫档案编辑对话框状态。 */
const catEditState = { catId: null, saving: false, accent: "#D9A066" };

/** 剧本库 / 新任务场景选择的临时状态。 */
const scenarioState = {
  items: [],
  loaded: false,
  loading: false,
  error: "",
  importOpen: false,
  importing: false,
  deleteConfirmId: null,
  deleteError: "",
  deleteErrorId: "",
  taskToken: 0,
  taskItems: [],
};

/** 审批队列 / pending 工具卡 / Needs Me 的临时状态。 */
const approvalState = {
  available: null,
  loading: false,
  pending: [],
  error: "",
  lastToolSignature: "",
};

/** 审批等待超时：与服务端一致，5 分钟后自动拒绝。 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** 任务恢复弹窗状态。 */
const taskRecoveryState = {
  taskId: null,
  action: "",
  saving: false,
  error: "",
};

/** 任务轨迹面板状态。 */
const traceState = {
  taskId: null,
  loading: false,
  available: null,
  data: null,
  error: "",
  filter: "all",
  collapsedStages: new Set(),
  requestId: 0,
};

/** 模型分工档案状态。 */
const modelProfileState = {
  loading: false,
  loaded: false,
  available: null,
  profiles: [],
  suggested: "",
  selectedId: null,
  applyingId: null,
  pendingId: null,
  error: "",
};

/** 流式草稿气泡 DOM 缓存。 */
const draftBubbleState = {
  node: null,
  roomId: null,
  catId: null,
  text: "",
  hideTimer: null,
};

/** 工作区 / 房间 / git 面板状态。 */
const workspaceState = {
  loading: false,
  loaded: false,
  available: null,
  list: [],
  error: "",
  git: {},
  gitLoading: {},
  formOpen: false,
  saving: false,
  deleteConfirmId: "",
  rowErrors: {},
  expanded: new Set(),
  panel: {
    id: null,
    open: false,
    loading: false,
    error: "",
    info: null,
    diff: "",
    diffLoading: false,
    diffError: "",
    files: [],
    filesLoading: false,
    filesError: "",
  },
};

const roomState = {
  creating: false,
  workspacesReady: false,
};

/** 房间管理（菜单 / 编辑 / 删除）状态。 */
const roomAdminState = {
  roomId: null,
  mode: "",
  available: null,
  probing: false,
  saving: false,
  deleting: false,
};

/** 测试中心：全局运行状态、SSE 日志缓存与面板状态。 */
const TEST_KIND_LABEL = {
  unit: "单元测试",
  real: "真实模型矩阵",
  scenario: "单场景",
};

const TEST_STATUS_LABEL = {
  running: "运行中",
  passed: "通过",
  failed: "失败",
  cancelled: "已取消",
  idle: "空闲",
};

const testCenterState = {
  available: null,
  loading: false,
  open: false,
  runs: [],
  running: new Set(),
  liveId: null,
  selectedId: null,
  details: new Map(),
  detailLoading: false,
  socket: null,
  socketOpen: false,
  disconnected: false,
  error: "",
  polling: false,
  lastPollAt: 0,
  onlyFailures: false,
  autoScroll: true,
  followLive: true,
  lineNumbers: true,
  rendered: { runId: "", count: 0, filter: false, lineNumbers: true },
};

/** 当前任务 git 面板 / 弹窗状态。 */
const taskGitState = {
  taskId: null,
  sig: "",
  loading: false,
  available: null,
  info: null,
  error: "",
  requestId: 0,
  workspaceSig: "",
};

const taskDiffModal = {
  taskId: null,
  loading: false,
  info: null,
  error: "",
  requestId: 0,
};

const taskCommitModal = {
  taskId: null,
  saving: false,
};

const taskRollbackModal = {
  taskId: null,
  saving: false,
};

/** MCP server 管理状态。 */
const mcpState = {
  loading: false,
  loaded: false,
  available: null,
  servers: [],
  error: "",
  formOpen: false,
  saving: false,
  busy: {},
  results: {},
  deleteConfirmId: "",
};

/** 每猫工具权限 / 技能弹窗状态。 */
const catAccessState = {
  catId: null,
  tools: [],
  skills: [],
  selectedTools: new Set(),
  selectedSkills: new Set(),
  loading: false,
  saving: false,
  toolsError: "",
  skillsError: "",
};

/** 沙盒面板 / 文件查看 / 重置 的临时状态。 */
const sandboxState = {
  loading: false,
  loaded: false,
  available: null,
  error: "",
  root: "",
  files: [],
  resetConfirm: false,
  resetting: false,
  resetError: "",
  refreshTimer: null,
  lastToolSignature: "",
  file: { open: false, loading: false, path: "", content: "", error: "" },
};

const els = {};

// ── 小工具 ──────────────────────────────────────────────────────────────

function $(selector, root) {
  return (root ?? document).querySelector(selector);
}

function $$(selector, root) {
  return Array.from((root ?? document).querySelectorAll(selector));
}

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "class") {
        node.className = String(value);
      } else if (key === "text") {
        node.textContent = String(value);
      } else if (key === "html") {
        // 只用于本地生成的 SVG 字符串，不含用户输入。
        node.innerHTML = String(value);
      } else if (key === "style") {
        if (typeof value === "object") Object.assign(node.style, value);
        else node.setAttribute("style", String(value));
      } else if (key === "dataset") {
        Object.assign(node.dataset, value);
      } else if (value === true) {
        node.setAttribute(key, "");
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.appendChild(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeCss(color, fallback = "#D9A066") {
  const value = String(color ?? "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback;
}

function fmtTime(ts) {
  if (!ts) return "--:--";
  try {
    return TIME_FMT.format(new Date(ts));
  } catch {
    return "--:--";
  }
}

function fmtFull(ts) {
  try {
    return FULL_FMT.format(new Date(ts));
  } catch {
    return "";
  }
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function isCompactViewport() {
  return Boolean(window.matchMedia?.("(max-width: 860px)").matches);
}

function isNearBottom(el) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}

function scrollToBottom(smooth) {
  const el = els.timelineScroll;
  if (!el) return;
  const behavior = smooth && !prefersReducedMotion() ? "smooth" : "auto";
  requestAnimationFrame(() => {
    el.scrollTo({ top: el.scrollHeight, behavior });
  });
}

// ── 从 state 里取数据 ───────────────────────────────────────────────────

function currentRoom() {
  const rooms = app.state?.rooms ?? [];
  return rooms.find((room) => room.id === app.roomId) ?? rooms[0] ?? null;
}

function roomCats() {
  const cats = app.state?.cats ?? [];
  const room = currentRoom();
  if (!room) return cats;
  return cats.filter((cat) => room.catIds.includes(cat.id));
}

function catById(id) {
  if (!id) return null;
  return (app.state?.cats ?? []).find((cat) => cat.id === id) ?? null;
}

function taskById(id) {
  if (!id) return null;
  return (app.state?.tasks ?? []).find((task) => task.id === id) ?? null;
}

function roomMessages() {
  const room = currentRoom();
  const messages = app.state?.messages ?? [];
  return room ? messages.filter((message) => message.roomId === room.id) : messages;
}

function currentDraft() {
  const room = currentRoom();
  if (!room) return null;
  const draft = app.state?.drafts?.[room.id];
  if (!draft || typeof draft !== "object") return null;
  if (typeof draft.catId !== "string" || typeof draft.text !== "string") return null;
  return draft;
}

// ── 工作区 / 房间作用域 ─────────────────────────────────────────────────

const DEFAULT_WORKSPACE_ID = "ws_sandbox";
const DEFAULT_WORKSPACE = {
  id: DEFAULT_WORKSPACE_ID,
  name: "猫咖沙盒",
  root: "",
  policy: "read-write",
  kind: "sandbox",
  isGit: false,
  createdAt: 0,
  roomCount: 1,
  bound: true,
};

function currentWorkspaceId() {
  return currentRoom()?.workspaceId || DEFAULT_WORKSPACE_ID;
}

function workspaceById(id) {
  if (!id) return null;
  return (workspaceState.list ?? []).find((workspace) => workspace.id === id) ?? null;
}

function currentWorkspace() {
  const id = currentWorkspaceId();
  const found = workspaceById(id);
  if (found) return found;
  if (id === DEFAULT_WORKSPACE_ID) {
    return workspaceState.available === false ? null : DEFAULT_WORKSPACE;
  }
  return null;
}

function workspacePolicyLabel(policy) {
  return policy === "read-write" ? "读写" : "只读";
}

function workspaceRoomBadge(room) {
  const workspace = workspaceById(room.workspaceId ?? DEFAULT_WORKSPACE_ID);
  if (!workspace) {
    if (workspaceState.available === false) return { text: "工作区未就绪", policy: "read-only" };
    return { text: "猫咖沙盒", policy: "read-write" };
  }
  return {
    text:
      workspace.kind === "sandbox"
        ? "猫咖沙盒"
        : `${workspace.name} · ${workspacePolicyLabel(workspace.policy)}`,
    policy: workspace.policy,
  };
}

/** 当前房间的任务（消息 / 任务 / 工作台按 roomId 隔离）。 */
function roomTasks() {
  const room = currentRoom();
  const tasks = app.state?.tasks ?? [];
  return room ? tasks.filter((task) => task.roomId === room.id) : tasks;
}

/** 最后一个未完成的任务（猫猫「工作中」状态以此为准）。 */
function latestActiveTask() {
  const tasks = roomTasks();
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    if (tasks[index].status !== "done") return tasks[index];
  }
  return null;
}

/** 工作台 / 进度条展示的任务：优先用户点选的任务，否则最新未完成任务 / 最新任务。 */
function activeTask() {
  const tasks = roomTasks();
  if (app.selectedTaskId) {
    const selected = tasks.find((task) => task.id === app.selectedTaskId);
    if (selected) return selected;
  }
  return latestActiveTask() ?? tasks[tasks.length - 1] ?? null;
}

function catState(catId) {
  const draft = currentDraft();
  if (draft?.catId === catId) return "talking";
  const room = currentRoom();
  const typingCat = room ? app.state?.typing?.[room.id] : null;
  if (typingCat === catId) return "typing";
  const task = latestActiveTask();
  if (task && task.owner === catId) return "working";
  return "sleeping";
}

function isTaskStalled(task) {
  if (!task || task.status === "done") return false;
  // 优先用 driver 明确标出的 stalled（例如漏 @ 导致卡住），
  // 其次才用「阶段内多久没有新动作」的时间阈值（阈值来自 /api/health.stallMs）。
  if (task.status === "stalled") return true;
  return Date.now() - (task.updatedAt || task.createdAt || Date.now()) > app.stallMs;
}

function latestTaskFor(taskId) {
  if (!taskId) return null;
  return taskById(taskId);
}

// ── 数据关联（消息 -> 交接 / 产物 / 评审） ──────────────────────────────

function resolveHandoff(message) {
  const handoffs = app.state?.handoffs ?? [];
  if (message.handoffId) {
    const exact = handoffs.find((handoff) => handoff.id === message.handoffId);
    if (exact) return exact;
  }
  if (!message.taskId) return null;
  const candidates = handoffs
    .filter((handoff) => handoff.taskId === message.taskId && handoff.createdAt <= message.at + 2000)
    .sort((a, b) => a.createdAt - b.createdAt);
  return candidates[candidates.length - 1] ?? null;
}

function resolveArtifact(message) {
  const artifacts = app.state?.artifacts ?? [];
  if (message.artifactId) {
    const exact = artifacts.find((artifact) => artifact.id === message.artifactId);
    if (exact) return exact;
  }
  if (!message.taskId) return null;
  const candidates = artifacts
    .filter((artifact) => artifact.taskId === message.taskId && artifact.createdAt <= message.at + 2000)
    .sort((a, b) => a.createdAt - b.createdAt);
  return candidates[candidates.length - 1] ?? null;
}

/**
 * review 的主路径（与 T1 约定）：
 *   artifact.body 第一行 `verdict: request_changes|approve`，空行后每条
 *   `- [blocker] 标题 — 详情`。
 * 同时容忍 message.text / JSON / 中文启发式。
 */
function resolveReview(message) {
  const artifacts = app.state?.artifacts ?? [];
  let artifact = null;
  if (message.artifactId) artifact = artifacts.find((item) => item.id === message.artifactId) ?? null;
  if (!artifact && message.taskId) {
    const candidates = artifacts
      .filter(
        (item) =>
          item.taskId === message.taskId &&
          item.kind === "review" &&
          item.createdAt <= message.at + 2000,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    artifact = candidates[candidates.length - 1] ?? null;
  }

  const text = String(message.text ?? "");
  const body = String(artifact?.body ?? "");
  const verdict = parseVerdict(body) ?? parseVerdict(text);
  const findings = parseFindings(body).length ? parseFindings(body) : parseFindings(text);
  return { artifact, verdict, findings };
}

function normalizeVerdict(value) {
  const text = String(value ?? "").toLowerCase();
  if (/request|changes|打回|要求修改|需修改|驳回|不通过/.test(text)) return "request_changes";
  if (/approve|通过|放行/.test(text)) return "approve";
  return null;
}

function parseVerdict(source) {
  const text = String(source ?? "");
  if (!text.trim()) return null;
  const explicit =
    /(?:^|\n)\s*(?:verdict|结论|判定)\s*[:：]\s*(approve|request[_\s-]?changes|通过|不通过|打回|要求修改|需修改)/i.exec(
      text,
    );
  if (explicit) return normalizeVerdict(explicit[1]);
  const json = /"verdict"\s*:\s*"([^"]+)"/i.exec(text);
  if (json) return normalizeVerdict(json[1]);
  if (/request[_\s-]?changes|打回|要求修改|需修改|驳回|不通过/i.test(text)) {
    return "request_changes";
  }
  if (/\bapprove[ds]?\b|评审通过/i.test(text)) return "approve";
  return null;
}

function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return String(value ?? "");
  }
}

function parseFindings(source) {
  const text = String(source ?? "");
  if (!text.trim()) return [];
  const findings = [];
  const lineRe =
    /^\s*(?:[-*•·]\s*)?(?:\[|\()?\s*(blocker|minor)\s*(?:\]|\))?\s*(?:[:：\-—–]\s*)?(.*)$/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = lineRe.exec(line);
    if (!match) continue;
    const rest = (match[2] ?? "").trim();
    if (!rest) continue;

    let title = rest;
    let detail = "";
    const split = /^(.*?)\s*(?:—|–|\s-\s|：|:)\s*(.+)$/.exec(rest);
    if (split) {
      title = split[1].trim();
      detail = split[2].trim();
    }
    title = title.replace(/^[「『"']+|[」』"']+$/g, "").trim();
    if (!title) continue;

    findings.push({
      severity: match[1].toLowerCase() === "blocker" ? "blocker" : "minor",
      title: title.slice(0, 180),
      detail: detail.slice(0, 500),
    });
    if (findings.length >= 10) break;
  }

  if (!findings.length) {
    const jsonRe =
      /"severity"\s*:\s*"(blocker|minor)"[\s\S]{0,240}?"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let match;
    while ((match = jsonRe.exec(text)) !== null && findings.length < 10) {
      findings.push({
        severity: match[1],
        title: unescapeJsonString(match[2]).slice(0, 180),
        detail: "",
      });
    }
  }

  return findings;
}

function handoffMissing(card) {
  if (!card) return HANDOFF_FIELDS.map((field) => field.label);
  const missing = [];
  for (const field of HANDOFF_FIELDS) {
    const value = card[field.key];
    if (Array.isArray(value)) {
      if (!value.some((item) => String(item ?? "").trim())) missing.push(field.label);
    } else if (!String(value ?? "").trim()) {
      missing.push(field.label);
    }
  }
  return missing;
}

// ── 启动 ────────────────────────────────────────────────────────────────

async function boot() {
  cacheDom();
  if (els.brandMark) els.brandMark.innerHTML = brandMarkSvg(34);
  bindUi();
  paintChrome();
  renderAll();

  void refreshHealth();
  void refreshGlobalModel();
  void loadWorkspaces().finally(() => void loadWorkspace());
  void loadApprovals();
  void loadToolCatalog();
  void initTestCenter();
  try {
    await refreshState("boot");
  } catch {
    setConn("offline");
  }

  connectEvents();
  startTicker();
}

function cacheDom() {
  els.brandMark = $("#brand-mark");
  els.connPills = $$("[data-conn]");
  els.connTexts = $$("[data-conn-text]");
  els.seqs = $$("[data-seq]");
  els.modes = $$("[data-mode]");
  els.roomName = $("[data-room-name]");
  els.roomTopic = $("[data-room-topic]");
  els.roomList = $("#room-list");
  els.roomCount = $("[data-room-count]");
  els.roomMenuModal = $("#room-menu-modal");
  els.roomMenuSub = $("#room-menu-sub");
  els.roomMenuError = $("#room-menu-error");
  els.roomMenuList = $("#room-menu-list");
  els.roomMenuRetry = $("#room-menu-retry");
  els.roomEditModal = $("#room-edit-modal");
  els.roomEditForm = $("#room-edit-form");
  els.roomEditTitle = $("#room-edit-title");
  els.roomEditSub = $("#room-edit-sub");
  els.roomEditNameField = $("#room-edit-name-field");
  els.roomEditName = $("#room-edit-name");
  els.roomEditTopicField = $("#room-edit-topic-field");
  els.roomEditTopic = $("#room-edit-topic");
  els.roomEditWorkspaceField = $("#room-edit-workspace-field");
  els.roomEditWorkspace = $("#room-edit-workspace");
  els.roomEditWorkspaceHint = $("#room-edit-workspace-hint");
  els.roomEditError = $("#room-edit-error");
  els.roomEditSave = $("#room-edit-save");
  els.roomDeleteModal = $("#room-delete-modal");
  els.roomDeleteSub = $("#room-delete-sub");
  els.roomDeleteCounts = $("#room-delete-counts");
  els.roomDeleteReason = $("#room-delete-reason");
  els.roomDeleteError = $("#room-delete-error");
  els.roomDeleteConfirm = $("#room-delete-confirm");
  els.roomPickerModal = $("#room-picker-modal");
  els.roomPickerList = $("#room-picker-list");
  els.newRoomModal = $("#new-room-modal");
  els.newRoomForm = $("#new-room-form");
  els.newRoomName = $("#new-room-name");
  els.newRoomWorkspace = $("#new-room-workspace");
  els.newRoomTopic = $("#new-room-topic");
  els.newRoomError = $("#new-room-error");
  els.createRoomBtn = $("#create-room-btn");
  els.newRoomWorkspaceHint = $("#new-room-workspace-hint");
  els.taskPivotModal = $("#task-pivot-modal");
  els.taskPivotForm = $("#task-pivot-form");
  els.taskPivotNote = $("#task-pivot-note");
  els.taskPivotError = $("#task-pivot-error");
  els.taskPivotSubmit = $("#task-pivot-submit");
  els.taskCloseModal = $("#task-close-modal");
  els.taskCloseForm = $("#task-close-form");
  els.taskCloseNote = $("#task-close-note");
  els.taskCloseError = $("#task-close-error");
  els.taskCloseSubmit = $("#task-close-submit");
  els.testCenterModal = $("#test-center-modal");
  els.testCenterClose = $("#test-center-close");
  els.testButtons = $$("[data-test-button]");
  els.testDots = $$("[data-test-dot]");
  els.testStatusBadge = $("#test-status-badge");
  els.testStatusText = $("#test-status-text");
  els.testDuration = $("#test-duration");
  els.testExit = $("#test-exit");
  els.testSummary = $("#test-summary");
  els.testError = $("#test-error");
  els.testRunUnit = $("#test-run-unit");
  els.testRunReal = $("#test-run-real");
  els.testScenario = $("#test-scenario");
  els.testRunScenario = $("#test-run-scenario");
  els.testStopBtn = $("#test-stop-btn");
  els.testReturnLive = $("#test-return-live");
  els.testLog = $("#test-log");
  els.testLineNumbers = $("#test-line-numbers");
  els.testFailBtn = $("#test-fail-btn");
  els.testLogHint = $("#test-log-hint");
  els.testBackBottom = $("#test-back-bottom");
  els.testHistoryList = $("#test-history-list");
  els.testRealConfirm = $("#test-real-confirm");
  els.testRealConfirmBtn = $("#test-real-confirm-btn");
  els.testRealError = $("#test-real-error");
  els.taskGitCard = $("#task-git-card");
  els.taskGitState = $("#task-git-state");
  els.taskGitBody = $("#task-git-body");
  els.taskGitHint = $("#task-git-hint");
  els.taskDiffBtn = $("#task-diff-btn");
  els.taskCommitBtn = $("#task-commit-btn");
  els.taskRollbackBtn = $("#task-rollback-btn");
  els.taskDiffModal = $("#task-diff-modal");
  els.taskDiffTitle = $("#task-diff-title");
  els.taskDiffSub = $("#task-diff-sub");
  els.taskDiffMeta = $("#task-diff-meta");
  els.taskDiffError = $("#task-diff-error");
  els.taskDiffStatus = $("#task-diff-status");
  els.taskDiffPre = $("#task-diff-pre");
  els.taskDiffRefresh = $("#task-diff-refresh-btn");
  els.taskCommitModal = $("#task-commit-modal");
  els.taskCommitForm = $("#task-commit-form");
  els.taskCommitSub = $("#task-commit-sub");
  els.taskCommitMessage = $("#task-commit-message");
  els.taskCommitConfirm = $("#task-commit-confirm");
  els.taskCommitError = $("#task-commit-error");
  els.taskCommitSubmit = $("#task-commit-submit");
  els.taskRollbackModal = $("#task-rollback-modal");
  els.taskRollbackInfo = $("#task-rollback-info");
  els.taskRollbackError = $("#task-rollback-error");
  els.taskRollbackConfirm = $("#task-rollback-confirm");
  els.workspaceBranchPerTask = $("#workspace-branch-per-task");
  els.currentWorkspaceBody = $("#current-workspace-body");
  els.currentWorkspacePolicy = $("[data-current-workspace-policy]");
  els.currentWorkspaceGitBtn = $("#current-workspace-git-btn");
  els.sandboxTitle = $("[data-sandbox-title]");
  els.sandboxResetBtn = $("#sandbox-reset-btn");
  els.workspaceList = $("#workspace-list");
  els.workspacesStatus = $("#workspaces-status");
  els.workspaceForm = $("#workspace-form");
  els.workspaceFormToggle = $("#workspace-form-toggle");
  els.workspaceName = $("#workspace-name");
  els.workspacePath = $("#workspace-path");
  els.workspacePolicyInputs = $$('input[name="workspace-policy"]');
  els.workspaceConfirmRow = $("#workspace-confirm-row");
  els.workspaceConfirm = $("#workspace-confirm");
  els.workspaceFormError = $("#workspace-form-error");
  els.workspaceSaveBtn = $("#workspace-save-btn");
  els.workspacesReload = $("#workspaces-reload-btn");
  els.gitModal = $("#git-modal");
  els.gitTitle = $("#git-title");
  els.gitSub = $("#git-sub");
  els.gitError = $("#git-error");
  els.gitMeta = $("#git-meta");
  els.gitStatusPre = $("#git-status-pre");
  els.gitDiffDetails = $("#git-diff-details");
  els.gitDiffPre = $("#git-diff-pre");
  els.gitFileList = $("#git-file-list");
  els.gitFileCount = $("#git-file-count");
  els.gitRefreshBtn = $("#git-refresh-btn");
  els.newTaskRoomHint = $("#new-task-room-hint");
  els.connBanner = $("#conn-banner");
  els.roster = $("#cat-roster");
  els.rosterCount = $("[data-roster-count]");
  els.taskList = $("#task-list");
  els.taskCount = $("[data-task-count]");
  els.timeline = $("#timeline");
  els.timelineScroll = $("#timeline-scroll");
  els.jump = $("#jump-latest");
  els.jumpCount = $("[data-jump-count]");
  els.tabs = $$(".tabbar .tab");
  els.chatTabDot = $("[data-tab-dot]");
  els.typingHint = $("#typing-hint");
  els.typingName = $("[data-typing-name]");
  els.mentionPopup = $("#mention-popup");
  els.composer = $("#composer");
  els.input = $("#composer-input");
  els.sendBtn = $("#send-btn");
  els.charHint = $("[data-char]");
  els.progress = $("#task-progress");
  els.progressHint = $("[data-progress-hint]");
  els.handoffs = $("#handoff-list");
  els.handoffCount = $("[data-handoff-count]");
  els.artifacts = $("#artifact-list");
  els.artifactCount = $("[data-artifact-count]");
  els.memory = $("#memory-list");
  els.memoryCount = $("[data-memory-count]");
  els.modal = $("#new-task-modal");
  els.newTaskForm = $("#new-task-form");
  els.brief = $("#brief-input");
  els.createBtn = $("#create-task-btn");
  els.formError = $("#new-task-error");
  els.modalChips = $$(".chip[data-brief]");
  els.toastStack = $("#toast-stack");

  els.settingsModal = $("#settings-modal");
  els.settingsForm = $("#settings-form");
  els.settingsNotice = $("#settings-notice");
  els.settingsError = $("#settings-error");
  els.settingsInfo = $("#settings-info");
  els.settingsModeInputs = $$('input[name="settings-mode"]');
  els.settingsSpeedInputs = $$('input[name="settings-speed"]');
  els.settingsStreaming = $("#settings-streaming");
  els.settingsStreamingHint = $("#settings-streaming-hint");
  els.settingsBaseUrl = $("#settings-base-url");
  els.settingsModel = $("#settings-model");
  els.settingsApiKey = $("#settings-api-key");
  els.settingsKeyToggle = $("#settings-key-toggle");
  els.settingsKeyStatus = $("#settings-key-status");
  els.settingsKeyHint = $("#settings-key-hint");
  els.settingsClearKey = $("#settings-clear-key");
  els.settingsTemperature = $("#settings-temperature");
  els.settingsTempValue = $("#settings-temp-value");
  els.settingsTestBtn = $("#settings-test-btn");
  els.settingsTestResult = $("#settings-test-result");
  els.settingsModeWarn = $("#settings-mode-warn");
  els.settingsLlmSection = $("#settings-llm-section");
  els.settingsResetBtn = $("#settings-reset-btn");
  els.settingsResetConfirm = $("#settings-reset-confirm");
  els.settingsConfirmReset = $("#settings-confirm-reset");
  els.settingsSaveBtn = $("#settings-save-btn");

  els.taskTraceModal = $("#task-trace-modal");
  els.traceSub = $("#task-trace-sub");
  els.traceSummary = $("#trace-summary");
  els.traceTimeline = $("#trace-timeline");
  els.traceCount = $("#trace-entry-count");
  els.traceError = $("#trace-error");
  els.traceFilters = $$(".trace-filter");
  els.modelProfilesList = $("#model-profile-list");
  els.modelProfilesStatus = $("#model-profiles-status");
  els.modelProfileMode = $("#model-profile-mode");
  els.modelProfileReload = $("#model-profiles-reload");
  els.modelProfileConfirm = $("#model-profile-confirm");
  els.modelProfileConfirmSub = $("#model-profile-confirm-sub");
  els.modelProfileConfirmError = $("#model-profile-confirm-error");
  els.modelProfileApplyBtn = $("#model-profile-apply-btn");
  els.catModelList = $("#cat-model-list");
  els.catEditModal = $("#cat-edit-modal");
  els.catEditForm = $("#cat-edit-form");
  els.catEditAvatar = $("#cat-edit-avatar");
  els.catEditNamePreview = $("#cat-edit-name-preview");
  els.catEditSpecies = $("#cat-edit-species");
  els.catName = $("#cat-name");
  els.catTitle = $("#cat-title");
  els.catPersona = $("#cat-persona");
  els.catCatchphrase = $("#cat-catchphrase");
  els.catGreeting = $("#cat-greeting");
  els.catAccent = $("#cat-accent");
  els.catAccentHex = $("#cat-accent-hex");
  els.catColorSwatches = $("#cat-color-swatches");
  els.catEditError = $("#cat-edit-error");
  els.catSaveBtn = $("#cat-save-btn");

  els.scenarioList = $("#scenario-list");
  els.scenarioStatus = $("#scenario-status");
  els.scenarioImportToggle = $("#scenario-import-toggle");
  els.scenarioImport = $("#scenario-import");
  els.scenarioImportText = $("#scenario-import-text");
  els.scenarioImportSubmit = $("#scenario-import-submit");
  els.scenarioImportError = $("#scenario-import-error");
  els.scenarioImportErrorList = $("#scenario-import-error-list");
  els.scenarioFile = $("#scenario-file");
  els.scenarioFileName = $("#scenario-file-name");
  els.scenarioReload = $("#scenario-reload-btn");

  els.taskScenario = $("#task-scenario");
  els.taskScenarioHint = $("#task-scenario-hint");

  els.settingsToolsToggle = $("#settings-tools-toggle");
  els.settingsToolsHint = $("#settings-tools-hint");
  els.settingsToolApproval = $("#settings-tool-approval");
  els.settingsToolApprovalHint = $("#settings-tool-approval-hint");

  els.needsNodes = $$("[data-needs-me]");
  els.needsCounts = $$("[data-needs-count]");

  els.mcpStatus = $("#mcp-status");
  els.mcpList = $("#mcp-list");
  els.mcpForm = $("#mcp-form");
  els.mcpFormToggle = $("#mcp-form-toggle");
  els.mcpName = $("#mcp-name");
  els.mcpTransport = $("#mcp-transport");
  els.mcpStdioFields = $("#mcp-stdio-fields");
  els.mcpHttpFields = $("#mcp-http-fields");
  els.mcpCommand = $("#mcp-command");
  els.mcpArgs = $("#mcp-args");
  els.mcpUrl = $("#mcp-url");
  els.mcpRisk = $("#mcp-risk");
  els.mcpEnabled = $("#mcp-enabled");
  els.mcpFormError = $("#mcp-form-error");
  els.mcpSaveBtn = $("#mcp-save-btn");
  els.mcpReload = $("#mcp-reload-btn");

  els.catAccessModal = $("#cat-access-modal");
  els.catAccessForm = $("#cat-access-form");
  els.catAccessSub = $("#cat-access-sub");
  els.catAccessTools = $("#cat-access-tools");
  els.catAccessSkills = $("#cat-access-skills");
  els.catAccessToolsCount = $("#cat-access-tools-count");
  els.catAccessSkillsCount = $("#cat-access-skills-count");
  els.catAccessError = $("#cat-access-error");
  els.catAccessSave = $("#cat-access-save");

  els.sandboxList = $("#sandbox-list");
  els.sandboxCount = $("[data-sandbox-count]");
  els.sandboxError = $("#sandbox-error");
  els.sandboxResetBtn = $("#sandbox-reset-btn");
  els.sandboxResetConfirm = $("#sandbox-reset-confirm");
  els.sandboxConfirmReset = $("#sandbox-confirm-reset");
  els.sandboxRefresh = $("#sandbox-refresh-btn");
  els.sandboxFileModal = $("#sandbox-file-modal");
  els.sandboxFilePath = $("#sandbox-file-path");
  els.sandboxFileSize = $("#sandbox-file-size");
  els.sandboxFileContent = $("#sandbox-file-content");
  els.sandboxFileError = $("#sandbox-file-error");
  els.sandboxCopyBtn = $("#sandbox-copy-btn");
}

// ── 网络：初始快照 / SSE / 去重 ─────────────────────────────────────────

async function refreshHealth() {
  try {
    const response = await fetch("/api/health", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = await response.json();
    const stallMs = Number(payload?.stallMs);
    if (Number.isFinite(stallMs) && stallMs > 0) app.stallMs = stallMs;
  } catch {
    /* /api/health 不可用时沿用默认阈值 */
  }
}

async function refreshState() {
  const response = await fetch("/api/state", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GET /api/state → HTTP ${response.status}`);
  const snapshot = await response.json();
  if (!snapshot || typeof snapshot !== "object") throw new Error("state payload is empty");
  applyState(snapshot);
  return snapshot;
}

function applyState(next) {
  if (!next || typeof next !== "object") return;
  const seq = Number(next.seq);
  const startedAt = Number(next.startedAt) || 0;
  const previous = app.state;
  const previousStartedAt = previous ? Number(previous.startedAt) || 0 : 0;
  const serverChanged = Boolean(previous) && startedAt !== previousStartedAt;

  if (previous && !serverChanged && Number.isFinite(seq) && seq <= app.lastSeq) {
    return; // 同一实例的旧快照 / 重复快照：按 seq 去重
  }
  if (Number.isFinite(seq)) app.lastSeq = seq;
  app.state = next;

  // toolCalls 状态变化后刷新沙盒文件列表（running -> ok/error 时文件可能已变）。
  const toolSignature = (next.toolCalls ?? [])
    .map((call) => `${call.id}:${call.status}`)
    .join("|");
  if (toolSignature !== sandboxState.lastToolSignature) {
    const hadSignature = Boolean(sandboxState.lastToolSignature);
    sandboxState.lastToolSignature = toolSignature;
    if (hadSignature) {
      scheduleSandboxRefresh();
      void loadApprovals();
    }
  }

  const rooms = next.rooms ?? [];
  if (rooms.length && !rooms.some((room) => room.id === app.roomId)) {
    app.roomId = rooms[0].id;
  }

  renderAll();
}

function connectEvents() {
  if (app.sse) {
    app.sse.close();
    app.sse = null;
  }
  setConn("connecting");

  let source;
  try {
    source = new EventSource("/api/events");
  } catch {
    setConn("offline");
    return;
  }
  app.sse = source;

  source.onopen = () => {
    setConn("online");
    // 断线重连后先拉一次 /api/state，补齐断线期间错过的快照。
    if (app.sseOpened) {
      refreshState().catch(() => setConn("offline"));
    }
    void refreshHealth();
    void loadApprovals();
    app.sseOpened = true;
  };

  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    const snapshot = payload.state ?? payload;
    if (!snapshot || typeof snapshot !== "object") return;
    setConn("online");
    applyState(snapshot);
  };

  source.onerror = () => {
    // EventSource 会按服务端 retry 自动重连；这里只更新 UI。
    setConn("offline");
  };
}

function setConn(next) {
  if (app.conn === next) return;
  app.conn = next;
  paintChrome();
}

// ── 渲染入口 ────────────────────────────────────────────────────────────

function renderAll() {
  paintChrome();
  renderRooms();
  renderRoster();
  renderTasks();
  renderWorkspace();
  renderCurrentWorkspace();
  renderTimeline();
  syncToolCards();
  renderDraftBubble();
  renderSandbox();
  updateNeedsMe();
  renderTypingHint();
  updateComposerState();
  updateStallUi();
  updateUnreadUi();
}

function paintChrome() {
  const snapshot = app.state;
  const conn = app.conn;
  const connLabel =
    conn === "online" ? "实时连接" : conn === "offline" ? "断线重连中" : "连接中…";

  for (const pill of els.connPills ?? []) pill.dataset.state = conn;
  for (const node of els.connTexts ?? []) node.textContent = connLabel;
  if (els.connBanner) els.connBanner.hidden = conn !== "offline";

  const seq = snapshot?.seq ?? app.lastSeq;
  const safeSeq = Number.isFinite(seq) && seq > 0 ? seq : 0;
  for (const node of els.seqs ?? []) node.textContent = `seq ${safeSeq}`;

  const mode = snapshot?.mode === "llm" ? "真实 LLM 模式" : "演出模式";
  for (const node of els.modes ?? []) node.textContent = mode;

  const room = currentRoom();
  if (els.roomName && room) els.roomName.textContent = room.name;
  if (els.roomTopic && room) els.roomTopic.textContent = room.topic;
}

// ── 左栏：猫猫名册 ──────────────────────────────────────────────────────

function renderRoster() {
  const host = els.roster;
  if (!host) return;
  const cats = roomCats();
  if (els.rosterCount) els.rosterCount.textContent = `${cats.length} 只`;

  if (!cats.length) {
    if (app.sig.roster === "empty") return;
    app.sig.roster = "empty";
    host.replaceChildren(h("div", { class: "empty", text: "猫猫还没到店，稍等刷新。" }));
    return;
  }

  const workTask = latestActiveTask();
  const statuses = cats.map((cat) => catState(cat.id));
  const mode = app.state?.mode ?? "mock";
  const sig = cats
    .map((cat, index) => {
      const state = statuses[index];
      return [
        cat.id,
        cat.name,
        cat.avatar,
        cat.accent,
        state,
        state === "working" ? workTask?.stage : "",
        cat.llmModel ?? "",
        mode,
        app.globalModel,
      ].join(":");
    })
    .join("|");

  if (sig === app.sig.roster) return;
  app.sig.roster = sig;

  const nodes = cats.map((cat, index) => {
    const status = statuses[index];
    const stageText =
      status === "talking"
        ? "说话中"
        : status === "typing"
          ? "打字中"
          : status === "working"
            ? `工作中 · ${STAGE_LABEL.get(workTask?.stage) ?? "进行中"}`
            : "睡觉中";
    const mood = status === "sleeping" ? "sleep" : status === "typing" || status === "talking" ? "typing" : "idle";

    return h(
      "button",
      {
        type: "button",
        class: "cat-row",
        "data-state": status,
        "data-action": "mention-cat",
        "data-cat-id": cat.id,
        style: `--accent:${safeCss(cat.accent)}`,
        title: `${cat.persona} 口头禅：「${cat.catchphrase}」`,
        "aria-label": `插入 @${cat.name}，${cat.species}，当前${stageText}`,
      },
      h(
        "span",
        { class: "cat-avatar", "aria-hidden": "true" },
        h("span", { html: avatarSvg(cat, { size: 38, mood }) }),
        status === "sleeping" ? h("span", { class: "cat-badge", text: "💤" }) : null,
      ),
      h(
        "span",
        { class: "cat-info" },
        h(
          "span",
          { class: "cat-name" },
          cat.name,
          status === "working" ? h("i", { class: "cat-working-dot", "aria-hidden": "true" }) : null,
          h("span", { class: "cat-species", text: cat.species }),
        ),
        h(
          "span",
          { class: "cat-status" },
          status === "typing" || status === "talking"
            ? [typingDots(), document.createTextNode(` ${stageText}`)]
            : stageText,
        ),
      ),
      (() => {
        const model = catModelLabel(cat);
        return h("span", {
          class: "cat-model-tag",
          "data-mode": app.state?.mode === "llm" ? "llm" : "mock",
          title: model.title,
          text: model.text,
        });
      })(),
    );
  });

  host.replaceChildren(...nodes);
}

/** 名册/设置里的「当前模型」标签。 */
function catModelLabel(cat) {
  const mode = app.state?.mode ?? "mock";
  if (mode !== "llm") {
    return { text: "演出", title: "演出模式：不调用模型" };
  }
  const override = String(cat?.llmModel ?? "").trim();
  if (override) return { text: override, title: `模型覆盖：${override}` };
  const globalModel = String(app.globalModel ?? "").trim();
  if (globalModel) return { text: globalModel, title: `跟随全局模型：${globalModel}` };
  return { text: "跟随全局", title: "跟随全局模型（全局模型名为空）" };
}

function typingDots() {
  return h(
    "span",
    { class: "typing-dots", "aria-hidden": "true" },
    h("i"),
    h("i"),
    h("i"),
  );
}

// ── 左栏：任务列表 ──────────────────────────────────────────────────────

function renderTasks() {
  const host = els.taskList;
  if (!host) return;
  const tasks = [...roomTasks()].sort((a, b) => b.createdAt - a.createdAt);
  if (els.taskCount) els.taskCount.textContent = String(tasks.length);

  const sig =
    `${app.roomId}|` +
    tasks.map((task) => [task.id, task.status, task.stage, task.owner, task.updatedAt].join(":")).join("|") +
    `|sel:${app.selectedTaskId ?? ""}`;
  if (sig === app.sig.tasks) return;
  app.sig.tasks = sig;

  if (!tasks.length) {
    host.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "还没有任务" }),
        h("span", { text: "点上面的「＋ 新任务」开工；下面的输入框是用来跟猫猫聊天的。" }),
      ),
    );
    return;
  }

  const focused = activeTask();
  host.replaceChildren(
    ...tasks.map((task) => {
      const stageLabel = STAGE_LABEL.get(task.stage) ?? task.stage;
      const stageIdx = STAGE_INDEX.get(task.stage) ?? 0;
      const pct =
        task.status === "done"
          ? 100
          : Math.max(4, Math.round((stageIdx / (STAGES.length - 1)) * 100));
      const owner = catById(task.owner);
      const isActive = focused?.id === task.id;
      const statusText =
        task.status === "stalled"
          ? "卡住了"
          : task.status === "done"
            ? "已完成"
            : `更新于 ${fmtTime(task.updatedAt)}`;

      return h(
        "button",
        {
          type: "button",
          class: `task-item${isActive ? " is-active" : ""}`,
          "data-action": "select-task",
          "data-task-id": task.id,
          "data-status": task.status,
          "aria-pressed": isActive ? "true" : "false",
          title: task.brief,
        },
        h(
          "span",
          { class: "task-item-top" },
          h("span", { class: "task-title", text: task.title }),
          h("span", {
            class: "stage-pill",
            "data-stage": task.stage,
            text: task.status === "done" ? "完成" : stageLabel,
          }),
        ),
        h(
          "span",
          { class: "task-meta" },
          owner ? h("span", { class: "mini-avatar", html: avatarSvg(owner, { size: 15 }) }) : null,
          h("span", { text: owner ? owner.name : "未指派" }),
          h("span", { text: "·" }),
          h("span", { text: statusText }),
        ),
        h(
          "span",
          { class: "task-progressbar", "aria-hidden": "true" },
          h("i", { style: `width:${pct}%` }),
        ),
      );
    }),
  );
}

// ── 右栏：任务进度 / 交接卡 / 产物 / 记忆 ───────────────────────────────

function renderWorkspace() {
  renderProgress();
  renderTaskGit();
  renderHandoffs();
  renderArtifacts();
  renderMemory();
}

function pendingApprovalCallsForTask(taskId) {
  if (!taskId) return [];
  return (app.state?.toolCalls ?? []).filter(
    (call) => call.taskId === taskId && call.status === "pending",
  );
}

function reviewLoopMemoryForTask(taskId) {
  if (!taskId) return null;
  const matches = (app.state?.memory ?? []).filter(
    (entry) =>
      entry.sourceTaskId === taskId &&
      Array.isArray(entry.tags) &&
      entry.tags.includes("review-loop"),
  );
  return matches.length ? matches[matches.length - 1] : null;
}

function stalledMinutesForTask(task) {
  const elapsed = Math.max(0, Date.now() - (task?.updatedAt || task?.createdAt || Date.now()));
  return Math.max(1, Math.ceil(elapsed / 60000));
}

function taskRecoveryInfo(task) {
  if (!task) return null;
  if (pendingApprovalCallsForTask(task.id).length > 0) return null;
  if (task.status === "stalled" || (task.status === "active" && isTaskStalled(task))) {
    return {
      mode: "stalled",
      badge: "卡住了",
      reason: `已 ${stalledMinutesForTask(task)} 分钟没有新动作，可以再给它一次机会或收尾。`,
    };
  }
  const memory = reviewLoopMemoryForTask(task.id);
  if (memory) {
    return {
      mode: "review-loop",
      badge: "被强制收尾",
      reason: memory.body || memory.title || "评审反复打回后已强制收尾。",
      memory,
    };
  }
  return null;
}

function recoveryPanelNode(task, info) {
  if (!task || !info) return null;
  const saving = taskRecoveryState.saving && taskRecoveryState.taskId === task.id;
  const error =
    taskRecoveryState.taskId === task.id ? taskRecoveryState.error : "";
  return h(
    "div",
    {
      class: "task-recovery",
      "data-mode": info.mode,
      "data-task-id": task.id,
      role: "group",
      "aria-label": "任务恢复",
    },
    h(
      "div",
      { class: "task-recovery-head" },
      h("span", { class: "task-recovery-title", text: "需要你决定" }),
      h("span", { class: "task-recovery-badge", "data-mode": info.mode, text: info.badge }),
    ),
    h("p", { class: "task-recovery-reason", "data-recovery-reason": "", text: info.reason }),
    h(
      "div",
      { class: "task-recovery-actions" },
      h(
        "button",
        {
          type: "button",
          class: "task-recovery-btn",
          "data-action": "recovery-continue",
          "data-task-id": task.id,
          "data-recovery": "continue",
          disabled: saving,
        },
        h("span", { text: "继续试试" }),
        h("small", { text: "再给它一次机会" }),
      ),
      h(
        "button",
        {
          type: "button",
          class: "task-recovery-btn",
          "data-action": "recovery-pivot",
          "data-task-id": task.id,
          "data-recovery": "pivot",
          disabled: saving,
        },
        h("span", { text: "换个方案" }),
        h("small", { text: "把新方向告诉猫" }),
      ),
      h(
        "button",
        {
          type: "button",
          class: "task-recovery-btn",
          "data-action": "recovery-close",
          "data-task-id": task.id,
          "data-recovery": "close",
          disabled: saving,
        },
        h("span", { text: "收尾" }),
        h("small", { text: "记录原因并写教训" }),
      ),
    ),
    h("p", {
      class: "task-recovery-error",
      "data-recovery-error": "",
      role: "alert",
      hidden: !error,
      text: error,
    }),
  );
}

function renderProgress() {
  const host = els.progress;
  if (!host) return;
  const task = activeTask();
  const pendingApprovalCount = task ? pendingApprovalCallsForTask(task.id).length : 0;
  const recovery = task ? taskRecoveryInfo(task) : null;
  const recoveryMemoryId = recovery?.memory?.id ?? "";
  const key = task
    ? [
        task.id,
        task.stage,
        task.status,
        task.owner,
        task.updatedAt,
        app.selectedTaskId ?? "",
        pendingApprovalCount,
        recovery?.mode ?? "",
        recoveryMemoryId,
      ].join(":")
    : `none:${app.selectedTaskId ?? ""}`;
  if (key === app.sig.progress) return;
  app.sig.progress = key;

  if (els.progressHint) {
    els.progressHint.textContent = task
      ? `${(STAGE_INDEX.get(task.stage) ?? 0) + 1} / ${STAGES.length}`
      : "";
  }

  if (!task) {
    host.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "还没有任务" }),
        h("span", { text: "提一个需求，四只猫会在这张桌子上开工。" }),
        h("button", {
          type: "button",
          class: "btn btn--tiny btn--primary",
          "data-action": "new-task",
          text: "＋ 提个需求",
        }),
      ),
    );
    return;
  }

  const stagedIdx = STAGE_INDEX.get(task.stage) ?? 0;
  const stalled = isTaskStalled(task) && pendingApprovalCount === 0;
  const owner = catById(task.owner);
  const status =
    task.status === "done"
      ? "done"
      : stalled
        ? "stalled"
        : pendingApprovalCount > 0
          ? "pending"
          : "active";
  const statusLabel =
    status === "done"
      ? "已完成"
      : status === "stalled"
        ? "卡住了"
        : status === "pending"
          ? "等待审批"
          : "进行中";

  const children = [];
  if (app.selectedTaskId) {
    children.push(
      h(
        "div",
        { class: "focus-bar" },
        h("span", { text: `聚焦：${task.title}` }),
        h("button", { type: "button", "data-action": "clear-focus", text: "看全部" }),
      ),
    );
  }

  children.push(
    h(
      "div",
      { class: "progress-top" },
      h("span", { class: "progress-title", text: task.title, title: task.brief }),
      h("span", { class: "task-status-badge", "data-status": status, text: statusLabel }),
    ),
    h(
      "ol",
      { class: "stage-track", "aria-label": "阶段进度" },
      ...STAGES.map((stage, index) => {
        const done = task.status === "done" || index < stagedIdx;
        const current = task.status !== "done" && index === stagedIdx;
        const classes = done ? "is-done" : current ? "is-current" : "is-todo";
        return h(
          "li",
          { class: `stage-step ${classes}`, ...(current ? { "aria-current": "step" } : {}) },
          h("span", { class: "stage-dot", "aria-hidden": "true" }),
          h("span", { class: "stage-name", text: stage.label }),
        );
      }),
    ),
    h(
      "div",
      { class: "owner-row" },
      owner ? h("span", { class: "owner-avatar", html: avatarSvg(owner, { size: 26 }) }) : null,
      h("span", { class: "owner-name", text: owner ? owner.name : "未指派" }),
      h("span", { class: "owner-role", text: owner ? owner.title : "" }),
      h(
        "span",
        { class: "owner-actions" },
        h("span", { class: "stall-note", "data-stall-note": "" }),
        h("button", {
          type: "button",
          class: "btn btn--tiny btn--ghost trace-open-btn",
          "data-action": "open-task-trace",
          "data-task-id": task.id,
          text: "🔍 查看轨迹",
        }),
        h("button", {
          type: "button",
          class: "btn btn--tiny btn--nudge",
          "data-action": "nudge",
          "data-task-id": task.id,
          hidden: !stalled || Boolean(recovery) || pendingApprovalCount > 0,
          text: "🐾 催一下",
        }),
      ),
    ),
  );

  const recoveryNode = recoveryPanelNode(task, recovery);
  if (recoveryNode) children.push(recoveryNode);

  host.replaceChildren(...children);
  updateStallUi();
}

function renderHandoffs() {
  const host = els.handoffs;
  if (!host) return;
  const task = activeTask();
  const handoffs = task
    ? (app.state?.handoffs ?? [])
        .filter((handoff) => handoff.taskId === task.id)
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  if (els.handoffCount) els.handoffCount.textContent = String(handoffs.length);

  const key = task ? `${task.id}:${handoffs.map((handoff) => handoff.id).join(",")}` : "none";
  if (key === app.sig.handoffs) return;
  app.sig.handoffs = key;

  if (!task) {
    host.replaceChildren(emptyNote("有任务后，猫猫的结构化交接卡会出现在这里。"));
    return;
  }
  if (!handoffs.length) {
    host.replaceChildren(emptyNote("当前任务还没有交接卡。"));
    return;
  }
  host.replaceChildren(...handoffs.map((handoff) => miniHandoffNode(handoff)));
}

function renderArtifacts() {
  const host = els.artifacts;
  if (!host) return;
  const task = activeTask();
  const artifacts = task
    ? (app.state?.artifacts ?? [])
        .filter((artifact) => artifact.taskId === task.id)
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  if (els.artifactCount) els.artifactCount.textContent = String(artifacts.length);

  const key = task
    ? `${task.id}:${artifacts.map((artifact) => `${artifact.id}:${artifact.version}`).join(",")}`
    : "none";
  if (key === app.sig.artifacts) return;
  app.sig.artifacts = key;

  if (!task) {
    host.replaceChildren(emptyNote("还没有任务。设计稿、实现稿和评审记录会收在这里。"));
    return;
  }
  if (!artifacts.length) {
    host.replaceChildren(emptyNote("当前任务还没有产物。"));
    return;
  }
  host.replaceChildren(...artifacts.map((artifact) => artifactNode(artifact)));
}

function renderMemory() {
  const host = els.memory;
  if (!host) return;
  const taskIds = new Set(roomTasks().map((task) => task.id));
  const memories = [...(app.state?.memory ?? [])]
    .filter((entry) => entry.sourceTaskId && taskIds.has(entry.sourceTaskId))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (els.memoryCount) els.memoryCount.textContent = String(memories.length);

  const key = `${app.roomId}:` + (memories.map((entry) => entry.id).join(",") || "none");
  if (key === app.sig.memory) return;
  app.sig.memory = key;

  if (!memories.length) {
    host.replaceChildren(
      emptyNote("猫猫还没把决定写进共享记忆。任务完成后，宪宪会把决策和教训记在这里。"),
    );
    return;
  }

  const groups = MEMORY_GROUPS.map((kind) => ({
    kind,
    items: memories.filter((entry) => entry.kind === kind),
  })).filter((group) => group.items.length);

  host.replaceChildren(
    ...groups.map((group) =>
      h(
        "div",
        { class: "memory-group" },
        h(
          "div",
          { class: "memory-group-title" },
          h("span", { text: MEMORY_KIND_LABEL[group.kind] ?? group.kind }),
          h("span", { class: "count", text: String(group.items.length) }),
        ),
        ...group.items.map((entry) => memoryNode(entry)),
      ),
    ),
  );
}

function memoryNode(entry) {
  const sourceTask = entry.sourceTaskId ? taskById(entry.sourceTaskId) : null;
  const tags = (entry.tags ?? []).filter((tag) => String(tag).trim());
  return h(
    "div",
    { class: "memory-item", "data-kind": entry.kind },
    h("div", { class: "memory-title", text: entry.title }),
    h("div", { class: "memory-body", text: entry.body }),
    tags.length
      ? h("div", { class: "memory-tags" }, ...tags.map((tag) => h("span", { class: "memory-tag", text: tag })))
      : null,
    h(
      "div",
      { class: "memory-source" },
      sourceTask ? `来自：${sourceTask.title}` : "来自：猫咖协作",
      h("span", { text: ` · ${fmtTime(entry.createdAt)}` }),
    ),
  );
}

function emptyNote(text) {
  return h("div", { class: "empty" }, h("span", { text }));
}

// ── 卡片：交接 / 评审 / 产物 / 决策 ────────────────────────────────────

function handoffCardNode(handoff) {
  const from = handoff ? catById(handoff.from) : null;
  const to = handoff ? catById(handoff.to) : null;
  const missing = handoffMissing(handoff?.card);
  const createdAt = handoff?.createdAt ?? Date.now();

  const cardNode = h(
    "div",
    {
      class: `handoff-card${missing.length ? " is-incomplete" : ""}`,
      role: "group",
      "aria-label": "结构化交接卡",
    },
    h(
      "div",
      { class: "handoff-head" },
      h("span", { class: "handoff-tag", text: "交接卡" }),
      h(
        "span",
        { class: "handoff-route" },
        from
          ? h("span", {
              class: "mini-avatar",
              html: avatarSvg(from, { size: 22 }),
              title: `${from.name} · ${from.species}`,
            })
          : null,
        h("span", { text: from?.name ?? "未知" }),
        h("span", { class: "handoff-arrow", "aria-hidden": "true", text: "→" }),
        to
          ? h("span", {
              class: "mini-avatar",
              html: avatarSvg(to, { size: 22 }),
              title: `${to.name} · ${to.species}`,
            })
          : null,
        h("span", { text: to?.name ?? "未知" }),
      ),
      h("time", {
        class: "handoff-time",
        datetime: new Date(createdAt).toISOString(),
        title: fmtFull(createdAt),
        text: fmtTime(createdAt),
      }),
    ),
    h(
      "div",
      { class: "hc-grid" },
      ...HANDOFF_FIELDS.map((field) => handoffFieldNode(field, handoff?.card, missing)),
    ),
    missing.length
      ? h(
          "div",
          { class: "handoff-warning" },
          h("span", { "aria-hidden": "true", text: "⚠" }),
          h("span", {
            text: `这张卡缺「${missing.join("、")}」——接收猫会先追问再开工。`,
          }),
        )
      : null,
  );

  return cardNode;
}

function handoffFieldNode(field, card, missingLabels) {
  const missing = missingLabels.includes(field.label);
  const host = h("div", {
    class: `hc-field${field.wide ? " hc-field--wide" : ""}${missing ? " is-missing" : ""}`,
  });
  host.appendChild(h("span", { class: "hc-label", text: field.label }));

  const valueHost = h("div", { class: "hc-val" });
  if (missing) {
    valueHost.appendChild(h("span", { class: "hc-missing", text: "空着 · 接收猫会追问" }));
  } else {
    const value = card?.[field.key];
    if (Array.isArray(value)) {
      const items = value.map((item) => String(item ?? "").trim()).filter(Boolean);
      valueHost.appendChild(h("ul", {}, ...items.map((item) => h("li", { text: item }))));
    } else {
      valueHost.textContent = String(value ?? "").trim();
    }
  }
  host.appendChild(valueHost);
  return host;
}

function miniHandoffNode(handoff) {
  const from = catById(handoff.from);
  const to = catById(handoff.to);
  const missing = handoffMissing(handoff.card);

  return h(
    "div",
    {
      class: `mini-handoff${missing.length ? " is-incomplete" : ""}`,
      role: "group",
      "aria-label": "交接卡",
    },
    h(
      "div",
      { class: "mini-handoff-head" },
      from
        ? h("span", {
            class: "mini-avatar",
            html: avatarSvg(from, { size: 22 }),
            title: from.name,
          })
        : null,
      h("span", { text: from?.name ?? "未知" }),
      h("span", { class: "handoff-arrow", "aria-hidden": "true", text: "→" }),
      to
        ? h("span", {
            class: "mini-avatar",
            html: avatarSvg(to, { size: 22 }),
            title: to.name,
          })
        : null,
      h("span", { text: to?.name ?? "未知" }),
      h("span", { class: "handoff-time", text: fmtTime(handoff.createdAt) }),
    ),
    h(
      "div",
      { class: "hc-grid" },
      ...HANDOFF_FIELDS.map((field) => handoffFieldNode(field, handoff.card, missing)),
    ),
    missing.length
      ? h(
          "div",
          { class: "handoff-warning" },
          h("span", { "aria-hidden": "true", text: "⚠" }),
          h("span", { text: `缺：${missing.join("、")}` }),
        )
      : null,
  );
}

function reviewCardNode(message, review) {
  const verdict = review.verdict;
  const verdictLabel =
    verdict === "approve" ? "✓ 通过" : verdict === "request_changes" ? "✕ 要求修改" : "· 评审中";
  const title = review.artifact?.title || "评审记录";

  const card = h(
    "div",
    { class: "review-card", role: "group", "aria-label": "评审卡片" },
    h(
      "div",
      { class: "review-head" },
      h("span", { class: "review-title", text: title }),
      h("span", {
        class: "verdict-badge",
        "data-verdict": verdict ?? "unknown",
        text: verdictLabel,
      }),
      review.findings.length
        ? h("span", { class: "count", text: `${review.findings.length} 条意见` })
        : null,
      h("time", {
        class: "handoff-time",
        datetime: new Date(message.at).toISOString(),
        title: fmtFull(message.at),
        text: fmtTime(message.at),
      }),
    ),
  );

  if (message.text.trim()) {
    card.appendChild(h("div", { class: "review-text", text: message.text }));
  }

  if (review.findings.length) {
    card.appendChild(
      h(
        "ul",
        { class: "findings" },
        ...review.findings.map((finding) =>
          h(
            "li",
            { class: "finding", "data-severity": finding.severity },
            h("span", { class: "finding-badge", text: finding.severity }),
            h(
              "div",
              {},
              h("div", { class: "finding-title", text: finding.title }),
              finding.detail
                ? h("div", { class: "finding-detail", text: finding.detail })
                : null,
            ),
          ),
        ),
      ),
    );
  } else if (review.artifact?.body) {
    card.appendChild(artifactNode(review.artifact));
  }

  return card;
}

function decisionCardNode(message) {
  const artifact = resolveArtifact(message);
  const card = h(
    "div",
    { class: "decision-card", role: "group", "aria-label": "决策记录" },
    h(
      "div",
      { class: "decision-head" },
      h("span", { class: "decision-tag", text: "决策" }),
      h("span", { class: "decision-title", text: artifact?.title || "写进共享记忆" }),
      h("time", {
        class: "handoff-time",
        datetime: new Date(message.at).toISOString(),
        title: fmtFull(message.at),
        text: fmtTime(message.at),
      }),
    ),
  );
  if (message.text.trim()) {
    card.appendChild(h("div", { class: "decision-text", text: message.text }));
  }
  if (artifact) card.appendChild(artifactNode(artifact));
  return card;
}

function artifactNode(artifact) {
  const author = catById(artifact.author);
  const details = h("details", { class: "artifact-card", "data-artifact-id": artifact.id });
  if (app.expanded.has(artifact.id)) details.setAttribute("open", "");

  details.appendChild(
    h(
      "summary",
      {},
      h("span", { class: "summary-chevron", "aria-hidden": "true", text: "▸" }),
      h("span", {
        class: "artifact-kind",
        "data-kind": artifact.kind,
        text: ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind,
      }),
      h("span", { class: "artifact-title", text: artifact.title, title: artifact.title }),
      h(
        "span",
        { class: "artifact-meta" },
        author ? h("span", { text: author.name }) : null,
        h("span", { text: `v${artifact.version}` }),
        h("span", { text: fmtTime(artifact.createdAt) }),
      ),
    ),
  );
  details.appendChild(h("pre", { class: "artifact-body", text: artifact.body || "（正文为空）" }));
  details.addEventListener("toggle", () => {
    if (details.open) app.expanded.add(artifact.id);
    else app.expanded.delete(artifact.id);
  });
  return details;
}

// ── 流式草稿气泡 ───────────────────────────────────────────────────────

function clearDraftBubbleImmediate() {
  if (draftBubbleState.hideTimer) {
    window.clearTimeout(draftBubbleState.hideTimer);
    draftBubbleState.hideTimer = null;
  }
  if (draftBubbleState.node) {
    draftBubbleState.node.remove();
  }
  draftBubbleState.node = null;
  draftBubbleState.roomId = null;
  draftBubbleState.catId = null;
  draftBubbleState.text = "";
}

function draftBubbleNode(draft) {
  const cat = catById(draft.catId) ?? {};
  const node = h("article", {
    class: "msg msg--cat msg--chat draft-bubble",
    style: `--accent:${safeCss(cat.accent ?? "#D9A066")}`,
    role: "status",
    "aria-live": "polite",
    "aria-label": `${cat.name ?? "猫猫"}正在输入`,
    "data-draft": "true",
  });
  node.appendChild(
    h("div", {
      class: "msg-avatar",
      "aria-hidden": "true",
      html: avatarSvg(cat, { size: 38 }),
    }),
  );
  const main = h("div", { class: "msg-main" });
  main.appendChild(
    h(
      "header",
      { class: "msg-head" },
      h("span", { class: "msg-author", text: cat.name ?? "猫猫" }),
      h("span", {
        class: "msg-role",
        text: String(cat.title ?? "").split(" / ")[0],
      }),
      h(
        "span",
        { class: "draft-typing" },
        typingDots(),
        document.createTextNode(" 正在输入…"),
      ),
    ),
  );
  main.appendChild(
    h("div", { class: "bubble", "data-role": "draft-text", text: draft.text || " " }),
  );
  main.appendChild(h("span", { class: "draft-pulse", "aria-hidden": "true" }, h("i")));
  node.appendChild(main);
  return node;
}

function removeDraftBubbleWithFade() {
  const node = draftBubbleState.node;
  draftBubbleState.node = null;
  draftBubbleState.roomId = null;
  draftBubbleState.catId = null;
  draftBubbleState.text = "";
  if (!node || !node.isConnected) return;
  node.classList.add("is-leaving");
  if (draftBubbleState.hideTimer) window.clearTimeout(draftBubbleState.hideTimer);
  draftBubbleState.hideTimer = window.setTimeout(() => {
    draftBubbleState.hideTimer = null;
    node.remove();
  }, 120);
}

function renderDraftBubble() {
  const host = els.timeline;
  if (!host) return;
  const draft = currentDraft();
  if (!draft) {
    if (draftBubbleState.node) removeDraftBubbleWithFade();
    return;
  }
  if (draftBubbleState.hideTimer) {
    window.clearTimeout(draftBubbleState.hideTimer);
    draftBubbleState.hideTimer = null;
  }

  const wasNearBottom = isNearBottom(els.timelineScroll);
  const hadNoMessages = !host.querySelector(".msg:not(.draft-bubble), .sys-line, .task-divider");
  const roomId = currentRoom()?.id ?? "";
  let node = draftBubbleState.node;
  const needsNew =
    !node ||
    !node.isConnected ||
    draftBubbleState.roomId !== roomId ||
    draftBubbleState.catId !== draft.catId ||
    node.classList.contains("is-leaving");

  if (needsNew) {
    if (node) node.remove();
    node = draftBubbleNode(draft);
    host.querySelector(".timeline-empty")?.remove();
    host.appendChild(node);
    draftBubbleState.node = node;
    draftBubbleState.roomId = roomId;
    draftBubbleState.catId = draft.catId;
    draftBubbleState.text = draft.text;
  } else {
    const bubble = node.querySelector('[data-role="draft-text"]');
    if (bubble && draftBubbleState.text !== draft.text) {
      const bubbleNearBottom =
        bubble.scrollHeight - bubble.scrollTop - bubble.clientHeight < 30;
      bubble.textContent = draft.text;
      if (bubbleNearBottom) bubble.scrollTop = bubble.scrollHeight;
      draftBubbleState.text = draft.text;
    }
    if (node.nextElementSibling) host.appendChild(node);
  }
  host.querySelector(".timeline-empty")?.remove();

  if (wasNearBottom || hadNoMessages) {
    scrollToBottom(false);
  }
}

// ── 中栏：timeline 增量渲染 ─────────────────────────────────────────────// ── 中栏：timeline 增量渲染 ─────────────────────────────────────────────

function renderTimeline() {
  // 渲染完成后同步一次"待审批"提示：审批卡可能在折叠区里，
  // 这条浮条是用户找到它的唯一持续线索。
  requestAnimationFrame(() => updateUnreadUi());
  const host = els.timeline;
  if (!host) return;
  const messages = roomMessages();
  const draft = currentDraft();
  const timeline = app.timeline;

  if (!messages.length) {
    if (draft) {
      host.querySelector(".timeline-empty")?.remove();
    } else if (!host.querySelector(".timeline-empty")) {
      host.replaceChildren(
        h("div", { class: "timeline-empty", text: "房间很安静。提一个需求，或者 @ 一只猫聊两句。" }),
      );
    }
    timeline.ids = [];
    timeline.lastTaskId = null;
    timeline.initialized = false;
    return;
  }

  if (host.querySelector(".timeline-empty")) {
    host.replaceChildren();
    timeline.ids = [];
    timeline.lastTaskId = null;
    timeline.initialized = false;
  }

  const hasStaleTimelineChildren = Boolean(
    host.querySelector(".msg, .sys-line, .task-divider, [data-synthetic-tool]"),
  );
  let rebuild =
    timeline.ids.length > messages.length ||
    (timeline.ids.length === 0 && hasStaleTimelineChildren);
  if (!rebuild) {
    for (let index = 0; index < timeline.ids.length; index += 1) {
      if (timeline.ids[index] !== messages[index].id) {
        rebuild = true;
        break;
      }
    }
  }

  const wasInitialized = timeline.initialized;
  const nearBottom = isNearBottom(els.timelineScroll);

  if (rebuild) {
    host.replaceChildren();
    toolCardNodes.clear();
    timeline.ids = [];
    timeline.lastTaskId = null;
    resetUnread();
  }

  let added = 0;
  for (let index = timeline.ids.length; index < messages.length; index += 1) {
    const message = messages[index];
    const taskId = message.taskId ?? null;
    if (taskId && taskId !== timeline.lastTaskId) {
      host.appendChild(taskDividerNode(taskId));
    }
    if (taskId) timeline.lastTaskId = taskId;

    const node = messageNode(message, wasInitialized && !rebuild);
    if (message.taskId) node.dataset.taskId = message.taskId;
    host.appendChild(node);
    timeline.ids.push(message.id);
    added += 1;
  }
  timeline.initialized = true;

  if (!added) return;
  if (rebuild || !wasInitialized) {
    scrollToBottom(false);
  } else if (nearBottom) {
    scrollToBottom(true);
  } else {
    app.unread += added;
    updateUnreadUi();
  }
}

function taskDividerNode(taskId) {
  const task = latestTaskFor(taskId);
  return h(
    "div",
    { class: "task-divider", role: "separator", "data-task-id": taskId },
    h("span", { text: `🧵 任务 · ${task?.title ?? "新任务"}` }),
  );
}

function messageNode(message, animate) {
  const kind = message.kind ?? "chat";
  const isUser = message.author === "user";
  const isSystem = message.author === "system" || kind === "system";

  if (isSystem) {
    return h("div", { class: `sys-line${animate ? " msg--new" : ""}`, role: "note" }, message.text);
  }

  const cat = isUser ? null : catById(message.author);
  const classes = [
    "msg",
    isUser ? "msg--user" : "msg--cat",
    `msg--${kind}`,
    animate ? "msg--new" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const node = h("article", {
    class: classes,
    style: cat ? `--accent:${safeCss(cat.accent)}` : null,
    "data-message-id": message.id,
    "data-message-kind": kind,
  });

  node.appendChild(
    h("div", {
      class: "msg-avatar",
      "aria-hidden": "true",
      html: isUser ? userAvatarSvg(38) : avatarSvg(cat ?? {}, { size: 38 }),
    }),
  );

  const main = h("div", { class: "msg-main" });
  main.appendChild(messageHead(message, cat, isUser));

  if (isUser) {
    const bubble = h("div", { class: "bubble" });
    appendRichText(bubble, message.text);
    main.appendChild(bubble);
  } else if (kind === "handoff") {
    const handoff = resolveHandoff(message);
    if (message.text.trim()) main.appendChild(h("div", { class: "msg-lead", text: message.text }));
    main.appendChild(handoffCardNode(handoff));
  } else if (kind === "tool") {
    const call = toolCallById(message.toolCallId);
    if (message.text.trim()) main.appendChild(h("div", { class: "msg-lead", text: message.text }));
    main.appendChild(toolCardNode(call, message));
  } else if (kind === "artifact") {
    const artifact = resolveArtifact(message);
    if (message.text.trim()) main.appendChild(h("div", { class: "msg-lead", text: message.text }));
    if (artifact) main.appendChild(artifactNode(artifact));
    else main.appendChild(h("div", { class: "msg-lead", text: "（产物正文暂未同步）" }));
  } else if (kind === "review") {
    main.appendChild(reviewCardNode(message, resolveReview(message)));
  } else if (kind === "decision") {
    main.appendChild(decisionCardNode(message));
  } else {
    const bubble = h("div", { class: "bubble" });
    appendRichText(bubble, message.text);
    main.appendChild(bubble);
  }

  const mentions = mentionsRow(message);
  if (mentions) main.appendChild(mentions);

  node.appendChild(main);
  return node;
}

function messageHead(message, cat, isUser) {
  const name = isUser ? "铲屎官" : (cat?.name ?? "猫猫");
  const author = isUser
    ? h("span", { class: "msg-author", text: name })
    : h("button", {
        type: "button",
        class: "msg-author",
        "data-action": "mention-cat",
        "data-cat-id": cat?.id ?? "",
        title: `点一下 @${name}`,
        text: name,
      });
  const role = cat ? h("span", { class: "msg-role", text: String(cat.title ?? "").split(" / ")[0] }) : null;
  return h(
    "header",
    { class: "msg-head" },
    author,
    role,
    h("time", {
      class: "msg-time",
      datetime: new Date(message.at).toISOString(),
      title: fmtFull(message.at),
      text: fmtTime(message.at),
    }),
  );
}

function mentionsRow(message) {
  const ids = message.mentions ?? [];
  if (!ids.length) return null;
  const row = h("div", { class: "msg-mentions", "aria-label": "被 @ 的猫" });
  let count = 0;
  for (const id of ids) {
    const cat = catById(id);
    if (!cat) continue;
    row.appendChild(
      h("button", {
        type: "button",
        class: "mention-chip",
        "data-action": "mention-cat",
        "data-cat-id": cat.id,
        text: cat.name,
        "aria-label": `插入 @${cat.name}`,
      }),
    );
    count += 1;
  }
  return count ? row : null;
}

function appendRichText(host, text) {
  const raw = String(text ?? "");
  if (!raw.trim()) {
    host.textContent = "（空消息）";
    return;
  }
  const cats = roomCats();
  if (!cats.length) {
    host.textContent = raw;
    return;
  }
  const names = cats
    .map((cat) => cat.name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (!names.length) {
    host.textContent = raw;
    return;
  }

  const pattern = new RegExp(`@(?:${names.join("|")})`, "g");
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      host.appendChild(document.createTextNode(raw.slice(lastIndex, match.index)));
    }
    const mention = h("span", { class: "mention" });
    mention.textContent = match[0];
    host.appendChild(mention);
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < raw.length) {
    host.appendChild(document.createTextNode(raw.slice(lastIndex)));
  }
}

// ── 连接 / 打字提示 / 输入框 ────────────────────────────────────────────

function renderTypingHint() {
  if (!els.typingHint) return;
  const room = currentRoom();
  const typingId = room ? app.state?.typing?.[room.id] : null;
  const cat = typingId ? catById(typingId) : null;
  els.typingHint.hidden = !cat;
  if (cat && els.typingName) els.typingName.textContent = cat.name;
}

function updateComposerState() {
  if (!els.sendBtn || !els.input) return;
  els.sendBtn.disabled = app.sending || !els.input.value.trim();
  if (els.charHint) {
    const length = els.input.value.length;
    if (length > 1800) els.charHint.textContent = `${length} / ${MAX_INPUT}`;
    else els.charHint.textContent = app.sending ? "发送中…" : "Enter 发送 · Shift+Enter 换行";
  }
}

function resizeInput() {
  const input = els.input;
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function updateUnreadUi() {
  // 待审批是"必须处理"，优先于"有新消息"：即使 unread=0 也要露出跳转条，
  // 否则审批卡被折叠进时间线后用户就找不到它了。
  const pending = pendingApprovalCount();
  const showPending = pending > 0 && app.tab === "chat";
  const showJump = (app.unread > 0 || showPending) && app.tab === "chat";
  if (els.jump) {
    const shouldHide = !showJump;
    if (els.jump.hidden !== shouldHide) els.jump.hidden = shouldHide;
    els.jump.classList.toggle("is-pending", showPending);
  }
  if (els.jumpCount) {
    els.jumpCount.textContent = String(showPending ? pending : app.unread);
  }
  const label = els.jump?.querySelector("[data-jump-label]");
  if (label) {
    label.innerHTML = showPending
      ? `🙋 <span data-jump-count>${pending}</span> 项待审批`
      : `↓ <span data-jump-count>${app.unread}</span> 条新消息`;
    els.jumpCount = label.querySelector("[data-jump-count]");
  }
  if (els.chatTabDot) els.chatTabDot.hidden = !(app.unread > 0 && app.tab !== "chat");
}

/** 当前房间有几个工具在等审批。 */
function pendingApprovalCount() {
  const calls = app.state?.toolCalls ?? [];
  const roomId = app.roomId;
  const taskIds = new Set(
    (app.state?.tasks ?? []).filter((task) => task.roomId === roomId).map((task) => task.id),
  );
  return calls.filter(
    (call) => call.status === "pending" && (!call.taskId || taskIds.has(call.taskId)),
  ).length;
}

function resetUnread() {
  app.unread = 0;
  updateUnreadUi();
}

function updateStallUi() {
  const task = activeTask();
  if (!task) return;
  const region = els.progress;
  if (!region) return;

  const pendingApprovalCount = pendingApprovalCallsForTask(task.id).length;
  const recovery = taskRecoveryInfo(task);
  const stalled = isTaskStalled(task) && pendingApprovalCount === 0;
  const status =
    task.status === "done"
      ? "done"
      : stalled
        ? "stalled"
        : pendingApprovalCount > 0
          ? "pending"
          : "active";
  const statusLabel =
    status === "done"
      ? "已完成"
      : status === "stalled"
        ? "卡住了"
        : status === "pending"
          ? "等待审批"
          : "进行中";
  const elapsed = Math.max(
    0,
    Math.floor((Date.now() - (task.updatedAt || task.createdAt || Date.now())) / 1000),
  );

  const badge = region.querySelector(".task-status-badge");
  if (badge) {
    if (badge.dataset.status !== status) badge.dataset.status = status;
    if (badge.textContent !== statusLabel) badge.textContent = statusLabel;
  }

  const note = region.querySelector("[data-stall-note]");
  if (note) {
    const hardStalled = task.status === "stalled";
    const noteText =
      task.status === "done"
        ? recovery?.mode === "review-loop"
          ? "任务已被强制收尾，可以继续试试或收尾。"
          : "任务已完成，猫猫去晒太阳了。"
        : pendingApprovalCount > 0
          ? "等待你批准工具调用中，批准后猫才会继续。"
          : stalled
            ? hardStalled
              ? "任务卡住了，可以继续试试或换个方案。"
              : `已 ${elapsed}s 没有新动作，可以继续试试或换个方案。`
            : `本阶段已进行 ${elapsed}s。`;
    if (note.textContent !== noteText) note.textContent = noteText;
  }

  const nudge = region.querySelector('[data-action="nudge"]');
  if (nudge) {
    const shouldHide = !stalled || Boolean(recovery) || pendingApprovalCount > 0;
    if (nudge.hidden !== shouldHide) nudge.hidden = shouldHide;
    if (nudge.dataset.taskId !== task.id) nudge.dataset.taskId = task.id;
  }

  const recoveryReason = region.querySelector("[data-recovery-reason]");
  if (recoveryReason && recovery?.mode === "stalled") {
    recoveryReason.textContent = recovery.reason;
  }
}

function startTicker() {
  if (app.ticker) clearInterval(app.ticker);
  app.ticker = setInterval(() => {
    if (!app.state) return;
    updateStallUi();
    updateApprovalCountdowns();
    updateTestCenterTicker();
  }, 1000);
}

// ── 事件绑定 ────────────────────────────────────────────────────────────

function bindUi() {
  document.addEventListener("click", onGlobalClick);
  document.addEventListener("keydown", onGlobalKeydown);

  if (els.input) {
    els.input.addEventListener("input", onComposerInput);
    els.input.addEventListener("keydown", onComposerKeydown);
    els.input.addEventListener("compositionstart", () => {
      app.composing = true;
    });
    els.input.addEventListener("compositionend", () => {
      app.composing = false;
    });
    els.input.addEventListener("blur", () => {
      window.setTimeout(closeMentionPopup, 140);
    });
  }

  if (els.composer) {
    els.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void sendMessage();
    });
  }

  if (els.mentionPopup) {
    // 点选补全项时不要抢走 textarea 焦点
    els.mentionPopup.addEventListener("mousedown", (event) => {
      const target = event.target instanceof Element ? event.target.closest(".mention-item") : null;
      if (target) event.preventDefault();
    });
  }

  if (els.timelineScroll) {
    els.timelineScroll.addEventListener("scroll", () => {
      if (app.unread > 0 && isNearBottom(els.timelineScroll)) resetUnread();
    }, { passive: true });
  }

  const tabbar = $(".tabbar");
  if (tabbar) tabbar.addEventListener("keydown", onTabbarKeydown);

  if (els.newTaskForm) {
    els.newTaskForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void createTask();
    });
  }
  if (els.brief) {
    els.brief.addEventListener("input", () => {
      updateCreateState();
      hideFormError();
    });
  }
  if (els.modal) {
    els.modal.addEventListener("click", (event) => {
      if (event.target === els.modal) closeNewTaskModal();
    });
    els.modal.addEventListener("close", () => {
      hideFormError();
    });
  }

  if (els.settingsForm) {
    els.settingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveSettings();
    });
    els.settingsForm.addEventListener("change", onSettingsChange);
    els.settingsForm.addEventListener("input", onSettingsInput);
  }
  if (els.settingsModal) {
    els.settingsModal.addEventListener("click", (event) => {
      if (event.target === els.settingsModal) closeSettings();
    });
    els.settingsModal.addEventListener("close", () => {
      settingsState.saving = false;
      settingsState.testing = false;
      settingsState.resetConfirm = false;
      settingsState.clearKeyRequested = false;
      if (els.settingsApiKey) els.settingsApiKey.value = "";
      setKeyVisibility(false);
      hideSettingsError();
      hideModeWarn();
      setSettingsResetConfirm(false);
    });
  }

  if (els.catEditForm) {
    els.catEditForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveCatProfile();
    });
    els.catEditForm.addEventListener("input", onCatEditInput);
  }
  if (els.catEditModal) {
    els.catEditModal.addEventListener("click", (event) => {
      if (event.target === els.catEditModal) closeCatEdit();
    });
    els.catEditModal.addEventListener("close", () => {
      catEditState.catId = null;
      catEditState.saving = false;
      hideCatEditError();
    });
  }

  if (els.sandboxFileModal) {
    els.sandboxFileModal.addEventListener("click", (event) => {
      if (event.target === els.sandboxFileModal) closeSandboxFile();
    });
    els.sandboxFileModal.addEventListener("close", () => {
      sandboxState.file.open = false;
      sandboxState.file.loading = false;
    });
  }

  if (els.mcpTransport) {
    els.mcpTransport.addEventListener("change", updateMcpTransportFields);
  }
  if (els.mcpForm) {
    els.mcpForm.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        void saveMcpServer();
      }
    });
  }
  for (const field of [els.mcpName, els.mcpCommand, els.mcpArgs, els.mcpUrl, els.mcpRisk]) {
    field?.addEventListener("input", hideMcpFormError);
  }

  if (els.newRoomForm) {
    els.newRoomForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void createRoom();
    });
  }
  els.newRoomName?.addEventListener("input", () => {
    hideNewRoomError();
    updateNewRoomState();
  });
  els.newRoomWorkspace?.addEventListener("change", updateNewRoomState);
  if (els.roomPickerModal) {
    els.roomPickerModal.addEventListener("click", (event) => {
      if (event.target === els.roomPickerModal) closeRoomPicker();
    });
  }
  if (els.newRoomModal) {
    els.newRoomModal.addEventListener("click", (event) => {
      if (event.target === els.newRoomModal) closeNewRoom();
    });
    els.newRoomModal.addEventListener("close", () => {
      roomState.creating = false;
      hideNewRoomError();
    });
  }

  for (const input of els.workspacePolicyInputs ?? []) {
    input.addEventListener("change", () => {
      hideWorkspaceFormError();
      updateWorkspaceFormState();
    });
  }
  for (const field of [els.workspaceName, els.workspacePath]) {
    field?.addEventListener("input", hideWorkspaceFormError);
  }
  if (els.gitDiffDetails) {
    els.gitDiffDetails.addEventListener("toggle", () => {
      if (
        els.gitDiffDetails.open &&
        workspaceState.panel.id &&
        !workspaceState.panel.diff &&
        !workspaceState.panel.diffLoading
      ) {
        void loadGitDiff(workspaceState.panel.id);
      }
    });
  }
  if (els.gitModal) {
    els.gitModal.addEventListener("click", (event) => {
      if (event.target === els.gitModal) closeGitPanel();
    });
    els.gitModal.addEventListener("close", () => {
      workspaceState.panel.open = false;
    });
  }

  if (els.taskPivotForm) {
    els.taskPivotForm.addEventListener("submit", (event) => void submitTaskPivot(event));
  }
  els.taskPivotNote?.addEventListener("input", hideTaskPivotError);
  if (els.taskPivotModal) {
    els.taskPivotModal.addEventListener("click", (event) => {
      if (event.target === els.taskPivotModal) closeTaskPivotModal();
    });
    els.taskPivotModal.addEventListener("close", () => {
      if (!taskRecoveryState.saving) taskRecoveryState.error = "";
    });
  }
  if (els.taskCloseForm) {
    els.taskCloseForm.addEventListener("submit", (event) => void submitTaskClose(event));
  }
  els.taskCloseNote?.addEventListener("input", hideTaskCloseError);
  if (els.taskCloseModal) {
    els.taskCloseModal.addEventListener("click", (event) => {
      if (event.target === els.taskCloseModal) closeTaskCloseModal();
    });
    els.taskCloseModal.addEventListener("close", () => {
      if (!taskRecoveryState.saving) taskRecoveryState.error = "";
    });
  }

  if (els.taskTraceModal) {
    els.taskTraceModal.addEventListener("click", (event) => {
      if (event.target === els.taskTraceModal) closeTaskTrace();
    });
  }

  if (els.modelProfileConfirm) {
    els.modelProfileConfirm.addEventListener("click", (event) => {
      if (event.target === els.modelProfileConfirm) closeModelProfileConfirm();
    });
  }

  if (els.testCenterModal) {
    els.testCenterModal.addEventListener("click", (event) => {
      if (event.target === els.testCenterModal) closeTestCenter();
    });
    els.testCenterModal.addEventListener("close", () => {
      testCenterState.open = false;
    });
  }
  if (els.testRealConfirm) {
    els.testRealConfirm.addEventListener("click", (event) => {
      if (event.target === els.testRealConfirm) closeTestRealConfirm();
    });
  }
  els.testLog?.addEventListener("scroll", () => {
    const near = isTestLogNearBottom();
    if (near !== testCenterState.autoScroll) {
      testCenterState.autoScroll = near;
      updateTestBackBottom();
      if (els.testLogHint) {
        const lines = testCenterState.details.get(testCenterState.selectedId)?.lines?.length ?? 0;
        els.testLogHint.textContent = `${lines} 行 · ${near ? "自动滚动" : "已暂停滚动"} · 最多保留 2000 行`;
      }
    }
  });
  els.testLineNumbers?.addEventListener("change", () => {
    testCenterState.lineNumbers = Boolean(els.testLineNumbers.checked);
    renderTestLog(true);
  });

  if (els.roomMenuModal) {
    els.roomMenuModal.addEventListener("click", (event) => {
      if (event.target === els.roomMenuModal) closeRoomMenu();
    });
  }
  if (els.roomEditForm) {
    els.roomEditForm.addEventListener("submit", (event) => void saveRoomEdit(event));
  }
  for (const field of [els.roomEditName, els.roomEditTopic]) {
    field?.addEventListener("input", () => {
      hideRoomEditError();
      updateRoomEditState();
    });
  }
  els.roomEditWorkspace?.addEventListener("change", () => {
    hideRoomEditError();
    updateRoomEditState();
  });
  if (els.roomEditModal) {
    els.roomEditModal.addEventListener("click", (event) => {
      if (event.target === els.roomEditModal) closeRoomEdit();
    });
    els.roomEditModal.addEventListener("close", () => {
      roomAdminState.saving = false;
      hideRoomEditError();
    });
  }
  if (els.roomDeleteModal) {
    els.roomDeleteModal.addEventListener("click", (event) => {
      if (event.target === els.roomDeleteModal) closeRoomDelete();
    });
    els.roomDeleteModal.addEventListener("close", () => {
      roomAdminState.deleting = false;
      hideRoomDeleteError();
    });
  }

  if (els.taskCommitForm) {
    els.taskCommitForm.addEventListener("submit", (event) => void submitTaskCommit(event));
  }
  els.taskCommitMessage?.addEventListener("input", () => {
    hideTaskCommitError();
    updateTaskCommitState();
  });
  els.taskCommitConfirm?.addEventListener("change", updateTaskCommitState);
  for (const [modal, closer] of [
    [els.taskDiffModal, closeTaskDiffModal],
    [els.taskCommitModal, closeTaskCommitModal],
    [els.taskRollbackModal, closeTaskRollbackModal],
  ]) {
    if (!modal) continue;
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closer();
    });
  }
  if (els.taskCommitModal) {
    els.taskCommitModal.addEventListener("close", () => {
      taskCommitModal.saving = false;
      hideTaskCommitError();
    });
  }
  if (els.taskRollbackModal) {
    els.taskRollbackModal.addEventListener("close", () => {
      taskRollbackModal.saving = false;
      hideTaskRollbackError();
    });
  }
  if (els.taskDiffModal) {
    els.taskDiffModal.addEventListener("close", () => {
      taskDiffModal.taskId = null;
      taskDiffModal.info = null;
      taskDiffModal.loading = false;
    });
  }

  if (els.catAccessForm) {
    els.catAccessForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveCatAccess();
    });
  }
  if (els.catAccessTools) {
    els.catAccessTools.addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.dataset.toolName) return;
      if (input.checked) catAccessState.selectedTools.add(input.dataset.toolName);
      else catAccessState.selectedTools.delete(input.dataset.toolName);
      updateCatAccessCounts();
    });
  }
  if (els.catAccessSkills) {
    els.catAccessSkills.addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.dataset.skillId) return;
      if (input.checked) catAccessState.selectedSkills.add(input.dataset.skillId);
      else catAccessState.selectedSkills.delete(input.dataset.skillId);
      updateCatAccessCounts();
    });
  }
  if (els.catAccessModal) {
    els.catAccessModal.addEventListener("click", (event) => {
      if (event.target === els.catAccessModal) closeCatAccess();
    });
    els.catAccessModal.addEventListener("close", () => {
      catAccessState.catId = null;
      catAccessState.saving = false;
      hideCatAccessError();
    });
  }

  if (els.taskScenario) {
    els.taskScenario.addEventListener("change", onTaskScenarioChange);
  }
  if (els.scenarioFile) {
    els.scenarioFile.addEventListener("change", () => {
      void readScenarioFile();
    });
  }
  if (els.scenarioImportText) {
    els.scenarioImportText.addEventListener("input", () => {
      hideScenarioImportErrors();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && app.conn !== "online") {
      refreshState().catch(() => setConn("offline"));
    }
  });
  window.addEventListener("pagehide", () => {
    if (app.sse) app.sse.close();
    if (testCenterState.socket) testCenterState.socket.close();
  });
}

function onGlobalClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const briefChip = target.closest("[data-brief]");
  if (briefChip) {
    applyBriefChip(briefChip);
    return;
  }

  const actionEl = target.closest("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  switch (action) {
    case "tab":
      setTab(actionEl.dataset.tab ?? "chat");
      break;
    case "mention-cat":
      if (actionEl.dataset.catId) insertMention(actionEl.dataset.catId);
      break;
    case "pick-mention":
      if (actionEl.dataset.catId) pickMention(actionEl.dataset.catId);
      break;
    case "select-task":
      if (actionEl.dataset.taskId) selectTask(actionEl.dataset.taskId);
      break;
    case "new-task":
      openNewTaskModal();
      break;
    case "close-modal":
      closeNewTaskModal();
      break;
    case "nudge":
      if (actionEl.dataset.taskId) void nudgeTask(actionEl.dataset.taskId);
      break;
    case "jump-latest":
      scrollToBottom(true);
      resetUnread();
      break;
    case "clear-focus":
      app.selectedTaskId = null;
      renderTasks();
      renderWorkspace();
      break;
    case "open-settings":
      void openSettings();
      break;
    case "close-settings":
      closeSettings();
      break;
    case "toggle-key":
      setKeyVisibility(els.settingsApiKey?.type === "password");
      break;
    case "clear-key":
      toggleClearKey();
      break;
    case "test-llm":
      void testLlmConnection();
      break;
    case "reset-studio":
      setSettingsResetConfirm(true);
      break;
    case "confirm-reset":
      void resetStudio();
      break;
    case "cancel-reset":
      setSettingsResetConfirm(false);
      break;
    case "edit-cat":
      if (actionEl.dataset.catId) openCatEdit(actionEl.dataset.catId);
      break;
    case "save-cat-model":
      if (actionEl.dataset.catId) void saveCatModel(actionEl.dataset.catId, actionEl);
      break;
    case "reload-model-profiles":
      void loadModelProfiles();
      break;
    case "apply-model-profile":
      if (actionEl.dataset.profileId) openModelProfileConfirm(actionEl.dataset.profileId);
      break;
    case "close-model-profile-confirm":
      closeModelProfileConfirm();
      break;
    case "confirm-model-profile":
      void confirmModelProfileApply();
      break;
    case "close-cat-edit":
      closeCatEdit();
      break;
    case "pick-accent":
      if (actionEl.dataset.accent) pickCatAccent(actionEl.dataset.accent);
      break;
    case "toggle-import-scenario":
      toggleScenarioImport();
      break;
    case "cancel-import-scenario":
      closeScenarioImport();
      break;
    case "import-scenario":
      void importScenario();
      break;
    case "reload-scenarios":
      void loadScenarios({ force: true });
      break;
    case "export-scenario":
      if (actionEl.dataset.scenarioId) exportScenario(actionEl.dataset.scenarioId);
      break;
    case "delete-scenario":
      if (actionEl.dataset.scenarioId) askDeleteScenario(actionEl.dataset.scenarioId);
      break;
    case "confirm-delete-scenario":
      if (actionEl.dataset.scenarioId) void deleteScenario(actionEl.dataset.scenarioId);
      break;
    case "cancel-delete-scenario":
      scenarioState.deleteConfirmId = null;
      renderScenarioList();
      break;
    case "toggle-tool-output":
      toggleToolOutput(actionEl);
      break;
    case "approve-tool":
      if (actionEl.dataset.callId) void decideToolCall(actionEl.dataset.callId, "approve", actionEl);
      break;
    case "reject-tool":
      if (actionEl.dataset.callId) void decideToolCall(actionEl.dataset.callId, "reject", actionEl);
      break;
    case "approve-tool-remember":
      if (actionEl.dataset.callId) {
        void decideToolCall(actionEl.dataset.callId, "approve", actionEl, { remember: true });
      }
      break;
    case "reject-tool-remember":
      if (actionEl.dataset.callId) {
        void decideToolCall(actionEl.dataset.callId, "reject", actionEl, { remember: true });
      }
      break;
    case "recovery-continue":
      if (actionEl.dataset.taskId) {
        void submitTaskAction(actionEl.dataset.taskId, "continue");
      }
      break;
    case "recovery-pivot":
      if (actionEl.dataset.taskId) openTaskPivotModal(actionEl.dataset.taskId);
      break;
    case "recovery-close":
      if (actionEl.dataset.taskId) openTaskCloseModal(actionEl.dataset.taskId);
      break;
    case "close-task-pivot":
      closeTaskPivotModal();
      break;
    case "close-task-close":
      closeTaskCloseModal();
      break;
    case "focus-needs-me":
      focusNeedsMe();
      break;
    case "switch-room":
      if (actionEl.dataset.roomId) setRoom(actionEl.dataset.roomId);
      break;
    case "open-test-center":
      openTestCenter();
      break;
    case "close-test-center":
      closeTestCenter();
      break;
    case "run-test-unit":
      void startTest("unit");
      break;
    case "run-test-real":
      openTestRealConfirm();
      break;
    case "run-test-scenario":
      void startTest("scenario", els.testScenario?.value ?? "basic");
      break;
    case "stop-test":
      void stopSelectedTest();
      break;
    case "select-test-run":
      if (actionEl.dataset.runId) selectTestRun(actionEl.dataset.runId);
      break;
    case "refresh-test-runs":
      void loadTestRuns();
      break;
    case "test-return-live":
      if (testCenterState.liveId) {
        testCenterState.followLive = true;
        selectTestRun(testCenterState.liveId);
      }
      break;
    case "test-fail-details":
      testCenterState.onlyFailures = !testCenterState.onlyFailures;
      testCenterState.autoScroll = true;
      renderTestLog(true);
      break;
    case "test-scroll-bottom":
      scrollTestLogToBottom();
      break;
    case "close-test-real-confirm":
      closeTestRealConfirm();
      break;
    case "confirm-test-real":
      void confirmTestReal();
      break;
    case "open-room-menu":
      if (actionEl.dataset.roomId) openRoomMenu(actionEl.dataset.roomId);
      break;
    case "close-room-menu":
      closeRoomMenu();
      break;
    case "room-action": {
      const mode = actionEl.dataset.mode;
      if (mode === "delete") openRoomDelete();
      else if (mode) openRoomEdit(mode);
      break;
    }
    case "retry-room-admin":
      roomAdminState.available = null;
      void probeRoomAdmin();
      break;
    case "close-room-edit":
      closeRoomEdit();
      break;
    case "close-room-delete":
      closeRoomDelete();
      break;
    case "confirm-room-delete":
      void confirmRoomDelete();
      break;
    case "open-room-picker":
      openRoomPicker();
      break;
    case "close-room-picker":
      closeRoomPicker();
      break;
    case "new-room":
      void openNewRoom();
      break;
    case "close-new-room":
      closeNewRoom();
      break;
    case "toggle-workspace-form":
      if (workspaceState.formOpen) closeWorkspaceForm();
      else openWorkspaceForm();
      break;
    case "cancel-workspace":
      closeWorkspaceForm();
      break;
    case "reload-workspaces":
      void loadWorkspaces();
      break;
    case "save-workspace":
      void saveWorkspace();
      break;
    case "toggle-workspace-path":
      if (actionEl.dataset.workspaceId) {
        const id = actionEl.dataset.workspaceId;
        if (workspaceState.expanded.has(id)) workspaceState.expanded.delete(id);
        else workspaceState.expanded.add(id);
        renderWorkspacesSettings();
      }
      break;
    case "open-workspace-git":
      if (actionEl.dataset.workspaceId) void openGitPanel(actionEl.dataset.workspaceId);
      break;
    case "refresh-workspace-git":
      if (actionEl.dataset.workspaceId) void loadWorkspaceGit(actionEl.dataset.workspaceId);
      break;
    case "delete-workspace":
      if (actionEl.dataset.workspaceId) askDeleteWorkspace(actionEl.dataset.workspaceId);
      break;
    case "confirm-delete-workspace":
      if (actionEl.dataset.workspaceId) void confirmDeleteWorkspace(actionEl.dataset.workspaceId);
      break;
    case "cancel-delete-workspace":
      workspaceState.deleteConfirmId = "";
      renderWorkspacesSettings();
      break;
    case "open-current-git": {
      const workspace = currentWorkspace();
      if (workspace) void openGitPanel(workspace.id);
      else toast("工作区服务未就绪", "warn");
      break;
    }
    case "close-git":
      closeGitPanel();
      break;
    case "refresh-git":
      void refreshGitPanel();
      break;
    case "open-workspace-file":
      if (actionEl.dataset.workspaceId && actionEl.dataset.path) {
        void openWorkspaceFile(actionEl.dataset.workspaceId, actionEl.dataset.path);
      }
      break;
    case "open-task-trace":
      if (actionEl.dataset.taskId) void openTaskTrace(actionEl.dataset.taskId);
      break;
    case "close-task-trace":
      closeTaskTrace();
      break;
    case "refresh-task-trace":
      if (traceState.taskId) void loadTaskTrace(traceState.taskId);
      break;
    case "filter-task-trace":
      if (actionEl.dataset.filter) {
        traceState.filter = actionEl.dataset.filter;
        renderTaskTrace();
      }
      break;
    case "toggle-trace-stage": {
      const key = actionEl.dataset.stageKey;
      if (key) {
        if (traceState.collapsedStages.has(key)) traceState.collapsedStages.delete(key);
        else traceState.collapsedStages.add(key);
        renderTaskTrace();
      }
      break;
    }
    case "toggle-trace-detail":
      actionEl.classList.toggle("is-expanded");
      break;
    case "open-task-diff":
      openTaskDiffModal();
      break;
    case "close-task-diff":
      closeTaskDiffModal();
      break;
    case "refresh-task-diff":
      if (taskDiffModal.taskId) void fetchTaskDiffModal(taskDiffModal.taskId);
      break;
    case "open-task-commit":
      openTaskCommitModal();
      break;
    case "close-task-commit":
      closeTaskCommitModal();
      break;
    case "open-task-rollback":
      openTaskRollbackModal();
      break;
    case "close-task-rollback":
      closeTaskRollbackModal();
      break;
    case "confirm-task-rollback":
      void confirmTaskRollback();
      break;
    case "copy-task-git":
      if (actionEl.dataset.copyText) {
        void copyTaskGitText(actionEl.dataset.copyText, actionEl.dataset.copyLabel);
      }
      break;
    case "toggle-mcp-form":
      if (mcpState.formOpen) closeMcpForm();
      else openMcpForm();
      break;
    case "cancel-mcp":
      closeMcpForm();
      break;
    case "save-mcp":
      void saveMcpServer();
      break;
    case "reload-mcp":
      void loadMcp();
      break;
    case "test-mcp":
      if (actionEl.dataset.id) void testMcpServer(actionEl.dataset.id);
      break;
    case "toggle-mcp":
      if (actionEl.dataset.id) {
        void toggleMcpServer(actionEl.dataset.id, actionEl.dataset.enabled !== "true");
      }
      break;
    case "delete-mcp":
      if (actionEl.dataset.id) askDeleteMcp(actionEl.dataset.id);
      break;
    case "confirm-delete-mcp":
      if (actionEl.dataset.id) void confirmDeleteMcp(actionEl.dataset.id);
      break;
    case "cancel-delete-mcp":
      mcpState.deleteConfirmId = "";
      renderMcpList();
      break;
    case "edit-cat-access":
      if (actionEl.dataset.catId) openCatAccess(actionEl.dataset.catId);
      break;
    case "close-cat-access":
      closeCatAccess();
      break;
    case "select-all-tools": {
      const names = new Set(catAccessState.tools.map((tool) => tool.name));
      for (const name of catAccessState.selectedTools) names.add(name);
      catAccessState.selectedTools = names;
      renderCatAccessTools();
      updateCatAccessCounts();
      break;
    }
    case "clear-all-tools":
      catAccessState.selectedTools = new Set();
      renderCatAccessTools();
      updateCatAccessCounts();
      break;
    case "select-all-skills": {
      const ids = new Set(catAccessState.skills.map((skill) => skill.id));
      for (const id of catAccessState.selectedSkills) ids.add(id);
      catAccessState.selectedSkills = ids;
      renderCatAccessSkills();
      updateCatAccessCounts();
      break;
    }
    case "clear-all-skills":
      catAccessState.selectedSkills = new Set();
      renderCatAccessSkills();
      updateCatAccessCounts();
      break;
    case "open-sandbox-file":
      if (actionEl.dataset.path) void openSandboxFile(actionEl.dataset.path);
      break;
    case "close-sandbox-file":
      closeSandboxFile();
      break;
    case "copy-sandbox-file":
      void copySandboxFile();
      break;
    case "refresh-sandbox":
      void loadWorkspace();
      break;
    case "reset-sandbox":
      askResetSandbox();
      break;
    case "confirm-reset-sandbox":
      void resetSandbox();
      break;
    case "cancel-reset-sandbox":
      setSandboxResetConfirm(false);
      break;
    default:
      break;
  }
}

function onGlobalKeydown(event) {
  if (event.key !== "Escape") return;
  if (app.mention.open) closeMentionPopup();
}

function onComposerInput() {
  resizeInput();
  updateComposerState();
  refreshMentionPopup();
}

function onComposerKeydown(event) {
  if (app.composing || event.isComposing) return;

  if (app.mention.open) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveMention(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveMention(-1);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const cat = app.mention.items[app.mention.index];
      if (cat) pickMention(cat.id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionPopup();
      return;
    }
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
}

function onTabbarKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const index = els.tabs.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  let next;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = els.tabs.length - 1;
  else {
    const step = event.key === "ArrowRight" ? 1 : -1;
    next = (index + step + els.tabs.length) % els.tabs.length;
  }
  els.tabs[next].focus();
  els.tabs[next].click();
}

// ── 动作：发送 / 催一下 / 新任务 / 选中任务 ────────────────────────────

async function sendMessage() {
  if (!els.input || app.sending) return;
  const text = els.input.value.trim();
  if (!text) return;

  // 真实用户最常见的错误：把一整段需求粘进聊天框，以为猫会开工。
  // 聊天不会创建任务，所以这里先问一次；只有用户明确选"就聊两句"才放行。
  if (looksLikeTaskBrief(text) && !app.briefHintAllowed) {
    showBriefHint(text);
    return;
  }
  app.briefHintAllowed = false;

  closeMentionPopup();
  app.sending = true;
  const raw = els.input.value;
  els.input.value = "";
  resizeInput();
  updateComposerState();

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(app.roomId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    scrollToBottom(true);
  } catch (error) {
    els.input.value = raw;
    resizeInput();
    toast(`发送失败：${error.message}`, "error");
  } finally {
    app.sending = false;
    updateComposerState();
    els.input.focus();
  }
}

/**
 * 粗略判断一段话是不是"需求"而不是"聊天"。
 *
 * 判据（命中两条以上才算）：够长、有列表/编号、有明确的功能动词。
 * 宁可不提示也不要烦人——只在第一次命中时提示一次。
 */
function looksLikeTaskBrief(text) {
  if (text.length < 60) return false;
  let score = 0;
  if (/\n\s*(\d+[.、)]|[-*•])/.test(text)) score += 2; // 有列表
  if (/(要求|需要|必须|希望|实现|做一个|开发|支持|导出|接入)/.test(text)) score += 1;
  if (/[,，。；;]/.test(text) && text.split(/[,，。；;]/).length >= 3) score += 1;
  return score >= 2;
}

/** 提示用户：这看起来是需求，要开任务吗？ */
function showBriefHint(text) {
  const dialog = document.createElement("div");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.innerHTML = `
    <div class="confirm-card">
      <h2>这看起来是一个需求</h2>
      <p>聊天框里的内容只会让猫"聊两句"，<strong>不会开工做任务</strong>。</p>
      <p>要把它交给四只猫正式做吗？会创建任务并进入接单 → 规划 → 实现 → 评审的流程。</p>
      <footer>
        <button type="button" data-choice="chat">就聊两句</button>
        <button type="button" class="primary" data-choice="task">开任务 🐾</button>
      </footer>
    </div>`;
  document.body.append(dialog);
  const close = () => dialog.remove();
  dialog.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const choice = target.dataset.choice;
    if (choice === "task") {
      close();
      if (els.input) els.input.value = "";
      openNewTaskModal(text);
      return;
    }
    if (choice === "chat") {
      close();
      // 用户明确表示只是聊天：放行一次，之后照常发送。
      app.briefHintAllowed = true;
      if (els.input) els.input.value = text;
      void sendMessage();
    }
  });
}

async function nudgeTask(taskId) {
  const buttons = els.progress
    ? $$('[data-action="nudge"]', els.progress).filter((button) => button.dataset.taskId === taskId)
    : [];
  for (const button of buttons) button.disabled = true;

  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/nudge`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(await readApiError(response));
    toast("已经敲了敲桌子：催一下 🐾");
  } catch (error) {
    toast(`催一下失败：${error.message}`, "error");
  } finally {
    window.setTimeout(() => {
      for (const button of buttons) button.disabled = false;
    }, 1200);
  }
}

function selectTask(taskId) {
  app.selectedTaskId = app.selectedTaskId === taskId ? null : taskId;
  renderTasks();
  renderWorkspace();
  updateStallUi();

  if (!app.selectedTaskId) return;

  const first = $$("[data-task-id]", els.timeline).find((node) => node.dataset.taskId === taskId);
  if (first) {
    first.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    first.classList.add("reveal-flash");
    window.setTimeout(() => first.classList.remove("reveal-flash"), 1300);
  }
  if (isCompactViewport()) setTab("work");
}

function setTab(tab) {
  if (!TAB_IDS.includes(tab) || app.tab === tab) return;
  app.tab = tab;
  document.body.dataset.tab = tab;
  for (const button of els.tabs) {
    const active = button.dataset.tab === tab;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (tab === "chat") {
    resetUnread();
    scrollToBottom(true);
  }
  updateUnreadUi();
}

// ── @ 自动补全 ──────────────────────────────────────────────────────────

function refreshMentionPopup() {
  if (!els.input) return;
  const caret = els.input.selectionStart ?? els.input.value.length;
  const before = els.input.value.slice(0, caret);
  const match = /(?:^|[\s\n])@([^\s@]{0,16})$/.exec(before);
  if (!match) {
    closeMentionPopup();
    return;
  }
  const prefix = match[1] ?? "";
  const lower = prefix.toLowerCase();
  const cats = roomCats().filter((cat) => {
    if (!lower) return true;
    return (
      cat.name.toLowerCase().includes(lower) ||
      cat.id.toLowerCase().includes(lower) ||
      String(cat.species ?? "").includes(prefix)
    );
  });
  if (!cats.length) {
    closeMentionPopup();
    return;
  }

  const key = `${prefix}:${cats.map((cat) => cat.id).join(",")}`;
  if (app.mention.lastKey !== key) {
    app.mention.lastKey = key;
    app.mention.index = 0;
  }

  app.mention.open = true;
  app.mention.items = cats;
  app.mention.tokenStart = caret - prefix.length - 1;
  app.mention.index = Math.max(0, Math.min(app.mention.index, cats.length - 1));
  renderMentionPopup();
}

function renderMentionPopup() {
  const popup = els.mentionPopup;
  if (!popup) return;
  if (!app.mention.open || !app.mention.items.length) {
    closeMentionPopup();
    return;
  }

  popup.replaceChildren(
    ...app.mention.items.map((cat, index) =>
      h(
        "button",
        {
          type: "button",
          class: "mention-item",
          role: "option",
          id: `mention-opt-${index}`,
          "data-action": "pick-mention",
          "data-cat-id": cat.id,
          "aria-selected": String(index === app.mention.index),
        },
        h("span", { class: "mini-avatar", html: avatarSvg(cat, { size: 30 }) }),
        h(
          "span",
          {},
          h("span", { class: "mention-item-name", text: cat.name }),
          h("span", { class: "mention-item-sub", text: `${cat.species} · ${cat.title}` }),
        ),
        h("span", { class: "mention-item-hint", text: index === app.mention.index ? "Enter ↵" : "" }),
      ),
    ),
  );

  popup.hidden = false;
  els.input.setAttribute("aria-expanded", "true");
  els.input.setAttribute("aria-controls", "mention-popup");
  updateMentionActive();
}

function updateMentionActive() {
  const popup = els.mentionPopup;
  if (!popup) return;
  const items = $$(".mention-item", popup);
  items.forEach((item, index) => {
    const active = index === app.mention.index;
    item.setAttribute("aria-selected", String(active));
    const hint = $(".mention-item-hint", item);
    if (hint) hint.textContent = active ? "Enter ↵" : "";
  });
  const activeItem = items[app.mention.index];
  if (activeItem) {
    els.input.setAttribute("aria-activedescendant", activeItem.id);
    activeItem.scrollIntoView({ block: "nearest" });
  }
}

function moveMention(delta) {
  const count = app.mention.items.length;
  if (!count) return;
  app.mention.index = (app.mention.index + delta + count) % count;
  updateMentionActive();
}

function closeMentionPopup() {
  app.mention.open = false;
  app.mention.items = [];
  app.mention.index = 0;
  app.mention.tokenStart = -1;
  app.mention.lastKey = "";
  if (els.mentionPopup) {
    els.mentionPopup.hidden = true;
    els.mentionPopup.replaceChildren();
  }
  if (els.input) {
    els.input.removeAttribute("aria-activedescendant");
    els.input.removeAttribute("aria-controls");
    els.input.setAttribute("aria-expanded", "false");
  }
}

function pickMention(catId) {
  const cat = catById(catId);
  if (!cat) return;
  if (!app.mention.open || !els.input) {
    insertMention(catId);
    return;
  }
  const caret = els.input.selectionStart ?? els.input.value.length;
  const start = Math.max(0, Math.min(app.mention.tokenStart, caret));
  const insert = `@${cat.name} `;
  els.input.value = els.input.value.slice(0, start) + insert + els.input.value.slice(caret);
  const position = start + insert.length;
  closeMentionPopup();
  resizeInput();
  updateComposerState();
  requestAnimationFrame(() => {
    els.input.focus();
    els.input.setSelectionRange(position, position);
  });
}

function insertMention(catId) {
  const cat = catById(catId);
  if (!cat || !els.input) return;
  setTab("chat");

  const input = els.input;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const needsSpace = before.length > 0 && !/\s$/.test(before);
  const insert = `${needsSpace ? " " : ""}@${cat.name} `;
  input.value = before + insert + after;
  const position = before.length + insert.length;

  closeMentionPopup();
  resizeInput();
  updateComposerState();

  requestAnimationFrame(() => {
    input.focus();
    input.setSelectionRange(position, position);
    if (els.composer) {
      els.composer.classList.add("is-flash");
      window.setTimeout(() => els.composer.classList.remove("is-flash"), 520);
    }
  });
}

// ── 新任务弹窗 ──────────────────────────────────────────────────────────

function openNewTaskModal(prefill = "") {
  if (!els.modal) return;
  hideFormError();
  if (els.newTaskRoomHint) {
    const room = currentRoom();
    els.newTaskRoomHint.textContent = room
      ? `将在「${room.name}」创建；任务和消息只属于这个房间。`
      : "将在当前房间创建。";
  }
  if (els.brief) {
    els.brief.value = prefill;
    for (const chip of els.modalChips ?? []) chip.classList.remove("is-active");
  }
  resetTaskScenarioSelect();
  updateCreateState();
  if (!els.modal.open) els.modal.showModal();
  void loadTaskScenarioOptions();
  requestAnimationFrame(() => els.brief?.focus());
}

function closeNewTaskModal() {
  if (els.modal?.open) els.modal.close();
}

function applyBriefChip(chip) {
  if (!els.brief) return;
  els.brief.value = chip.dataset.brief ?? "";
  for (const item of els.modalChips ?? []) item.classList.toggle("is-active", item === chip);
  updateCreateState();
  hideFormError();
  els.brief.focus();
  els.brief.setSelectionRange(els.brief.value.length, els.brief.value.length);
}

function updateCreateState() {
  if (!els.createBtn || !els.brief) return;
  const length = els.brief.value.trim().length;
  els.createBtn.disabled = app.creating || length < 4;
  els.createBtn.textContent = app.creating ? "正在召唤猫猫…" : "让猫猫开工 🐾";
}

function showFormError(message) {
  if (!els.formError) return;
  els.formError.textContent = message;
  els.formError.hidden = false;
}

function hideFormError() {
  if (!els.formError) return;
  els.formError.hidden = true;
  els.formError.textContent = "";
}

async function createTask() {
  if (app.creating || !els.brief) return;
  const brief = els.brief.value.trim();
  if (brief.length < 4) {
    showFormError("至少写 4 个字，猫猫才看得懂。");
    return;
  }

  app.creating = true;
  updateCreateState();
  try {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: app.roomId,
        brief,
        ...(els.taskScenario?.value ? { scenarioId: els.taskScenario.value } : {}),
      }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    await response.json();
    closeNewTaskModal();
    // 不自动「聚焦」新任务：进度面板默认跟最新未完成任务即可，避免多出一个「看全部」。
    app.selectedTaskId = null;
    renderTasks();
    renderWorkspace();
    updateStallUi();
    setTab("chat");
    toast("新任务已开工，宪宪先接单 🐾");
    els.input?.focus();
  } catch (error) {
    showFormError(`创建失败：${error.message}`);
    toast(`创建失败：${error.message}`, "error");
  } finally {
    app.creating = false;
    updateCreateState();
  }
}

// ── 设置面板 ────────────────────────────────────────────────────────────

async function refreshGlobalModel() {
  try {
    const response = await fetch("/api/settings", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = await response.json();
    const model = String(data?.llm?.model ?? "");
    if (model !== app.globalModel) {
      app.globalModel = model;
      renderRoster();
    }
  } catch {
    /* 设置接口未就绪时名册显示「演出」/「跟随全局」即可 */
  }
}

async function openSettings() {
  const modal = els.settingsModal;
  if (!modal) return;

  settingsState.loading = false;
  settingsState.ready = false;
  settingsState.data = null;
  settingsState.saving = false;
  settingsState.testing = false;
  settingsState.resetting = false;
  settingsState.resetConfirm = false;
  settingsState.clearKeyRequested = false;

  hideSettingsError();
  hideModeWarn();
  setSettingsResetConfirm(false);
  setTestResult("idle", "填好 Base URL 与模型后可以测试。");
  setSettingsNotice("正在读取设置…", "pending");
  resetSettingsForm();
  renderSettingsReadonly(null);
  renderCatModelList();
  renderScenarioList();
  updateSettingsButtons();

  if (!modal.open) modal.showModal();
  void loadScenarios();
  void loadMcp();
  void loadToolCatalog();
  void loadWorkspaces();
  void loadModelProfiles();
  await loadSettings();
}

function closeSettings() {
  if (els.settingsModal?.open) els.settingsModal.close();
}

async function fetchSettings() {
  const response = await fetch("/api/settings", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await describeHttpError(response, "GET /api/settings"));
  return response.json();
}

async function describeHttpError(response, label) {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === "string" && payload.error) {
      return `${label}：${payload.error}`;
    }
  } catch {
    /* 非 JSON 错误体 */
  }
  return `${label} → HTTP ${response.status}`;
}

async function loadSettings() {
  settingsState.loading = true;
  updateSettingsButtons();
  try {
    const data = await fetchSettings();
    settingsState.data = data;
    settingsState.ready = true;
    const globalModel = String(data?.llm?.model ?? "");
    if (globalModel !== app.globalModel) {
      app.globalModel = globalModel;
      renderRoster();
    }
    fillSettingsForm(data);
    renderSettingsReadonly(data);
    renderCatModelList();
    hideSettingsNotice();
  } catch (error) {
    settingsState.ready = false;
    resetSettingsForm();
    renderSettingsReadonly(null);
    setSettingsNotice(
      `设置服务未就绪（${error.message}）。按钮仍可点击，会在面板内显示具体错误；接口就绪后重新打开设置即可。`,
      "warn",
    );
  } finally {
    settingsState.loading = false;
    updateSettingsButtons();
  }
}

function resetSettingsForm() {
  setModeRadios(app.state?.mode === "llm" ? "llm" : "mock");
  setSpeedRadios("normal");
  settingsState.streamingAvailable = null;
  if (els.settingsStreaming) {
    els.settingsStreaming.checked = true;
    els.settingsStreaming.disabled = false;
  }
  if (els.settingsStreamingHint) {
    els.settingsStreamingHint.textContent =
      "开启后真实模式下猫的话会逐段出现；关闭则等整段说完再显示。演出模式不受影响。";
    delete els.settingsStreamingHint.dataset.missing;
  }
  if (els.settingsBaseUrl) els.settingsBaseUrl.value = "";
  if (els.settingsModel) els.settingsModel.value = "";
  if (els.settingsTemperature) els.settingsTemperature.value = "0.8";
  updateTempOutput();
  if (els.settingsApiKey) els.settingsApiKey.value = "";
  setKeyVisibility(false);
  renderKeyStatus(null);
  if (els.settingsToolsToggle) els.settingsToolsToggle.checked = true;
  if (els.settingsToolsHint) delete els.settingsToolsHint.dataset.missing;
  if (els.settingsToolApproval) els.settingsToolApproval.value = "commands";
  if (els.settingsToolApprovalHint) {
    els.settingsToolApprovalHint.textContent =
      "仅对真实模式下模型主动发起的工具生效；剧本工具自动放行。";
  }
  updateToolsHint();
  hideModeWarn();
}

function fillSettingsForm(data) {
  const mode = data?.mode === "llm" ? "llm" : "mock";
  const speed = ["slow", "normal", "fast"].includes(data?.speed) ? data.speed : "normal";
  const llm = data?.llm ?? {};

  setModeRadios(mode);
  setSpeedRadios(speed);
  const streamingAvailable = typeof data?.streaming === "boolean";
  settingsState.streamingAvailable = streamingAvailable;
  if (els.settingsStreaming) {
    els.settingsStreaming.checked = streamingAvailable ? data.streaming : true;
    els.settingsStreaming.disabled = !streamingAvailable;
  }
  if (els.settingsStreamingHint) {
    if (streamingAvailable) {
      els.settingsStreamingHint.textContent =
        "开启后真实模式下猫的话会逐段出现；关闭则等整段说完再显示。演出模式不受影响。";
      delete els.settingsStreamingHint.dataset.missing;
    } else {
      els.settingsStreamingHint.textContent =
        "当前服务端未提供 streaming 字段（旧版本），开关不可用，按默认开启处理。";
      els.settingsStreamingHint.dataset.missing = "true";
    }
  }
  if (els.settingsBaseUrl) els.settingsBaseUrl.value = llm.baseUrl ?? "";
  if (els.settingsModel) els.settingsModel.value = llm.model ?? "";
  const temperature = Number(llm.temperature);
  if (els.settingsTemperature) {
    els.settingsTemperature.value = String(Number.isFinite(temperature) ? temperature : 0.8);
  }
  updateTempOutput();
  if (els.settingsApiKey) els.settingsApiKey.value = "";
  setKeyVisibility(false);
  settingsState.clearKeyRequested = false;
  renderKeyStatus(llm);
  if (els.settingsToolsToggle) {
    const toolsEnabled =
      typeof data?.toolsEnabled === "boolean" ? data.toolsEnabled : true;
    els.settingsToolsToggle.checked = toolsEnabled;
    if (els.settingsToolsHint) {
      if (typeof data?.toolsEnabled === "boolean") {
        delete els.settingsToolsHint.dataset.missing;
      } else {
        els.settingsToolsHint.dataset.missing = "true";
      }
    }
  }
  if (els.settingsToolApproval) {
    const approval = ["auto", "commands", "all"].includes(data?.toolApproval)
      ? data.toolApproval
      : "commands";
    els.settingsToolApproval.value = approval;
    if (els.settingsToolApprovalHint) {
      const missing = typeof data?.toolApproval !== "string";
      els.settingsToolApprovalHint.textContent = missing
        ? "仅对真实模式下模型主动发起的工具生效；当前服务端未返回 toolApproval（可能未就绪）。"
        : "仅对真实模式下模型主动发起的工具生效；剧本工具自动放行。";
    }
  }
  updateToolsHint();
  hideModeWarn();
  renderModelProfiles();
}

function setModeRadios(mode) {
  for (const input of els.settingsModeInputs) input.checked = input.value === mode;
  syncSettingsSegments();
}

function setSpeedRadios(speed) {
  for (const input of els.settingsSpeedInputs) input.checked = input.value === speed;
  syncSettingsSegments();
}

function syncSettingsSegments() {
  if (!els.settingsForm) return;
  for (const segment of $$(".segment", els.settingsForm)) {
    const input = segment.querySelector('input[type="radio"]');
    segment.classList.toggle("is-active", Boolean(input?.checked));
  }
}

function currentModeChoice() {
  return els.settingsModeInputs.find((input) => input.checked)?.value ?? "mock";
}

function currentSpeedChoice() {
  return els.settingsSpeedInputs.find((input) => input.checked)?.value ?? "normal";
}

function renderKeyStatus(llm) {
  const hasKey = Boolean(llm?.hasKey);
  const source =
    llm?.keySource === "env" ? "环境变量" : llm?.keySource === "ui" ? "设置面板" : "";
  const pendingClear = settingsState.clearKeyRequested;

  if (els.settingsKeyStatus) {
    const status = els.settingsKeyStatus;
    status.dataset.state = pendingClear ? "pending" : hasKey ? "ok" : "empty";
    const text = $("[data-key-status-text]", status);
    if (text) {
      text.textContent = pendingClear
        ? "保存后清除"
        : hasKey
          ? `已配置${source ? ` · ${source}` : ""}`
          : "未配置";
    }
  }

  if (els.settingsApiKey) {
    els.settingsApiKey.placeholder = pendingClear
      ? "保存后将清除已保存的 Key"
      : hasKey
        ? "已配置，留空则不修改"
        : "输入 API Key（可留空）";
  }

  if (els.settingsKeyHint) {
    els.settingsKeyHint.textContent = hasKey && !pendingClear
      ? `已保存 Key（来源：${source || "服务内存"}），留空则不修改。`
      : pendingClear
        ? "点击下方按钮可以取消清除；保存前仍会使用已保存的 Key。"
        : "只保存在服务内存，不写盘。";
  }

  if (els.settingsClearKey) {
    els.settingsClearKey.hidden = !hasKey;
    els.settingsClearKey.textContent = pendingClear ? "取消清除 Key" : "清除已保存的 Key";
  }
}

function toggleClearKey() {
  if (!settingsState.data?.llm?.hasKey) return;
  settingsState.clearKeyRequested = !settingsState.clearKeyRequested;
  renderKeyStatus(settingsState.data.llm);
}

function setKeyVisibility(visible) {
  if (!els.settingsApiKey) return;
  els.settingsApiKey.type = visible ? "text" : "password";
  if (els.settingsKeyToggle) {
    els.settingsKeyToggle.setAttribute("aria-pressed", String(visible));
    els.settingsKeyToggle.setAttribute("aria-label", visible ? "隐藏 API Key" : "显示 API Key");
    els.settingsKeyToggle.textContent = visible ? "🙈" : "👁";
  }
}

function updateTempOutput() {
  if (!els.settingsTempValue || !els.settingsTemperature) return;
  const value = Number(els.settingsTemperature.value);
  els.settingsTempValue.textContent = Number.isFinite(value) ? value.toFixed(1) : "0.8";
}

function renderSettingsReadonly(data) {
  if (!els.settingsInfo) return;
  const snapshot = app.state;
  const mode = data?.mode ?? snapshot?.mode;
  const stallMs = Number(data?.stallMs);
  const rows = [
    ["版本", data?.version ?? "—"],
    ["端口", data?.port != null ? String(data.port) : "—"],
    ["Node", data?.node ?? "—"],
    ["启动时间", data?.startedAt ? fmtFull(data.startedAt) : "—"],
    ["当前模式", mode === "llm" ? "真实模式（LLM）" : "演出模式"],
    ["stallMs", Number.isFinite(stallMs) ? `${stallMs} ms` : `${app.stallMs} ms（本地阈值）`],
  ];

  const nodes = rows.map(([label, value]) =>
    h(
      "div",
      {},
      h("dt", { text: label }),
      h("dd", { text: String(value) }),
    ),
  );
  nodes.push(
    h(
      "div",
      { class: "settings-info-wide" },
      h("dt", { text: "数据目录" }),
      h("dd", { text: data?.dataDir ?? "—" }),
    ),
  );
  els.settingsInfo.replaceChildren(...nodes);
}

function showModeWarn(message) {
  if (!els.settingsModeWarn) return;
  els.settingsModeWarn.textContent = message;
  els.settingsModeWarn.hidden = false;
}

function hideModeWarn() {
  if (!els.settingsModeWarn) return;
  els.settingsModeWarn.hidden = true;
  els.settingsModeWarn.textContent = "";
}

function setSettingsNotice(message, tone = "warn") {
  if (!els.settingsNotice) return;
  els.settingsNotice.hidden = false;
  els.settingsNotice.dataset.tone = tone;
  const text = $("[data-settings-notice-text]", els.settingsNotice);
  if (text) text.textContent = message;
}

function hideSettingsNotice() {
  if (els.settingsNotice) els.settingsNotice.hidden = true;
}

function showSettingsError(message) {
  if (!els.settingsError) return;
  els.settingsError.textContent = message;
  els.settingsError.hidden = false;
}

function hideSettingsError() {
  if (!els.settingsError) return;
  els.settingsError.hidden = true;
  els.settingsError.textContent = "";
}

function setTestResult(tone, message) {
  if (!els.settingsTestResult) return;
  els.settingsTestResult.dataset.tone = tone;
  els.settingsTestResult.textContent = message;
}

function setSettingsResetConfirm(show) {
  settingsState.resetConfirm = show;
  if (els.settingsResetBtn) els.settingsResetBtn.hidden = show;
  if (els.settingsResetConfirm) els.settingsResetConfirm.hidden = !show;
}

function updateSettingsButtons() {
  if (els.settingsSaveBtn) {
    els.settingsSaveBtn.disabled = settingsState.saving;
    els.settingsSaveBtn.textContent = settingsState.saving ? "保存中…" : "保存配置";
  }
  if (els.settingsTestBtn) {
    els.settingsTestBtn.disabled = settingsState.testing;
    els.settingsTestBtn.textContent = settingsState.testing ? "测试中…" : "🔌 测试连接";
  }
  if (els.settingsConfirmReset) els.settingsConfirmReset.disabled = settingsState.resetting;
  if (els.settingsResetBtn) {
    els.settingsResetBtn.disabled = settingsState.resetting;
    els.settingsResetBtn.textContent = settingsState.resetting ? "重置中…" : "重置猫咖";
  }
  if (els.settingsForm) {
    els.settingsForm.setAttribute("aria-busy", settingsState.loading ? "true" : "false");
  }
}

function onSettingsChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.name === "settings-mode") {
    syncSettingsSegments();
    onSettingsModeChange();
  } else if (target.name === "settings-speed") {
    syncSettingsSegments();
  } else if (target === els.settingsToolsToggle) {
    updateToolsHint();
  }
}

function onSettingsModeChange() {
  const mode = currentModeChoice();
  const baseUrl = els.settingsBaseUrl?.value.trim() ?? "";
  const model = els.settingsModel?.value.trim() ?? "";
  if (mode !== "llm") {
    hideModeWarn();
    return;
  }
  if (baseUrl && model) {
    hideModeWarn();
    return;
  }
  showModeWarn("真实模式需要先填写 Base URL 和模型名，已定位到 LLM 连接。");
  els.settingsLlmSection?.scrollIntoView({
    block: "center",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
  els.settingsBaseUrl?.focus({ preventScroll: true });
}

function onSettingsInput(event) {
  const target = event.target;
  if (target === els.settingsTemperature) {
    updateTempOutput();
    return;
  }
  if (target === els.settingsApiKey && settingsState.clearKeyRequested) {
    if (String(target.value ?? "").trim()) {
      settingsState.clearKeyRequested = false;
      renderKeyStatus(settingsState.data?.llm ?? null);
    }
    return;
  }
  if (
    (target === els.settingsBaseUrl || target === els.settingsModel) &&
    currentModeChoice() === "llm" &&
    els.settingsBaseUrl?.value.trim() &&
    els.settingsModel?.value.trim()
  ) {
    hideModeWarn();
  }
}

function collectSettingsPatch() {
  const patch = {
    mode: currentModeChoice(),
    speed: currentSpeedChoice(),
    toolsEnabled: els.settingsToolsToggle ? Boolean(els.settingsToolsToggle.checked) : true,
    toolApproval: els.settingsToolApproval?.value ?? "commands",
    ...(settingsState.streamingAvailable
      ? { streaming: els.settingsStreaming ? Boolean(els.settingsStreaming.checked) : true }
      : {}),
    llm: {
      baseUrl: els.settingsBaseUrl?.value.trim() ?? "",
      model: els.settingsModel?.value.trim() ?? "",
      temperature: Number(els.settingsTemperature?.value ?? 0.8),
    },
  };
  const apiKey = els.settingsApiKey?.value.trim() ?? "";
  if (apiKey) patch.llm.apiKey = apiKey;
  if (settingsState.clearKeyRequested) patch.llm.clearKey = true;
  return patch;
}

async function saveSettings() {
  if (settingsState.saving) return;
  hideSettingsError();

  // 没拿到当前配置时不提交，避免把服务端已有配置覆盖成空值。
  if (!settingsState.ready || !settingsState.data) {
    showSettingsError("设置服务未就绪，无法保存。请等设置接口恢复后重新打开设置。");
    return;
  }

  settingsState.saving = true;
  updateSettingsButtons();
  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectSettingsPatch()),
    });
    if (!response.ok) throw new Error(await describeHttpError(response, "PUT /api/settings"));
    const data = await response.json();

    settingsState.data = data;
    settingsState.ready = true;
    settingsState.clearKeyRequested = false;
    const globalModel = String(data?.llm?.model ?? "");
    if (globalModel !== app.globalModel) {
      app.globalModel = globalModel;
      renderRoster();
      renderCatModelList();
    }
    fillSettingsForm(data);
    renderSettingsReadonly(data);
    hideSettingsNotice();
    setTestResult("idle", "配置已更新，可重新测试连接。");
    hideSettingsError();
    toast("配置已保存");

    // 模式/节奏可能在服务端即时生效；同步一次状态与健康信息。
    void refreshState().catch(() => {});
    void refreshHealth();
  } catch (error) {
    showSettingsError(`保存失败：${error.message}`);
  } finally {
    settingsState.saving = false;
    updateSettingsButtons();
  }
}

async function testLlmConnection() {
  if (settingsState.testing) return;
  const baseUrl = els.settingsBaseUrl?.value.trim() ?? "";
  const model = els.settingsModel?.value.trim() ?? "";
  const apiKey = els.settingsApiKey?.value.trim() ?? "";

  if (!baseUrl || !model) {
    setTestResult("error", "先填 Base URL 和模型名再测试。");
    onSettingsModeChange();
    return;
  }

  settingsState.testing = true;
  updateSettingsButtons();
  setTestResult("pending", "正在测试连接…");
  try {
    const payload = { baseUrl, model };
    if (apiKey) payload.apiKey = apiKey;
    const response = await fetch("/api/settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(await describeHttpError(response, "POST /api/settings/test"));
    const result = await response.json();

    const ok = Boolean(result?.ok);
    const latency = Number(result?.latencyMs);
    const detail = String(result?.detail ?? "").trim();
    const latencyText = Number.isFinite(latency) ? ` · ${latency}ms` : "";
    const label = ok ? "连接成功" : "连接失败";
    // 服务端 detail 常已包含「连接成功/失败」，避免重复。
    const text = detail
      ? detail.includes(label)
        ? `${detail}${latencyText}`
        : `${label}${latencyText} · ${detail}`
      : `${label}${latencyText}`;
    setTestResult(ok ? "ok" : "error", text);
  } catch (error) {
    setTestResult("error", `设置服务未就绪或测试失败：${error.message}`);
  } finally {
    settingsState.testing = false;
    updateSettingsButtons();
  }
}

async function resetStudio() {
  if (settingsState.resetting) return;
  hideSettingsError();
  settingsState.resetting = true;
  updateSettingsButtons();
  try {
    const response = await fetch("/api/reset", { method: "POST" });
    if (!response.ok) throw new Error(await describeHttpError(response, "POST /api/reset"));
    await response.json().catch(() => null);

    app.selectedTaskId = null;
    app.expanded.clear();
    await refreshState().catch(() => {});
    void refreshHealth();
    setSettingsResetConfirm(false);
    closeSettings();
    toast("猫咖已重置，任务、消息、产物与记忆已清空");
  } catch (error) {
    setSettingsResetConfirm(false);
    showSettingsError(`重置失败：${error.message}`);
  } finally {
    settingsState.resetting = false;
    updateSettingsButtons();
  }
}


// ── 设置 · 猫猫与模型 / 猫猫档案 ────────────────────────────────────────

// ── 任务轨迹面板 ───────────────────────────────────────────────────────

const TRACE_KIND_META = {
  llm: { icon: "✦", label: "模型" },
  tool: { icon: "🛠", label: "工具" },
  handoff: { icon: "🔁", label: "交接" },
  artifact: { icon: "📄", label: "产物" },
  review: { icon: "🔍", label: "评审" },
  chat: { icon: "💬", label: "发言" },
  decision: { icon: "⚖", label: "决策" },
  memory: { icon: "🧠", label: "记忆" },
  system: { icon: "•", label: "系统" },
};

function traceTime(at) {
  const date = new Date(Number(at) || Date.now());
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function traceNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("zh-CN").format(number) : "0";
}

function traceActorName(actor, actorName) {
  if (actorName) return actorName;
  if (actor === "user") return "铲屎官";
  if (actor === "system") return "系统";
  return catById(actor)?.name ?? actor ?? "未知";
}

function parseTraceLlmDetail(detail) {
  const text = String(detail ?? "");
  const duration = /·\s*(\d+)ms(?:\s*·|$)/.exec(text);
  const tokens = /in\s+(\d+)\/out\s+(\d+)/.exec(text);
  return {
    durationMs: duration ? Number(duration[1]) : undefined,
    input: tokens ? Number(tokens[1]) : undefined,
    output: tokens ? Number(tokens[2]) : undefined,
  };
}

function parseToolTraceStatus(detail) {
  const match = /(?:^|\s)(ok|error|rejected)(?:\s|\(|$)/.exec(String(detail ?? ""));
  return match ? match[1] : "";
}

async function openTaskTrace(taskId) {
  const task = taskId ? taskById(taskId) : activeTask();
  if (!task || !els.taskTraceModal) return;
  traceState.taskId = task.id;
  traceState.filter = "all";
  traceState.collapsedStages = new Set();
  traceState.error = "";
  traceState.data = null;
  traceState.available = null;
  traceState.loading = true;
  if (els.traceSub) els.traceSub.textContent = `${task.title} · 读取轨迹…`;
  if (!els.taskTraceModal.open) els.taskTraceModal.showModal();
  renderTaskTrace();
  await loadTaskTrace(task.id);
}

function closeTaskTrace() {
  if (els.taskTraceModal?.open) els.taskTraceModal.close();
  traceState.taskId = null;
  traceState.data = null;
  traceState.loading = false;
}

async function loadTaskTrace(taskId) {
  const requestId = ++traceState.requestId;
  traceState.loading = true;
  traceState.error = "";
  renderTaskTrace();
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/trace`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 503) {
      throw Object.assign(new Error("轨迹服务未就绪"), { unavailable: true });
    }
    if (!response.ok) throw new Error(await describeHttpError(response, "GET task trace"));
    const payload = await response.json();
    if (requestId !== traceState.requestId) return;
    traceState.data = payload;
    traceState.available = true;
    traceState.error = "";
  } catch (error) {
    if (requestId !== traceState.requestId) return;
    traceState.available = false;
    traceState.error = error.unavailable
      ? "轨迹服务未就绪（GET /api/tasks/:id/trace 404/503）"
      : `轨迹读取失败：${error.message}`;
    traceState.data = null;
  } finally {
    if (requestId === traceState.requestId) {
      traceState.loading = false;
      renderTaskTrace();
    }
  }
}

function traceVisibleEntries(entries) {
  const filter = traceState.filter;
  if (filter === "all") return entries;
  return entries.filter((entry) => entry.kind === filter);
}

function traceStageGroups(entries) {
  const groups = [];
  let current = { stage: "", label: "开始", at: null, entries: [] };
  for (const entry of entries) {
    if (entry.kind === "stage") {
      const stage = String(entry.meta?.stage ?? "");
      const hasContent = current.entries.length > 0;
      if (hasContent || groups.length) groups.push(current);
      current = {
        stage,
        label: STAGE_LABEL.get(stage) ?? stage ?? "阶段",
        at: entry.at,
        actorName: entry.actorName ?? entry.actor,
        entries: [],
      };
      continue;
    }
    current.entries.push(entry);
  }
  groups.push(current);
  return groups.filter((group) => group.stage || group.entries.length);
}

function traceSummaryNode(data) {
  const summary = data?.summary ?? {};
  const duration = Number(summary.durationMs) || 0;
  const llmDuration = Number(summary.llmDurationMs) || 0;
  const llmCalls = Number(summary.llmCalls) || 0;
  const percent = duration > 0 ? Math.round((llmDuration / duration) * 100) : 0;
  const metrics = [
    { label: "总耗时", value: formatTestDuration(duration) },
    { label: "模型调用", value: `${llmCalls} 次` },
    { label: "Tokens", value: `in ${traceNumber(summary.inputTokens)} / out ${traceNumber(summary.outputTokens)}` },
    { label: "工具", value: `${Number(summary.toolCalls) || 0} 次` },
    { label: "交接", value: `${Number(summary.handoffs) || 0} 次` },
    { label: "产物", value: `${Number(summary.artifacts) || 0} 个` },
    { label: "降级", value: `${Number(summary.degradations) || 0} 次`, tone: Number(summary.degradations) > 0 ? "danger" : "" },
    { label: "审批拒绝", value: `${Number(summary.approvals) || 0} 次` },
    { label: "重试", value: `${Number(summary.retries) || 0} 次` },
  ];
  const hero = h(
    "div",
    { class: "trace-hero" },
    h(
      "div",
      { class: "trace-hero-main" },
      h("span", { class: "trace-hero-value", text: `${percent}%` }),
      h("span", { class: "trace-hero-label", text: "模型思考占总耗时" }),
      h("span", {
        class: "trace-hero-sub",
        text: `模型 ${formatTestDuration(llmDuration)} / 总 ${formatTestDuration(duration)} · ${llmCalls} 次调用`,
      }),
    ),
    h(
      "div",
      { class: "trace-share" },
      h(
        "div",
        {
          class: "trace-share-track",
          role: "img",
          "aria-label": `模型思考占总耗时 ${percent}%`,
        },
        h("i", { class: "trace-share-fill", style: `width:${Math.max(percent, 0)}%` }),
      ),
      h(
        "div",
        { class: "trace-share-legend" },
        h("span", {}, h("i", { class: "trace-share-dot" }), `模型 ${formatTestDuration(llmDuration)}`),
        h("span", {}, h("i", { class: "trace-share-dot", "data-kind": "other" }), `其他 ${formatTestDuration(Math.max(0, duration - llmDuration))}`),
      ),
    ),
  );
  return [hero, h("div", { class: "trace-metrics" }, ...metrics.map((metric) =>
    h(
      "div",
      { class: "trace-metric", "data-tone": metric.tone ?? "" },
      h("span", { class: "trace-metric-label", text: metric.label }),
      h("span", { class: "trace-metric-value", text: metric.value }),
    ),
  ))];
}

function renderTaskTrace() {
  if (!els.traceTimeline) return;
  const task = traceState.taskId ? taskById(traceState.taskId) : null;
  if (els.traceSub) {
    els.traceSub.textContent = task
      ? `${task.title} · ${task.status === "done" ? "已完成" : task.status === "stalled" ? "卡住了" : "进行中"}`
      : "一次协作里发生了什么。";
  }
  if (els.traceSummary) {
    els.traceSummary.replaceChildren();
    if (!traceState.loading && traceState.data) {
      els.traceSummary.append(...traceSummaryNode(traceState.data));
    }
  }
  for (const button of els.traceFilters ?? []) {
    button.classList.toggle("is-active", button.dataset.filter === traceState.filter);
  }
  if (els.traceError) {
    els.traceError.hidden = !traceState.error;
    els.traceError.textContent = traceState.error || "";
  }

  const timeline = els.traceTimeline;
  if (els.traceCount) els.traceCount.textContent = "";
  if (traceState.loading) {
    timeline.replaceChildren(h("div", { class: "trace-empty", text: "读取轨迹…" }));
    return;
  }
  if (traceState.available === false) {
    timeline.replaceChildren(
      h(
        "div",
        { class: "trace-empty" },
        h("strong", { text: "轨迹服务未就绪" }),
        h("span", { text: traceState.error || "接口 404/503" }),
        h("button", {
          type: "button",
          class: "btn btn--ghost btn--tiny",
          "data-action": "refresh-task-trace",
          text: "↻ 重试",
        }),
      ),
    );
    return;
  }
  const entries = Array.isArray(traceState.data?.entries) ? traceState.data.entries : [];
  if (!entries.length) {
    timeline.replaceChildren(h("div", { class: "trace-empty", text: "这个任务还没有轨迹。" }));
    return;
  }

  const visible = traceVisibleEntries(entries);
  if (els.traceCount) els.traceCount.textContent = `${visible.length} 条轨迹`;
  if (!visible.length) {
    timeline.replaceChildren(h("div", { class: "trace-empty", text: "没有匹配的轨迹条目。" }));
    return;
  }

  const maxLlmDuration = Math.max(
    1,
    ...entries
      .filter((entry) => entry.kind === "llm")
      .map((entry) => parseTraceLlmDetail(entry.detail).durationMs ?? 0),
  );

  const groups = traceStageGroups(entries);
  const nodes = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const groupEntries = traceVisibleEntries(group.entries);
    if (!groupEntries.length && traceState.filter !== "all") continue;
    const key = group.stage ? `${group.stage}:${group.at ?? index}` : `group:${index}`;
    const collapsed = traceState.collapsedStages.has(key);
    const section = h("div", {
      class: `trace-stage${collapsed ? " is-collapsed" : ""}`,
      role: "group",
      "data-stage-key": key,
    });
    if (group.stage) {
      section.appendChild(
        h(
          "button",
          {
            type: "button",
            class: "trace-stage-head",
            "data-action": "toggle-trace-stage",
            "data-stage-key": key,
            "aria-expanded": collapsed ? "false" : "true",
          },
          h("span", { class: "trace-stage-chevron", text: "▾" }),
          h("span", { class: "trace-stage-name", text: group.label }),
          h("span", { class: "trace-stage-time", text: group.at ? traceTime(group.at) : "" }),
          h("span", {
            class: "trace-stage-count",
            text: `${groupEntries.length} 条`,
          }),
        ),
      );
    }
    const list = h("div", { class: "trace-stage-entries" });
    for (const entry of groupEntries) {
      list.appendChild(traceEntryNode(entry, maxLlmDuration));
    }
    section.appendChild(list);
    nodes.push(section);
  }
  if (!nodes.length) {
    timeline.replaceChildren(h("div", { class: "trace-empty", text: "没有匹配的轨迹条目。" }));
    return;
  }
  timeline.replaceChildren(...nodes);
}

function traceEntryNode(entry, maxLlmDuration) {
  const kind = String(entry.kind ?? "chat");
  const meta = TRACE_KIND_META[kind] ?? { icon: "•", label: kind };
  const actor = entry.actor ?? "";
  const cat = actor !== "user" && actor !== "system" ? catById(actor) : null;
  const actorName = traceActorName(actor, entry.actorName);
  const degraded = kind === "llm" && entry.meta?.degraded === true;
  const llm = kind === "llm" ? parseTraceLlmDetail(entry.detail) : null;
  const toolStatus = kind === "tool" ? parseToolTraceStatus(entry.detail) : "";
  const detail = h("div", {
    class: "trace-detail",
    "data-action": "toggle-trace-detail",
    title: entry.detail || "",
    text: entry.detail || "",
    "data-tool-status": toolStatus,
  });
  const children = [
    h("span", { class: "trace-actor" },
      h("i", {
        class: "trace-actor-dot",
        "data-actor": actor,
        style: cat?.accent ? `--accent:${safeCss(cat.accent)}` : null,
      }),
      h("span", { text: actorName }),
    ),
    detail,
  ];
  if (kind === "llm") {
    const metaRow = h("div", { class: "trace-llm-meta" });
    if (llm?.durationMs !== undefined) {
      metaRow.appendChild(h("span", { class: "trace-llm-duration", text: `${llm.durationMs}ms` }));
      const width = Math.max(4, Math.round((llm.durationMs / maxLlmDuration) * 100));
      metaRow.appendChild(h("span", { class: "trace-llm-bar", title: `相对耗时 ${width}%` }, h("i", { style: `width:${width}%` })));
    }
    if (llm?.input !== undefined || llm?.output !== undefined) {
      metaRow.appendChild(h("span", {
        class: "trace-llm-tokens",
        text: `in ${traceNumber(llm.input)} / out ${traceNumber(llm.output)}`,
      }));
    }
    if (degraded) metaRow.appendChild(h("span", { class: "trace-degraded-badge", text: "降级" }));
    children.push(metaRow);
  }
  if (kind === "tool" && entry.meta?.label) {
    children.push(h("span", {
      class: "trace-tool-extra",
      text: `${entry.meta.label}${entry.meta.durationMs !== undefined ? ` · ${entry.meta.durationMs}ms` : ""}`,
    }));
  }
  return h(
    "div",
    {
      class: "trace-item",
      role: "listitem",
      "data-kind": kind,
      "data-degraded": degraded ? "true" : "false",
      ...(degraded ? { title: String(entry.meta?.degradeReason ?? "模型调用降级") } : {}),
    },
    h("span", { class: "trace-time", text: traceTime(entry.at) }),
    h("span", { class: "trace-icon", "aria-hidden": "true", title: meta.label, text: meta.icon }),
    h("div", { class: "trace-body" }, ...children),
  );
}

// ── 模型分工档案 ───────────────────────────────────────────────────────

const MODEL_PROFILE_STORAGE_KEY = "catcafe.modelProfileId";

function modelProfileGlobalModel() {
  return String(settingsState.data?.llm?.model ?? app.globalModel ?? "").trim();
}

function catEffectiveModel(cat) {
  const override = String(cat?.llmModel ?? "").trim();
  if (override) return override;
  return modelProfileGlobalModel() || "跟随全局";
}

function catEffectiveModelBadge(cat) {
  const override = String(cat?.llmModel ?? "").trim();
  if (override) return override;
  const global = modelProfileGlobalModel();
  return global ? `跟随全局：${global}` : "跟随全局";
}

function currentModelMode() {
  const cats = app.state?.cats ?? [];
  if (!cats.length) return "uniform";
  const effective = cats.map((cat) => catEffectiveModel(cat));
  return new Set(effective).size > 1 ? "mixed" : "uniform";
}

function profileMatchesCurrent(profile) {
  const cats = app.state?.cats ?? [];
  if (!profile || !cats.length) return false;
  if (!profile.assignments?.length) {
    return cats.every(
      (cat) =>
        !String(cat?.llmModel ?? "").trim() &&
        cat?.llmTemperature === undefined,
    );
  }
  const byCat = new Map(profile.assignments.map((item) => [item.catId, item]));
  return cats.every((cat) => {
    const assignment = byCat.get(cat.id);
    if (!assignment) return false;
    const model = String(cat.llmModel ?? "").trim();
    const temp = typeof cat.llmTemperature === "number" ? cat.llmTemperature : undefined;
    return model === assignment.model && temp === assignment.temperature;
  });
}

function storedModelProfileId() {
  try {
    return window.localStorage.getItem(MODEL_PROFILE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function rememberModelProfileId(id) {
  try {
    if (id) window.localStorage.setItem(MODEL_PROFILE_STORAGE_KEY, id);
    else window.localStorage.removeItem(MODEL_PROFILE_STORAGE_KEY);
  } catch {
    /* localStorage 不可用就只保留内存状态 */
  }
}

function pickModelProfileSelection() {
  const ids = new Set((modelProfileState.profiles ?? []).map((profile) => profile.id));
  if (modelProfileState.selectedId && ids.has(modelProfileState.selectedId)) return;
  const stored = storedModelProfileId();
  if (stored && ids.has(stored)) {
    modelProfileState.selectedId = stored;
    return;
  }
  const matched = (modelProfileState.profiles ?? []).find((profile) =>
    profileMatchesCurrent(profile),
  );
  modelProfileState.selectedId =
    matched?.id ?? modelProfileState.suggested ?? modelProfileState.profiles?.[0]?.id ?? null;
}

async function loadModelProfiles() {
  if (modelProfileState.loading) return;
  modelProfileState.loading = true;
  renderModelProfiles();
  try {
    const response = await fetch("/api/model-profiles", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 503) {
      modelProfileState.available = false;
      modelProfileState.error = "模型档案服务未就绪（GET /api/model-profiles 404/503）";
      modelProfileState.loaded = true;
      renderModelProfiles();
      return;
    }
    if (!response.ok) throw new Error(await describeHttpError(response, "GET /api/model-profiles"));
    const payload = await response.json();
    modelProfileState.profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    modelProfileState.suggested = String(payload?.suggested ?? "");
    modelProfileState.available = true;
    modelProfileState.error = "";
    modelProfileState.loaded = true;
    pickModelProfileSelection();
  } catch (error) {
    modelProfileState.available = false;
    modelProfileState.error = `模型档案读取失败：${error.message}`;
    modelProfileState.loaded = true;
  } finally {
    modelProfileState.loading = false;
    renderModelProfiles();
  }
}

function renderModelProfiles() {
  const host = els.modelProfilesList;
  if (!host) return;
  if (els.modelProfileMode) {
    const mode = currentModelMode();
    els.modelProfileMode.dataset.mode = mode;
    els.modelProfileMode.textContent = mode === "mixed" ? "混搭" : "统一";
  }
  if (els.modelProfilesStatus) {
    els.modelProfilesStatus.textContent =
      modelProfileState.loading
        ? "读取模型档案…"
        : modelProfileState.available === false
          ? "模型档案服务未就绪"
          : modelProfileState.profiles.length
            ? `${modelProfileState.profiles.length} 套档案`
            : "";
  }
  if (modelProfileState.loading && !modelProfileState.loaded) {
    host.replaceChildren(emptyNote("读取模型档案…"));
    return;
  }
  if (modelProfileState.available === false) {
    host.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "模型档案服务未就绪" }),
        h("span", { text: modelProfileState.error || "接口 404/503；每猫手动模型配置仍可用。" }),
        h("button", {
          type: "button",
          class: "btn btn--ghost btn--tiny",
          "data-action": "reload-model-profiles",
          text: "↻ 重试",
        }),
      ),
    );
    return;
  }
  if (!modelProfileState.profiles.length) {
    host.replaceChildren(emptyNote("没有可用的模型档案。"));
    return;
  }

  host.replaceChildren(
    ...modelProfileState.profiles.map((profile) => modelProfileCard(profile)),
  );
}

function modelProfileCard(profile) {
  const recommended = profile.id === modelProfileState.suggested;
  const selected = profile.id === modelProfileState.selectedId;
  const matches = profileMatchesCurrent(profile);
  const drift = selected && !matches;
  const applying = modelProfileState.applyingId === profile.id;
  const cats = app.state?.cats ?? [];

  const map = [];
  if (!profile.assignments?.length) {
    map.push(
      h(
        "span",
        { class: "model-profile-map-item" },
        h("strong", { text: "四只猫" }),
        document.createTextNode(" → "),
        h("code", { text: "跟随全局模型", title: "清空所有每猫覆盖" }),
      ),
    );
  } else {
    for (const assignment of profile.assignments) {
      const cat = catById(assignment.catId);
      map.push(
        h(
          "span",
          {
            class: "model-profile-map-item",
            title: assignment.reason || "",
          },
          h("strong", { text: cat?.name ?? assignment.catId }),
          document.createTextNode(" → "),
          h("code", { text: assignment.model }),
          h("span", { class: "model-profile-badge", text: `T ${assignment.temperature}` }),
        ),
      );
    }
  }

  return h(
    "div",
    {
      class: "model-profile-card",
      "data-profile-id": profile.id,
      "data-recommended": recommended ? "true" : "false",
      "data-selected": selected ? "true" : "false",
    },
    h(
      "div",
      { class: "model-profile-top" },
      h("span", { class: "model-profile-name", text: profile.name }),
      recommended ? h("span", { class: "model-profile-badge", "data-kind": "recommended", text: "推荐" }) : null,
      matches ? h("span", { class: "model-profile-badge", "data-kind": "active", text: "当前生效" }) : null,
      drift ? h("span", { class: "model-profile-badge", "data-kind": "drift", text: "当前配置已偏离" }) : null,
    ),
    h("p", { class: "model-profile-desc", text: profile.description }),
    profile.endpoint
      ? h("span", { class: "model-profile-endpoint", text: `适用于 ${profile.endpoint}` })
      : h("span", { class: "model-profile-endpoint", text: "适用于任意 OpenAI 兼容端点" }),
    h("div", { class: "model-profile-map" }, ...map),
    h(
      "div",
      { class: "model-profile-actions" },
      h("span", {
        class: "model-profile-badge",
        text: `${cats.length} 只猫`,
      }),
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--primary",
        "data-action": "apply-model-profile",
        "data-profile-id": profile.id,
        disabled: Boolean(modelProfileState.applyingId),
        text: applying ? "应用中…" : "应用",
      }),
    ),
  );
}

function openModelProfileConfirm(profileId) {
  const profile = modelProfileState.profiles.find((item) => item.id === profileId);
  if (!profile || !els.modelProfileConfirm) return;
  if (modelProfileState.available === false) {
    toast("模型档案服务未就绪", "warn");
    return;
  }
  modelProfileState.pendingId = profileId;
  if (els.modelProfileConfirmSub) {
    els.modelProfileConfirmSub.textContent = `确认应用「${profile.name}」？`;
  }
  if (els.modelProfileConfirmError) {
    els.modelProfileConfirmError.hidden = true;
    els.modelProfileConfirmError.textContent = "";
  }
  if (els.modelProfileApplyBtn) {
    els.modelProfileApplyBtn.disabled = false;
    els.modelProfileApplyBtn.textContent = "确认应用";
  }
  if (!els.modelProfileConfirm.open) els.modelProfileConfirm.showModal();
}

function closeModelProfileConfirm() {
  if (els.modelProfileConfirm?.open) els.modelProfileConfirm.close();
}

function showModelProfileConfirmError(message) {
  if (!els.modelProfileConfirmError) return;
  els.modelProfileConfirmError.textContent = message;
  els.modelProfileConfirmError.hidden = false;
}

async function confirmModelProfileApply() {
  const profileId = modelProfileState.pendingId;
  if (!profileId || modelProfileState.applyingId) return;
  const profile = modelProfileState.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  modelProfileState.applyingId = profileId;
  if (els.modelProfileApplyBtn) {
    els.modelProfileApplyBtn.disabled = true;
    els.modelProfileApplyBtn.textContent = "应用中…";
  }
  if (els.modelProfileConfirmError) {
    els.modelProfileConfirmError.hidden = true;
    els.modelProfileConfirmError.textContent = "";
  }
  renderModelProfiles();
  try {
    const response = await fetch("/api/model-profiles/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: profileId }),
    });
    if (response.status === 404 || response.status === 503) {
      modelProfileState.available = false;
      throw new Error("模型档案服务未就绪（HTTP 404/503）");
    }
    if (!response.ok) throw new Error(await describeApiError(response));
    const payload = await response.json();
    modelProfileState.selectedId = profileId;
    rememberModelProfileId(profileId);
    closeModelProfileConfirm();
    toast(`已应用模型档案「${payload?.profile?.name ?? profile.name}」`);
    await refreshState().catch(() => {});
    if (els.settingsModal?.open) {
      renderCatModelList();
      renderModelProfiles();
    }
    renderAll();
  } catch (error) {
    showModelProfileConfirmError(`应用失败：${error.message}`);
  } finally {
    modelProfileState.applyingId = null;
    if (els.modelProfileApplyBtn) {
      els.modelProfileApplyBtn.disabled = false;
      els.modelProfileApplyBtn.textContent = "确认应用";
    }
    renderModelProfiles();
  }
}

async function describeApiError(response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === "string" && payload.error) return payload.error;
  } catch {
    /* ignore */
  }
  return `HTTP ${response.status}`;
}

function renderCatModelList() {
  const host = els.catModelList;
  if (!host) return;
  const cats = app.state?.cats ?? [];
  if (!cats.length) {
    host.replaceChildren(emptyNote("猫猫还没到店，稍后刷新。"));
    return;
  }
  host.replaceChildren(...cats.map((cat) => catModelRow(cat)));
}

function catModelRow(cat) {
  const model = catModelLabel(cat);
  const globalTemp = Number(settingsState.data?.llm?.temperature);
  const tempPlaceholder = Number.isFinite(globalTemp)
    ? `跟随全局（${globalTemp}）`
    : "跟随全局";
  const modelPlaceholder = `跟随全局：${app.globalModel || "未配置"}`;
  const overriding = Boolean(String(cat.llmModel ?? "").trim());
  const effectiveBadge = catEffectiveModelBadge(cat);
  const tempValue =
    typeof cat.llmTemperature === "number" && Number.isFinite(cat.llmTemperature)
      ? String(cat.llmTemperature)
      : "";

  return h(
    "div",
    {
      class: "cat-model-row",
      "data-cat-id": cat.id,
      style: `--accent:${safeCss(cat.accent)}`,
    },
    h(
      "div",
      { class: "cat-model-head" },
      h("span", { class: "cat-avatar", "aria-hidden": "true", html: avatarSvg(cat, { size: 32 }) }),
      h(
        "div",
        { class: "cat-model-id" },
        h(
          "span",
          { class: "cat-model-name-row" },
          h("strong", { text: cat.name }),
          h("span", {
            class: "cat-model-badge",
            "data-override": overriding ? "true" : "false",
            title: overriding ? `模型覆盖：${cat.llmModel}` : "没有覆盖，使用全局模型",
            text: effectiveBadge,
          }),
        ),
        h("span", { text: `${cat.species} · ${cat.title}` }),
      ),
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--ghost",
        "data-action": "edit-cat-access",
        "data-cat-id": cat.id,
        text: "工具/技能",
      }),
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--ghost",
        "data-action": "edit-cat",
        "data-cat-id": cat.id,
        text: "编辑档案",
      }),
    ),
    h(
      "div",
      { class: "cat-model-fields" },
      h(
        "label",
        { class: "field" },
        h("span", { class: "field-label", text: "模型覆盖" }),
        h("input", {
          type: "text",
          class: "cat-model-input",
          "data-role": "model",
          autocomplete: "off",
          spellcheck: "false",
          placeholder: modelPlaceholder,
          value: cat.llmModel ?? "",
          "aria-label": `${cat.name} 的模型覆盖`,
        }),
      ),
      h(
        "label",
        { class: "field" },
        h("span", { class: "field-label", text: "温度覆盖" }),
        h("input", {
          type: "number",
          class: "cat-temp-input",
          "data-role": "temp",
          min: "0",
          max: "2",
          step: "0.1",
          placeholder: tempPlaceholder,
          value: tempValue,
          "aria-label": `${cat.name} 的温度覆盖`,
        }),
      ),
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--primary cat-model-save",
        "data-action": "save-cat-model",
        "data-cat-id": cat.id,
        text: "保存模型",
      }),
      h("span", {
        class: "cat-model-row-error",
        "data-role": "error",
        role: "alert",
        hidden: true,
      }),
    ),
    overriding
      ? h("span", {
          class: "field-hint",
          text: "当前为单独覆盖；把模型/温度清空后保存即「跟随全局」。",
        })
      : null,
  );
}

function catModelRowError(catId, message) {
  const row = Array.from(els.catModelList?.querySelectorAll(".cat-model-row") ?? []).find(
    (node) => node.dataset.catId === catId,
  );
  const host = row?.querySelector('[data-role="error"]');
  if (host) {
    host.textContent = message;
    host.hidden = !message;
  }
}

async function saveCatModel(catId, trigger) {
  const row = trigger?.closest(".cat-model-row");
  const cat = catById(catId);
  if (!row || !cat) return;

  const modelInput = row.querySelector('[data-role="model"]');
  const tempInput = row.querySelector('[data-role="temp"]');
  const saveBtn = row.querySelector('[data-action="save-cat-model"]');
  const llmModel = String(modelInput?.value ?? "").trim();
  const tempRaw = String(tempInput?.value ?? "").trim();

  let llmTemperature = null;
  if (tempRaw !== "") {
    const parsed = Number(tempRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
      catModelRowError(catId, "温度需要在 0–2 之间，或留空跟随全局。");
      return;
    }
    llmTemperature = Math.round(parsed * 10) / 10;
  }

  catModelRowError(catId, "");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
  }
  try {
    const updated = await putCat(catId, { llmModel, llmTemperature });
    if (updated && typeof updated === "object") applyUpdatedCat(updated);
    toast(`已保存 ${cat.name} 的模型设置`);
  } catch (error) {
    catModelRowError(catId, error.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存模型";
    }
  }
}

async function putCat(catId, patch) {
  const response = await fetch(`/api/cats/${encodeURIComponent(catId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await describeHttpError(response, "PUT /api/cats"));
  return response.json();
}

/** 同步服务端返回的 Cat（名字/颜色立即反映到名册与消息）。 */
function applyUpdatedCat(updated) {
  if (!updated || typeof updated !== "object") return;
  const cats = app.state?.cats ?? [];
  const index = cats.findIndex((cat) => cat.id === updated.id);
  if (index >= 0) cats[index] = { ...cats[index], ...updated };
  renderAll();
  if (els.settingsModal?.open) {
    renderCatModelList();
    renderModelProfiles();
  }
  void refreshState().catch(() => {});
}

// —— 猫猫档案对话框 ——

const ACCENT_PRESETS = [
  "#7C9EB2",
  "#8C6A4F",
  "#C9A227",
  "#B08D57",
  "#D9A066",
  "#F2C6B4",
  "#6F4E37",
  "#A9BFA6",
];

function toColorInputValue(accent) {
  const value = String(accent ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return "#D9A066";
}

function openCatEdit(catId) {
  const cat = catById(catId);
  if (!cat || !els.catEditModal) return;
  catEditState.catId = catId;
  catEditState.saving = false;
  catEditState.accent = toColorInputValue(cat.accent);
  hideCatEditError();

  if (els.catName) els.catName.value = cat.name ?? "";
  if (els.catTitle) els.catTitle.value = cat.title ?? "";
  if (els.catPersona) els.catPersona.value = cat.persona ?? "";
  if (els.catCatchphrase) els.catCatchphrase.value = cat.catchphrase ?? "";
  if (els.catGreeting) els.catGreeting.value = cat.greeting ?? "";
  if (els.catAccent) els.catAccent.value = catEditState.accent;
  if (els.catAccentHex) els.catAccentHex.textContent = catEditState.accent.toUpperCase();

  renderAccentSwatches();
  updateCatEditPreview();
  updateCatSaveState();
  if (!els.catEditModal.open) els.catEditModal.showModal();
  requestAnimationFrame(() => els.catName?.focus());
}

function closeCatEdit() {
  if (els.catEditModal?.open) els.catEditModal.close();
}

function renderAccentSwatches() {
  if (!els.catColorSwatches) return;
  els.catColorSwatches.replaceChildren(
    ...ACCENT_PRESETS.map((accent) =>
      h("button", {
        type: "button",
        class: "color-swatch",
        "data-action": "pick-accent",
        "data-accent": accent,
        style: `background:${accent}`,
        "aria-label": `主题色 ${accent}`,
        "aria-pressed": String(accent.toLowerCase() === catEditState.accent.toLowerCase()),
      }),
    ),
  );
}

function pickCatAccent(accent) {
  const value = toColorInputValue(accent);
  catEditState.accent = value;
  if (els.catAccent) els.catAccent.value = value;
  if (els.catAccentHex) els.catAccentHex.textContent = value.toUpperCase();
  renderAccentSwatches();
  updateCatEditPreview();
}

function updateCatEditPreview() {
  const cat = catById(catEditState.catId);
  if (!cat) return;
  const name = els.catName?.value.trim() || cat.name || "猫猫";
  const title = els.catTitle?.value.trim() || cat.title || "";
  const accent = els.catAccent?.value || catEditState.accent;
  catEditState.accent = toColorInputValue(accent);
  if (els.catAccentHex) els.catAccentHex.textContent = catEditState.accent.toUpperCase();
  if (els.catEditAvatar) {
    els.catEditAvatar.innerHTML = avatarSvg(
      { ...cat, name, accent: catEditState.accent },
      { size: 54 },
    );
  }
  if (els.catEditNamePreview) els.catEditNamePreview.textContent = name;
  if (els.catEditSpecies) els.catEditSpecies.textContent = `${cat.species} · ${title}`;
}

function onCatEditInput(event) {
  const target = event.target;
  if (target === els.catName || target === els.catTitle) {
    updateCatEditPreview();
  } else if (target === els.catAccent) {
    pickCatAccent(target.value);
    return;
  }
  hideCatEditError();
}

function showCatEditError(message) {
  if (!els.catEditError) return;
  els.catEditError.textContent = message;
  els.catEditError.hidden = false;
}

function hideCatEditError() {
  if (!els.catEditError) return;
  els.catEditError.hidden = true;
  els.catEditError.textContent = "";
}

function updateCatSaveState() {
  if (!els.catSaveBtn) return;
  els.catSaveBtn.disabled = catEditState.saving;
  els.catSaveBtn.textContent = catEditState.saving ? "保存中…" : "保存档案";
}

async function saveCatProfile() {
  if (catEditState.saving) return;
  const cat = catById(catEditState.catId);
  if (!cat) return;

  const name = String(els.catName?.value ?? "").trim();
  if (!name) {
    showCatEditError("名字不能为空。");
    els.catName?.focus();
    return;
  }
  const title = String(els.catTitle?.value ?? "").trim();
  const persona = String(els.catPersona?.value ?? "").trim();
  const catchphrase = String(els.catCatchphrase?.value ?? "").trim();
  const greeting = String(els.catGreeting?.value ?? "").trim();
  const accent = toColorInputValue(els.catAccent?.value || catEditState.accent);

  hideCatEditError();
  catEditState.saving = true;
  updateCatSaveState();
  try {
    const updated = await putCat(cat.id, {
      name,
      title,
      persona,
      catchphrase,
      greeting,
      accent,
    });
    if (updated && typeof updated === "object") applyUpdatedCat(updated);
    closeCatEdit();
    toast(`已保存「${updated?.name ?? name}」的档案`);
  } catch (error) {
    showCatEditError(`保存失败：${error.message}`);
  } finally {
    catEditState.saving = false;
    updateCatSaveState();
  }
}

// ── 设置 · 剧本库 ───────────────────────────────────────────────────────

async function fetchScenarioList() {
  const response = await fetch("/api/scenarios", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await describeHttpError(response, "GET /api/scenarios"));
  const payload = await response.json();
  const raw = Array.isArray(payload?.scenarios)
    ? payload.scenarios
    : Array.isArray(payload)
      ? payload
      : [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const scenario = item.scenario && typeof item.scenario === "object" ? item.scenario : item;
      const source = (item.source ?? scenario.source) === "custom" ? "custom" : "builtin";
      return { scenario, source };
    })
    .filter(Boolean);
}

function setScenarioStatus(message) {
  if (els.scenarioStatus) els.scenarioStatus.textContent = message;
}

async function loadScenarios(options = {}) {
  if (scenarioState.loading) return;
  scenarioState.loading = true;
  if (options.force) setScenarioStatus("刷新中…");
  renderScenarioList();
  updateScenarioButtons();
  try {
    const items = await fetchScenarioList();
    scenarioState.items = items;
    scenarioState.loaded = true;
    scenarioState.error = "";
    setScenarioStatus(`${items.length} 个剧本`);
  } catch (error) {
    scenarioState.error = error.message;
    scenarioState.loaded = true;
    setScenarioStatus("剧本服务未就绪");
  } finally {
    scenarioState.loading = false;
    renderScenarioList();
    updateScenarioButtons();
  }
}

function renderScenarioList() {
  const host = els.scenarioList;
  if (!host) return;

  if (scenarioState.loading && !scenarioState.items.length) {
    host.replaceChildren(emptyNote("正在读取剧本…"));
    return;
  }
  if (scenarioState.error && !scenarioState.items.length) {
    host.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "剧本服务未就绪" }),
        h("span", { text: scenarioState.error }),
        h("button", {
          type: "button",
          class: "btn btn--tiny btn--ghost",
          "data-action": "reload-scenarios",
          text: "↻ 重试",
        }),
      ),
    );
    return;
  }
  if (!scenarioState.items.length) {
    host.replaceChildren(emptyNote("还没有剧本。内置剧本会由服务端提供。"));
    return;
  }

  host.replaceChildren(...scenarioState.items.map((item) => scenarioRow(item)));
}

function scenarioRow(item) {
  const { scenario, source } = item;
  const confirming = scenarioState.deleteConfirmId === scenario.id;
  const deleteError =
    scenarioState.deleteErrorId === scenario.id ? scenarioState.deleteError : "";

  return h(
    "div",
    {
      class: "scenario-item",
      "data-scenario-id": scenario.id,
      "data-source": source,
    },
    h(
      "div",
      { class: "scenario-item-head" },
      h("strong", { text: scenario.name || scenario.id }),
      h("span", {
        class: "scenario-badge",
        "data-source": source,
        text: source === "custom" ? "自定义" : "内置",
      }),
      h("span", { class: "scenario-id", text: scenario.id }),
    ),
    scenario.sampleBrief ? h("p", { class: "scenario-brief", text: scenario.sampleBrief }) : null,
    (scenario.tags ?? []).length
      ? h(
          "div",
          { class: "scenario-tags" },
          ...(scenario.tags ?? []).map((tag) => h("span", { class: "scenario-tag", text: String(tag) })),
        )
      : null,
    h(
      "div",
      { class: "scenario-item-actions" },
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--ghost",
        "data-action": "export-scenario",
        "data-scenario-id": scenario.id,
        text: "导出",
      }),
      source === "custom"
        ? confirming
          ? h(
              "span",
              { class: "scenario-confirm" },
              h("span", { text: "删除后不可恢复，确认？" }),
              h("button", {
                type: "button",
                class: "btn btn--tiny btn--danger",
                "data-action": "confirm-delete-scenario",
                "data-scenario-id": scenario.id,
                text: "确认删除",
              }),
              h("button", {
                type: "button",
                class: "btn btn--tiny btn--ghost",
                "data-action": "cancel-delete-scenario",
                text: "取消",
              }),
            )
          : h("button", {
              type: "button",
              class: "btn btn--tiny btn--danger",
              "data-action": "delete-scenario",
              "data-scenario-id": scenario.id,
              text: "删除",
            })
        : null,
    ),
    deleteError ? h("span", { class: "scenario-item-error", text: deleteError }) : null,
  );
}

function updateScenarioButtons() {
  if (els.scenarioImportToggle) {
    els.scenarioImportToggle.textContent = scenarioState.importOpen ? "－ 收起导入" : "＋ 导入剧本";
  }
  if (els.scenarioImportSubmit) {
    els.scenarioImportSubmit.disabled = scenarioState.importing;
    els.scenarioImportSubmit.textContent = scenarioState.importing ? "导入中…" : "导入";
  }
  if (els.scenarioReload) els.scenarioReload.disabled = scenarioState.loading;
}

function toggleScenarioImport() {
  if (scenarioState.importOpen) {
    closeScenarioImport();
    return;
  }
  scenarioState.importOpen = true;
  if (els.scenarioImport) els.scenarioImport.hidden = false;
  updateScenarioButtons();
  hideScenarioImportErrors();
  requestAnimationFrame(() => els.scenarioImportText?.focus());
}

function closeScenarioImport() {
  scenarioState.importOpen = false;
  if (els.scenarioImport) els.scenarioImport.hidden = true;
  if (els.scenarioImportText) els.scenarioImportText.value = "";
  if (els.scenarioFile) els.scenarioFile.value = "";
  if (els.scenarioFileName) els.scenarioFileName.textContent = "";
  hideScenarioImportErrors();
  updateScenarioButtons();
}

function hideScenarioImportErrors() {
  if (els.scenarioImportError) {
    els.scenarioImportError.hidden = true;
    els.scenarioImportError.textContent = "";
  }
  if (els.scenarioImportErrorList) {
    els.scenarioImportErrorList.hidden = true;
    els.scenarioImportErrorList.replaceChildren();
  }
}

function showScenarioImportErrors(messages) {
  const list = messages.map((message) => String(message ?? "").trim()).filter(Boolean);
  if (!list.length) return;
  if (els.scenarioImportError) {
    const multi = list.length > 1;
    els.scenarioImportError.textContent = multi ? "导入失败，请检查以下问题：" : "";
    els.scenarioImportError.hidden = !multi;
  }
  if (els.scenarioImportErrorList) {
    // 服务端 errors 数组逐条列出（单条也直接列出来）。
    els.scenarioImportErrorList.replaceChildren(
      ...list.map((message) => h("li", { text: message })),
    );
    els.scenarioImportErrorList.hidden = false;
  }
}

async function readScenarioFile() {
  const file = els.scenarioFile?.files?.[0];
  if (!file) return;
  hideScenarioImportErrors();
  try {
    const text = await file.text();
    if (els.scenarioImportText) els.scenarioImportText.value = text;
    if (els.scenarioFileName) els.scenarioFileName.textContent = file.name;
  } catch (error) {
    showScenarioImportErrors([`读取文件失败：${error.message}`]);
  }
}

async function importScenario() {
  if (scenarioState.importing) return;
  hideScenarioImportErrors();
  const raw = String(els.scenarioImportText?.value ?? "").trim();
  if (!raw) {
    showScenarioImportErrors(["先粘贴剧本 JSON，或选择一个 .json 文件。"]);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    showScenarioImportErrors([`JSON 解析失败：${error.message}`]);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    showScenarioImportErrors(["剧本必须是一个 JSON 对象。"]);
    return;
  }
  const scenario =
    parsed.scenario && typeof parsed.scenario === "object" ? parsed.scenario : parsed;

  scenarioState.importing = true;
  updateScenarioButtons();
  try {
    const response = await fetch("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario }),
    });
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* ignore */
      }
      const messages =
        Array.isArray(payload?.errors) && payload.errors.length
          ? payload.errors.map(String)
          : [String(payload?.error ?? `POST /api/scenarios → HTTP ${response.status}`)];
      showScenarioImportErrors(messages);
      setScenarioStatus(response.status === 409 ? "剧本 id 冲突" : "导入失败");
      return;
    }
    const data = await response.json();
    const imported = data?.scenario ?? scenario;
    toast(`剧本「${imported?.name ?? imported?.id ?? "未命名"}」已导入`);
    closeScenarioImport();
    await loadScenarios({ force: true });
  } catch (error) {
    showScenarioImportErrors([`剧本服务未就绪或导入失败：${error.message}`]);
  } finally {
    scenarioState.importing = false;
    updateScenarioButtons();
  }
}

function exportScenario(scenarioId) {
  const item = scenarioState.items.find((entry) => entry.scenario.id === scenarioId);
  if (!item) return;
  const scenario = item.scenario;
  const json = JSON.stringify(
    {
      id: scenario.id,
      name: scenario.name,
      sampleBrief: scenario.sampleBrief,
      tags: scenario.tags ?? [],
      beats: scenario.beats ?? [],
    },
    null,
    2,
  );
  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${scenario.id}.json`;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setScenarioStatus(`已导出 ${scenario.id}.json`);
  } catch {
    setScenarioStatus("导出失败：浏览器不支持下载");
  }
}

function askDeleteScenario(scenarioId) {
  scenarioState.deleteConfirmId = scenarioId;
  scenarioState.deleteError = "";
  scenarioState.deleteErrorId = "";
  renderScenarioList();
}

async function deleteScenario(scenarioId) {
  scenarioState.deleteConfirmId = null;
  scenarioState.deleteError = "";
  scenarioState.deleteErrorId = "";
  setScenarioStatus("正在删除…");
  renderScenarioList();
  try {
    const response = await fetch(`/api/scenarios/${encodeURIComponent(scenarioId)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(await describeHttpError(response, "DELETE /api/scenarios"));
    toast(`剧本「${scenarioId}」已删除`);
    await loadScenarios({ force: true });
  } catch (error) {
    scenarioState.deleteError = `删除失败：${error.message}`;
    scenarioState.deleteErrorId = scenarioId;
    setScenarioStatus("删除失败");
    renderScenarioList();
  }
}

// ── 新任务：场景选择 ────────────────────────────────────────────────────

function resetTaskScenarioSelect() {
  if (!els.taskScenario) return;
  scenarioState.taskToken += 1;
  scenarioState.taskItems = [];
  els.taskScenario.replaceChildren(h("option", { value: "", text: "自动匹配（按需求）" }));
  if (els.taskScenarioHint) {
    els.taskScenarioHint.textContent =
      "自动匹配：根据需求关键词挑一个演示剧本；也可以指定内置或自定义剧本。";
  }
}

async function loadTaskScenarioOptions() {
  const token = ++scenarioState.taskToken;
  let items;
  try {
    items = await fetchScenarioList();
  } catch {
    if (token === scenarioState.taskToken && els.taskScenarioHint) {
      els.taskScenarioHint.textContent = "场景列表未就绪，将按需求自动匹配。";
    }
    return;
  }
  if (token !== scenarioState.taskToken || !els.taskScenario) return;
  scenarioState.taskItems = items;
  const options = [h("option", { value: "", text: "自动匹配（按需求）" })];
  for (const item of items) {
    options.push(
      h("option", {
        value: item.scenario.id,
        text: `${item.scenario.name || item.scenario.id}${item.source === "custom" ? "（自定义）" : ""}`,
      }),
    );
  }
  els.taskScenario.replaceChildren(...options);
  updateTaskScenarioHint();
}

function onTaskScenarioChange() {
  updateTaskScenarioHint();
}

function updateTaskScenarioHint() {
  if (!els.taskScenarioHint) return;
  const id = els.taskScenario?.value ?? "";
  if (!id) {
    els.taskScenarioHint.textContent =
      "自动匹配：根据需求关键词挑一个演示剧本；也可以指定内置或自定义剧本。";
    return;
  }
  const item = (scenarioState.taskItems ?? []).find((entry) => entry.scenario.id === id);
  const brief = String(item?.scenario?.sampleBrief ?? "").trim();
  els.taskScenarioHint.textContent = brief
    ? `示例需求：${brief}`
    : "该剧本没有示例需求，按你写的需求运行。";
}


// ── 工具调用卡片 ────────────────────────────────────────────────────────

function toolCallById(id) {
  if (!id) return null;
  return (app.state?.toolCalls ?? []).find((call) => call.id === id) ?? null;
}

function toolMeta(tool) {
  return TOOL_META[tool] ?? { icon: "🧰", verb: "工具" };
}

function toolLine(call) {
  if (!call) return "";
  const input = call.input ?? {};
  if (call.tool === "run_command") {
    const cmd = String(input.cmd ?? "").trim();
    const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [];
    const line = [cmd, ...args].filter(Boolean).join(" ").trim();
    return line || call.label || "运行命令";
  }
  const path = String(input.path ?? "").trim();
  if (path) return path;
  return call.label || toolMeta(call.tool).verb;
}

function toolOutputText(call) {
  const raw = String(call?.output ?? "");
  if (!raw) return "";
  if (raw.length <= TOOL_OUTPUT_MAX) return raw;
  return `${raw.slice(0, TOOL_OUTPUT_MAX)}\n\n…（输出已截断，原长度 ${raw.length} 字）`;
}

function toolStatusLabel(call) {
  const status = call?.status ?? "running";
  if (status === "pending") return "⏳ 等你批准";
  if (status === "ok") return "✓ 成功";
  if (status === "error") return "✗ 失败";
  if (status === "rejected") return "✗ 已拒绝";
  return "执行中…";
}

function toolDurationText(call) {
  if (!call?.startedAt || !call?.finishedAt) return "";
  const ms = Number(call.finishedAt) - Number(call.startedAt);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 构建工具卡容器。running→ok 时不重建节点，由 syncToolCards() 原地更新。
 */
function toolCardNode(call, message) {
  const id = call?.id ?? message?.toolCallId ?? "";
  const existing = id ? toolCardNodes.get(id) : null;
  if (existing) {
    updateToolCard(existing, call, { initial: false });
    return existing;
  }
  const card = h("div", {
    class: "tool-card",
    "data-tool-call-id": id,
    "data-status": call?.status ?? "running",
    "data-tool": call?.tool ?? "",
  });
  if (id) toolCardNodes.set(id, card);

  card.append(
    h(
      "div",
      { class: "tool-head" },
      h("span", { class: "tool-icon", "data-role": "icon", "aria-hidden": "true", text: "🧰" }),
      h("span", { class: "tool-label", "data-role": "label", text: call?.label ?? "工具调用" }),
      h("span", { class: "tool-source", "data-role": "source", hidden: true }),
      h("span", {
        class: "tool-status",
        "data-role": "status",
        "data-status": call?.status ?? "running",
        text: toolStatusLabel(call),
      }),
      h("span", { class: "tool-exit", "data-role": "exit", hidden: true }),
      h("span", { class: "tool-duration", "data-role": "duration" }),
    ),
    h(
      "div",
      { class: "tool-command" },
      h("code", { "data-role": "command", text: toolLine(call) }),
      h("button", {
        type: "button",
        class: "tool-toggle",
        "data-action": "toggle-tool-output",
        "aria-expanded": "false",
        text: "展开输出",
      }),
    ),
    h(
      "div",
      { class: "tool-approval", "data-role": "approval", hidden: true },
      h("span", {
        class: "tool-approval-countdown",
        "data-role": "approval-countdown",
        text: "⏱ 计算剩余时间…",
      }),
      h("span", {
        class: "tool-approval-hint",
        "data-role": "approval-hint",
        text: "等待你批准中，批准后猫才会继续；期间任务不会判定卡住。",
      }),
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--approve",
        "data-action": "approve-tool",
        "data-call-id": id,
        "data-role": "approve",
        text: "批准执行",
      }),
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--danger",
        "data-action": "reject-tool",
        "data-call-id": id,
        "data-role": "reject",
        text: "拒绝",
      }),
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--ghost",
        "data-action": "approve-tool-remember",
        "data-call-id": id,
        "data-role": "approve-remember",
        text: "批准并记住",
      }),
      h(
        "details",
        { class: "tool-approval-more" },
        h("summary", { text: "更多" }),
        h("button", {
          type: "button",
          "data-action": "reject-tool-remember",
          "data-call-id": id,
          "data-role": "reject-remember",
          text: "拒绝并记住",
        }),
      ),
      h("span", {
        class: "tool-approval-note",
        "data-role": "approval-note",
        text: "记住后同一只猫的同类工具调用自动放行，重启服务后失效。",
      }),
      h("span", {
        class: "tool-approval-error",
        "data-role": "approval-error",
        role: "alert",
        hidden: true,
      }),
    ),
    h(
      "div",
      { class: "tool-rejected-note", "data-role": "rejected-note", hidden: true },
      h("span", { "aria-hidden": "true", text: "🚫" }),
      h("span", { text: "铲屎官拒绝了这次执行。" }),
    ),
    h(
      "div",
      { class: "tool-output", "data-role": "output", hidden: true },
      h("pre", { "data-role": "pre" }),
    ),
  );

  updateToolCard(card, call, { initial: true });
  return card;
}

function updateToolCard(card, call, options = {}) {
  if (!card) return;
  const status = call?.status ?? "running";
  card.dataset.status = status;
  if (call?.tool) card.dataset.tool = call.tool;

  const meta = toolMeta(call?.tool);
  const icon = card.querySelector('[data-role="icon"]');
  const label = card.querySelector('[data-role="label"]');
  const statusEl = card.querySelector('[data-role="status"]');
  const exitEl = card.querySelector('[data-role="exit"]');
  const durationEl = card.querySelector('[data-role="duration"]');
  const commandEl = card.querySelector('[data-role="command"]');
  const outputEl = card.querySelector('[data-role="output"]');
  const preEl = card.querySelector('[data-role="pre"]');
  const toggle = card.querySelector(".tool-toggle");

  if (icon) icon.textContent = meta.icon;
  if (label) label.textContent = call?.label ?? "工具调用";
  const sourceEl = card.querySelector('[data-role="source"]');
  const source = toolSourceInfo(call?.tool);
  if (sourceEl) {
    sourceEl.hidden = !source;
    if (source) {
      sourceEl.dataset.source = source.kind;
      sourceEl.textContent = source.label;
      sourceEl.title = source.title;
    }
  }
  if (statusEl) {
    statusEl.dataset.status = status;
    statusEl.textContent = toolStatusLabel(call);
  }
  if (exitEl) {
    const showExit = call?.tool === "run_command" && typeof call?.exitCode === "number";
    exitEl.hidden = !showExit;
    if (showExit) {
      exitEl.textContent = `exit ${call.exitCode}`;
      exitEl.dataset.state = Number(call.exitCode) === 0 ? "ok" : "error";
    }
  }
  if (durationEl) durationEl.textContent = toolDurationText(call);
  if (commandEl) commandEl.textContent = toolLine(call);

  if (status !== "pending") {
    delete card.dataset.deciding;
    card.dataset.approvalSent = "";
    const approvalError = card.querySelector('[data-role="approval-error"]');
    if (approvalError) {
      approvalError.hidden = true;
      approvalError.textContent = "";
    }
  }

  const output = toolOutputText(call);
  if (preEl) preEl.textContent = output || (status === "running" ? "执行中…" : "（无输出）");
  if (outputEl && toggle) {
    const hasOutput = Boolean(output);
    const userCollapsed = card.dataset.userCollapsed === "true";
    let expanded = !outputEl.hidden;
    if (options.initial) expanded = status === "error";
    else if (status === "error" && !userCollapsed) expanded = true;
    if (!hasOutput) expanded = false;
    outputEl.hidden = !expanded;
    toggle.hidden = !hasOutput;
    toggle.textContent = expanded ? "收起输出" : "展开输出";
    toggle.setAttribute("aria-expanded", String(expanded));
  }

  updateToolApprovalUi(card);
}

function showToolApprovalError(card, message) {
  const error = card?.querySelector('[data-role="approval-error"]');
  if (!error) return;
  error.textContent = message;
  error.hidden = false;
}

function approvalStartedAtFor(card) {
  const call = toolCallById(card?.dataset?.toolCallId);
  return Number(call?.startedAt) || Number(card?.dataset?.approvalStartedAt) || 0;
}

function approvalRemainingMs(card) {
  const startedAt = approvalStartedAtFor(card);
  if (!startedAt) return APPROVAL_TIMEOUT_MS;
  return startedAt + APPROVAL_TIMEOUT_MS - Date.now();
}

function formatApprovalCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updateToolApprovalUi(card) {
  if (!card) return;
  const status = card.dataset.status;
  const approval = card.querySelector('[data-role="approval"]');
  const rejectedNote = card.querySelector('[data-role="rejected-note"]');
  if (rejectedNote) rejectedNote.hidden = status !== "rejected";
  if (!approval) return;
  if (status !== "pending") {
    approval.hidden = true;
    return;
  }
  approval.hidden = false;

  const deciding = card.dataset.deciding || "";
  const sent = card.dataset.approvalSent || "";
  const rememberedSent = card.dataset.approvalRemembered || "";
  const available = approvalState.available !== false;
  const hint = card.querySelector('[data-role="approval-hint"]');
  const countdown = card.querySelector('[data-role="approval-countdown"]');
  const approveBtn = card.querySelector('[data-role="approve"]');
  const rejectBtn = card.querySelector('[data-role="reject"]');
  const approveRememberBtn = card.querySelector('[data-role="approve-remember"]');
  const rejectRememberBtn = card.querySelector('[data-role="reject-remember"]');
  const remaining = approvalRemainingMs(card);
  const expired = remaining <= 0;

  if (countdown) {
    countdown.dataset.expired = expired ? "true" : "false";
    countdown.textContent = expired
      ? "⏱ 已自动拒绝（超过 5 分钟）"
      : `⏱ ${formatApprovalCountdown(remaining)} 后自动拒绝`;
  }

  const busy = Boolean(deciding) || Boolean(sent) || expired || !available;
  for (const button of [approveBtn, rejectBtn, approveRememberBtn, rejectRememberBtn]) {
    if (button) button.disabled = busy;
  }
  if (approveBtn) {
    approveBtn.textContent = deciding === "approve" ? "批准中…" : "批准执行";
  }
  if (rejectBtn) {
    rejectBtn.textContent = deciding === "reject" ? "拒绝中…" : "拒绝";
  }
  if (approveRememberBtn) {
    approveRememberBtn.textContent =
      deciding === "approve:remember" ? "记住中…" : "批准并记住";
  }
  if (rejectRememberBtn) {
    rejectRememberBtn.textContent =
      deciding === "reject:remember" ? "记住中…" : "拒绝并记住";
  }
  if (hint) {
    if (!available) hint.textContent = "审批服务未就绪（接口 404/503），暂时不能处理。";
    else if (expired) hint.textContent = "已超过 5 分钟，服务端会按拒绝处理；等待任务状态更新…";
    else if (rememberedSent === "approved") hint.textContent = "已批准并记住：同类工具后续自动放行。";
    else if (rememberedSent === "rejected") hint.textContent = "已拒绝并记住：同类工具后续自动拒绝。";
    else if (sent === "approved") hint.textContent = "已批准，等待猫继续…";
    else if (sent === "rejected") hint.textContent = "已拒绝，等待状态更新…";
    else if (deciding) hint.textContent = "处理中…";
    else hint.textContent = "等待你批准中，批准后猫才会继续；期间任务不会判定卡住。";
  }
}

function updateApprovalCountdowns() {
  if (!els.timeline) return;
  for (const card of $$('.tool-card[data-status="pending"]', els.timeline)) {
    const countdown = card.querySelector('[data-role="approval-countdown"]');
    if (!countdown) continue;
    const remaining = approvalRemainingMs(card);
    const expired = remaining <= 0;
    countdown.dataset.expired = expired ? "true" : "false";
    countdown.textContent = expired
      ? "⏱ 已自动拒绝（超过 5 分钟）"
      : `⏱ ${formatApprovalCountdown(remaining)} 后自动拒绝`;
    if (expired) updateToolApprovalUi(card);
  }
}

function updateAllApprovalUi() {
  if (!els.timeline) return;
  for (const card of $$(".tool-card[data-tool-call-id]", els.timeline)) {
    updateToolApprovalUi(card);
  }
}

function pendingCallsFromState() {
  return (app.state?.toolCalls ?? []).filter((call) => call.status === "pending");
}

function pendingCallCount() {
  const stateCount = pendingCallsFromState().length;
  if (stateCount > 0) return stateCount;
  return Array.isArray(approvalState.pending) ? approvalState.pending.length : 0;
}

async function loadApprovals() {
  if (approvalState.loading) return;
  approvalState.loading = true;
  try {
    const response = await fetch("/api/approvals", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 503) {
      approvalState.available = false;
      approvalState.pending = [];
      approvalState.error = "审批服务未就绪";
    } else if (!response.ok) {
      throw new Error(await describeHttpError(response, "GET /api/approvals"));
    } else {
      const payload = await response.json();
      approvalState.available = true;
      approvalState.pending = Array.isArray(payload?.pending) ? payload.pending : [];
      approvalState.error = "";
    }
  } catch (error) {
    approvalState.available = false;
    approvalState.error = error.message || "审批服务未就绪";
  } finally {
    approvalState.loading = false;
    updateNeedsMe();
    updateAllApprovalUi();
  }
}

function updateNeedsMe() {
  const count = pendingCallCount();
  for (const node of els.needsNodes ?? []) node.hidden = count === 0;
  for (const node of els.needsCounts ?? []) node.textContent = String(count);
  const room = currentRoom();
  const base = room ? `${room.name} · Cat Café Lab` : "Cat Café Lab · 猫咖工作台";
  document.title = count > 0 ? `(${count}) ${base}` : base;
}

function focusNeedsMe() {
  const card = els.timeline ? $('.tool-card[data-status="pending"]', els.timeline) : null;
  if (!card) {
    toast("当前没有待审批的工具调用", "warn");
    void refreshState().catch(() => {});
    return;
  }
  const target = card.closest(".msg") ?? card;
  target.scrollIntoView({
    block: "center",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
  target.classList.remove("needs-flash");
  void target.offsetWidth;
  target.classList.add("needs-flash");
  window.setTimeout(() => target.classList.remove("needs-flash"), 1900);
  const approve = card.querySelector('[data-role="approve"]');
  if (approve) approve.focus({ preventScroll: true });
}

async function decideToolCall(callId, decision, trigger, options = {}) {
  const card = trigger?.closest?.(".tool-card");
  if (!card || !callId) return;
  if (card.dataset.status !== "pending" || card.dataset.approvalSent) {
    showToolApprovalError(card, "已经处理过了");
    return;
  }
  if (card.dataset.deciding) return;
  if (approvalRemainingMs(card) <= 0) {
    showToolApprovalError(card, "已经超过 5 分钟，服务端会自动拒绝。");
    updateToolApprovalUi(card);
    return;
  }
  if (approvalState.available === false) {
    showToolApprovalError(card, "审批服务未就绪（接口 404/503），暂时不能处理。");
    updateToolApprovalUi(card);
    return;
  }

  const remember = Boolean(options.remember);
  const verb = decision === "approve" ? "批准" : "拒绝";
  const decidingKey = remember ? `${decision}:remember` : decision;
  card.dataset.deciding = decidingKey;
  updateToolApprovalUi(card);

  try {
    const response = await fetch(
      `/api/tool-calls/${encodeURIComponent(callId)}/${decision}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(remember ? { remember: true } : {}),
      },
    );
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* ignore */
      }
      if (response.status === 404) {
        approvalState.available = true;
        showToolApprovalError(card, "已经处理过了");
        delete card.dataset.deciding;
        updateToolApprovalUi(card);
        await refreshState().catch(() => {});
        void loadApprovals();
        return;
      }
      if (response.status === 503) {
        approvalState.available = false;
        showToolApprovalError(card, "审批服务未就绪（503）：服务端未启用审批队列。");
        delete card.dataset.deciding;
        updateAllApprovalUi();
        return;
      }
      showToolApprovalError(
        card,
        `${verb}失败：${payload?.error ?? `HTTP ${response.status}`}`,
      );
      delete card.dataset.deciding;
      updateToolApprovalUi(card);
      return;
    }

    const payload = await response.json().catch(() => null);
    const remembered = Boolean(payload?.remembered);
    card.dataset.approvalSent = decision === "approve" ? "approved" : "rejected";
    card.dataset.approvalRemembered = remembered
      ? decision === "approve"
        ? "approved"
        : "rejected"
      : "";
    delete card.dataset.deciding;
    updateToolApprovalUi(card);
    if (remember) {
      const call = toolCallById(callId);
      const cat = catById(call?.catId);
      toast(
        `已记住：${cat?.name ?? "这只猫"} + ${call?.tool ?? "该工具"}，后续同类调用不再询问`,
      );
    }
    void loadApprovals();

    // 兜底：8s 后仍未收到状态更新，就还原按钮并提示可以刷新。
    window.setTimeout(() => {
      if (card.isConnected && card.dataset.status === "pending") {
        delete card.dataset.approvalSent;
        delete card.dataset.approvalRemembered;
        showToolApprovalError(card, `已${verb}，仍在等待服务端更新；可刷新页面查看。`);
        updateToolApprovalUi(card);
      }
    }, 8000);
  } catch (error) {
    showToolApprovalError(card, `${verb}失败：${error.message}`);
    delete card.dataset.deciding;
    updateToolApprovalUi(card);
  }
}

function showTaskRecoveryPanelError(message) {
  taskRecoveryState.error = message || "";
  app.sig.progress = null;
  renderProgress();
}

async function submitTaskAction(taskId, action, note) {
  if (!taskId || taskRecoveryState.saving) return false;
  const task = taskById(taskId);
  if (!task) return false;
  taskRecoveryState.taskId = taskId;
  taskRecoveryState.action = action;
  taskRecoveryState.saving = true;
  taskRecoveryState.error = "";
  app.sig.progress = null;
  renderProgress();
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(note?.trim() ? { note: note.trim() } : {}) }),
    });
    if (response.status === 404 || response.status === 503) {
      throw new Error("任务恢复服务未就绪（接口 404/503）");
    }
    if (!response.ok) throw new Error(await readApiError(response));
    if (action === "continue") toast("已让猫继续试试，再给它一次机会");
    else if (action === "pivot") toast("已换个方案，猫会按新方向继续");
    else toast("已收尾，并记了一条 manual-close 教训");
    window.setTimeout(() => {
      void refreshState().catch(() => {});
    }, 250);
    return true;
  } catch (error) {
    showTaskRecoveryPanelError(`${action === "close" ? "收尾" : action === "pivot" ? "换方案" : "继续"}失败：${error.message}`);
    return false;
  } finally {
    taskRecoveryState.saving = false;
    app.sig.progress = null;
    renderProgress();
  }
}

function openTaskPivotModal(taskId) {
  const task = taskById(taskId) ?? activeTask();
  if (!task) return;
  taskRecoveryState.taskId = task.id;
  taskRecoveryState.action = "pivot";
  taskRecoveryState.error = "";
  if (els.taskPivotNote) els.taskPivotNote.value = "";
  hideTaskPivotError();
  updateTaskPivotState();
  if (!els.taskPivotModal?.open) els.taskPivotModal?.showModal();
  requestAnimationFrame(() => els.taskPivotNote?.focus());
}

function closeTaskPivotModal() {
  if (els.taskPivotModal?.open) els.taskPivotModal.close();
}

function hideTaskPivotError() {
  if (!els.taskPivotError) return;
  els.taskPivotError.hidden = true;
  els.taskPivotError.textContent = "";
}

function showTaskPivotError(message) {
  if (!els.taskPivotError) return;
  els.taskPivotError.textContent = message;
  els.taskPivotError.hidden = false;
}

function updateTaskPivotState() {
  if (!els.taskPivotSubmit) return;
  els.taskPivotSubmit.disabled = taskRecoveryState.saving;
  els.taskPivotSubmit.textContent = taskRecoveryState.saving ? "提交中…" : "提交新方向";
}

function openTaskCloseModal(taskId) {
  const task = taskById(taskId) ?? activeTask();
  if (!task) return;
  taskRecoveryState.taskId = task.id;
  taskRecoveryState.action = "close";
  taskRecoveryState.error = "";
  if (els.taskCloseNote) els.taskCloseNote.value = "";
  hideTaskCloseError();
  updateTaskCloseState();
  if (!els.taskCloseModal?.open) els.taskCloseModal?.showModal();
  requestAnimationFrame(() => els.taskCloseNote?.focus());
}

function closeTaskCloseModal() {
  if (els.taskCloseModal?.open) els.taskCloseModal.close();
}

function hideTaskCloseError() {
  if (!els.taskCloseError) return;
  els.taskCloseError.hidden = true;
  els.taskCloseError.textContent = "";
}

function showTaskCloseError(message) {
  if (!els.taskCloseError) return;
  els.taskCloseError.textContent = message;
  els.taskCloseError.hidden = false;
}

function updateTaskCloseState() {
  if (!els.taskCloseSubmit) return;
  els.taskCloseSubmit.disabled = taskRecoveryState.saving;
  els.taskCloseSubmit.textContent = taskRecoveryState.saving ? "收尾中…" : "确认收尾";
}

async function submitTaskPivot(event) {
  event.preventDefault();
  if (taskRecoveryState.saving) return;
  hideTaskPivotError();
  updateTaskPivotState();
  const ok = await submitTaskAction(
    taskRecoveryState.taskId,
    "pivot",
    els.taskPivotNote?.value ?? "",
  );
  if (ok) closeTaskPivotModal();
  else showTaskPivotError(taskRecoveryState.error || "换方案失败");
  updateTaskPivotState();
}

async function submitTaskClose(event) {
  event.preventDefault();
  if (taskRecoveryState.saving) return;
  hideTaskCloseError();
  updateTaskCloseState();
  const ok = await submitTaskAction(
    taskRecoveryState.taskId,
    "close",
    els.taskCloseNote?.value ?? "",
  );
  if (ok) closeTaskCloseModal();
  else showTaskCloseError(taskRecoveryState.error || "收尾失败");
  updateTaskCloseState();
}

function toggleToolOutput(button) {
  const card = button?.closest?.(".tool-card");
  if (!card) return;
  const output = card.querySelector('[data-role="output"]');
  const toggle = card.querySelector(".tool-toggle");
  if (!output) return;
  const willExpand = output.hidden;
  output.hidden = !willExpand;
  if (toggle) {
    toggle.textContent = willExpand ? "收起输出" : "展开输出";
    toggle.setAttribute("aria-expanded", String(willExpand));
  }
  card.dataset.userCollapsed = willExpand ? "false" : "true";
}

function syntheticToolMessageNode(call) {
  const cat = catById(call.catId);
  const node = h("article", {
    class: "msg msg--cat msg--tool",
    "data-synthetic-tool": "true",
    "data-synthetic-id": call.id,
    style: cat ? `--accent:${safeCss(cat.accent)}` : null,
  });
  node.appendChild(
    h("div", {
      class: "msg-avatar",
      "aria-hidden": "true",
      html: avatarSvg(cat ?? {}, { size: 38 }),
    }),
  );
  const main = h("div", { class: "msg-main" });
  main.appendChild(
    h(
      "header",
      { class: "msg-head" },
      h("span", { class: "msg-author", text: cat?.name ?? "猫猫" }),
      h("span", { class: "msg-role", text: "工具" }),
      h("time", {
        class: "msg-time",
        datetime: new Date(call.startedAt).toISOString(),
        title: fmtFull(call.startedAt),
        text: fmtTime(call.startedAt),
      }),
    ),
  );
  main.appendChild(toolCardNode(call, null));
  node.appendChild(main);
  return node;
}

/** 原地更新所有已渲染工具卡；补位没有对应消息的工具调用。 */
function syncToolCards() {
  const host = els.timeline;
  if (!host) return;

  const calls = app.state?.toolCalls ?? [];
  const callsById = new Map(calls.map((call) => [call.id, call]));
  const messages = roomMessages();
  const represented = new Set(
    messages.filter((message) => message.kind === "tool" && message.toolCallId).map((message) => message.toolCallId),
  );

  for (const card of $$(".tool-card[data-tool-call-id]", host)) {
    const call = callsById.get(card.dataset.toolCallId);
    if (call) updateToolCard(card, call);
  }

  // 工具消息到达后，移除补位卡容器（卡片节点可能已被移入真实消息节点）。
  for (const node of $$("[data-synthetic-tool]", host)) {
    const id = node.dataset.syntheticId;
    const card = node.querySelector(".tool-card[data-tool-call-id]");
    if (!card || (id && represented.has(id))) node.remove();
  }

  const existingIds = new Set(
    $$(".tool-card[data-tool-call-id]", host).map((card) => card.dataset.toolCallId),
  );
  const roomTaskIds = new Set(
    (app.state?.tasks ?? []).filter((task) => task.roomId === app.roomId).map((task) => task.id),
  );

  const wasNearBottom = isNearBottom(els.timelineScroll);
  let addedSynthetic = false;
  for (const call of calls) {
    if (represented.has(call.id) || existingIds.has(call.id)) continue;
    if (call.taskId && !roomTaskIds.has(call.taskId)) continue;
    if (host.querySelector(".timeline-empty")) host.replaceChildren();
    host.appendChild(syntheticToolMessageNode(call));
    addedSynthetic = true;
  }
  // pending 卡可能比普通消息高（多一排审批按钮），补位后如果原本在底部要跟着滚，
  // 否则批准/拒绝按钮会落在视口外。
  if (addedSynthetic && wasNearBottom) scrollToBottom(true);
}

// ── 沙盒 / 工作区文件面板 / 文件查看 ───────────────────────────────────

function updateSandboxWorkspaceChrome() {
  const workspace = currentWorkspace();
  const isSandbox = !workspace || workspace.kind === "sandbox";
  if (els.sandboxTitle) {
    els.sandboxTitle.textContent = isSandbox ? "沙盒" : "工作区文件";
  }
  if (els.sandboxResetBtn) {
    els.sandboxResetBtn.title = isSandbox
      ? "清空并重种内置沙盒文件"
      : "当前工作区不是内置沙盒，不能重置";
  }
}

async function loadWorkspace() {
  if (sandboxState.loading) return;
  const workspace = currentWorkspace();
  const requestedWorkspaceId = workspace?.id ?? null;
  sandboxState.loading = true;
  if (sandboxState.workspaceId !== requestedWorkspaceId) {
    sandboxState.files = [];
    sandboxState.loaded = false;
    sandboxState.error = "";
  }
  sandboxState.workspaceId = requestedWorkspaceId;
  updateSandboxWorkspaceChrome();
  renderSandbox();
  try {
    let payload;
    let endpoint;
    if (workspace && workspaceState.available !== false) {
      endpoint = `/api/workspaces/${encodeURIComponent(workspace.id)}/files`;
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await describeHttpError(response, `GET ${endpoint}`));
      payload = await response.json();
    } else {
      endpoint = "/api/workspace/tree";
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 503) {
        const error = new Error("沙盒服务未就绪（HTTP 503），接入后会自动恢复。");
        error.status = 503;
        throw error;
      }
      if (!response.ok) throw new Error(await describeHttpError(response, endpoint));
      payload = await response.json();
    }
    if (requestedWorkspaceId !== (currentWorkspace()?.id ?? null)) return;
    sandboxState.root = String(payload?.root ?? workspace?.root ?? "");
    sandboxState.files = Array.isArray(payload?.files)
      ? payload.files
          .filter((file) => file && typeof file.path === "string")
          .map((file) => ({ path: file.path, size: Number(file.size) || 0 }))
          .sort((a, b) => a.path.localeCompare(b.path))
      : [];
    sandboxState.available = true;
    sandboxState.error = "";
    sandboxState.resetError = "";
    sandboxState.loaded = true;
  } catch (error) {
    if (requestedWorkspaceId !== (currentWorkspace()?.id ?? null)) return;
    sandboxState.available = false;
    sandboxState.error = error.message || "工作区文件读取失败";
    sandboxState.files = [];
    sandboxState.loaded = true;
  } finally {
    sandboxState.loading = false;
    renderSandbox();
  }
}

function scheduleSandboxRefresh() {
  if (sandboxState.refreshTimer) window.clearTimeout(sandboxState.refreshTimer);
  sandboxState.refreshTimer = window.setTimeout(() => {
    sandboxState.refreshTimer = null;
    if (sandboxState.available === false) return;
    void loadWorkspace();
  }, 800);
}

function formatBytes(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function renderSandbox() {
  const host = els.sandboxList;
  if (!host) return;
  const workspace = currentWorkspace();
  const isSandbox = !workspace || workspace.kind === "sandbox";
  if (els.sandboxCount) els.sandboxCount.textContent = String(sandboxState.files.length);
  updateSandboxWorkspaceChrome();

  if (els.sandboxError) {
    els.sandboxError.hidden = !sandboxState.resetError;
    els.sandboxError.textContent = sandboxState.resetError || "";
  }
  if (els.sandboxResetBtn) {
    els.sandboxResetBtn.hidden = sandboxState.resetConfirm || !isSandbox;
  }
  if (els.sandboxResetConfirm) els.sandboxResetConfirm.hidden = !sandboxState.resetConfirm;
  if (els.sandboxConfirmReset) {
    els.sandboxConfirmReset.disabled = sandboxState.resetting;
    els.sandboxConfirmReset.textContent = sandboxState.resetting ? "重置中…" : "确认重置";
  }
  if (els.sandboxRefresh) els.sandboxRefresh.disabled = sandboxState.loading;

  if (sandboxState.loading && !sandboxState.loaded) {
    host.replaceChildren(emptyNote(isSandbox ? "读取沙盒…" : "读取工作区文件…"));
    return;
  }
  if (sandboxState.error) {
    host.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: isSandbox ? "沙盒未启用" : "工作区文件未就绪" }),
        h("span", { text: sandboxState.error }),
        h("button", {
          type: "button",
          class: "btn btn--ghost btn--tiny",
          "data-action": "refresh-sandbox",
          text: "↻ 重试",
        }),
      ),
    );
    return;
  }
  if (!sandboxState.files.length) {
    host.replaceChildren(
      emptyNote(
        isSandbox
          ? "沙盒还是空的。猫猫写文件后会出现在这里。"
          : "这个工作区还没有文件。",
      ),
    );
    return;
  }

  host.replaceChildren(
    ...sandboxState.files.map((file) =>
      h(
        "button",
        {
          type: "button",
          class: "sandbox-file",
          "data-action": "open-sandbox-file",
          "data-path": file.path,
          title: `查看 ${file.path}`,
        },
        h("span", { class: "sandbox-path", text: file.path }),
        h("span", { class: "sandbox-size", text: formatBytes(file.size) }),
      ),
    ),
  );
}

function askResetSandbox() {
  sandboxState.resetConfirm = true;
  sandboxState.resetError = "";
  renderSandbox();
}

function setSandboxResetConfirm(show) {
  sandboxState.resetConfirm = show;
  renderSandbox();
}

async function resetSandbox() {
  if (sandboxState.resetting) return;
  const workspace = currentWorkspace();
  if (workspace && workspace.kind !== "sandbox") {
    sandboxState.resetError = "当前工作区不是内置沙盒，不能重置。";
    renderSandbox();
    return;
  }
  sandboxState.resetting = true;
  sandboxState.resetError = "";
  renderSandbox();
  try {
    const response = await fetch("/api/workspace/reset", { method: "POST" });
    if (response.status === 503) {
      throw new Error("沙盒服务未就绪（POST /api/workspace/reset → HTTP 503）");
    }
    if (!response.ok) throw new Error(await describeHttpError(response, "POST /api/workspace/reset"));
    await response.json().catch(() => null);
    sandboxState.resetConfirm = false;
    closeSandboxFile();
    toast("沙盒已重置");
    await loadWorkspace();
  } catch (error) {
    sandboxState.resetConfirm = false;
    sandboxState.resetError = `重置失败：${error.message}`;
  } finally {
    sandboxState.resetting = false;
    renderSandbox();
  }
}

async function openSandboxFile(path) {
  if (!els.sandboxFileModal) return;
  const workspace = currentWorkspace();
  sandboxState.file = { open: true, loading: true, path, content: "", error: "" };

  const title = $("#sandbox-file-title");
  if (title) title.textContent = path;
  if (els.sandboxFilePath) els.sandboxFilePath.textContent = path;
  if (els.sandboxFileSize) els.sandboxFileSize.textContent = "";
  if (els.sandboxFileError) {
    els.sandboxFileError.hidden = true;
    els.sandboxFileError.textContent = "";
  }
  if (els.sandboxFileContent) els.sandboxFileContent.textContent = "读取中…";
  if (els.sandboxCopyBtn) els.sandboxCopyBtn.disabled = true;
  if (!els.sandboxFileModal.open) els.sandboxFileModal.showModal();

  try {
    const endpoint =
      workspace && workspaceState.available !== false
        ? `/api/workspaces/${encodeURIComponent(workspace.id)}/file?path=${encodeURIComponent(path)}`
        : `/api/workspace/file?path=${encodeURIComponent(path)}`;
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 503) throw new Error("文件服务未就绪（HTTP 503）");
    if (!response.ok) throw new Error(await describeHttpError(response, `GET ${endpoint}`));
    const payload = await response.json();
    sandboxState.file.content = String(payload?.content ?? "");
    sandboxState.file.path = String(payload?.path ?? path);
    if (title) title.textContent = sandboxState.file.path;
    if (els.sandboxFilePath) els.sandboxFilePath.textContent = sandboxState.file.path;
    if (els.sandboxFileContent) els.sandboxFileContent.textContent = sandboxState.file.content || "（空文件）";
    if (els.sandboxFileSize) {
      const bytes = new TextEncoder().encode(sandboxState.file.content).length;
      els.sandboxFileSize.textContent = formatBytes(bytes);
    }
    if (els.sandboxCopyBtn) els.sandboxCopyBtn.disabled = false;
  } catch (error) {
    sandboxState.file.error = error.message;
    if (els.sandboxFileError) {
      els.sandboxFileError.textContent = error.message;
      els.sandboxFileError.hidden = false;
    }
    if (els.sandboxFileContent) els.sandboxFileContent.textContent = "（无法读取）";
  } finally {
    sandboxState.file.loading = false;
  }
}

function closeSandboxFile() {
  if (els.sandboxFileModal?.open) els.sandboxFileModal.close();
}

async function copySandboxFile() {
  const content = sandboxState.file.content;
  if (!content) {
    toast("文件内容为空", "warn");
    return;
  }
  try {
    await navigator.clipboard.writeText(content);
    toast("已复制文件内容");
    return;
  } catch {
    /* 降级到 execCommand */
  }
  try {
    const area = document.createElement("textarea");
    area.value = content;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("copy failed");
    toast("已复制文件内容");
  } catch {
    toast("复制失败，请手动选择文本", "error");
  }
}

// ── 设置 · 工具执行开关 ─────────────────────────────────────────────────

function updateToolsHint() {
  if (!els.settingsToolsHint) return;
  const checked = els.settingsToolsToggle ? els.settingsToolsToggle.checked : true;
  if (els.settingsToolsHint.dataset.missing === "true") {
    els.settingsToolsHint.textContent =
      "当前服务端未返回 toolsEnabled（可能还没就绪），保存后以服务端为准。";
    return;
  }
  els.settingsToolsHint.textContent = checked
    ? "开启：猫可以读/写工作区文件并运行命令；关闭：只产出文字。"
    : "已关闭：猫不会写文件或运行命令，只会产出文字。";
}



// ── 房间切换 ───────────────────────────────────────────────────────────

function renderRooms() {
  const rooms = app.state?.rooms ?? [];
  const workspaceSig = (workspaceState.list ?? [])
    .map((workspace) => `${workspace.id}:${workspace.policy}:${workspace.roomCount}:${workspace.kind}`)
    .join(",");
  const sig =
    `${app.roomId}|${workspaceState.available}|` +
    rooms.map((room) => `${room.id}:${room.name}:${room.workspaceId ?? ""}`).join("|") +
    `|ws:${workspaceSig}`;
  if (sig === app.sig.rooms) return;
  app.sig.rooms = sig;

  if (els.roomCount) els.roomCount.textContent = String(rooms.length);
  if (!els.roomList) return;
  if (!rooms.length) {
    els.roomList.replaceChildren(emptyNote("等房间数据…"));
    return;
  }
  els.roomList.replaceChildren(...rooms.map((room) => roomItem(room)));
}

function roomItem(room, options = {}) {
  const active = room.id === app.roomId;
  const badge = workspaceRoomBadge(room);
  const withMenu = options.withMenu !== false;
  return h(
    "div",
    {
      class: `room-item${active ? " is-active" : ""}`,
      "data-room-id": room.id,
      role: "listitem",
    },
    h(
      "button",
      {
        type: "button",
        class: "room-main",
        "data-action": "switch-room",
        "data-room-id": room.id,
        "aria-pressed": active ? "true" : "false",
        title: `${room.name} · ${badge.text}`,
      },
      h(
        "span",
        { class: "room-item-main" },
        h("span", { class: "room-item-name", text: room.name }),
        h("span", {
          class: "room-item-badge",
          "data-policy": badge.policy,
          text: badge.text,
        }),
      ),
      active ? h("span", { class: "room-item-check", "aria-hidden": "true", text: "●" }) : null,
    ),
    withMenu
      ? h("button", {
          type: "button",
          class: "room-menu-btn",
          "data-action": "open-room-menu",
          "data-room-id": room.id,
          "aria-label": `管理房间「${room.name}」`,
          title: "房间操作",
          text: "…",
        })
      : null,
  );
}

function renderRoomPicker() {
  if (!els.roomPickerList) return;
  const rooms = app.state?.rooms ?? [];
  els.roomPickerList.replaceChildren(
    ...(rooms.length
      ? rooms.map((room) => roomItem(room, { withMenu: false }))
      : [emptyNote("还没有房间")]),
  );
}

function openRoomPicker() {
  if (!els.roomPickerModal) return;
  renderRoomPicker();
  if (!els.roomPickerModal.open) els.roomPickerModal.showModal();
}

function closeRoomPicker() {
  if (els.roomPickerModal?.open) els.roomPickerModal.close();
}

function setRoom(roomId, options = {}) {
  if (!roomId) return;
  const room = (app.state?.rooms ?? []).find((item) => item.id === roomId);
  if (!room) return;
  if (roomId !== app.roomId) {
    app.roomId = roomId;
    app.selectedTaskId = null;
    app.timeline = { ids: [], lastTaskId: null, initialized: false };
    toolCardNodes.clear();
    clearDraftBubbleImmediate();
    if (els.timeline) els.timeline.replaceChildren();
    app.expanded.clear();
    app.sig.tasks = null;
    app.sig.progress = null;
    app.sig.handoffs = null;
    app.sig.artifacts = null;
    app.sig.memory = null;
    app.sig.currentWorkspace = null;
    resetUnread();
  }
  closeRoomPicker();
  renderAll();
  if (options.scroll !== false) scrollToBottom(false);
  ensureCurrentWorkspaceData();
  if (isCompactViewport() && options.tab !== false) setTab("chat");
}

function updateNewRoomState() {
  const name = els.newRoomName?.value.trim() ?? "";
  const workspaceId = els.newRoomWorkspace?.value ?? "";
  const valid = name.length >= 1 && name.length <= 30 && Boolean(workspaceId);
  if (els.createRoomBtn) {
    els.createRoomBtn.disabled = roomState.creating || !valid;
    els.createRoomBtn.textContent = roomState.creating ? "创建中…" : "创建并进入";
  }
}

function hideNewRoomError() {
  if (!els.newRoomError) return;
  els.newRoomError.hidden = true;
  els.newRoomError.textContent = "";
}

function showNewRoomError(message) {
  if (!els.newRoomError) return;
  els.newRoomError.textContent = message;
  els.newRoomError.hidden = false;
}

function populateNewRoomWorkspaces() {
  if (!els.newRoomWorkspace) return;
  const selected = els.newRoomWorkspace.value;
  const options = [];
  for (const workspace of workspaceState.list ?? []) {
    options.push(
      h("option", {
        value: workspace.id,
        text:
          workspace.kind === "sandbox"
            ? `${workspace.name}（内置沙盒）`
            : `${workspace.name} · ${workspacePolicyLabel(workspace.policy)}`,
      }),
    );
  }
  if (!options.length) {
    options.push(
      h("option", {
        value: "",
        text: workspaceState.available === false ? "工作区服务未就绪" : "（没有可用工作区）",
      }),
    );
  }
  els.newRoomWorkspace.replaceChildren(...options);
  const preferred = selected ||
    currentRoom()?.workspaceId ||
    options[0]?.value ||
    "";
  if ([...els.newRoomWorkspace.options].some((option) => option.value === preferred)) {
    els.newRoomWorkspace.value = preferred;
  }
  if (els.newRoomWorkspaceHint) {
    els.newRoomWorkspaceHint.textContent =
      workspaceState.available === false
        ? "工作区服务未就绪，暂时无法创建房间。你可以稍后重试。"
        : "每个房间绑定一个工作区；真实仓库默认只读，需要写入请先在设置里授权。";
  }
  updateNewRoomState();
}

async function openNewRoom() {
  closeRoomPicker();
  if (!els.newRoomModal) return;
  hideNewRoomError();
  roomState.creating = false;
  if (els.newRoomName) els.newRoomName.value = "";
  if (els.newRoomTopic) els.newRoomTopic.value = "";
  updateNewRoomState();
  if (!els.newRoomModal.open) els.newRoomModal.showModal();
  if (!workspaceState.loaded) await loadWorkspaces();
  populateNewRoomWorkspaces();
  updateNewRoomState();
  requestAnimationFrame(() => els.newRoomName?.focus());
}

function closeNewRoom() {
  if (els.newRoomModal?.open) els.newRoomModal.close();
}

async function createRoom() {
  if (roomState.creating) return;
  hideNewRoomError();
  const name = els.newRoomName?.value.trim() ?? "";
  const workspaceId = els.newRoomWorkspace?.value ?? "";
  const topic = els.newRoomTopic?.value.trim() ?? "";
  if (name.length < 1 || name.length > 30) {
    showNewRoomError("房间名需要 1–30 个字符。");
    els.newRoomName?.focus();
    return;
  }
  if (!workspaceId) {
    showNewRoomError("先选一个工作区；工作区服务未就绪时暂时不能创建房间。");
    return;
  }
  roomState.creating = true;
  updateNewRoomState();
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, workspaceId, ...(topic ? { topic } : {}) }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const room = await response.json();
    closeNewRoom();
    await refreshState().catch(() => {});
    if (app.state && !(app.state.rooms ?? []).some((item) => item.id === room.id)) {
      app.state.rooms = [...(app.state.rooms ?? []), room];
    }
    setRoom(room.id);
    void loadWorkspaces();
    toast(`已创建房间「${room.name}」`);
  } catch (error) {
    showNewRoomError(`创建失败：${error.message}`);
  } finally {
    roomState.creating = false;
    updateNewRoomState();
  }
}


// ── 房间管理：菜单 / 编辑 / 删除 ───────────────────────────────────────

function roomById(id) {
  return (app.state?.rooms ?? []).find((room) => room.id === id) ?? null;
}

function roomTaskIds(roomId) {
  return new Set(
    (app.state?.tasks ?? []).filter((task) => task.roomId === roomId).map((task) => task.id),
  );
}

function roomDeleteCounts(roomId) {
  const taskIds = roomTaskIds(roomId);
  return {
    tasks: (app.state?.tasks ?? []).filter((task) => task.roomId === roomId).length,
    messages: (app.state?.messages ?? []).filter((message) => message.roomId === roomId).length,
    handoffs: (app.state?.handoffs ?? []).filter((handoff) => taskIds.has(handoff.taskId)).length,
    artifacts: (app.state?.artifacts ?? []).filter((artifact) => taskIds.has(artifact.taskId)).length,
    toolCalls: (app.state?.toolCalls ?? []).filter((call) => call.taskId && taskIds.has(call.taskId)).length,
  };
}

function activeTasksInRoom(roomId) {
  return (app.state?.tasks ?? []).filter(
    (task) =>
      task.roomId === roomId && (task.status === "active" || task.status === "stalled"),
  );
}

function roomDeleteBlockReason(room) {
  if (!room) return "房间不存在";
  if ((app.state?.rooms ?? []).length <= 1) return "最后一个房间不能删除";
  if (roomAdminState.probing) return "正在检查房间管理接口…";
  if (roomAdminState.available === false) return "房间管理服务未就绪（PATCH/DELETE 404/503）";
  const active = activeTasksInRoom(room.id);
  if (active.length > 0) {
    return `还有 ${active.length} 个进行中 / 卡住的任务，先等它们结束或重置猫咖`;
  }
  return "";
}

async function probeRoomAdmin() {
  if (roomAdminState.probing) return;
  const roomId = roomAdminState.roomId;
  if (!roomId) return;
  roomAdminState.probing = true;
  renderRoomMenu();
  try {
    // 空 PATCH 不带字段：路由存在时服务端返回 400「没有可更新的字段」，
    // 不会改数据；路由缺失/未启用则 404/503，用来做能力探测。
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.status === 400 || response.status === 200) {
      roomAdminState.available = true;
    } else if (response.status === 404 || response.status === 503) {
      roomAdminState.available = false;
    } else {
      roomAdminState.available = false;
    }
  } catch {
    roomAdminState.available = false;
  } finally {
    roomAdminState.probing = false;
    renderRoomMenu();
  }
}

function openRoomMenu(roomId) {
  const room = roomById(roomId);
  if (!room) return;
  roomAdminState.roomId = roomId;
  roomAdminState.mode = "";
  renderRoomMenu();
  if (!els.roomMenuModal?.open) els.roomMenuModal?.showModal();
  if (roomAdminState.available === null) void probeRoomAdmin();
}

function closeRoomMenu() {
  if (els.roomMenuModal?.open) els.roomMenuModal.close();
}

function roomMenuButton(mode, title, description, options = {}) {
  return h(
    "button",
    {
      type: "button",
      class: "room-menu-item",
      "data-action": "room-action",
      "data-mode": mode,
      "data-danger": options.danger ? "true" : "false",
      disabled: Boolean(options.disabled),
    },
    h("span", { class: "room-menu-item-title", text: title }),
    h("small", { text: options.disabled && options.reason ? options.reason : description }),
  );
}

function renderRoomMenu() {
  const room = roomById(roomAdminState.roomId);
  if (!room) {
    closeRoomMenu();
    return;
  }
  const busy = roomAdminState.probing || roomAdminState.available === false;
  if (els.roomMenuSub) {
    const badge = workspaceRoomBadge(room);
    els.roomMenuSub.textContent = `${room.name} · ${badge.text}`;
  }
  if (els.roomMenuError) {
    const unavailable =
      roomAdminState.available === false
        ? "房间管理服务未就绪（PATCH/DELETE 404/503），菜单暂时只读。"
        : roomAdminState.probing
          ? "正在检查房间管理接口…"
          : "";
    els.roomMenuError.hidden = !unavailable;
    els.roomMenuError.textContent = unavailable;
  }
  if (els.roomMenuRetry) {
    els.roomMenuRetry.hidden = roomAdminState.available !== false;
  }

  const workspaceDisabled =
    busy ||
    (workspaceState.available === false &&
      !(workspaceState.list ?? []).some((item) => item.id === room.workspaceId));
  const workspaceReason =
    roomAdminState.probing
      ? "正在检查房间管理接口…"
      : roomAdminState.available === false
        ? "房间管理服务未就绪，暂时不能修改"
        : workspaceState.available === false
          ? "工作区服务未就绪，暂时不能切换"
          : "";
  const deleteReason = roomDeleteBlockReason(room);

  if (els.roomMenuList) {
    els.roomMenuList.replaceChildren(
      roomMenuButton("name", "重命名", `当前名称：${room.name}`, {
        disabled: busy,
        reason:
          roomAdminState.available === false
            ? "房间管理服务未就绪，暂时不能修改"
            : roomAdminState.probing
              ? "正在检查房间管理接口…"
              : "",
      }),
      roomMenuButton("topic", "修改主题", room.topic || "（没有主题）", {
        disabled: busy,
        reason:
          roomAdminState.available === false
            ? "房间管理服务未就绪，暂时不能修改"
            : roomAdminState.probing
              ? "正在检查房间管理接口…"
              : "",
      }),
      roomMenuButton("workspace", "更换工作区", `当前：${workspaceRoomBadge(room).text}`, {
        disabled: workspaceDisabled,
        reason: workspaceReason,
      }),
      roomMenuButton(
        "delete",
        "删除房间",
        roomDeleteCounts(room.id).tasks
          ? `会删除 ${roomDeleteCounts(room.id).tasks} 个任务及相关数据`
          : "删除该房间及其任务/消息/产物",
        {
          danger: true,
          disabled: Boolean(deleteReason),
          reason: deleteReason,
        },
      ),
    );
  }
}

function openRoomEdit(mode) {
  const room = roomById(roomAdminState.roomId);
  if (!room) return;
  if (roomAdminState.probing || roomAdminState.available === false) {
    toast(roomAdminState.probing ? "正在检查房间管理接口…" : "房间管理服务未就绪", "warn");
    return;
  }
  if (mode === "workspace" && workspaceState.available === false) {
    toast("工作区服务未就绪，暂时不能切换", "warn");
    return;
  }
  roomAdminState.mode = mode;
  closeRoomMenu();
  if (els.roomEditNameField) els.roomEditNameField.hidden = mode !== "name";
  if (els.roomEditTopicField) els.roomEditTopicField.hidden = mode !== "topic";
  if (els.roomEditWorkspaceField) els.roomEditWorkspaceField.hidden = mode !== "workspace";
  if (els.roomEditName) els.roomEditName.value = room.name;
  if (els.roomEditTopic) els.roomEditTopic.value = room.topic ?? "";
  if (els.roomEditError) {
    els.roomEditError.hidden = true;
    els.roomEditError.textContent = "";
  }
  let title = "编辑房间";
  let sub = "修改房间信息。";
  let saveText = "保存";
  if (mode === "name") {
    title = "重命名房间";
    sub = "房间名会显示在左栏和聊天头部，1–30 个字符。";
    saveText = "保存名称";
  } else if (mode === "topic") {
    title = "修改房间主题";
    sub = "房间主题显示在聊天头部，最多 120 个字符。";
    saveText = "保存主题";
  } else if (mode === "workspace") {
    title = "更换工作区";
    sub = "切换后这个房间的文件、沙盒与 git 状态会跟着变。";
    saveText = "保存工作区";
  }
  if (els.roomEditTitle) els.roomEditTitle.textContent = title;
  if (els.roomEditSub) els.roomEditSub.textContent = sub;
  if (els.roomEditSave) els.roomEditSave.textContent = saveText;
  if (mode === "workspace") {
    void populateRoomWorkspaceSelect(room);
  }
  updateRoomEditState();
  if (!els.roomEditModal?.open) els.roomEditModal?.showModal();
  requestAnimationFrame(() => {
    if (mode === "name") {
      els.roomEditName?.focus();
      els.roomEditName?.select();
    } else if (mode === "topic") {
      els.roomEditTopic?.focus();
      els.roomEditTopic?.select();
    }
  });
}

async function populateRoomWorkspaceSelect(room) {
  const select = els.roomEditWorkspace;
  if (!select) return;
  if (!workspaceState.loaded) await loadWorkspaces();
  const options = (workspaceState.list ?? []).map((workspace) =>
    h("option", {
      value: workspace.id,
      text:
        workspace.kind === "sandbox"
          ? `${workspace.name}（内置沙盒）`
          : `${workspace.name} · ${workspacePolicyLabel(workspace.policy)}`,
    }),
  );
  if (!options.length) {
    options.push(h("option", { value: "", text: "工作区服务未就绪" }));
  }
  select.replaceChildren(...options);
  if ([...select.options].some((option) => option.value === room.workspaceId)) {
    select.value = room.workspaceId;
  }
  if (els.roomEditWorkspaceHint) {
    els.roomEditWorkspaceHint.textContent =
      workspaceState.available === false
        ? "工作区服务未就绪，暂时不能切换工作区。"
        : "切换后当前房间的文件、沙盒与 git 状态会跟着变。";
  }
  updateRoomEditState();
}

function closeRoomEdit() {
  if (els.roomEditModal?.open) els.roomEditModal.close();
}

function hideRoomEditError() {
  if (!els.roomEditError) return;
  els.roomEditError.hidden = true;
  els.roomEditError.textContent = "";
}

function showRoomEditError(message) {
  if (!els.roomEditError) return;
  els.roomEditError.textContent = message;
  els.roomEditError.hidden = false;
}

function updateRoomEditState() {
  if (!els.roomEditSave) return;
  const mode = roomAdminState.mode;
  let valid = true;
  if (mode === "name") {
    const name = els.roomEditName?.value.trim() ?? "";
    valid = name.length >= 1 && name.length <= 30;
  } else if (mode === "topic") {
    valid = (els.roomEditTopic?.value.length ?? 0) <= 120;
  } else if (mode === "workspace") {
    valid =
      workspaceState.available !== false &&
      Boolean(els.roomEditWorkspace?.value);
  }
  els.roomEditSave.disabled = roomAdminState.saving || !valid;
  const labels = { name: "保存名称", topic: "保存主题", workspace: "保存工作区" };
  els.roomEditSave.textContent = roomAdminState.saving
    ? "保存中…"
    : labels[mode] ?? "保存";
}

function applyUpdatedRoom(updated) {
  if (!updated?.id || !app.state) return;
  const rooms = app.state.rooms ?? [];
  const index = rooms.findIndex((room) => room.id === updated.id);
  const previous = index >= 0 ? rooms[index] : null;
  const workspaceChanged = Boolean(previous && previous.workspaceId !== updated.workspaceId);
  if (index >= 0) rooms[index] = updated;
  app.sig.rooms = null;
  if (workspaceChanged && app.roomId === updated.id) {
    app.sig.currentWorkspace = null;
    sandboxState.files = [];
    sandboxState.loaded = false;
    sandboxState.workspaceId = null;
    clearTaskGitState();
  }
  renderAll();
  if (workspaceChanged) {
    void loadWorkspaces();
    if (app.roomId === updated.id) ensureCurrentWorkspaceData();
  }
}

async function saveRoomEdit(event) {
  event.preventDefault();
  if (roomAdminState.saving) return;
  const room = roomById(roomAdminState.roomId);
  if (!room) return;
  const mode = roomAdminState.mode;
  const patch = {};
  if (mode === "name") {
    const name = els.roomEditName?.value.trim() ?? "";
    if (name.length < 1 || name.length > 30) {
      showRoomEditError("房间名需要 1–30 个字符。");
      els.roomEditName?.focus();
      return;
    }
    patch.name = name;
  } else if (mode === "topic") {
    const topic = els.roomEditTopic?.value.trim() ?? "";
    if (topic.length > 120) {
      showRoomEditError("主题不能超过 120 个字符。");
      els.roomEditTopic?.focus();
      return;
    }
    patch.topic = topic;
  } else if (mode === "workspace") {
    const workspaceId = els.roomEditWorkspace?.value ?? "";
    if (!workspaceId) {
      showRoomEditError("请选择一个工作区。");
      return;
    }
    patch.workspaceId = workspaceId;
  } else {
    return;
  }

  roomAdminState.saving = true;
  hideRoomEditError();
  updateRoomEditState();
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (response.status === 404 || response.status === 503) {
      roomAdminState.available = false;
    }
    if (!response.ok) throw new Error(await readApiError(response));
    const updated = await response.json();
    closeRoomEdit();
    applyUpdatedRoom(updated);
    if (mode === "name") toast(`房间已重命名为「${updated.name}」`);
    else if (mode === "topic") toast("房间主题已更新");
    else toast("房间工作区已切换");
  } catch (error) {
    showRoomEditError(`保存失败：${error.message}`);
  } finally {
    roomAdminState.saving = false;
    updateRoomEditState();
  }
}

function openRoomDelete() {
  const room = roomById(roomAdminState.roomId);
  if (!room) return;
  closeRoomMenu();
  roomAdminState.mode = "delete";
  const counts = roomDeleteCounts(room.id);
  const reason = roomDeleteBlockReason(room);
  if (els.roomDeleteSub) els.roomDeleteSub.textContent = `确认删除「${room.name}」？`;
  if (els.roomDeleteCounts) {
    els.roomDeleteCounts.replaceChildren(
      h("span", { class: "room-delete-count", text: `任务 ${counts.tasks}` }),
      h("span", { class: "room-delete-count", text: `消息 ${counts.messages}` }),
      h("span", { class: "room-delete-count", text: `交接卡 ${counts.handoffs}` }),
      h("span", { class: "room-delete-count", text: `产物 ${counts.artifacts}` }),
      h("span", { class: "room-delete-count", text: `工具记录 ${counts.toolCalls}` }),
    );
  }
  if (els.roomDeleteReason) {
    els.roomDeleteReason.hidden = !reason;
    els.roomDeleteReason.textContent = reason || "";
  }
  if (els.roomDeleteError) {
    els.roomDeleteError.hidden = true;
    els.roomDeleteError.textContent = "";
  }
  if (els.roomDeleteConfirm) {
    els.roomDeleteConfirm.disabled = Boolean(reason) || roomAdminState.deleting;
    els.roomDeleteConfirm.textContent = roomAdminState.deleting ? "删除中…" : "确认删除";
  }
  if (!els.roomDeleteModal?.open) els.roomDeleteModal?.showModal();
}

function closeRoomDelete() {
  if (els.roomDeleteModal?.open) els.roomDeleteModal.close();
}

function showRoomDeleteError(message) {
  if (!els.roomDeleteError) return;
  els.roomDeleteError.textContent = message;
  els.roomDeleteError.hidden = false;
}

function hideRoomDeleteError() {
  if (!els.roomDeleteError) return;
  els.roomDeleteError.hidden = true;
  els.roomDeleteError.textContent = "";
}

function removeRoomLocally(roomId) {
  if (!app.state) return;
  const taskIds = roomTaskIds(roomId);
  app.state.rooms = (app.state.rooms ?? []).filter((room) => room.id !== roomId);
  app.state.messages = (app.state.messages ?? []).filter((message) => message.roomId !== roomId);
  app.state.tasks = (app.state.tasks ?? []).filter((task) => task.roomId !== roomId);
  app.state.handoffs = (app.state.handoffs ?? []).filter((handoff) => !taskIds.has(handoff.taskId));
  app.state.artifacts = (app.state.artifacts ?? []).filter((artifact) => !taskIds.has(artifact.taskId));
  app.state.toolCalls = (app.state.toolCalls ?? []).filter(
    (call) => !call.taskId || !taskIds.has(call.taskId),
  );
  app.state.memory = (app.state.memory ?? []).filter(
    (entry) => !entry.sourceTaskId || !taskIds.has(entry.sourceTaskId),
  );
  delete app.state.typing?.[roomId];
  app.sig.rooms = null;
}

async function confirmRoomDelete() {
  if (roomAdminState.deleting) return;
  const room = roomById(roomAdminState.roomId);
  if (!room) return;
  const reason = roomDeleteBlockReason(room);
  if (reason) {
    if (els.roomDeleteReason) {
      els.roomDeleteReason.hidden = false;
      els.roomDeleteReason.textContent = reason;
    }
    return;
  }
  const wasCurrent = app.roomId === room.id;
  roomAdminState.deleting = true;
  hideRoomDeleteError();
  if (els.roomDeleteConfirm) {
    els.roomDeleteConfirm.disabled = true;
    els.roomDeleteConfirm.textContent = "删除中…";
  }
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}`, {
      method: "DELETE",
    });
    if (response.status === 404 || response.status === 503) {
      roomAdminState.available = false;
    }
    if (!response.ok) throw new Error(await readApiError(response));
    const payload = await response.json();
    closeRoomDelete();
    const removed = payload?.removed ?? {};
    await refreshState().catch(() => {});
    if ((app.state?.rooms ?? []).some((item) => item.id === room.id)) {
      removeRoomLocally(room.id);
    }
    const remaining = app.state?.rooms ?? [];
    if (wasCurrent || !remaining.some((item) => item.id === app.roomId)) {
      if (remaining[0]) setRoom(remaining[0].id);
    } else {
      renderAll();
    }
    void loadWorkspaces();
    toast(
      `已删除房间「${room.name}」` +
        (removed.tasks ? `（任务 ${removed.tasks} / 消息 ${removed.messages ?? 0}）` : ""),
    );
  } catch (error) {
    showRoomDeleteError(`删除失败：${error.message}`);
  } finally {
    roomAdminState.deleting = false;
    if (els.roomDeleteConfirm) {
      els.roomDeleteConfirm.disabled = false;
      els.roomDeleteConfirm.textContent = "确认删除";
    }
  }
}

// ── 工作区 ─────────────────────────────────────────────────────────────

function setWorkspacesStatus(text) {
  if (els.workspacesStatus) els.workspacesStatus.textContent = text;
}

async function loadWorkspaces(options = {}) {
  if (workspaceState.loading) return;
  workspaceState.loading = true;
  if (!workspaceState.loaded && !options.silent) setWorkspacesStatus("读取工作区…");
  renderWorkspacesSettings();
  renderCurrentWorkspace();
  try {
    const response = await fetch("/api/workspaces", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 503 || response.status === 404) {
      throw new Error("工作区服务未就绪");
    }
    if (!response.ok) throw new Error(await describeHttpError(response, "GET /api/workspaces"));
    const payload = await response.json();
    workspaceState.list = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
    workspaceState.available = true;
    workspaceState.error = "";
    workspaceState.loaded = true;
    setWorkspacesStatus(`${workspaceState.list.length} 个工作区`);
  } catch (error) {
    workspaceState.available = false;
    workspaceState.error = error.message || "工作区服务未就绪";
    workspaceState.list = [];
    workspaceState.loaded = true;
    setWorkspacesStatus("工作区服务未就绪");
  } finally {
    workspaceState.loading = false;
    renderRooms();
    renderWorkspacesSettings();
    renderCurrentWorkspace();
    if (els.newRoomModal?.open) populateNewRoomWorkspaces();
    updateSandboxWorkspaceChrome();
  }
  if (workspaceState.available) {
    await Promise.all(
      workspaceState.list
        .filter((workspace) => workspace.isGit)
        .map((workspace) => loadWorkspaceGit(workspace.id, { silent: true })),
    );
    const current = currentWorkspace();
    if (current?.isGit && !workspaceState.git[current.id]) {
      void loadWorkspaceGit(current.id, { silent: true });
    }
  }
}

function gitBadgeFor(workspace) {
  if (!workspace) return "—";
  if (!workspace.isGit) return "非 git";
  const info = workspaceState.git[workspace.id];
  if (workspaceState.gitLoading[workspace.id] && !info) return "git…";
  if (!info) return "git 未读取";
  if (info.error) return "git 错误";
  const branch = info.branch || "detached";
  return `${branch} · ${info.clean === true ? "clean" : info.clean === false ? "dirty" : "?"}`;
}

async function loadWorkspaceGit(workspaceId, options = {}) {
  const workspace = workspaceById(workspaceId);
  if (!workspace || !workspace.isGit) return;
  if (workspaceState.gitLoading[workspaceId]) return;
  workspaceState.gitLoading[workspaceId] = true;
  if (!options.silent) {
    renderWorkspacesSettings();
    renderCurrentWorkspace();
  }
  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/git`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await describeHttpError(response, "GET workspace git"));
    workspaceState.git[workspaceId] = await response.json();
  } catch (error) {
    workspaceState.git[workspaceId] = {
      workspaceId,
      isGit: true,
      error: error.message || "git 读取失败",
    };
  } finally {
    delete workspaceState.gitLoading[workspaceId];
    renderWorkspacesSettings();
    renderCurrentWorkspace();
    if (workspaceState.panel.open && workspaceState.panel.id === workspaceId) {
      renderGitPanel();
    }
  }
}

function renderWorkspacesSettings() {
  const host = els.workspaceList;
  if (!host) return;
  if (workspaceState.loading && !workspaceState.loaded) {
    host.replaceChildren(emptyNote("读取工作区…"));
    return;
  }
  if (workspaceState.available === false) {
    host.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "工作区服务未就绪" }),
        h("span", {
          text:
            workspaceState.error && workspaceState.error !== "工作区服务未就绪"
              ? workspaceState.error
              : "接口 503 / 404；工作区服务就绪后可以重试。",
        }),
        h("button", {
          type: "button",
          class: "btn btn--ghost btn--tiny",
          "data-action": "reload-workspaces",
          text: "↻ 重试",
        }),
      ),
    );
    return;
  }
  if (!workspaceState.list.length) {
    host.replaceChildren(emptyNote("还没有工作区。默认房间会使用内置沙盒。"));
    return;
  }
  host.replaceChildren(...workspaceState.list.map((workspace) => workspaceRowNode(workspace)));
}

function workspaceRowNode(workspace) {
  const roomCount = Number.isFinite(workspace.roomCount)
    ? Number(workspace.roomCount)
    : (app.state?.rooms ?? []).filter((room) => room.workspaceId === workspace.id).length;
  const isSandbox = workspace.kind === "sandbox" || workspace.id === DEFAULT_WORKSPACE_ID;
  const bound = roomCount > 0;
  const expanded = workspaceState.expanded.has(workspace.id);
  const gitInfo = workspaceState.git[workspace.id];
  const deleteDisabled = isSandbox || bound;
  const rowError = workspaceState.rowErrors[workspace.id];

  return h(
    "div",
    {
      class: "workspace-row",
      "data-workspace-id": workspace.id,
      "data-policy": workspace.policy,
    },
    h(
      "div",
      { class: "workspace-head" },
      h("span", { class: "workspace-name", text: workspace.name }),
      h("span", {
        class: "workspace-policy-badge",
        "data-policy": workspace.policy,
        text: workspacePolicyLabel(workspace.policy),
      }),
      h("span", {
        class: "workspace-policy-badge",
        text: isSandbox ? "内置沙盒" : workspace.isGit ? "git 仓库" : "目录",
      }),
      h("span", {
        class: "workspace-policy-badge",
        "data-branch": workspace.branchPerTask ? "on" : "off",
        text: `任务分支：${workspace.branchPerTask ? "开" : "关"}`,
      }),
      h("span", {
        class: "workspace-git-badge",
        "data-clean": gitInfo?.clean === false ? "false" : gitInfo?.clean === true ? "true" : "",
        text: gitBadgeFor(workspace),
      }),
      h("span", {
        class: "workspace-delete-hint",
        text: isSandbox
          ? "内置不可删"
          : bound
            ? `${roomCount} 个房间正在用`
            : "",
      }),
    ),
    h(
      "div",
      { class: `workspace-path${expanded ? " is-expanded" : ""}` },
      h("code", { text: workspace.root, title: workspace.root }),
      h("button", {
        type: "button",
        class: "workspace-path-toggle",
        "data-action": "toggle-workspace-path",
        "data-workspace-id": workspace.id,
        text: expanded ? "收起" : "展开",
      }),
    ),
    h(
      "div",
      { class: "workspace-meta" },
      h("span", { text: `绑定房间：${roomCount}` }),
      gitInfo?.lastCommit ? h("span", { text: `· ${gitInfo.lastCommit}` }) : null,
      workspace.isGit
        ? h("span", { text: `· ${gitBadgeFor(workspace)}` })
        : null,
    ),
    workspace.policy === "read-write"
      ? h("p", { class: "workspace-warning", text: "⚠ 写入会改真实文件" })
      : null,
    workspace.isGit && gitInfo?.error ? h("p", { class: "mcp-last-error", text: gitInfo.error }) : null,
    rowError ? h("p", { class: "mcp-last-error", text: rowError }) : null,
    h(
      "div",
      { class: "workspace-actions" },
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--ghost",
        "data-action": "open-workspace-git",
        "data-workspace-id": workspace.id,
        text: "查看 git / 文件",
      }),
      workspace.isGit
        ? h("button", {
            type: "button",
            class: "btn btn--tiny btn--ghost",
            "data-action": "refresh-workspace-git",
            "data-workspace-id": workspace.id,
            text: "刷新 git",
          })
        : null,
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--danger",
        "data-action": "delete-workspace",
        "data-workspace-id": workspace.id,
        disabled: deleteDisabled,
        title: isSandbox
          ? "内置沙盒工作区不可删除"
          : bound
            ? "还有房间绑定这个工作区，先解绑再删除"
            : "删除工作区",
        text: "删除",
      }),
      workspaceState.deleteConfirmId === workspace.id
        ? h(
            "span",
            { class: "mcp-confirm" },
            h("span", { text: "确认从列表删除？" }),
            h("button", {
              type: "button",
              class: "btn btn--tiny btn--danger",
              "data-action": "confirm-delete-workspace",
              "data-workspace-id": workspace.id,
              text: "确认删除",
            }),
            h("button", {
              type: "button",
              class: "btn btn--tiny btn--ghost",
              "data-action": "cancel-delete-workspace",
              text: "取消",
            }),
          )
        : null,
    ),
  );
}

function openWorkspaceForm() {
  workspaceState.formOpen = true;
  if (els.workspaceForm) els.workspaceForm.hidden = false;
  if (els.workspaceFormToggle) els.workspaceFormToggle.textContent = "－ 收起表单";
  hideWorkspaceFormError();
  updateWorkspaceFormState();
  requestAnimationFrame(() => els.workspaceName?.focus());
}

function closeWorkspaceForm() {
  workspaceState.formOpen = false;
  if (els.workspaceForm) els.workspaceForm.hidden = true;
  if (els.workspaceFormToggle) els.workspaceFormToggle.textContent = "＋ 添加工作区";
  if (els.workspaceName) els.workspaceName.value = "";
  if (els.workspacePath) els.workspacePath.value = "";
  if (els.workspaceConfirm) els.workspaceConfirm.checked = false;
  if (els.workspaceBranchPerTask) els.workspaceBranchPerTask.checked = true;
  const readOnly = (els.workspacePolicyInputs ?? []).find((input) => input.value === "read-only");
  if (readOnly) readOnly.checked = true;
  updateWorkspaceFormState();
  hideWorkspaceFormError();
}

function workspacePolicyValue() {
  const checked = (els.workspacePolicyInputs ?? []).find((input) => input.checked);
  return checked?.value === "read-write" ? "read-write" : "read-only";
}

function updateWorkspaceFormState() {
  const policy = workspacePolicyValue();
  if (els.workspaceConfirmRow) els.workspaceConfirmRow.hidden = policy !== "read-write";
  if (els.workspaceConfirm && policy !== "read-write") els.workspaceConfirm.checked = false;
  if (els.workspaceSaveBtn) {
    els.workspaceSaveBtn.disabled = workspaceState.saving;
    els.workspaceSaveBtn.textContent = workspaceState.saving ? "保存中…" : "添加工作区";
  }
}

function showWorkspaceFormError(message) {
  if (!els.workspaceFormError) return;
  els.workspaceFormError.textContent = message;
  els.workspaceFormError.hidden = false;
}

function hideWorkspaceFormError() {
  if (!els.workspaceFormError) return;
  els.workspaceFormError.textContent = "";
  els.workspaceFormError.hidden = true;
}

function isAbsolutePath(path) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

async function saveWorkspace() {
  if (workspaceState.saving) return;
  hideWorkspaceFormError();
  const name = els.workspaceName?.value.trim() ?? "";
  const path = els.workspacePath?.value.trim() ?? "";
  const policy = workspacePolicyValue();
  if (name.length < 1 || name.length > 40) {
    showWorkspaceFormError("名称需要 1–40 个字符。");
    els.workspaceName?.focus();
    return;
  }
  if (!isAbsolutePath(path)) {
    showWorkspaceFormError("路径必须是绝对路径（例如 /Users/you/project）。");
    els.workspacePath?.focus();
    return;
  }
  if (policy === "read-write" && !els.workspaceConfirm?.checked) {
    showWorkspaceFormError("读写工作区需要先勾选「我确认写入会修改真实文件」。");
    els.workspaceConfirm?.focus();
    return;
  }

  workspaceState.saving = true;
  updateWorkspaceFormState();
  try {
    const body = {
      name,
      path,
      policy,
      branchPerTask: els.workspaceBranchPerTask ? Boolean(els.workspaceBranchPerTask.checked) : true,
    };
    if (policy === "read-write") body.confirm = true;
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const payload = await response.json();
    closeWorkspaceForm();
    await loadWorkspaces();
    toast(`工作区「${payload?.workspace?.name ?? name}」已添加`);
  } catch (error) {
    showWorkspaceFormError(`添加失败：${error.message}`);
  } finally {
    workspaceState.saving = false;
    updateWorkspaceFormState();
  }
}

function askDeleteWorkspace(workspaceId) {
  workspaceState.deleteConfirmId = workspaceId;
  renderWorkspacesSettings();
}

async function confirmDeleteWorkspace(workspaceId) {
  workspaceState.deleteConfirmId = "";
  delete workspaceState.rowErrors[workspaceId];
  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(await readApiError(response));
    await loadWorkspaces();
    toast("工作区已删除");
  } catch (error) {
    workspaceState.rowErrors[workspaceId] = `删除失败：${error.message}`;
    renderWorkspacesSettings();
  }
}

// ── 右栏：当前工作区 / git 面板 ────────────────────────────────────────

function renderCurrentWorkspace() {
  const body = els.currentWorkspaceBody;
  if (!body) return;
  const workspace = currentWorkspace();
  const id = workspace?.id ?? currentWorkspaceId();
  const info = workspace ? workspaceState.git[workspace.id] : null;
  const sig =
    `${app.roomId}|${id}|${workspace?.name ?? ""}|${workspace?.policy ?? ""}|` +
    `${workspace?.isGit ?? ""}|${info?.branch ?? ""}|${info?.clean ?? ""}|${info?.error ?? ""}|` +
    `${workspaceState.available}`;
  if (sig === app.sig.currentWorkspace) return;
  app.sig.currentWorkspace = sig;

  if (els.currentWorkspacePolicy) {
    els.currentWorkspacePolicy.textContent = workspace
      ? workspacePolicyLabel(workspace.policy)
      : "";
  }

  if (!workspace) {
    body.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "工作区服务未就绪" }),
        h("span", { text: workspaceState.error || "接口 503 / 404" }),
        h("button", {
          type: "button",
          class: "btn btn--ghost btn--tiny",
          "data-action": "reload-workspaces",
          text: "↻ 重试",
        }),
      ),
    );
    return;
  }

  const children = [
    h(
      "div",
      { class: "current-workspace-name" },
      h("span", { text: workspace.name }),
      h("span", {
        class: "workspace-policy-badge",
        "data-policy": workspace.policy,
        text: workspacePolicyLabel(workspace.policy),
      }),
      workspace.kind === "sandbox"
        ? h("span", { class: "workspace-policy-badge", text: "内置沙盒" })
        : null,
    ),
    h("p", { class: "current-workspace-path", text: workspace.root }),
  ];

  if (workspace.isGit) {
    const loading = workspaceState.gitLoading[workspace.id] && !info;
    children.push(
      h(
        "div",
        { class: "current-workspace-git" },
        h("span", { text: "git" }),
        h("span", { class: "git-branch", text: info?.branch || (loading ? "读取中…" : "—") }),
        info
          ? h("span", {
              class: "current-workspace-clean",
              "data-clean": info.clean === false ? "false" : info.clean === true ? "true" : "",
              text: info.clean === false ? "dirty" : info.clean === true ? "clean" : "?",
            })
          : null,
        info?.lastCommit ? h("span", { text: info.lastCommit }) : null,
      ),
    );
    if (info?.error) {
      children.push(h("p", { class: "workspace-warning", text: info.error }));
    }
  } else {
    children.push(
      h("div", { class: "current-workspace-git" }, h("span", { text: "非 git 工作区" })),
    );
  }

  if (workspace.policy === "read-write" && workspace.kind !== "sandbox") {
    children.push(
      h("span", { class: "current-workspace-warning", text: "⚠ 写入会改真实文件" }),
    );
  }
  body.replaceChildren(...children);
  if (els.currentWorkspaceGitBtn) {
    els.currentWorkspaceGitBtn.textContent = workspace.isGit ? "查看 git" : "查看文件";
  }
}

function ensureCurrentWorkspaceData() {
  const workspace = currentWorkspace();
  if (!workspace) {
    renderCurrentWorkspace();
    return;
  }
  if (workspace.isGit && !workspaceState.git[workspace.id] && !workspaceState.gitLoading[workspace.id]) {
    void loadWorkspaceGit(workspace.id, { silent: true });
  }
  updateSandboxWorkspaceChrome();
  void loadWorkspace();
}

async function openGitPanel(workspaceId) {
  const workspace = workspaceById(workspaceId) ?? (workspaceId === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE : null);
  if (!workspace) {
    toast("工作区不存在", "warn");
    return;
  }
  workspaceState.panel = {
    id: workspace.id,
    open: true,
    loading: true,
    error: "",
    info: workspaceState.git[workspace.id] ?? null,
    diff: "",
    diffLoading: false,
    diffError: "",
    files: [],
    filesLoading: true,
    filesError: "",
  };
  if (els.gitTitle) {
    els.gitTitle.textContent = workspace.isGit ? `Git · ${workspace.name}` : `文件 · ${workspace.name}`;
  }
  if (els.gitSub) els.gitSub.textContent = `${workspace.root} · 只读查询`;
  if (els.gitDiffDetails) els.gitDiffDetails.open = false;
  renderGitPanel();
  if (!els.gitModal?.open) els.gitModal?.showModal();
  await Promise.allSettled([
    workspace.isGit ? loadWorkspaceGit(workspace.id, { silent: true }) : Promise.resolve(),
    loadGitFiles(workspace.id),
  ]);
  workspaceState.panel.loading = false;
  renderGitPanel();
}

function closeGitPanel() {
  if (els.gitModal?.open) els.gitModal.close();
}

function renderGitPanel() {
  const panel = workspaceState.panel;
  if (!panel.id) return;
  const workspace = workspaceById(panel.id) ?? (panel.id === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE : null);
  const info = workspaceState.git[panel.id] ?? null;
  panel.info = info;
  if (els.gitError) {
    els.gitError.hidden = !panel.error;
    els.gitError.textContent = panel.error || "";
  }

  if (els.gitMeta) {
    const nodes = [];
    if (!workspace) {
      nodes.push(h("span", { text: "工作区不存在" }));
    } else {
      nodes.push(h("span", { class: "git-branch", text: workspace.name }));
      nodes.push(h("span", { text: workspacePolicyLabel(workspace.policy) }));
      if (!workspace.isGit) nodes.push(h("span", { text: "非 git 工作区" }));
      if (info?.branch) nodes.push(h("span", { text: `分支 ${info.branch}` }));
      if (info && info.clean !== undefined) {
        nodes.push(
          h("span", {
            class: "git-clean",
            "data-clean": info.clean ? "true" : "false",
            text: info.clean ? "clean" : "dirty",
          }),
        );
      }
      if (info?.lastCommit) nodes.push(h("span", { text: info.lastCommit }));
      if (info?.diffStat) nodes.push(h("span", { text: info.diffStat.split("\n").slice(-1)[0] }));
      if (info?.error) nodes.push(h("span", { class: "workspace-warning", text: info.error }));
    }
    els.gitMeta.replaceChildren(...nodes);
  }

  if (els.gitStatusPre) {
    els.gitStatusPre.textContent = !workspace
      ? "—"
      : !workspace.isGit
        ? "不是 git 仓库；仍然可以查看文件。"
        : panel.loading && !info
          ? "读取中…"
          : info?.error
            ? info.error
            : info?.status || "（没有未提交变更）";
  }

  if (els.gitDiffPre) {
    els.gitDiffPre.textContent = panel.diffError
      ? panel.diffError
      : panel.diffLoading
        ? "读取 diff…"
        : panel.diff || "展开后加载 diff。";
  }

  if (els.gitFileList) {
    if (panel.filesLoading) {
      els.gitFileList.replaceChildren(emptyNote("读取文件…"));
    } else if (panel.filesError) {
      els.gitFileList.replaceChildren(emptyNote(panel.filesError));
    } else if (!panel.files.length) {
      els.gitFileList.replaceChildren(emptyNote("工作区没有文件。"));
    } else {
      els.gitFileList.replaceChildren(
        ...panel.files.map((file) =>
          h("button", {
            type: "button",
            class: "git-file",
            "data-action": "open-workspace-file",
            "data-workspace-id": panel.id,
            "data-path": file.path,
            text: file.path,
            title: `${file.path} · ${formatBytes(file.size ?? 0)}`,
          }),
        ),
      );
    }
    if (els.gitFileCount) els.gitFileCount.textContent = String(panel.files.length);
  }
}

async function loadGitDiff(workspaceId) {
  const panel = workspaceState.panel;
  if (!panel || panel.id !== workspaceId || panel.diffLoading) return;
  panel.diffLoading = true;
  panel.diffError = "";
  renderGitPanel();
  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/diff`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await describeHttpError(response, "GET workspace git diff"));
    const payload = await response.json();
    if (payload?.ok === false) {
      panel.diffError = payload?.error ? `diff 不可用：${payload.error}` : "diff 不可用";
    } else {
      panel.diff = String(payload?.diff ?? "");
    }
  } catch (error) {
    panel.diffError = `diff 读取失败：${error.message}`;
  } finally {
    panel.diffLoading = false;
    renderGitPanel();
  }
}

async function loadGitFiles(workspaceId) {
  const panel = workspaceState.panel;
  if (!panel || panel.id !== workspaceId) return;
  panel.filesLoading = true;
  panel.filesError = "";
  renderGitPanel();
  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await describeHttpError(response, "GET workspace files"));
    const payload = await response.json();
    panel.files = Array.isArray(payload?.files) ? payload.files : [];
  } catch (error) {
    panel.filesError = `文件读取失败：${error.message}`;
  } finally {
    panel.filesLoading = false;
    renderGitPanel();
  }
}

async function refreshGitPanel() {
  const panel = workspaceState.panel;
  if (!panel.id) return;
  if (panel.info?.isGit !== false) await loadWorkspaceGit(panel.id, { silent: true });
  await loadGitFiles(panel.id);
  if (els.gitDiffDetails?.open) await loadGitDiff(panel.id);
  renderGitPanel();
}

async function openWorkspaceFile(workspaceId, path) {
  if (!els.sandboxFileModal) return;
  sandboxState.file = { open: true, loading: true, path, content: "", error: "" };
  const title = $("#sandbox-file-title");
  if (title) title.textContent = path;
  if (els.sandboxFilePath) els.sandboxFilePath.textContent = path;
  if (els.sandboxFileSize) els.sandboxFileSize.textContent = "";
  if (els.sandboxFileError) {
    els.sandboxFileError.hidden = true;
    els.sandboxFileError.textContent = "";
  }
  if (els.sandboxFileContent) els.sandboxFileContent.textContent = "读取中…";
  if (els.sandboxCopyBtn) els.sandboxCopyBtn.disabled = true;
  if (!els.sandboxFileModal.open) els.sandboxFileModal.showModal();
  try {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" },
    );
    if (!response.ok) throw new Error(await describeHttpError(response, "GET workspace file"));
    const payload = await response.json();
    sandboxState.file.content = String(payload?.content ?? "");
    sandboxState.file.path = String(payload?.path ?? path);
    if (title) title.textContent = sandboxState.file.path;
    if (els.sandboxFilePath) els.sandboxFilePath.textContent = sandboxState.file.path;
    if (els.sandboxFileContent) {
      els.sandboxFileContent.textContent = sandboxState.file.content || "（空文件）";
    }
    if (els.sandboxFileSize) {
      const bytes = new TextEncoder().encode(sandboxState.file.content).length;
      els.sandboxFileSize.textContent = formatBytes(bytes);
    }
    if (els.sandboxCopyBtn) els.sandboxCopyBtn.disabled = false;
  } catch (error) {
    sandboxState.file.error = error.message;
    if (els.sandboxFileError) {
      els.sandboxFileError.textContent = error.message;
      els.sandboxFileError.hidden = false;
    }
    if (els.sandboxFileContent) els.sandboxFileContent.textContent = "（无法读取）";
  } finally {
    sandboxState.file.loading = false;
  }
}



// ── 测试中心 ───────────────────────────────────────────────────────────

function formatTestDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function testRunDuration(run) {
  if (!run) return 0;
  const start = Number(run.startedAt) || 0;
  const end = Number(run.finishedAt) || (run.status === "running" ? Date.now() : start);
  return Math.max(0, end - start);
}

function testRunById(id) {
  return testCenterState.runs.find((run) => run.id === id) ?? null;
}

function selectedTestRun() {
  const detail = testCenterState.details.get(testCenterState.selectedId);
  return detail ?? testRunById(testCenterState.selectedId) ?? testRunById(testCenterState.liveId);
}

function testRunStatusLabel(run) {
  return TEST_STATUS_LABEL[run?.status] ?? "空闲";
}

function testKindLabel(run) {
  if (!run) return "";
  const base = TEST_KIND_LABEL[run.kind] ?? run.kind;
  return run.kind === "scenario" && run.scenario ? `${base} · ${run.scenario}` : base;
}

function syncTestRunningFromRuns() {
  const running = new Set(
    testCenterState.runs.filter((run) => run.status === "running").map((run) => run.id),
  );
  testCenterState.running = running;
  const latest = [...running][0] ?? null;
  if (latest) {
    if (!testCenterState.liveId || !running.has(testCenterState.liveId)) {
      testCenterState.liveId = latest;
    }
  } else {
    testCenterState.liveId = null;
  }
}

function updateTestTopButton() {
  if (!els.testButtons?.length && !els.testDots?.length) return;
  const runningCount = testCenterState.running.size;
  const latest = testCenterState.runs[0] ?? null;
  let state = "idle";
  if (testCenterState.available === false) state = "unavailable";
  else if (runningCount > 0) state = "running";
  else if (latest?.status) state = latest.status;
  for (const dot of els.testDots ?? []) dot.dataset.state = state;
  const title =
    testCenterState.available === false
      ? "测试服务未就绪"
      : runningCount > 0
        ? `测试运行中（${runningCount}）`
        : latest
          ? `上次测试：${testRunStatusLabel(latest)}`
          : "测试中心";
  for (const button of els.testButtons ?? []) {
    button.title = title;
    button.setAttribute("aria-label", title);
  }
}

async function loadTestRuns(options = {}) {
  if (testCenterState.loading) return;
  testCenterState.loading = true;
  try {
    const response = await fetch("/api/tests/runs", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 503) {
      testCenterState.available = false;
      testCenterState.error = "测试服务未就绪（GET /api/tests/runs 404/503）";
      updateTestTopButton();
      if (testCenterState.open) renderTestCenter();
      return;
    }
    if (!response.ok) throw new Error(await describeHttpError(response, "GET /api/tests/runs"));
    const payload = await response.json();
    testCenterState.runs = Array.isArray(payload?.runs) ? payload.runs : [];
    testCenterState.available = true;
    if (testCenterState.error === "测试服务未就绪（GET /api/tests/runs 404/503）") {
      testCenterState.error = "";
    }
    syncTestRunningFromRuns();
    for (const run of testCenterState.runs) {
      const detail = testCenterState.details.get(run.id);
      if (detail) {
        detail.status = run.status;
        if (run.finishedAt) detail.finishedAt = run.finishedAt;
        if (run.exitCode !== undefined) detail.exitCode = run.exitCode;
        if (run.summary) detail.summary = run.summary;
      }
    }
    if (!testCenterState.selectedId || !testCenterState.runs.some((run) => run.id === testCenterState.selectedId)) {
      testCenterState.selectedId = testCenterState.liveId ?? testCenterState.runs[0]?.id ?? null;
    }
    updateTestTopButton();
    if (testCenterState.available && !testCenterState.socket) connectTestStream();
    if (testCenterState.open) {
      renderTestCenter();
      const selected = testCenterState.selectedId;
      if (selected && !testCenterState.details.has(selected)) void loadTestRunDetail(selected);
    }
  } catch (error) {
    testCenterState.error = `测试服务读取失败：${error.message}`;
    updateTestTopButton();
    if (testCenterState.open) renderTestCenter();
  } finally {
    testCenterState.loading = false;
  }
}

async function initTestCenter() {
  await loadTestRuns();
  updateTestTopButton();
}

function connectTestStream() {
  if (testCenterState.socket || testCenterState.available === false) return;
  let source;
  try {
    source = new EventSource("/api/tests/stream");
  } catch {
    testCenterState.error = "测试日志流无法连接";
    return;
  }
  testCenterState.socket = source;
  source.onopen = () => {
    const recovered = testCenterState.disconnected;
    testCenterState.socketOpen = true;
    testCenterState.disconnected = false;
    if (recovered) {
      appendTestSystemLine("连接已恢复，正在补齐日志…");
      const id = testCenterState.selectedId ?? testCenterState.liveId;
      if (id) void loadTestRunDetail(id);
    }
    if (testCenterState.open) renderTestLog(false);
  };
  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object" || !payload.runId) return;
    handleTestStreamEvent(payload);
  };
  source.onerror = () => {
    if (!testCenterState.disconnected) {
      testCenterState.disconnected = true;
      appendTestSystemLine("连接断开，重连中…");
    }
  };
}

function handleTestStreamEvent(event) {
  const runId = String(event.runId ?? "");
  if (!runId) return;
  if (event.event === "start") {
    if (!testCenterState.running.has(runId)) testCenterState.running.add(runId);
    testCenterState.liveId = runId;
    if (!testRunById(runId)) {
      testCenterState.runs.unshift({
        id: runId,
        kind: "unit",
        status: "running",
        startedAt: Date.now(),
        lineCount: 0,
      });
      if (testCenterState.runs.length > 20) testCenterState.runs.length = 20;
    }
    if (testCenterState.open && (!testCenterState.selectedId || testCenterState.followLive !== false)) {
      testCenterState.selectedId = runId;
      testCenterState.autoScroll = true;
    }
    updateTestTopButton();
    void loadTestRunDetail(runId);
    void loadTestRuns({ silent: true });
    if (testCenterState.open) renderTestCenter();
    return;
  }
  if (event.event === "exit") {
    testCenterState.running.delete(runId);
    if (testCenterState.liveId === runId) {
      testCenterState.liveId = [...testCenterState.running][0] ?? null;
    }
    const summary = testRunById(runId);
    const wasCancelled = summary?.status === "cancelled" || testCenterState.details.get(runId)?.status === "cancelled";
    const status = wasCancelled ? "cancelled" : event.code === 0 ? "passed" : "failed";
    if (summary) {
      summary.status = status;
      summary.exitCode = event.code ?? undefined;
      summary.finishedAt = Date.now();
    }
    const detail = testCenterState.details.get(runId);
    if (detail) {
      detail.status = status;
      detail.exitCode = event.code ?? undefined;
      detail.finishedAt = Date.now();
      detail.summary = detail.summary ?? summarizeTestLines(detail.lines);
    }
    updateTestTopButton();
    void loadTestRunDetail(runId);
    void loadTestRuns({ silent: true });
    if (testCenterState.open) renderTestCenter();
    return;
  }
  if (typeof event.line === "string") {
    appendTestLine(runId, {
      at: Number(event.at) || Date.now(),
      stream: event.stream === "stderr" ? "stderr" : "stdout",
      text: event.line,
    });
  }
}

function appendTestLine(runId, line) {
  let detail = testCenterState.details.get(runId);
  if (!detail) {
    const summary = testRunById(runId);
    detail = {
      id: runId,
      kind: summary?.kind ?? "unit",
      ...(summary?.scenario ? { scenario: summary.scenario } : {}),
      status: summary?.status ?? "running",
      startedAt: summary?.startedAt ?? Date.now(),
      lines: [],
    };
    testCenterState.details.set(runId, detail);
  }
  detail.lines.push(line);
  let trimmed = false;
  if (detail.lines.length > 2000) {
    detail.lines.splice(0, detail.lines.length - 2000);
    trimmed = true;
  }
  const summary = testRunById(runId);
  if (summary) summary.lineCount = detail.lines.length;
  if (testCenterState.open && testCenterState.selectedId === runId) {
    renderTestLog(trimmed);
    renderTestStatus();
    renderTestHistory();
  }
}

function appendTestSystemLine(text) {
  const id = testCenterState.liveId ?? testCenterState.selectedId;
  if (!id) return;
  appendTestLine(id, {
    at: Date.now(),
    stream: "stdout",
    text,
    system: true,
  });
}

function summarizeTestLines(lines) {
  let tests = 0;
  let pass = 0;
  let fail = 0;
  for (const line of lines) {
    const text = String(line.text ?? "");
    const passMatch = /^(?:#|ℹ)\s*pass\s+(\d+)/i.exec(text);
    const failMatch = /^(?:#|ℹ)\s*fail\s+(\d+)/i.exec(text);
    const testsMatch = /^(?:#|ℹ)\s*tests\s+(\d+)/i.exec(text);
    if (testsMatch) tests = Number(testsMatch[1]);
    if (passMatch) pass = Number(passMatch[1]);
    if (failMatch) fail = Number(failMatch[1]);
  }
  return tests || pass || fail ? { tests, pass, fail } : undefined;
}

async function loadTestRunDetail(runId) {
  if (!runId) return;
  testCenterState.detailLoading = true;
  try {
    const response = await fetch(`/api/tests/runs/${encodeURIComponent(runId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 503) {
      if (response.status === 503) testCenterState.available = false;
      if (testCenterState.selectedId === runId) {
        testCenterState.error =
          response.status === 503 ? "测试服务未就绪（HTTP 503）" : "测试记录不存在";
      }
      return;
    }
    if (!response.ok) throw new Error(await describeHttpError(response, "GET test run"));
    const detail = await response.json();
    if (!detail?.id) return;
    if (!Array.isArray(detail.lines)) detail.lines = [];
    testCenterState.details.set(detail.id, detail);
    // 缓存最近查看的 detail，避免无限增长。
    while (testCenterState.details.size > 6) {
      const oldest = [...testCenterState.details.keys()].find(
        (id) => id !== testCenterState.selectedId && id !== testCenterState.liveId,
      );
      if (!oldest) break;
      testCenterState.details.delete(oldest);
    }
    const summary = testRunById(detail.id);
    if (summary) {
      summary.status = detail.status;
      summary.exitCode = detail.exitCode;
      summary.finishedAt = detail.finishedAt;
      summary.summary = detail.summary;
      summary.lineCount = detail.lines.length;
    }
    if (testCenterState.open && testCenterState.selectedId === detail.id) {
      renderTestCenter();
    }
    updateTestTopButton();
  } catch (error) {
    if (testCenterState.selectedId === runId) {
      testCenterState.error = `测试日志读取失败：${error.message}`;
      if (testCenterState.open) renderTestCenter();
    }
  } finally {
    testCenterState.detailLoading = false;
  }
}

async function startTest(kind, scenario) {
  if (testCenterState.available === false) {
    setTestError("测试服务未就绪，暂时不能运行测试。");
    return;
  }
  const alreadyRunning = testCenterState.runs.some(
    (run) => run.kind === kind && run.status === "running",
  );
  if (alreadyRunning) {
    setTestError(`${TEST_KIND_LABEL[kind] ?? kind} 已经在跑，等它结束或先停止。`);
    return;
  }
  clearTestError();
  const body = { kind };
  if (kind === "scenario") body.scenario = scenario;
  try {
    const response = await fetch("/api/tests/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 404 || response.status === 503) {
      testCenterState.available = false;
      setTestError("测试服务未就绪（HTTP 404/503），暂时不能运行测试。");
      updateTestTopButton();
      return;
    }
    if (!response.ok) {
      const message = await readApiError(response);
      setTestError(message);
      return;
    }
    const payload = await response.json();
    const runId = payload?.runId;
    if (!runId) {
      setTestError("测试启动失败：服务端没有返回 runId。");
      return;
    }
    const placeholder = {
      id: runId,
      kind,
      ...(scenario ? { scenario } : {}),
      status: "running",
      startedAt: Number(payload?.startedAt) || Date.now(),
      lineCount: 0,
    };
    testCenterState.runs = [placeholder, ...testCenterState.runs.filter((run) => run.id !== runId)];
    if (testCenterState.runs.length > 20) testCenterState.runs.length = 20;
    testCenterState.running.add(runId);
    testCenterState.liveId = runId;
    testCenterState.selectedId = runId;
    testCenterState.followLive = true;
    testCenterState.onlyFailures = false;
    testCenterState.autoScroll = true;
    testCenterState.details.set(runId, { ...placeholder, lines: [] });
    updateTestTopButton();
    if (testCenterState.open) renderTestCenter();
    if (!testCenterState.socket) connectTestStream();
    void loadTestRunDetail(runId);
    setTimeout(() => void loadTestRuns({ silent: true }), 350);
  } catch (error) {
    setTestError(`启动测试失败：${error.message}`);
  }
}

async function stopSelectedTest() {
  const run = selectedTestRun();
  if (!run || run.status !== "running") return;
  clearTestError();
  try {
    const response = await fetch(`/api/tests/runs/${encodeURIComponent(run.id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const message = await readApiError(response);
      setTestError(`停止失败：${message}`);
      return;
    }
    testCenterState.running.delete(run.id);
    if (testCenterState.liveId === run.id) testCenterState.liveId = [...testCenterState.running][0] ?? null;
    const detail = testCenterState.details.get(run.id);
    if (detail) {
      detail.status = "cancelled";
      detail.finishedAt = Date.now();
    }
    const summary = testRunById(run.id);
    if (summary) {
      summary.status = "cancelled";
      summary.finishedAt = Date.now();
    }
    if (testCenterState.open) renderTestCenter();
    updateTestTopButton();
    void loadTestRunDetail(run.id);
  } catch (error) {
    setTestError(`停止失败：${error.message}`);
  }
}

function selectTestRun(runId) {
  if (!runId) return;
  testCenterState.selectedId = runId;
  testCenterState.followLive = testCenterState.running.has(runId);
  testCenterState.onlyFailures = false;
  testCenterState.autoScroll = true;
  if (testCenterState.open) renderTestCenter();
  if (!testCenterState.details.has(runId) || testCenterState.running.has(runId)) {
    void loadTestRunDetail(runId);
  }
}

function updateTestCenterTicker() {
  if (!testCenterState.open && testCenterState.running.size === 0) return;
  if (testCenterState.open) {
    renderTestStatus();
    renderTestControls();
  }
  const now = Date.now();
  const shouldPoll =
    testCenterState.available !== false &&
    !testCenterState.polling &&
    now - testCenterState.lastPollAt > 4000 &&
    (testCenterState.running.size > 0 || testCenterState.open);
  if (shouldPoll) {
    testCenterState.polling = true;
    testCenterState.lastPollAt = now;
    void loadTestRuns({ silent: true }).finally(() => {
      testCenterState.polling = false;
    });
  }
}

function clearTestError() {
  testCenterState.error = "";
  if (els.testError) {
    els.testError.hidden = true;
    els.testError.textContent = "";
  }
}

function setTestError(message) {
  testCenterState.error = message;
  if (els.testError) {
    els.testError.textContent = message;
    els.testError.hidden = false;
  }
  if (testCenterState.open) renderTestControls();
}

function openTestCenter() {
  if (!els.testCenterModal) return;
  testCenterState.open = true;
  testCenterState.autoScroll = true;
  testCenterState.followLive = true;
  if (!els.testCenterModal.open) els.testCenterModal.showModal();
  if (testCenterState.runs.length === 0 && testCenterState.available !== false) {
    void loadTestRuns();
  }
  if (testCenterState.liveId) {
    testCenterState.selectedId = testCenterState.liveId;
  } else if (!testCenterState.selectedId) {
    testCenterState.selectedId = testCenterState.runs[0]?.id ?? null;
  }
  renderTestCenter();
  const selected = testCenterState.selectedId;
  if (selected) void loadTestRunDetail(selected);
  requestAnimationFrame(() => els.testCenterClose?.focus());
}

function closeTestCenter() {
  testCenterState.open = false;
  if (els.testCenterModal?.open) els.testCenterModal.close();
}

function openTestRealConfirm() {
  if (!els.testRealConfirm) return;
  if (els.testRealError) {
    els.testRealError.hidden = true;
    els.testRealError.textContent = "";
  }
  if (!els.testRealConfirm.open) els.testRealConfirm.showModal();
  requestAnimationFrame(() => els.testRealConfirmBtn?.focus());
}

function closeTestRealConfirm() {
  if (els.testRealConfirm?.open) els.testRealConfirm.close();
}

async function confirmTestReal() {
  closeTestRealConfirm();
  await startTest("real");
}

function renderTestCenter() {
  updateTestTopButton();
  renderTestControls();
  renderTestStatus();
  renderTestHistory();
  renderTestLog(false);
  if (els.testError) {
    els.testError.hidden = !testCenterState.error;
    els.testError.textContent = testCenterState.error || "";
  }
}

function renderTestControls() {
  const unavailable = testCenterState.available === false;
  const runningKinds = new Set(
    testCenterState.runs.filter((run) => run.status === "running").map((run) => run.kind),
  );
  if (els.testRunUnit) {
    els.testRunUnit.disabled = unavailable || runningKinds.has("unit");
    els.testRunUnit.title = unavailable ? "测试服务未就绪" : runningKinds.has("unit") ? "单元测试运行中" : "跑单元测试";
  }
  if (els.testRunReal) {
    els.testRunReal.disabled = unavailable || runningKinds.has("real");
    els.testRunReal.title = unavailable ? "测试服务未就绪" : runningKinds.has("real") ? "真实模型测试运行中" : "跑真实模型矩阵";
  }
  if (els.testRunScenario) {
    els.testRunScenario.disabled = unavailable || runningKinds.has("scenario");
    els.testRunScenario.title = unavailable ? "测试服务未就绪" : runningKinds.has("scenario") ? "场景测试运行中" : "跑单个场景";
  }
  if (els.testScenario) els.testScenario.disabled = unavailable;
  const selected = selectedTestRun();
  if (els.testStopBtn) {
    els.testStopBtn.hidden = selected?.status !== "running";
    els.testStopBtn.disabled = unavailable;
  }
  if (els.testReturnLive) {
    els.testReturnLive.hidden = !(
      testCenterState.liveId &&
      testCenterState.liveId !== testCenterState.selectedId &&
      testCenterState.running.has(testCenterState.liveId)
    );
  }
}

function updateTestStatusDom(run) {
  const status = run?.status ?? "idle";
  if (els.testStatusBadge) {
    els.testStatusBadge.dataset.state = status;
    els.testStatusBadge.textContent = testRunStatusLabel(run);
  }
  if (els.testStatusText) {
    if (!run) els.testStatusText.textContent = "空闲";
    else if (run.status === "running") {
      els.testStatusText.textContent = `${testKindLabel(run)} · 运行中 · 已用时 ${formatTestDuration(testRunDuration(run))}`;
    } else {
      els.testStatusText.textContent = `${testKindLabel(run)} · ${testRunStatusLabel(run)} · 耗时 ${formatTestDuration(testRunDuration(run))}`;
    }
  }
  if (els.testDuration) {
    els.testDuration.textContent = run ? `开始 ${fmtTime(run.startedAt)}` : "";
  }
  if (els.testExit) {
    els.testExit.textContent = run && run.exitCode !== undefined ? `退出码 ${run.exitCode}` : "";
  }
  if (els.testSummary) {
    const summary = run?.summary;
    if (!summary) {
      els.testSummary.textContent = run?.lineCount ? `${run.lineCount} 行` : "";
    } else if (summary.tests !== undefined || summary.pass !== undefined || summary.fail !== undefined) {
      els.testSummary.textContent = `${summary.tests ?? 0} 项 · ${summary.pass ?? 0} pass / ${summary.fail ?? 0} fail`;
    } else if (summary.scenarios !== undefined) {
      els.testSummary.textContent = `${summary.scenarios ?? 0} 场景 · ${summary.failed ?? 0} 失败`;
    } else {
      els.testSummary.textContent = "";
    }
  }
}

function renderTestStatus() {
  const run = selectedTestRun();
  updateTestStatusDom(run);
  renderTestControls();
}

function testFailLines(lines) {
  return (lines ?? []).filter(
    (line) => line.stream === "stderr" && /^\s*✖/.test(String(line.text ?? "")),
  );
}

function renderTestHistory() {
  if (!els.testHistoryList) return;
  const runs = testCenterState.runs;
  const sig = runs
    .map((run) => [run.id, run.status, run.finishedAt ?? "", run.lineCount ?? ""].join(":"))
    .join("|") + `|sel:${testCenterState.selectedId ?? ""}`;
  if (els.testHistoryList.dataset.sig === sig) return;
  els.testHistoryList.dataset.sig = sig;
  if (!runs.length) {
    els.testHistoryList.replaceChildren(emptyNote("还没有测试运行。点上方按钮跑一次。"));
    return;
  }
  els.testHistoryList.replaceChildren(
    ...runs.slice(0, 20).map((run) => {
      const active = run.id === testCenterState.selectedId;
      return h(
        "button",
        {
          type: "button",
          class: `test-history-item${active ? " is-active" : ""}`,
          "data-action": "select-test-run",
          "data-run-id": run.id,
          title: testKindLabel(run),
        },
        h(
          "span",
          { class: "test-history-top" },
          h("span", { text: testKindLabel(run) }),
          h("span", {
            class: "test-history-status",
            "data-state": run.status,
            text: testRunStatusLabel(run),
          }),
        ),
        h(
          "span",
          { class: "test-history-meta" },
          h("span", { text: fmtTime(run.startedAt) }),
          h("span", { text: " · " }),
          h("span", { text: formatTestDuration(testRunDuration(run)) }),
          run.exitCode !== undefined ? h("span", { text: ` · 退出 ${run.exitCode}` }) : null,
        ),
      );
    }),
  );
}

function testLogLineNode(line, index) {
  const text = String(line.text ?? "");
  const failed = line.stream === "stderr" && /^\s*✖/.test(text);
  const node = h(
    "div",
    {
      class: `test-line${failed ? " is-fail-line" : ""}${line.system ? " is-system" : ""}`,
      "data-stream": line.stream ?? "stdout",
    },
    h("span", { class: "test-line-no", text: String(index + 1) }),
    h("span", { class: "test-line-text", text }),
  );
  return node;
}

function isTestLogNearBottom() {
  const log = els.testLog;
  if (!log) return true;
  return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
}

function updateTestBackBottom() {
  if (!els.testBackBottom) return;
  const log = els.testLog;
  const overflowing = Boolean(log && log.scrollHeight > log.clientHeight + 8);
  els.testBackBottom.hidden = testCenterState.autoScroll || !overflowing;
}

function renderTestLog(force) {
  const log = els.testLog;
  if (!log) return;
  const run = selectedTestRun();
  const detail = testCenterState.details.get(testCenterState.selectedId);
  const failBtn = els.testFailBtn;
  const failLines = testFailLines(detail?.lines);
  if (failBtn) {
    failBtn.hidden = !(run && run.status !== "running" && failLines.length > 0);
    failBtn.textContent = testCenterState.onlyFailures ? "看全部日志" : "查看失败详情";
    failBtn.classList.toggle("is-active", testCenterState.onlyFailures);
  }
  log.classList.toggle("no-line-numbers", !testCenterState.lineNumbers);
  if (els.testLineNumbers) els.testLineNumbers.checked = testCenterState.lineNumbers;

  const lines = detail?.lines ?? [];
  if (!detail) {
    log.replaceChildren();
    testCenterState.rendered = { runId: "", count: 0, filter: false, lineNumbers: testCenterState.lineNumbers };
    if (els.testLogHint) {
      els.testLogHint.textContent = testCenterState.detailLoading ? "读取日志…" : "";
    }
    updateTestBackBottom();
    return;
  }

  const shouldRebuild =
    force ||
    testCenterState.onlyFailures ||
    testCenterState.rendered.runId !== detail.id ||
    testCenterState.rendered.filter !== testCenterState.onlyFailures ||
    testCenterState.rendered.lineNumbers !== testCenterState.lineNumbers ||
    testCenterState.rendered.count > lines.length;

  const visibleLines = testCenterState.onlyFailures
    ? lines.filter((line) => line.stream === "stderr" && /^\s*✖/.test(String(line.text ?? "")))
    : lines;
  const nearBottom = isTestLogNearBottom();

  if (shouldRebuild) {
    log.replaceChildren();
    testCenterState.rendered = {
      runId: detail.id,
      count: lines.length,
      filter: testCenterState.onlyFailures,
      lineNumbers: testCenterState.lineNumbers,
    };
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < visibleLines.length; index += 1) {
      const line = visibleLines[index];
      const sourceIndex = lines.indexOf(line);
      fragment.appendChild(testLogLineNode(line, sourceIndex >= 0 ? sourceIndex : index));
    }
    log.appendChild(fragment);
    log.scrollTop = log.scrollHeight;
    testCenterState.autoScroll = true;
  } else {
    const start = testCenterState.rendered.count;
    if (start < lines.length) {
      const shouldStick = testCenterState.autoScroll || nearBottom;
      const fragment = document.createDocumentFragment();
      for (let index = start; index < lines.length; index += 1) {
        fragment.appendChild(testLogLineNode(lines[index], index));
      }
      log.appendChild(fragment);
      testCenterState.rendered.count = lines.length;
      if (shouldStick) {
        log.scrollTop = log.scrollHeight;
        testCenterState.autoScroll = true;
      }
    }
  }
  if (els.testLogHint) {
    const filterText = testCenterState.onlyFailures ? ` · 仅失败行 ${visibleLines.length}` : "";
    els.testLogHint.textContent = `${lines.length} 行${filterText} · ${testCenterState.autoScroll ? "自动滚动" : "已暂停滚动"} · 最多保留 2000 行`;
  }
  updateTestBackBottom();
}

function scrollTestLogToBottom() {
  const log = els.testLog;
  if (!log) return;
  log.scrollTop = log.scrollHeight;
  testCenterState.autoScroll = true;
  updateTestBackBottom();
  if (els.testLogHint) {
    const lines = testCenterState.details.get(testCenterState.selectedId)?.lines?.length ?? 0;
    els.testLogHint.textContent = `${lines} 行 · 自动滚动 · 最多保留 2000 行`;
  }
}

// ── 任务 Git（分支 / diff / commit / 回滚） ────────────────────────────

function shortHash(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 8) : "";
}

function taskGitSignature(task) {
  const workspace = currentWorkspace();
  return [
    app.roomId,
    task?.id ?? "",
    task?.updatedAt ?? "",
    task?.git?.branch ?? "",
    task?.git?.baseBranch ?? "",
    task?.git?.commit ?? "",
    task?.git?.committedAt ?? "",
    task?.git?.stashedAt ?? "",
    task?.git?.error ?? "",
    workspace?.id ?? "",
    workspace?.policy ?? "",
  ].join("|");
}

function clearTaskGitState() {
  taskGitState.taskId = null;
  taskGitState.sig = "";
  taskGitState.info = null;
  taskGitState.error = "";
  taskGitState.available = null;
  taskGitState.requestId += 1;
}

function ensureTaskGitDiff(task) {
  const workspace = currentWorkspace();
  if (!workspace?.isGit || !task) return;
  const sig = taskGitSignature(task);
  if (taskGitState.taskId === task.id && taskGitState.sig === sig) return;
  taskGitState.taskId = task.id;
  taskGitState.sig = sig;
  taskGitState.info = null;
  taskGitState.error = "";
  taskGitState.available = null;
  taskGitState.loading = true;
  void fetchTaskGitDiff(task.id);
}

async function fetchTaskGitDiff(taskId) {
  const requestId = ++taskGitState.requestId;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/diff`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 503) {
      throw new Error(`任务 git 服务未就绪（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(await describeHttpError(response, "GET task diff"));
    const payload = await response.json();
    if (requestId !== taskGitState.requestId) return;
    taskGitState.info = payload;
    taskGitState.available = true;
    taskGitState.error = "";
  } catch (error) {
    if (requestId !== taskGitState.requestId) return;
    taskGitState.available = false;
    taskGitState.error = error.message || "任务 git 读取失败";
  } finally {
    if (requestId === taskGitState.requestId) {
      taskGitState.loading = false;
      renderTaskGit();
    }
  }
}

function taskStatusLineCount(status) {
  return String(status ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function taskGitActionState(task, workspace) {
  const git = task?.git ?? {};
  const unavailable = taskGitState.available === false;
  const committed = Boolean(git.commit || git.committedAt);
  const stashed = Boolean(git.stashedAt);
  const readonly = workspace?.policy === "read-only";
  const commitReason = !task
    ? "当前没有任务"
    : readonly
      ? "只读工作区，不能提交"
      : unavailable
        ? "任务 git 服务未就绪，按钮暂时不可用"
        : committed
          ? "任务已提交，不能重复提交"
          : stashed
            ? "任务已回滚，请重新开任务再提交"
            : git.error
              ? "建分支失败，不能提交"
              : !git.branch
                ? "这个任务没有独立分支；请在工作区开启「任务分支」后重新开任务"
                : "";
  const rollbackReason = !task
    ? "当前没有任务"
    : readonly
      ? "只读工作区，不能回滚"
      : unavailable
        ? "任务 git 服务未就绪，按钮暂时不可用"
        : committed
          ? "任务已提交，不能回滚；请手动处理分支"
          : stashed
            ? "任务已经回滚过了"
            : "";
  return {
    diff: !task ? "当前没有任务" : unavailable ? "任务 git 服务未就绪" : "",
    commit: commitReason,
    rollback: rollbackReason,
  };
}

function renderTaskGit() {
  const card = els.taskGitCard;
  if (!card) return;
  const workspace = currentWorkspace();
  if (!workspace?.isGit) {
    card.hidden = true;
    taskGitState.workspaceSig = "";
    clearTaskGitState();
    return;
  }
  card.hidden = false;
  const task = activeTask();
  const git = task?.git ?? {};
  const actions = taskGitActionState(task, workspace);
  const info = taskGitState.taskId === task?.id ? taskGitState.info : null;
  const loading = taskGitState.taskId === task?.id && taskGitState.loading;
  const unavailable = taskGitState.available === false;
  const committed = Boolean(git.commit || git.committedAt);
  const stashed = Boolean(git.stashedAt);
  const readonly = workspace.policy === "read-only";

  const workspaceSig =
    `${workspace.id}|${git.branch ?? ""}|${git.commit ?? ""}|${git.stashedAt ?? ""}|` +
    `${taskGitState.taskId === task?.id ? taskGitState.info?.status ?? "" : ""}`;
  if (taskGitState.workspaceSig !== workspaceSig) {
    taskGitState.workspaceSig = workspaceSig;
    void loadWorkspaceGit(workspace.id, { silent: true });
  }

  let statusText = "—";
  let statusTone = "";
  if (!task) {
    statusText = "没有任务";
  } else if (git.error) {
    statusText = "分支创建失败";
    statusTone = "danger";
  } else if (unavailable) {
    statusText = "git 服务未就绪";
    statusTone = "danger";
  } else if (committed) {
    statusText = `已提交 · ${shortHash(git.commit)}`;
    statusTone = "ok";
  } else if (stashed) {
    statusText = "已回滚（stash 可恢复）";
    statusTone = "warn";
  } else if (readonly) {
    statusText = "只读工作区";
    statusTone = "danger";
  } else if (git.branch) {
    if (loading) {
      statusText = "读取改动…";
    } else {
      const count = taskStatusLineCount(info?.status);
      statusText = count > 0 ? `工作树有改动 · ${count} 个文件` : "工作树干净 · 已建分支";
      statusTone = count > 0 ? "warn" : "ok";
    }
  } else {
    statusText = "没有独立分支";
    statusTone = "warn";
  }

  if (els.taskGitState) {
    els.taskGitState.textContent = statusText;
    els.taskGitState.dataset.tone = statusTone;
  }

  const body = els.taskGitBody;
  if (!body) return;
  if (!task) {
    body.replaceChildren(emptyNote("当前任务还没有 git 信息。"));
  } else {
    const rows = [];
    if (git.branch) {
      rows.push(
        h(
          "div",
          { class: "task-git-branch" },
          h("span", { class: "task-git-label", text: "任务分支" }),
          h("code", { text: git.branch }),
          h("button", {
            type: "button",
            class: "task-git-copy",
            "data-action": "copy-task-git",
            "data-copy-text": git.branch,
            "data-copy-label": "任务分支",
            text: "复制",
            title: "复制分支名",
          }),
        ),
      );
    }
    if (git.baseBranch || git.baseCommit) {
      rows.push(
        h(
          "div",
          { class: "task-git-branch" },
          h("span", { class: "task-git-label", text: "base" }),
          h("code", {
            text: git.baseBranch ?? "—",
            title: git.baseCommit ? `base commit ${git.baseCommit}` : "",
          }),
          git.baseCommit
            ? h("span", { class: "task-git-label", text: shortHash(git.baseCommit) })
            : null,
        ),
      );
    }
    if (git.commit) {
      rows.push(
        h(
          "div",
          { class: "task-git-branch" },
          h("span", { class: "task-git-label", text: "commit" }),
          h("code", { text: shortHash(git.commit), title: git.commit }),
          h("button", {
            type: "button",
            class: "task-git-copy",
            "data-action": "copy-task-git",
            "data-copy-text": git.commit,
            "data-copy-label": "commit hash",
            text: "复制",
            title: "复制完整 hash",
          }),
        ),
      );
    }
    rows.push(h("span", { class: "task-git-status", "data-tone": statusTone, text: statusText }));
    if (git.error) {
      rows.push(h("p", { class: "task-git-hint", "data-tone": "danger", text: `⚠ ${git.error}` }));
    }
    if (readonly) {
      rows.push(
        h("p", {
          class: "task-git-hint",
          "data-tone": "danger",
          text: "只读工作区，不能提交/回滚；可以查看 diff 和文件。",
        }),
      );
    } else if (unavailable) {
      rows.push(
        h("p", {
          class: "task-git-hint",
          "data-tone": "danger",
          text: taskGitState.error || "任务 git 服务未就绪（接口 404/503）。",
        }),
      );
    } else if (stashed) {
      rows.push(
        h("p", {
          class: "task-git-hint",
          text: "改动已收进 git stash，可用 git stash list 找回。",
        }),
      );
    }
    body.replaceChildren(...rows);
  }

  if (els.taskDiffBtn) {
    els.taskDiffBtn.disabled = Boolean(actions.diff);
    els.taskDiffBtn.title = actions.diff || "查看任务 diff";
  }
  if (els.taskCommitBtn) {
    els.taskCommitBtn.disabled = Boolean(actions.commit);
    els.taskCommitBtn.title = actions.commit || "提交到任务分支";
  }
  if (els.taskRollbackBtn) {
    els.taskRollbackBtn.disabled = Boolean(actions.rollback);
    els.taskRollbackBtn.title = actions.rollback || "回滚任务改动（stash）";
  }
  if (els.taskGitHint) {
    const hint = unavailable
      ? taskGitState.error || "任务 git 服务未就绪（接口 404/503），按钮暂时不可用。"
      : actions.commit ||
        actions.rollback ||
        templateTaskGitHint(task, git, workspace);
    els.taskGitHint.hidden = !hint;
    els.taskGitHint.textContent = hint || "";
    els.taskGitHint.dataset.tone =
      actions.commit || actions.rollback ? "danger" : "muted";
  }

  ensureTaskGitDiff(task);
}

function templateTaskGitHint(task, git, workspace) {
  if (!task) return "当前房间没有进行中的任务。";
  if (workspace?.policy === "read-only") return "只读工作区，不能提交/回滚。";
  if (git?.commit) return "已提交：任务分支保留，请人工 review / merge。";
  if (git?.stashedAt) return "已回滚：改动在 git stash 中，可手动恢复。";
  if (git?.branch && !git?.error) return "";
  return "";
}

async function fetchTaskDiffModal(taskId) {
  const requestId = ++taskDiffModal.requestId;
  taskDiffModal.loading = true;
  taskDiffModal.error = "";
  renderTaskDiffModal();
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/diff`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 503) {
      throw new Error(`任务 git 服务未就绪（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(await describeHttpError(response, "GET task diff"));
    const payload = await response.json();
    if (requestId !== taskDiffModal.requestId) return;
    taskDiffModal.info = payload;
  } catch (error) {
    if (requestId !== taskDiffModal.requestId) return;
    taskDiffModal.info = null;
    taskDiffModal.error = error.message || "任务 diff 读取失败";
  } finally {
    if (requestId === taskDiffModal.requestId) {
      taskDiffModal.loading = false;
      renderTaskDiffModal();
    }
  }
}

function openTaskDiffModal() {
  const task = activeTask();
  if (!task) {
    toast("当前没有任务", "warn");
    return;
  }
  taskDiffModal.taskId = task.id;
  taskDiffModal.info = null;
  taskDiffModal.error = "";
  taskDiffModal.loading = true;
  if (els.taskDiffTitle) els.taskDiffTitle.textContent = `任务 Diff · ${task.title}`;
  renderTaskDiffModal();
  if (!els.taskDiffModal?.open) els.taskDiffModal?.showModal();
  void fetchTaskDiffModal(task.id);
}

function closeTaskDiffModal() {
  if (els.taskDiffModal?.open) els.taskDiffModal.close();
}

function renderTaskDiffModal() {
  const task = taskById(taskDiffModal.taskId);
  if (els.taskDiffSub) {
    els.taskDiffSub.textContent = task
      ? `${task.title} · 只读查看；已提交看 base...branch，否则看工作树。`
      : "只读查看任务分支或工作树的改动。";
  }
  if (els.taskDiffRefresh) els.taskDiffRefresh.disabled = taskDiffModal.loading;
  if (els.taskDiffError) {
    els.taskDiffError.hidden = !taskDiffModal.error;
    els.taskDiffError.textContent = taskDiffModal.error || "";
  }
  const info = taskDiffModal.info;
  if (els.taskDiffMeta) {
    const nodes = [];
    if (info?.branch) nodes.push(h("span", { class: "git-branch", text: info.branch }));
    if (info?.base) nodes.push(h("span", { text: `base ${info.base}` }));
    const count = taskStatusLineCount(info?.status);
    if (info && !info.error) nodes.push(h("span", { text: `${count} 个改动文件` }));
    if (info?.error) nodes.push(h("span", { class: "workspace-warning", text: info.error }));
    els.taskDiffMeta.replaceChildren(...nodes);
  }
  if (els.taskDiffStatus) {
    els.taskDiffStatus.textContent = taskDiffModal.loading
      ? "读取中…"
      : info?.status
        ? info.status
        : "（没有改动）";
  }
  if (els.taskDiffPre) {
    els.taskDiffPre.textContent = taskDiffModal.loading
      ? "读取 diff…"
      : info?.error
        ? info.error
        : info?.diff
          ? info.diff
          : "没有改动";
  }
}

function openTaskCommitModal() {
  const task = activeTask();
  if (!task) {
    toast("当前没有任务", "warn");
    return;
  }
  const actions = taskGitActionState(task, currentWorkspace());
  if (actions.commit) {
    toast(actions.commit, "warn");
    return;
  }
  taskCommitModal.taskId = task.id;
  taskCommitModal.saving = false;
  if (els.taskCommitSub) {
    els.taskCommitSub.textContent = task.git?.branch
      ? `提交到 ${task.git.branch}；提交后切回 base，不会自动合并。`
      : "提交到当前任务分支；不会自动合并到 base。";
  }
  if (els.taskCommitMessage) els.taskCommitMessage.value = "";
  if (els.taskCommitConfirm) els.taskCommitConfirm.checked = false;
  hideTaskCommitError();
  updateTaskCommitState();
  if (!els.taskCommitModal?.open) els.taskCommitModal?.showModal();
  requestAnimationFrame(() => els.taskCommitMessage?.focus());
}

function closeTaskCommitModal() {
  if (els.taskCommitModal?.open) els.taskCommitModal.close();
}

function hideTaskCommitError() {
  if (!els.taskCommitError) return;
  els.taskCommitError.hidden = true;
  els.taskCommitError.textContent = "";
}

function showTaskCommitError(message) {
  if (!els.taskCommitError) return;
  els.taskCommitError.textContent = message;
  els.taskCommitError.hidden = false;
}

function updateTaskCommitState() {
  if (!els.taskCommitSubmit) return;
  const message = els.taskCommitMessage?.value.trim() ?? "";
  const confirmed = Boolean(els.taskCommitConfirm?.checked);
  const valid = message.length >= 1 && message.length <= 200 && confirmed;
  els.taskCommitSubmit.disabled = taskCommitModal.saving || !valid;
  els.taskCommitSubmit.textContent = taskCommitModal.saving ? "提交中…" : "提交到任务分支";
}

function applyUpdatedTask(updatedTask) {
  if (!updatedTask?.id || !app.state) return;
  const tasks = app.state.tasks ?? [];
  const index = tasks.findIndex((task) => task.id === updatedTask.id);
  if (index >= 0) tasks[index] = updatedTask;
  clearTaskGitState();
  renderAll();
}

async function submitTaskCommit(event) {
  event.preventDefault();
  if (taskCommitModal.saving) return;
  const taskId = taskCommitModal.taskId;
  const message = els.taskCommitMessage?.value.trim() ?? "";
  if (!message || message.length > 200) {
    showTaskCommitError("Commit message 需要 1–200 个字符。");
    els.taskCommitMessage?.focus();
    return;
  }
  if (!els.taskCommitConfirm?.checked) {
    showTaskCommitError("请先勾选确认。");
    return;
  }
  taskCommitModal.saving = true;
  updateTaskCommitState();
  hideTaskCommitError();
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, confirm: true }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const payload = await response.json();
    closeTaskCommitModal();
    toast(`已提交 ${shortHash(payload?.commit)}`);
    if (payload?.task) applyUpdatedTask(payload.task);
    await refreshState().catch(() => {});
    clearTaskGitState();
    renderAll();
  } catch (error) {
    showTaskCommitError(`提交失败：${error.message}`);
  } finally {
    taskCommitModal.saving = false;
    updateTaskCommitState();
  }
}

function openTaskRollbackModal() {
  const task = activeTask();
  if (!task) {
    toast("当前没有任务", "warn");
    return;
  }
  const actions = taskGitActionState(task, currentWorkspace());
  if (actions.rollback) {
    toast(actions.rollback, "warn");
    return;
  }
  taskRollbackModal.taskId = task.id;
  taskRollbackModal.saving = false;
  hideTaskRollbackError();
  if (els.taskRollbackInfo) {
    const nodes = [];
    if (task.git?.branch) nodes.push(h("span", { class: "git-branch", text: task.git.branch }));
    if (task.git?.baseBranch) nodes.push(h("span", { text: `base ${task.git.baseBranch}` }));
    nodes.push(h("span", { text: "改动会进入 git stash，可恢复" }));
    els.taskRollbackInfo.replaceChildren(...nodes);
  }
  if (els.taskRollbackConfirm) {
    els.taskRollbackConfirm.disabled = false;
    els.taskRollbackConfirm.textContent = "确认回滚";
  }
  if (!els.taskRollbackModal?.open) els.taskRollbackModal?.showModal();
}

function closeTaskRollbackModal() {
  if (els.taskRollbackModal?.open) els.taskRollbackModal.close();
}

function hideTaskRollbackError() {
  if (!els.taskRollbackError) return;
  els.taskRollbackError.hidden = true;
  els.taskRollbackError.textContent = "";
}

function showTaskRollbackError(message) {
  if (!els.taskRollbackError) return;
  els.taskRollbackError.textContent = message;
  els.taskRollbackError.hidden = false;
}

async function confirmTaskRollback() {
  if (taskRollbackModal.saving) return;
  const taskId = taskRollbackModal.taskId;
  taskRollbackModal.saving = true;
  hideTaskRollbackError();
  if (els.taskRollbackConfirm) {
    els.taskRollbackConfirm.disabled = true;
    els.taskRollbackConfirm.textContent = "回滚中…";
  }
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const payload = await response.json();
    closeTaskRollbackModal();
    toast(payload?.stash ? `已回滚，改动收进 ${payload.stash}` : payload?.note || "已回滚");
    if (payload?.task) applyUpdatedTask(payload.task);
    await refreshState().catch(() => {});
    clearTaskGitState();
    renderAll();
  } catch (error) {
    showTaskRollbackError(`回滚失败：${error.message}`);
  } finally {
    taskRollbackModal.saving = false;
    if (els.taskRollbackConfirm) {
      els.taskRollbackConfirm.disabled = false;
      els.taskRollbackConfirm.textContent = "确认回滚";
    }
  }
}

async function copyTaskGitText(text, label) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${label ?? "内容"}`);
    return;
  } catch {
    /* 降级 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("copy failed");
    toast(`已复制${label ?? "内容"}`);
  } catch {
    toast("复制失败，请手动选择文本", "error");
  }
}

// ── 工具目录 / 来源徽标 ─────────────────────────────────────────────────

const BUILTIN_TOOL_NAMES = Object.keys(TOOL_META);

function toolSourceInfo(toolName) {
  if (!toolName) return null;
  const def = (app.toolCatalog ?? []).find((tool) => tool.name === toolName);
  if (def?.source === "mcp") {
    const server = def.serverId ? ` · ${def.serverId}` : "";
    return { kind: "mcp", label: `MCP${server}`, title: `来自 MCP server${def.serverId ? `：${def.serverId}` : ""}` };
  }
  if (def?.source === "sandbox" || BUILTIN_TOOL_NAMES.includes(toolName)) {
    return { kind: "sandbox", label: "沙盒", title: "内置沙盒工具" };
  }
  return null;
}

async function loadToolCatalog() {
  try {
    const response = await fetch("/api/tools", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await describeHttpError(response, "GET /api/tools"));
    const payload = await response.json();
    app.toolCatalog = Array.isArray(payload?.tools) ? payload.tools : [];
  } catch {
    app.toolCatalog = [];
  }
  updateAllToolSourceBadges();
}

function updateAllToolSourceBadges() {
  if (!els.timeline) return;
  for (const card of $$(".tool-card[data-tool-call-id]", els.timeline)) {
    const call = toolCallById(card.dataset.toolCallId);
    if (call) updateToolCard(card, call);
  }
}

// ── 设置 · MCP 工具管理 ────────────────────────────────────────────────

function setMcpStatus(message) {
  if (els.mcpStatus) els.mcpStatus.textContent = message;
}

async function loadMcp() {
  if (mcpState.loading) return;
  mcpState.loading = true;
  if (!mcpState.loaded) setMcpStatus("读取 MCP 配置…");
  renderMcpList();
  try {
    const response = await fetch("/api/mcp", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 503 || response.status === 404) {
      throw new Error("MCP 服务未就绪");
    }
    if (!response.ok) throw new Error(await describeHttpError(response, "GET /api/mcp"));
    const payload = await response.json();
    mcpState.servers = Array.isArray(payload?.servers) ? payload.servers : [];
    mcpState.available = true;
    mcpState.error = "";
    mcpState.loaded = true;
    setMcpStatus(`${mcpState.servers.length} 个 MCP server`);
  } catch (error) {
    mcpState.available = false;
    mcpState.error = error.message || "MCP 服务未就绪";
    mcpState.servers = [];
    mcpState.loaded = true;
    setMcpStatus("MCP 服务未就绪");
  } finally {
    mcpState.loading = false;
    renderMcpList();
  }
}

function renderMcpList() {
  const host = els.mcpList;
  if (!host) return;

  if (mcpState.loading && !mcpState.loaded) {
    host.replaceChildren(emptyNote("读取 MCP 配置…"));
    return;
  }
  if (mcpState.available === false) {
    host.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "MCP 服务未就绪" }),
        h("span", {
          text:
            mcpState.error && mcpState.error !== "MCP 服务未就绪"
              ? mcpState.error
              : "接口 503 / 404；服务端启用 MCP 后可以重试。",
        }),
        h("button", {
          type: "button",
          class: "btn btn--ghost btn--tiny",
          "data-action": "reload-mcp",
          text: "↻ 重试",
        }),
      ),
    );
    return;
  }
  if (!mcpState.servers.length) {
    host.replaceChildren(
      emptyNote("还没有 MCP server。点「＋ 添加 MCP Server」接入本地进程或 HTTP 服务。"),
    );
    return;
  }
  host.replaceChildren(...mcpState.servers.map((server) => mcpRow(server)));
}

const MCP_STATUS_LABEL = {
  connected: "已连接",
  error: "连接错误",
  disconnected: "已停用",
  connecting: "连接中",
};

function mcpRow(server) {
  const busy = mcpState.busy[server.id] || "";
  const result = mcpState.results[server.id];
  const confirming = mcpState.deleteConfirmId === server.id;
  const statusLabel = MCP_STATUS_LABEL[server.status] ?? server.status;
  const risk = server.risk ?? "needs_approval";
  const meta =
    server.transport === "stdio"
      ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
      : server.url ?? "";

  const actions = h("span", { class: "mcp-actions" });
  if (confirming) {
    actions.append(
      h(
        "span",
        { class: "mcp-confirm" },
        h("span", { text: "删除后工具会立刻下线，确认？" }),
        h("button", {
          type: "button",
          class: "btn btn--tiny btn--danger",
          "data-action": "confirm-delete-mcp",
          "data-id": server.id,
          text: "确认删除",
        }),
        h("button", {
          type: "button",
          class: "btn btn--tiny btn--ghost",
          "data-action": "cancel-delete-mcp",
          text: "取消",
        }),
      ),
    );
  } else {
    actions.append(
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--ghost",
        "data-action": "toggle-mcp",
        "data-id": server.id,
        "data-enabled": String(server.enabled),
        disabled: Boolean(busy),
        text: busy === "toggle" ? "处理中…" : server.enabled ? "停用" : "启用",
      }),
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--ghost",
        "data-action": "test-mcp",
        "data-id": server.id,
        disabled: Boolean(busy),
        text: busy === "test" ? "测试中…" : "测试",
      }),
      h("button", {
        type: "button",
        class: "btn btn--tiny btn--danger",
        "data-action": "delete-mcp",
        "data-id": server.id,
        text: "删除",
      }),
    );
  }

  return h(
    "div",
    {
      class: `mcp-row${server.status === "error" ? " is-error" : ""}`,
      "data-mcp-id": server.id,
    },
    h(
      "div",
      { class: "mcp-head" },
      h("span", {
        class: "mcp-status-dot",
        "data-state": server.status,
        title: statusLabel,
        "aria-label": statusLabel,
      }),
      h("span", { class: "mcp-name", text: server.name }),
      h("span", { class: "mcp-badge", text: server.transport }),
      h("span", {
        class: "mcp-badge",
        "data-kind": "risk",
        "data-risk": risk,
        text: risk === "safe" ? "安全" : "需审批",
      }),
      h("span", {
        class: "mcp-tool-count",
        text: `${server.toolCount ?? 0} 个工具 · ${statusLabel}`,
      }),
      actions,
    ),
    meta ? h("p", { class: "mcp-meta", text: meta }) : null,
    server.lastError ? h("p", { class: "mcp-last-error", text: server.lastError }) : null,
    result ? h("p", { class: "mcp-result", "data-tone": result.tone, text: result.text }) : null,
  );
}

function openMcpForm() {
  mcpState.formOpen = true;
  if (els.mcpForm) els.mcpForm.hidden = false;
  if (els.mcpFormToggle) els.mcpFormToggle.textContent = "－ 收起表单";
  hideMcpFormError();
  requestAnimationFrame(() => els.mcpName?.focus());
}

function closeMcpForm() {
  mcpState.formOpen = false;
  if (els.mcpForm) els.mcpForm.hidden = true;
  if (els.mcpFormToggle) els.mcpFormToggle.textContent = "＋ 添加 MCP Server";
  if (els.mcpName) els.mcpName.value = "";
  if (els.mcpCommand) els.mcpCommand.value = "";
  if (els.mcpArgs) els.mcpArgs.value = "";
  if (els.mcpUrl) els.mcpUrl.value = "";
  if (els.mcpRisk) els.mcpRisk.value = "needs_approval";
  if (els.mcpEnabled) els.mcpEnabled.checked = true;
  if (els.mcpTransport) els.mcpTransport.value = "stdio";
  updateMcpTransportFields();
  hideMcpFormError();
}

function updateMcpTransportFields() {
  const transport = els.mcpTransport?.value ?? "stdio";
  if (els.mcpStdioFields) els.mcpStdioFields.hidden = transport !== "stdio";
  if (els.mcpHttpFields) els.mcpHttpFields.hidden = transport !== "http";
}

function showMcpFormError(message) {
  if (!els.mcpFormError) return;
  els.mcpFormError.textContent = message;
  els.mcpFormError.hidden = false;
}

function hideMcpFormError() {
  if (!els.mcpFormError) return;
  els.mcpFormError.hidden = true;
  els.mcpFormError.textContent = "";
}

async function saveMcpServer() {
  if (mcpState.saving) return;
  hideMcpFormError();
  const name = els.mcpName?.value.trim() ?? "";
  const transport = els.mcpTransport?.value === "http" ? "http" : "stdio";
  if (!name) {
    showMcpFormError("先给 MCP server 起个名字。");
    els.mcpName?.focus();
    return;
  }
  const body = {
    name,
    transport,
    risk: els.mcpRisk?.value === "safe" ? "safe" : "needs_approval",
    enabled: els.mcpEnabled ? Boolean(els.mcpEnabled.checked) : true,
  };
  if (transport === "stdio") {
    const command = els.mcpCommand?.value.trim() ?? "";
    if (!command) {
      showMcpFormError("stdio server 需要填 command（例如 node）。");
      els.mcpCommand?.focus();
      return;
    }
    body.command = command;
    body.args = String(els.mcpArgs?.value ?? "")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  } else {
    const url = els.mcpUrl?.value.trim() ?? "";
    if (!/^https?:\/\//i.test(url)) {
      showMcpFormError("http server 需要以 http:// 或 https:// 开头的 URL。");
      els.mcpUrl?.focus();
      return;
    }
    body.url = url;
  }

  mcpState.saving = true;
  if (els.mcpSaveBtn) {
    els.mcpSaveBtn.disabled = true;
    els.mcpSaveBtn.textContent = "保存中…";
  }
  try {
    const response = await fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await describeHttpError(response, "POST /api/mcp"));
    const payload = await response.json();
    const server = payload?.server;
    toast(`MCP server「${server?.name ?? name}」已${server?.enabled === false ? "添加" : "连接"}`);
    closeMcpForm();
    await loadMcp();
    void loadToolCatalog();
  } catch (error) {
    showMcpFormError(`添加失败：${error.message}`);
  } finally {
    mcpState.saving = false;
    if (els.mcpSaveBtn) {
      els.mcpSaveBtn.disabled = false;
      els.mcpSaveBtn.textContent = "保存 MCP Server";
    }
  }
}

async function testMcpServer(serverId) {
  if (mcpState.busy[serverId]) return;
  mcpState.busy[serverId] = "test";
  delete mcpState.results[serverId];
  renderMcpList();
  try {
    const response = await fetch(`/api/mcp/${encodeURIComponent(serverId)}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error ?? `POST /api/mcp/${serverId}/test → HTTP ${response.status}`);
    }
    const tools = Array.isArray(payload?.tools) ? payload.tools : [];
    if (payload?.ok === false || payload?.error) {
      mcpState.results[serverId] = { tone: "error", text: `✗ ${payload?.error ?? "连接失败"}` };
    } else {
      const names = tools.slice(0, 3).map((tool) => tool.name).filter(Boolean).join("、");
      mcpState.results[serverId] = {
        tone: "ok",
        text: `✓ 连接成功 · ${tools.length} 个工具${names ? `（${names}${tools.length > 3 ? "…" : ""}）` : ""}`,
      };
    }
  } catch (error) {
    mcpState.results[serverId] = { tone: "error", text: `✗ 测试失败：${error.message}` };
  } finally {
    delete mcpState.busy[serverId];
    renderMcpList();
  }
}

async function toggleMcpServer(serverId, enabled) {
  if (mcpState.busy[serverId]) return;
  mcpState.busy[serverId] = "toggle";
  renderMcpList();
  try {
    const response = await fetch(`/api/mcp/${encodeURIComponent(serverId)}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? `POST /api/mcp/${serverId}/toggle → HTTP ${response.status}`);
    }
    toast(`MCP server 已${enabled ? "启用" : "停用"}`);
    await loadMcp();
    void loadToolCatalog();
  } catch (error) {
    mcpState.results[serverId] = { tone: "error", text: `✗ 切换失败：${error.message}` };
    renderMcpList();
  } finally {
    delete mcpState.busy[serverId];
    renderMcpList();
  }
}

function askDeleteMcp(serverId) {
  mcpState.deleteConfirmId = serverId;
  renderMcpList();
}

async function confirmDeleteMcp(serverId) {
  if (mcpState.busy[serverId]) return;
  mcpState.deleteConfirmId = "";
  mcpState.busy[serverId] = "delete";
  renderMcpList();
  try {
    const response = await fetch(`/api/mcp/${encodeURIComponent(serverId)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? `DELETE /api/mcp/${serverId} → HTTP ${response.status}`);
    }
    toast("MCP server 已删除");
    await loadMcp();
    void loadToolCatalog();
  } catch (error) {
    mcpState.results[serverId] = { tone: "error", text: `✗ 删除失败：${error.message}` };
    renderMcpList();
  } finally {
    delete mcpState.busy[serverId];
    renderMcpList();
  }
}

// ── 每猫工具权限 / 技能 ────────────────────────────────────────────────

function openCatAccess(catId) {
  const cat = catById(catId);
  if (!cat || !els.catAccessModal) return;

  catAccessState.catId = catId;
  catAccessState.tools = [];
  catAccessState.skills = [];
  catAccessState.selectedTools = new Set();
  catAccessState.selectedSkills = new Set();
  catAccessState.loading = true;
  catAccessState.saving = false;
  catAccessState.toolsError = "";
  catAccessState.skillsError = "";

  if (els.catAccessSub) {
    els.catAccessSub.textContent = `${cat.name} · ${cat.species} · 配置它能使用的工具与技能包。`;
  }
  hideCatAccessError();
  updateCatAccessCounts();
  updateCatAccessSave();
  renderCatAccessLists();
  if (!els.catAccessModal.open) els.catAccessModal.showModal();
  void loadCatAccessCatalogs(cat);
}

async function loadCatAccessCatalogs(cat) {
  const [toolsResult, skillsResult] = await Promise.allSettled([
    fetchJson("/api/tools", "GET /api/tools"),
    fetchJson("/api/skills", "GET /api/skills"),
  ]);

  if (toolsResult.status === "fulfilled") {
    catAccessState.tools = Array.isArray(toolsResult.value?.tools) ? toolsResult.value.tools : [];
    app.toolCatalog = catAccessState.tools;
  } else {
    catAccessState.tools = [];
    catAccessState.toolsError = toolsResult.reason?.message ?? "工具目录未就绪";
  }
  if (skillsResult.status === "fulfilled") {
    catAccessState.skills = Array.isArray(skillsResult.value?.skills) ? skillsResult.value.skills : [];
    app.skillCatalog = catAccessState.skills;
  } else {
    catAccessState.skills = [];
    catAccessState.skillsError = skillsResult.reason?.message ?? "技能目录未就绪";
  }

  const catalogToolNames = catAccessState.tools.map((tool) => tool.name);
  const toolNames = new Set(catalogToolNames);
  if (Array.isArray(cat.tools)) {
    for (const name of cat.tools) toolNames.add(name);
    catAccessState.selectedTools = new Set(cat.tools.filter((name) => typeof name === "string"));
  } else {
    catAccessState.selectedTools = new Set(catalogToolNames);
  }

  const catalogSkillIds = catAccessState.skills.map((skill) => skill.id);
  const skillIds = new Set(catalogSkillIds);
  if (Array.isArray(cat.skills)) {
    for (const id of cat.skills) skillIds.add(id);
    catAccessState.selectedSkills = new Set(cat.skills.filter((id) => typeof id === "string"));
  } else {
    catAccessState.selectedSkills = new Set();
  }

  catAccessState.loading = false;
  renderCatAccessLists();
  updateCatAccessCounts();
  updateCatAccessSave();
  updateAllToolSourceBadges();
}

function renderCatAccessLists() {
  renderCatAccessTools();
  renderCatAccessSkills();
  updateCatAccessCounts();
}

function renderCatAccessTools() {
  const host = els.catAccessTools;
  if (!host) return;
  if (catAccessState.loading) {
    host.replaceChildren(emptyNote("读取工具目录…"));
    return;
  }
  if (catAccessState.toolsError) {
    host.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "工具目录未就绪" }),
        h("span", { text: catAccessState.toolsError }),
      ),
    );
    return;
  }

  const catalog = catAccessState.tools;
  const catalogNames = new Set(catalog.map((tool) => tool.name));
  const stale = [...catAccessState.selectedTools].filter((name) => !catalogNames.has(name));
  const groups = [];

  const sandboxTools = catalog.filter((tool) => tool.source !== "mcp");
  if (sandboxTools.length) groups.push({ label: "沙盒工具", items: sandboxTools });

  const mcpTools = catalog.filter((tool) => tool.source === "mcp");
  if (mcpTools.length) {
    const byServer = new Map();
    for (const tool of mcpTools) {
      const key = tool.serverId ?? "mcp";
      if (!byServer.has(key)) byServer.set(key, []);
      byServer.get(key).push(tool);
    }
    for (const [serverId, items] of byServer) {
      groups.push({ label: `MCP · ${serverId}`, items });
    }
  }

  if (stale.length) {
    groups.push({
      label: "已下线工具",
      items: stale.map((name) => ({
        name,
        title: name,
        description: "当前工具目录里已不存在；取消勾选后保存即可移除。",
        risk: "needs_approval",
        source: "unknown",
      })),
    });
  }

  if (!groups.length) {
    host.replaceChildren(emptyNote("工具目录是空的。"));
    return;
  }

  const nodes = [];
  for (const group of groups) {
    nodes.push(h("div", { class: "access-group-label", text: group.label }));
    for (const tool of group.items) {
      const source =
        tool.source === "mcp"
          ? `MCP${tool.serverId ? ` · ${tool.serverId}` : ""}`
          : tool.source === "unknown"
            ? "已下线"
            : "沙盒";
      nodes.push(
        h(
          "label",
          { class: "access-item" },
          h("input", {
            type: "checkbox",
            "data-tool-name": tool.name,
            checked: catAccessState.selectedTools.has(tool.name),
          }),
          h(
            "span",
            { class: "access-item-main" },
            h(
              "span",
              { class: "access-item-name" },
              h("span", { text: tool.title || tool.name }),
              h("span", {
                class: "tool-source",
                "data-source": tool.source === "mcp" ? "mcp" : "sandbox",
                text: source,
              }),
              h("span", {
                class: "mcp-badge",
                "data-kind": "risk",
                "data-risk": tool.risk ?? "needs_approval",
                text: (tool.risk ?? "needs_approval") === "safe" ? "安全" : "需审批",
              }),
            ),
            h("span", { class: "access-item-desc", text: tool.description || "" }),
            h("span", { class: "access-item-desc", text: tool.name }),
          ),
        ),
      );
    }
  }
  host.replaceChildren(...nodes);
}

function renderCatAccessSkills() {
  const host = els.catAccessSkills;
  if (!host) return;
  if (catAccessState.loading) {
    host.replaceChildren(emptyNote("读取技能包…"));
    return;
  }
  if (catAccessState.skillsError) {
    host.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "技能目录未就绪" }),
        h("span", { text: catAccessState.skillsError }),
      ),
    );
    return;
  }

  const catalog = catAccessState.skills;
  const catalogIds = new Set(catalog.map((skill) => skill.id));
  const stale = [...catAccessState.selectedSkills].filter((id) => !catalogIds.has(id));
  const items = [
    ...catalog.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      stale: false,
    })),
    ...stale.map((id) => ({
      id,
      name: id,
      description: "当前技能目录里不存在；取消勾选后保存即可移除。",
      stale: true,
    })),
  ];

  if (!items.length) {
    host.replaceChildren(emptyNote("技能包目录是空的。"));
    return;
  }

  host.replaceChildren(
    ...items.map((skill) =>
      h(
        "label",
        { class: "access-item" },
        h("input", {
          type: "checkbox",
          "data-skill-id": skill.id,
          checked: catAccessState.selectedSkills.has(skill.id),
        }),
        h(
          "span",
          { class: "access-item-main" },
          h(
            "span",
            { class: "access-item-name" },
            h("span", { text: skill.name }),
            skill.stale
              ? h("span", { class: "tool-source", "data-source": "sandbox", text: "已下线" })
              : null,
          ),
          h("span", { class: "access-item-desc", text: skill.description || "" }),
        ),
      ),
    ),
  );
}

function updateCatAccessCounts() {
  const totalTools = new Set([
    ...catAccessState.tools.map((tool) => tool.name),
    ...catAccessState.selectedTools,
  ]).size;
  const totalSkills = new Set([
    ...catAccessState.skills.map((skill) => skill.id),
    ...catAccessState.selectedSkills,
  ]).size;
  if (els.catAccessToolsCount) {
    els.catAccessToolsCount.textContent = `${catAccessState.selectedTools.size} / ${totalTools}`;
  }
  if (els.catAccessSkillsCount) {
    els.catAccessSkillsCount.textContent = `${catAccessState.selectedSkills.size} / ${totalSkills}`;
  }
}

function updateCatAccessSave() {
  if (!els.catAccessSave) return;
  const blocked = catAccessState.loading ||
    Boolean(catAccessState.toolsError) ||
    Boolean(catAccessState.skillsError);
  els.catAccessSave.disabled = Boolean(catAccessState.saving) || blocked;
  els.catAccessSave.textContent = catAccessState.saving ? "保存中…" : "保存权限";
}

function showCatAccessError(message) {
  if (!els.catAccessError) return;
  els.catAccessError.textContent = message;
  els.catAccessError.hidden = false;
}

function hideCatAccessError() {
  if (!els.catAccessError) return;
  els.catAccessError.hidden = true;
  els.catAccessError.textContent = "";
}

function closeCatAccess() {
  if (els.catAccessModal?.open) els.catAccessModal.close();
}

async function saveCatAccess() {
  if (catAccessState.saving) return;
  const cat = catById(catAccessState.catId);
  if (!cat) return;
  if (catAccessState.toolsError || catAccessState.skillsError) {
    showCatAccessError("工具/技能目录未就绪，暂时不能保存。");
    return;
  }
  hideCatAccessError();
  catAccessState.saving = true;
  updateCatAccessSave();
  try {
    const response = await fetch(`/api/cats/${encodeURIComponent(cat.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tools: [...catAccessState.selectedTools],
        skills: [...catAccessState.selectedSkills],
      }),
    });
    if (!response.ok) throw new Error(await describeHttpError(response, "PUT /api/cats"));
    const updated = await response.json();
    if (updated && typeof updated === "object") applyUpdatedCat(updated);
    closeCatAccess();
    toast(`已更新「${updated?.name ?? cat.name}」的工具与技能`);
  } catch (error) {
    showCatAccessError(`保存失败：${error.message}`);
  } finally {
    catAccessState.saving = false;
    updateCatAccessSave();
  }
}

async function fetchJson(path, label) {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await describeHttpError(response, label));
  return response.json();
}

// ── 杂项 ────────────────────────────────────────────────────────────────

async function readApiError(response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === "string") return payload.error;
  } catch {
    /* ignore */
  }
  return `HTTP ${response.status}`;
}

function toast(message, tone = "info") {
  if (!els.toastStack) return;
  const node = h("div", { class: "toast", "data-tone": tone, role: "status", text: message });
  els.toastStack.appendChild(node);
  window.setTimeout(() => {
    node.classList.add("is-out");
    window.setTimeout(() => node.remove(), 260);
  }, 2800);
}

// 暴露一点调试信息，方便验收时在控制台查看当前状态（不影响 UI）。
window.catCafe = {
  get state() {
    return app.state;
  },
  get seq() {
    return app.lastSeq;
  },
  get connection() {
    return app.conn;
  },
};

boot();
