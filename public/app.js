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
  sig: { roster: null, tasks: null, progress: null, handoffs: null, artifacts: null, memory: null },
  mention: { open: false, items: [], index: 0, tokenStart: -1, lastKey: "" },
  sse: null,
  sseOpened: false,
  ticker: null,
  /** 卡住判定的时间阈值，优先取 /api/health 的 stallMs。 */
  stallMs: FALLBACK_STALL_MS,
};

/** 设置面板的临时状态（打开时才加载，关闭即丢弃草稿）。 */
const settingsState = {
  loading: false,
  ready: false,
  data: null,
  saving: false,
  testing: false,
  resetting: false,
  resetConfirm: false,
  clearKeyRequested: false,
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

/** 最后一个未完成的任务（猫猫「工作中」状态以此为准）。 */
function latestActiveTask() {
  const tasks = app.state?.tasks ?? [];
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    if (tasks[index].status !== "done") return tasks[index];
  }
  return null;
}

/** 工作台 / 进度条展示的任务：优先用户点选的任务，否则最新未完成任务 / 最新任务。 */
function activeTask() {
  const tasks = app.state?.tasks ?? [];
  if (app.selectedTaskId) {
    const selected = tasks.find((task) => task.id === app.selectedTaskId);
    if (selected) return selected;
  }
  return latestActiveTask() ?? tasks[tasks.length - 1] ?? null;
}

function catState(catId) {
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
  renderRoster();
  renderTasks();
  renderWorkspace();
  renderTimeline();
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
  const sig = cats
    .map((cat, index) => {
      const state = statuses[index];
      return [cat.id, cat.name, cat.avatar, cat.accent, state, state === "working" ? workTask?.stage : ""].join(":");
    })
    .join("|");

  if (sig === app.sig.roster) return;
  app.sig.roster = sig;

  const nodes = cats.map((cat, index) => {
    const status = statuses[index];
    const stageText =
      status === "typing"
        ? "打字中"
        : status === "working"
          ? `工作中 · ${STAGE_LABEL.get(workTask?.stage) ?? "进行中"}`
          : "睡觉中";
    const mood = status === "sleeping" ? "sleep" : status === "typing" ? "typing" : "idle";

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
          status === "typing"
            ? [typingDots(), document.createTextNode(` ${stageText}`)]
            : stageText,
        ),
      ),
      h("span", { class: "cat-catch", "aria-hidden": "true", text: cat.catchphrase }),
    );
  });

  host.replaceChildren(...nodes);
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
  const tasks = [...(app.state?.tasks ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  if (els.taskCount) els.taskCount.textContent = String(tasks.length);

  const sig =
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
        h("span", { text: "点上面的「＋ 新任务」，或在下面直接跟猫猫说需求。" }),
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
  renderHandoffs();
  renderArtifacts();
  renderMemory();
}

function renderProgress() {
  const host = els.progress;
  if (!host) return;
  const task = activeTask();
  const key = task
    ? [task.id, task.stage, task.status, task.owner, task.updatedAt, app.selectedTaskId ?? ""].join(":")
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
  const stalled = isTaskStalled(task);
  const owner = catById(task.owner);
  const status = task.status === "done" ? "done" : stalled ? "stalled" : "active";
  const statusLabel = status === "done" ? "已完成" : status === "stalled" ? "卡住了" : "进行中";

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
          class: "btn btn--tiny btn--nudge",
          "data-action": "nudge",
          "data-task-id": task.id,
          hidden: !stalled,
          text: "🐾 催一下",
        }),
      ),
    ),
  );

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
  const memories = [...(app.state?.memory ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  if (els.memoryCount) els.memoryCount.textContent = String(memories.length);

  const key = memories.map((entry) => entry.id).join(",") || "none";
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

// ── 中栏：timeline 增量渲染 ─────────────────────────────────────────────

function renderTimeline() {
  const host = els.timeline;
  if (!host) return;
  const messages = roomMessages();
  const timeline = app.timeline;

  if (!messages.length) {
    if (!host.querySelector(".timeline-empty")) {
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

  let rebuild = timeline.ids.length > messages.length;
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
  const showJump = app.unread > 0 && app.tab === "chat";
  if (els.jump) {
    const shouldHide = !showJump;
    if (els.jump.hidden !== shouldHide) els.jump.hidden = shouldHide;
  }
  if (els.jumpCount) els.jumpCount.textContent = String(app.unread);
  if (els.chatTabDot) els.chatTabDot.hidden = !(app.unread > 0 && app.tab !== "chat");
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

  const stalled = isTaskStalled(task);
  const status = task.status === "done" ? "done" : stalled ? "stalled" : "active";
  const statusLabel = status === "done" ? "已完成" : status === "stalled" ? "卡住了" : "进行中";
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
        ? "任务已完成，猫猫去晒太阳了。"
        : stalled
          ? hardStalled
            ? "任务卡住了，可以催一下让它继续。"
            : `已 ${elapsed}s 没有新动作，可以催一下。`
          : `本阶段已进行 ${elapsed}s。`;
    if (note.textContent !== noteText) note.textContent = noteText;
  }

  const nudge = region.querySelector('[data-action="nudge"]');
  if (nudge) {
    const shouldHide = !stalled;
    if (nudge.hidden !== shouldHide) nudge.hidden = shouldHide;
    if (nudge.dataset.taskId !== task.id) nudge.dataset.taskId = task.id;
  }
}

function startTicker() {
  if (app.ticker) clearInterval(app.ticker);
  app.ticker = setInterval(() => {
    if (!app.state) return;
    updateStallUi();
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

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && app.conn !== "online") {
      refreshState().catch(() => setConn("offline"));
    }
  });
  window.addEventListener("pagehide", () => {
    if (app.sse) app.sse.close();
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

function openNewTaskModal() {
  if (!els.modal) return;
  hideFormError();
  if (els.brief) {
    els.brief.value = "";
    for (const chip of els.modalChips ?? []) chip.classList.remove("is-active");
  }
  updateCreateState();
  if (!els.modal.open) els.modal.showModal();
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
      body: JSON.stringify({ roomId: app.roomId, brief }),
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
  updateSettingsButtons();

  if (!modal.open) modal.showModal();
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
    fillSettingsForm(data);
    renderSettingsReadonly(data);
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
  if (els.settingsBaseUrl) els.settingsBaseUrl.value = "";
  if (els.settingsModel) els.settingsModel.value = "";
  if (els.settingsTemperature) els.settingsTemperature.value = "0.8";
  updateTempOutput();
  if (els.settingsApiKey) els.settingsApiKey.value = "";
  setKeyVisibility(false);
  renderKeyStatus(null);
  hideModeWarn();
}

function fillSettingsForm(data) {
  const mode = data?.mode === "llm" ? "llm" : "mock";
  const speed = ["slow", "normal", "fast"].includes(data?.speed) ? data.speed : "normal";
  const llm = data?.llm ?? {};

  setModeRadios(mode);
  setSpeedRadios(speed);
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
  hideModeWarn();
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
