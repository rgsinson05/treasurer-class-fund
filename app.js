const DB_NAME = "BSCS2CTreasury";
const DB_VERSION = 1;
const STORE_NAMES = [
  "students",
  "contributions",
  "expenses",
  "activity",
  "recycle",
  "settings",
];
const ADMIN = "Treasurer";
const PASSWORD = "BSCS2C";
const APP_NAME = "Kolekta";

let db;
let dbReadyPromise = Promise.resolve();
let dataReady = false;
let dataInitPromise = null;
let currentView = "dashboard";
let quickSessionTotal = 0;
let quickSessionCount = 0;
let quickOverrideOn = false;
let quickOverrideValue = "";
let bulkRecordMode = false;
let bulkRecordDate = "";
let bulkRecordAmount = "";
let bulkRecordSelected = [];
const ACTIVITY_RECENT_LIMIT = 20;
let state = {
  students: [],
  contributions: [],
  expenses: [],
  activity: [],
  recycle: [],
  collectionSessions: [],
  settings: {
    contributionAmount: 5,
    className: "BSCS2C",
    departmentName: "",
    tagline: "",
    brandingConfigured: false,
    setupComplete: false,
    eventName: "Christmas Party",
    contributionStartDate: "",
    noClassDates: [],
    appDateKey: "",
  },
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const uid = (prefix) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const money = (n) =>
  `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateTime = (d) =>
  new Date(d).toLocaleString("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
const dateOnly = (d) =>
  new Date(d).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ],
  );

function openDB() {
  return new Promise((resolve, reject) => {
    // Open at the database's existing version so a database created by a later
    // build is never downgraded. Missing v16 stores are added only when an
    // upgrade is actually required.
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      STORE_NAMES.forEach((name) => {
        if (!d.objectStoreNames.contains(name))
          d.createObjectStore(name, { keyPath: "id" });
      });
    };
    req.onblocked = () =>
      reject(
        new Error(
          `The local database is busy. Close any other ${APP_NAME} tab or installed copy and reopen this one.`,
        ),
      );
    req.onerror = () =>
      reject(req.error || new Error("Could not open local database."));
    req.onsuccess = () => {
      const connection = req.result;
      connection.onversionchange = () => connection.close();
      resolve(connection);
    };
  });
}
function tx(store, mode = "readonly") {
  if (!db) throw new Error("Local database is not ready.");
  if (!db.objectStoreNames.contains(store))
    throw new Error(`Missing local data store: ${store}`);
  return db.transaction(store, mode).objectStore(store);
}
async function getAll(store) {
  await dbReadyPromise;
  return new Promise((resolve, reject) => {
    try {
      const r = tx(store).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function put(store, obj) {
  await dbReadyPromise;
  return new Promise((resolve, reject) => {
    try {
      const r = tx(store, "readwrite").put(obj);
      r.onsuccess = () => resolve(obj);
      r.onerror = () => reject(r.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function del(store, id) {
  await dbReadyPromise;
  return new Promise((resolve, reject) => {
    try {
      const r = tx(store, "readwrite").delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function refresh() {
  state.students = await getAll("students");
  state.contributions = await getAll("contributions");
  state.expenses = await getAll("expenses");
  state.activity = await getAll("activity");
  state.recycle = await getAll("recycle");
  const settings = await getAll("settings");
  state.settings = {
    ...state.settings,
    ...Object.fromEntries(settings.map((x) => [x.key, x.value])),
  };
  state.collectionSessions = Array.isArray(state.settings.collectionSessions)
    ? state.settings.collectionSessions
    : [];
  if (!Array.isArray(state.settings.noClassDates))
    state.settings.noClassDates = [];
  if (typeof state.settings.appDateKey !== "string")
    state.settings.appDateKey = "";
  if (
    state.settings.appDateKey &&
    state.settings.appDateKey > localDateKey(new Date())
  )
    state.settings.appDateKey = "";
  const missingDates = [];
  for (const s of state.students) {
    if (!s.createdAt) {
      const first = state.contributions
        .filter((x) => x.studentId === s.id)
        .sort((a, b) => new Date(a.at) - new Date(b.at))[0];
      s.createdAt = first?.at || new Date().toISOString();
      s.updatedAt = new Date().toISOString();
      missingDates.push(s);
    }
  }
  for (const s of missingDates) await put("students", s);
}
async function saveSetting(key, value) {
  await put("settings", { id: key, key, value });
  state.settings[key] = value;
}
async function log(action, details) {
  await put("activity", {
    id: uid("act"),
    action,
    details,
    at: new Date().toISOString(),
    by: ADMIN,
  });
}
async function softDelete(store, obj, type) {
  await put("recycle", {
    id: uid("del"),
    originalId: obj.id,
    store,
    type,
    data: obj,
    deletedAt: new Date().toISOString(),
    deletedBy: ADMIN,
  });
  await del(store, obj.id);
  await log(
    `Deleted ${type}`,
    `${type} ${obj.name || obj.description || obj.id} moved to recycle bin.`,
  );
}

function enforceToastLimit(max = 3) {
  const region = $("#toastRegion");
  if (!region) return;
  while (region.children.length > max) region.firstElementChild.remove();
}
function showToast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  $("#toastRegion").appendChild(el);
  enforceToastLimit();
  setTimeout(() => el.remove(), 3200);
}
function showActionToast(message, actionLabel, onAction, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type} toast-action`;
  const msg = document.createElement("span");
  msg.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-action-btn";
  btn.textContent = actionLabel;
  btn.onclick = () => {
    el.remove();
    onAction();
  };
  el.appendChild(msg);
  el.appendChild(btn);
  $("#toastRegion").appendChild(el);
  enforceToastLimit();
  setTimeout(() => el.remove(), 4500);
}
function vibrate(ms = 35) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}
function modal(title, body, actions = "") {
  const region = $("#toastRegion");
  if (region) region.innerHTML = "";
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal-backdrop" id="modalBackdrop"><div class="modal"><div class="modal-head"><h3>${title}</h3><button class="icon-btn" data-close-modal>×</button></div>${body}${actions}</div></div>`;
  $("#modalBackdrop").addEventListener("click", (e) => {
    if (
      e.target.id === "modalBackdrop" ||
      e.target.closest("[data-close-modal]")
    )
      closeModal();
  });
}
function closeModal() {
  $("#modalRoot").innerHTML = "";
}
function button(label, cls = "", attrs = "") {
  return `<button class="${cls}" ${attrs}>${label}</button>`;
}

function render() {
  const titles = {
    dashboard: ["OVERVIEW", "Dashboard"],
    students: ["PEOPLE", "Students"],
    contributions: ["INCOME", "Contributions"],
    quickRecord: ["QUICK COLLECTION", "Quick Record"],
    collectionSessions: ["CASH CONTROL", "Collection Sessions"],
    expenses: ["OUTGOING", "Expenses"],
    reports: ["REPORTING", "Reports"],
    recycle: ["RECOVERY", "Recycle Bin"],
    activity: ["AUDIT", "Activity Log"],
    settings: ["CONFIGURATION", "Settings"],
  };
  $("#pageEyebrow").textContent = titles[currentView][0];
  $("#pageTitle").textContent = titles[currentView][1];
  $$(".nav-item[data-view]").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === currentView),
  );
  const views = {
    dashboard: renderDashboard,
    students: renderStudents,
    contributions: renderContributions,
    quickRecord: renderQuickRecord,
    collectionSessions: renderCollectionSessions,
    expenses: renderExpenses,
    reports: renderReports,
    recycle: renderRecycle,
    activity: renderActivity,
    settings: renderSettings,
  };
  $("#viewContainer").innerHTML = views[currentView]();
  bindViewEvents();
}

function getCollectionSession(dateKey = effectiveTodayKey()) {
  return state.collectionSessions.find((x) => x.date === dateKey) || null;
}
function sessionTotal(session) {
  if (!session) return 0;
  const ids = new Set(session.paymentIds || []);
  return state.contributions
    .filter((x) => ids.has(x.id))
    .reduce((sum, x) => sum + Number(x.amount || 0), 0);
}
function todayCollectionStats() {
  const today = effectiveTodayKey();
  const daily = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const active = state.students.filter((s) => s.status === "Active");
  let expected = 0,
    covered = 0,
    collected = 0;
  for (const s of active) {
    const l = studentLedger(s.id, today);
    const d = l.due.find((x) => x.date === today);
    if (!isClassDay(today) || !d) continue;
    if (d.status === "unpaid") expected += daily;
    else covered++;
  }
  for (const p of state.contributions) {
    for (const a of p.allocations || []) {
      if (a.date === today && a.status === "paid")
        collected += Number(a.amount) || 0;
    }
  }
  return {
    today,
    daily,
    active: active.length,
    expected,
    collected,
    remaining: Math.max(0, expected - collected),
    covered,
  };
}
function renderTodayCollectionCard() {
  const x = todayCollectionStats();
  const pct =
    x.expected > 0
      ? Math.min(100, (x.collected / x.expected) * 100)
      : x.active
        ? 100
        : 0;
  const session = getCollectionSession(x.today);
  const sessionState = session
    ? session.status === "open"
      ? `Session open · ${money(sessionTotal(session))}`
      : `Session closed · ${money(sessionTotal(session))}`
    : "No session started";
  return `<section class="panel glass today-collection-card"><div class="panel-header"><div><h3>Today's Collection</h3><span class="muted">${dateOnly(effectiveTodayDate())} · ${x.active} active students</span></div><span class="badge ${x.remaining ? "expense" : "paid"}">${x.remaining ? money(x.remaining) + " remaining" : "Complete"}</span></div><div class="today-collection-grid"><div><span>Expected today</span><strong>${money(x.expected)}</strong></div><div><span>Collected today</span><strong>${money(x.collected)}</strong></div><div><span>Covered today</span><strong>${x.covered} / ${x.active}</strong></div></div><div class="progress-wrap"><div class="progress-track"><div class="progress-bar" style="width:${pct}%"></div></div><div class="progress-meta"><span>${Math.round(pct)}% covered</span><span>${sessionState}</span></div></div><div class="today-collection-actions">${button("View unpaid today", "ghost-btn", 'data-action="view-today-unpaid"')}${session ? button("Open session", "small-btn", 'data-view="collectionSessions"') : button("Start collection session", "primary-btn", 'data-action="start-session"')}</div></section>`;
}
function collectionSessionDetail(sessionId) {
  const session = state.collectionSessions.find((x) => x.id === sessionId);
  if (!session) return;
  const ids = new Set(session.paymentIds || []);
  const payments = state.contributions
    .filter((x) => ids.has(x.id))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  const total = sessionTotal(session);
  const rows = payments.length
    ? payments
        .map(
          (p) =>
            `<div class="session-payment-row"><div><strong>${esc(displayStudent(state.students.find((s) => s.id === p.studentId)))}</strong><span>${dateTime(p.at)} · ${esc(p.by || ADMIN)}</span></div><strong>${money(p.amount)}</strong></div>`,
        )
        .join("")
    : '<div class="empty">No payments attached to this session.</div>';
  modal(
    `Session · ${dateOnly(dateFromKey(session.date))}`,
    `<div class="history-summary"><div><span class="muted">Collected</span><strong>${money(total)}</strong></div><div><span class="muted">Payments</span><strong>${payments.length}</strong></div><div><span class="muted">Status</span><strong>${session.status === "open" ? "Open" : "Closed"}</strong></div>${session.status === "closed" ? `<div><span class="muted">Cash counted</span><strong>${money(session.cashCounted)}</strong></div><div><span class="muted">Difference</span><strong class="${Math.abs(Number(session.difference || 0)) < 0.001 ? "good-text" : "warn-text"}">${money(session.difference)}</strong></div>` : ""}</div><div class="history-section-title"><div><strong>Payments in this session</strong><span>Actual money collected during the session</span></div></div><div class="session-payment-list">${rows}</div>${session.note ? `<div class="footer-note" style="margin-top:12px">Note: ${esc(session.note)}</div>` : ""}`,
    `<div class="modal-actions">${session.status === "open" ? button("Add all from this day", "ghost-btn", `data-action="attach-all-session" data-attach-session="${session.id}"`) + button("Add existing payment", "ghost-btn", `data-action="attach-session-payment" data-attach-session="${session.id}"`) : ""}${button("Delete session", "danger-btn", `data-action="delete-session" data-session-delete="${session.id}" data-session-date="${session.date}"`)}<button class="ghost-btn" data-close-modal>Close</button></div>`,
  );
}

function renderCollectionSessions() {
  const today = effectiveTodayKey();
  const session = getCollectionSession(today);
  const sessions = [...state.collectionSessions].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  const current = session
    ? `<section class="panel glass session-hero"><div class="panel-header"><div><h3>Today's session</h3><span class="muted">${dateOnly(dateFromKey(today))}</span></div><span class="badge ${session.status === "open" ? "paid" : "active"}">${session.status === "open" ? "Open" : "Closed"}</span></div><div class="session-summary"><div><span>Collected</span><strong>${money(sessionTotal(session))}</strong></div><div><span>Payments</span><strong>${(session.paymentIds || []).length}</strong></div><div><span>Started</span><strong>${dateTime(session.startedAt)}</strong></div>${session.status === "closed" ? `<div><span>Cash counted</span><strong>${money(session.cashCounted)}</strong></div><div><span>Difference</span><strong class="${Math.abs(Number(session.difference || 0)) < 0.001 ? "good-text" : "warn-text"}">${money(session.difference)}</strong></div>` : ""}</div>${session.status === "open" ? `<div class="session-actions">${button("Add all from this day", "ghost-btn", `data-action="attach-all-session" data-attach-session="${session.id}"`)}${button("Add existing payment", "ghost-btn", `data-action="attach-session-payment" data-attach-session="${session.id}"`)}${button("Close session", "primary-btn", 'data-action="close-session"')}</div>` : `<div class="footer-note">This session is closed. Payments can no longer be attached to it.</div>`}</section>`
    : `<section class="panel glass session-hero"><div class="panel-header"><div><h3>No session started today</h3><span class="muted">Sessions track only money collected during the session.</span></div></div><div class="session-actions">${button("Start today’s collection session", "primary-btn", 'data-action="start-session"')}</div></section>`;
  const history = sessions
    .map(
      (x) =>
        `<article class="session-row" data-session-id="${x.id}"><div><strong>${dateOnly(dateFromKey(x.date))}</strong><span>${(x.paymentIds || []).length} payment${(x.paymentIds || []).length === 1 ? "" : "s"} · ${x.status === "open" ? "Open" : "Closed"}</span></div><div class="session-row-right"><div><strong>${money(sessionTotal(x))}</strong>${x.status === "closed" ? `<span class="${Math.abs(Number(x.difference || 0)) < 0.001 ? "good-text" : "warn-text"}">${Math.abs(Number(x.difference || 0)) < 0.001 ? "✓ Balanced" : `Difference ${money(x.difference)}`}</span>` : "<span>In progress</span>"}</div>${button("Delete", "small-btn danger", `data-action="delete-session" data-session-delete="${x.id}" data-session-date="${x.date}"`)}</div></article>`,
    )
    .join("");
  return `<div class="view"><section class="panel glass"><div class="panel-header"><div><h3>Collection Sessions</h3><span class="muted">Count and reconcile the cash you collect</span></div></div><p class="footer-note" style="margin:8px 0 0">A collection session groups the payments you take in one sitting so you can count the physical cash afterward and check it matches what was recorded. Start a session before collecting, add the payments you take (or tap "Add all from this day" to pull in everything recorded that day), then close it and enter the cash counted to catch any shortage.</p></section>${current}<section class="panel glass"><div class="panel-header"><div><h3>Session history</h3><span class="muted">${sessions.length} session${sessions.length === 1 ? "" : "s"}</span></div></div><div class="session-list">${history || '<div class="empty">No collection sessions yet.</div>'}</div></section></div>`;
}

function renderDashboard() {
  const total = state.contributions.reduce((a, x) => a + Number(x.amount), 0),
    expenses = state.expenses.reduce((a, x) => a + Number(x.amount), 0),
    balance = total - expenses;
  const activeStudents = state.students.filter((x) => x.status === "Active");
  const paid = activeStudents.filter((s) => {
      const l = studentLedger(s.id);
      return l.due.length > 0 && l.outstanding === 0;
    }).length,
    active = activeStudents.length,
    pct = active ? Math.min(100, (paid / active) * 100) : 0;
  const recent = [
    ...state.contributions.map((x) => ({ ...x, kind: "Contribution" })),
    ...state.expenses.map((x) => ({ ...x, kind: "Expense" })),
  ]
    .sort((a, b) => new Date(b.at || b.date) - new Date(a.at || a.date))
    .slice(0, 7);
  return `<div class="view">
    ${state.settings.appDateKey ? `<section class="panel glass backdate-banner"><div class="backdate-banner-main"><span class="backdate-dot"></span><div><strong>Recording for ${dateOnly(effectiveTodayDate())}</strong><span class="muted">You're back-dated — device date is ${dateOnly(new Date())}. New payments and today's totals use this date.</span></div></div>${button("Back to today", "primary-btn", 'data-action="reset-app-date"')}</section>` : ""}
    <section class="dash-metrics">
      <div class="dash-metric collected">${reportsIcon(REP_IC.cash)}<div class="dash-metric-body"><span>Total Collected</span><strong>${money(total)}</strong></div></div>
      <div class="dash-metric spent">${reportsIcon(REP_IC.receipt)}<div class="dash-metric-body"><span>Total Expenses</span><strong>${money(expenses)}</strong></div></div>
      <div class="dash-metric balance">${reportsIcon(REP_IC.balance)}<div class="dash-metric-body"><span>Current Balance</span><strong>${money(balance)}</strong></div></div>
      <div class="dash-metric students">${reportsIcon(REP_IC.usersCheck)}<div class="dash-metric-body"><span>Paid Students</span><strong>${paid} / ${active}</strong></div></div>
    </section>
    <section class="grid-2">
      <div class="panel glass dash-progress"><div class="panel-header with-ic">${reportsIcon(REP_IC.chart)}<div><h3>Contribution progress</h3><span class="muted">${esc(state.settings.eventName)}</span></div><span class="badge paid">${Math.round(pct)}%</span></div><div class="progress-wrap"><div class="progress-track tall"><div class="progress-bar" style="width:${pct}%"></div></div><div class="progress-meta"><span><strong>${paid}</strong> of ${active} paid</span><span>${Math.max(0, active - paid)} not recorded</span></div></div><div class="footer-note">Class days are tracked at the fixed daily amount; past due days and advance payments are allocated automatically.</div></div>
      <div class="panel glass"><div class="panel-header with-ic">${reportsIcon(REP_IC.bolt)}<div><h3>Quick actions</h3></div></div><div class="dash-actions">${button("+ Add Student", "primary-btn", 'data-action="add-student"')}${button("+ Record Contribution", "ghost-btn", 'data-action="add-contribution"')}${button("+ Add Expense", "ghost-btn", 'data-action="add-expense"')}</div><div class="footer-note">Contribution amount: <strong>${money(state.settings.contributionAmount)}</strong></div></div>
    </section>
    <section class="panel glass"><div class="panel-header with-ic">${reportsIcon(REP_IC.list)}<div><h3>Recent transactions</h3><span class="muted">Latest money movement</span></div>${button("View all", "small-btn", 'data-view="contributions"')}</div>${recentTable(recent)}</section>
    <div class="app-footer"><div class="dashboard-credit">Developed by <strong>RG Sinson</strong></div><div class="dashboard-rights">© 2026 RG Sinson · All rights reserved.</div></div>
  </div>`;
}
function stat(label, value, sub, icon) {
  return `<div class="stat-card glass"><div class="stat-head"><span>${label}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
}
function recentTable(rows) {
  if (!rows.length) return `<div class="empty">No transactions yet.</div>`;
  return `<div class="recent-list">${rows
    .map((x) => {
      const isExp = x.kind === "Expense";
      const student = state.students.find((s) => s.id === x.studentId);
      const label = isExp
        ? esc(x.description || x.category || "Expense")
        : esc(student?.name || "Unknown student");
      return `<div class="recent-item"><span class="recent-type ${isExp ? "expense" : "paid"}">${isExp ? "Expense" : "Contribution"}</span><div class="recent-info"><strong>${label}</strong><span>${dateTime(x.at || x.date)}</span></div><b class="recent-amount ${isExp ? "warn-text" : "good-text"}">${isExp ? "−" : "+"}${money(x.amount)}</b></div>`;
    })
    .join("")}</div>`;
}

function statusLabel(status) {
  return status === "Active" ? "Participating" : "Not participating";
}
function genderGroupKey(s) {
  return s.gender === "Male"
    ? "Male"
    : s.gender === "Female"
      ? "Female"
      : "Unspecified";
}
function genderGroupLabel(key) {
  return key === "Male" ? "Boys" : key === "Female" ? "Girls" : "Unspecified";
}
function studentComputed(s) {
  const payments = state.contributions
    .filter((x) => x.studentId === s.id)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  const ledger = studentLedger(s.id);
  const todayKey = effectiveTodayKey();
  const todayDue =
    isClassDay(todayKey) && todayKey >= classStartKey()
      ? ledger.due.find((x) => x.date === todayKey)
      : null;
  const todayLabel =
    todayDue?.status === "paid"
      ? "Paid"
      : todayDue?.status === "advance"
        ? "Advance"
        : todayDue
          ? "Due"
          : "No class";
  const todayHtml =
    todayLabel === "Paid"
      ? '<span class="badge paid">Paid</span>'
      : todayLabel === "Advance"
        ? '<span class="badge paid">Advance</span>'
        : todayLabel === "Due"
          ? '<span class="badge expense">Due</span>'
          : '<span class="muted">No class</span>';
  const balanceHtml = ledger.outstanding
    ? `<span class="badge expense">${money(ledger.outstanding)} due</span>`
    : ledger.advance.length
      ? `<span class="badge paid">${ledger.advance.length} day${ledger.advance.length === 1 ? "" : "s"} ahead</span>`
      : '<span class="badge active">₱0 due</span>';
  const last = payments[0] ? dateTime(payments[0].at) : "—";
  return { todayHtml, balanceHtml, last };
}
function renderStudents() {
  return `<div class="view"><section class="panel glass"><div class="panel-header"><div><h3>Classmates</h3><span class="muted">Manually managed student list</span></div>${button("+ Add Student", "primary-btn", 'data-action="add-student"')}</div><div class="search-row"><input class="input search-input" id="studentSearch" placeholder="Search student name..."> <select class="select" id="studentGenderFilter" style="width:130px"><option value="all">All genders</option><option value="Male">Boys</option><option value="Female">Girls</option></select> <select class="select" id="studentStatusFilter" style="width:170px"><option value="all">All statuses</option><option value="Active">Participating</option><option value="Inactive">Not participating</option></select></div><div id="studentsTable"></div></section></div>`;
}
function studentsTable(filter = "", status = "all", gender = "all") {
  const matched = state.students.filter(
    (s) =>
      s.name.toLowerCase().includes(filter.toLowerCase()) &&
      (status === "all" || s.status === status) &&
      (gender === "all" || genderGroupKey(s) === gender),
  );
  if (!matched.length) return `<div class="empty">No students found.</div>`;
  const order = gender === "all" ? ["Male", "Female", "Unspecified"] : [gender];
  const blocks = order
    .map((key) => {
      const rows = matched
        .filter((s) => genderGroupKey(s) === key)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!rows.length) return "";
      const head = `<div class="student-group-head"><strong>${genderGroupLabel(key)}</strong><span class="student-group-count">${rows.length}</span></div>`;
      const tableRows = rows
        .map((s) => {
          const c = studentComputed(s);
          return `<tr class="student-row" data-student-detail="${s.id}"><td><strong>${esc(s.name)}</strong>${s.alias ? `<div class="muted">${esc(s.alias)}</div>` : ""}</td><td><span class="badge ${s.status.toLowerCase()}">${statusLabel(s.status)}</span></td><td>${c.todayHtml}</td><td>${c.balanceHtml}</td><td>${c.last}</td></tr>`;
        })
        .join("");
      const table = `<div class="table-wrap students-desktop"><table class="data-table"><thead><tr><th>Name</th><th>Status</th><th>Today</th><th>Balance</th><th>Last payment</th></tr></thead><tbody>${tableRows}</tbody></table></div>`;
      const cards = `<div class="students-mobile student-card-list">${rows
        .map((s) => {
          const c = studentComputed(s);
          return `<button type="button" class="student-card" data-student-detail="${s.id}"><div class="student-card-info"><strong>${esc(s.name)}</strong>${s.alias ? `<span class="student-card-alias">${esc(s.alias)}</span>` : ""}<div class="student-card-meta">${c.todayHtml}${c.balanceHtml}<span class="badge ${s.status.toLowerCase()}">${statusLabel(s.status)}</span></div></div><span class="student-card-chevron" aria-hidden="true">›</span></button>`;
        })
        .join("")}</div>`;
      return `<div class="student-group">${head}${table}${cards}</div>`;
    })
    .join("");
  return `<div class="student-groups">${blocks}</div>`;
}

function renderQuickRecord() {
  const fixed = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const todayLabel = bulkRecordDate || effectiveTodayKey();
  const todayDateStr = todayLabel ? dateOnly(dateFromKey(todayLabel)) : "Today";
  const activeStudents = state.students.filter(s => s.status === "Active").sort((a, b) => displayStudent(a).localeCompare(displayStudent(b)));
  return `<div class="view"><section class="panel glass quick-record-panel"><div class="panel-header"><div><h3>Quick Record</h3><span class="muted">${bulkRecordMode ? "Record the same payment amount for multiple students at once." : "Record one or more ${money(fixed)} class-day contributions in a single payment."}</span></div><span class="badge paid">${money(fixed)} / class day</span></div><div class="quick-session-total"><div><span class="muted">Collected this round</span><strong>${money(quickSessionTotal)}</strong></div><span class="muted">${quickSessionCount} payment${quickSessionCount === 1 ? "" : "s"}</span>${quickSessionCount > 0 ? button("Reset", "ghost-btn small-btn", 'data-action="reset-quick-session"') : ""}</div><div class="quick-mode-toggle"><button class="mode-btn ${bulkRecordMode ? "" : "active"}" data-action="set-quick-mode" data-mode="individual">Individual</button><button class="mode-btn ${bulkRecordMode ? "active" : ""}" data-action="set-quick-mode" data-mode="bulk">Bulk Record</button></div>${bulkRecordMode ? renderBulkRecordPanel(fixed, todayDateStr, activeStudents) : renderIndividualPanel(fixed)}</section></div>`;
}
function renderIndividualPanel(fixed) {
  return `<div class="quick-record-controls"><div class="quick-amount-box"><span class="muted">Default payment</span><strong>${money(fixed)}</strong></div><label class="override-toggle"><input type="checkbox" id="quickOverrideToggle" ${quickOverrideOn ? "checked" : ""}> <span>Override amount</span></label><input class="input quick-override-input" id="quickOverrideAmount" type="number" min="${fixed}" step="0.01" inputmode="decimal" placeholder="e.g. ${fixed * 2}" value="${quickOverrideOn ? esc(String(quickOverrideValue)) : ""}" ${quickOverrideOn ? "" : "disabled"}></div><div class="search-row quick-search-row"><input class="input search-input" id="quickRecordSearch" placeholder="Search student name or identifier..." autocomplete="off"></div><div class="quick-student-list quick-student-scroll" id="quickStudentList">${quickStudentList("")}</div><div class="footer-note">Each class day is exactly ${money(fixed)}. Weekends and dates marked as no-class are skipped. A larger payment automatically settles oldest unpaid days first, then covers future class days.</div>`;
}
function renderBulkRecordPanel(fixed, todayDateStr, activeStudents) {
  const amountVal = bulkRecordAmount || String(fixed);
  const amountNum = Number(amountVal) || 0;
  const checkedIds = new Set(bulkRecordSelected || []);
  const selectedCount = checkedIds.size;
  const total = amountNum * selectedCount;
  const rows = activeStudents.map(s => {
    const ledger = studentLedger(s.id);
    const today = effectiveTodayKey();
    const todayDue = ledger.due.find(x => x.date === today);
    const status = todayDue?.status === "paid" ? "Paid today" : todayDue?.status === "advance" ? "Paid in advance" : todayDue ? "Due today" : "No class today";
    const balance = ledger.outstanding ? `${money(ledger.outstanding)} due` : ledger.advance.length ? `${ledger.advance.length} day${ledger.advance.length === 1 ? "" : "s"} ahead` : "Up to date";
    const checked = checkedIds.has(s.id) ? "checked" : "";
    return `<label class="bulk-student-row"><input type="checkbox" class="bulk-student-check" data-student-id="${s.id}" ${checked}><div class="bulk-student-info"><strong>${esc(displayStudent(s))}</strong><span>${status} · ${balance}</span></div></label>`;
  }).join("");
  const dateInputVal = bulkRecordDate || "";
  return `<div class="bulk-record-panel"><div class="bulk-section"><div class="bulk-section-label">Payment Date</div><input class="input bulk-date-input" id="bulkDateInput" type="date" value="${esc(dateInputVal)}" max="${localDateKey(new Date())}"><div class="bulk-date-display">${esc(todayDateStr)}</div></div><div class="bulk-section"><div class="bulk-section-label">Select Students</div><div class="bulk-actions-row"><button class="small-btn" data-action="bulk-select-all">Select All</button><button class="small-btn" data-action="bulk-clear-all">Clear All</button></div><div class="search-row"><input class="input search-input" id="bulkSearchInput" placeholder="Search student name..." autocomplete="off"></div><div class="bulk-student-list" id="bulkStudentList">${rows || '<div class="empty">No active students.</div>'}</div><div class="bulk-selected-count">${selectedCount} student${selectedCount !== 1 ? "s" : ""} selected</div></div><div class="bulk-section"><div class="bulk-section-label">Amount per student</div><input class="input bulk-amount-input" id="bulkAmountInput" type="number" min="0.01" step="0.01" inputmode="decimal" value="${esc(amountVal)}"></div><div class="bulk-total-box"><span class="muted">Total</span><strong id="bulkTotalDisplay">${money(total)}</strong></div><div class="bulk-actions"><button class="ghost-btn" data-action="set-quick-mode" data-mode="individual">Cancel</button><button class="primary-btn" id="bulkRecordBtn" data-action="bulk-confirm" ${selectedCount === 0 || amountNum <= 0 ? "disabled" : ""}>Record ${selectedCount} Payment${selectedCount !== 1 ? "s" : ""}</button></div></div></div>`;
}
function quickStudentList(q = "") {
  const fixed = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const rows = state.students
    .filter(
      (s) =>
        s.status === "Active" &&
        displayStudent(s).toLowerCase().includes(q.toLowerCase()),
    )
    .sort((a, b) => displayStudent(a).localeCompare(displayStudent(b)));
  if (!rows.length)
    return `<div class="empty">${q ? "No students match your search." : "No participating students found."}</div>`;
  return rows
    .map((s) => {
      const payments = state.contributions
        .filter((x) => x.studentId === s.id)
        .sort((a, b) => new Date(b.at) - new Date(a.at));
      const ledger = studentLedger(s.id);
      const today = effectiveTodayKey();
      const todayDue = ledger.due.find((x) => x.date === today);
      const status =
        todayDue?.status === "paid"
          ? "Paid today"
          : todayDue?.status === "advance"
            ? "Paid in advance"
            : todayDue
              ? "Due today"
              : "No class today";
      const balance = ledger.outstanding
        ? `${money(ledger.outstanding)} due`
        : ledger.advance.length
          ? `${ledger.advance.length} day${ledger.advance.length === 1 ? "" : "s"} ahead`
          : "Up to date";
      return `<div class="quick-student-row"><div class="quick-student-info"><strong>${esc(displayStudent(s))}</strong><span>${status} · ${balance} · ${payments.length ? `${payments.length} payment${payments.length === 1 ? "" : "s"}` : "No payments yet"}</span></div><div class="quick-student-actions">${button("History", "small-btn", 'data-payment-history="' + s.id + '"')}${button("Record " + money(fixed), "primary-btn quick-record-btn", 'data-quick-record="' + s.id + '"')}</div></div>`;
    })
    .join("");
}
function renderContributions() {
  const total = state.contributions.reduce((a, x) => a + Number(x.amount), 0);
  return `<div class="view"><section class="cards">${stat("Collected", money(total), "All recorded contributions", "₱")}${stat("Transactions", state.contributions.length, "Payment records", "≡")}${stat("Fixed amount", money(state.settings.contributionAmount), "Christmas Party", "◎")}${stat("Contributors", new Set(state.contributions.map((x) => x.studentId)).size, "Unique students", "✓")}</section><section class="panel glass"><div class="panel-header"><div><h3>Contribution records</h3><span class="muted">${esc(state.settings.eventName)}</span></div><div class="header-actions">${button("+ Record Contribution", "primary-btn", 'data-action="add-contribution"')}${state.contributions.length ? button("Delete all", "danger-btn", 'data-action="delete-all-contributions"') : ""}</div></div><div class="search-row"><input class="input search-input" id="contributionSearch" placeholder="Search student..."><input class="input" type="date" id="contributionDateFilter" style="width:180px"></div><div id="contributionTable"></div></section></div>`;
}
function contributionTable(q = "", date = "") {
  let rows = [...state.contributions]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .filter((x) => {
      const s = state.students.find((s) => s.id === x.studentId);
      return (
        (!q || (s?.name || "").toLowerCase().includes(q.toLowerCase())) &&
        (!date || x.at.slice(0, 10) === date)
      );
    });
  if (!rows.length)
    return `<div class="empty">No contribution records found.</div>`;
  const groups = new Map();
  for (const x of rows) {
    const key = localDateKey(x.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  const dayKeys = [...groups.keys()].sort((a, b) => b.localeCompare(a));
  const grandTotal = rows.reduce((a, x) => a + Number(x.amount || 0), 0);
  const summary = `<div class="contrib-summary"><span>${rows.length} payment${rows.length === 1 ? "" : "s"} · ${dayKeys.length} day${dayKeys.length === 1 ? "" : "s"}</span><strong>${money(grandTotal)}</strong></div>`;
  const groupsHtml = dayKeys
    .map((key, i) => {
      const items = groups.get(key);
      const dayTotal = items.reduce((a, x) => a + Number(x.amount || 0), 0);
      const body = `<div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Amount</th><th>Time</th><th>Recorded by</th><th>Actions</th></tr></thead><tbody>${items
        .map(
          (x) =>
            `<tr><td>${esc(displayStudent(state.students.find((s) => s.id === x.studentId)))}</td><td><strong>${money(x.amount)}</strong></td><td>${new Date(x.at).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</td><td>${esc(x.by)}</td><td><div class="actions">${button("Edit", "small-btn", 'data-edit-contribution="' + x.id + '"')}${button("Delete", "small-btn danger", 'data-delete-contribution="' + x.id + '"')}</div></td></tr>`,
        )
        .join("")}</tbody></table></div>`;
      return `<details class="day-group"${i === 0 ? " open" : ""}><summary class="day-summary"><div class="day-summary-info"><strong>${dateOnly(dateFromKey(key))}</strong><span>${items.length} payment${items.length === 1 ? "" : "s"}</span></div><span class="day-summary-total">${money(dayTotal)}</span><span class="settings-chevron" aria-hidden="true">⌄</span></summary>${body}</details>`;
    })
    .join("");
  return `${summary}<div class="day-group-list">${groupsHtml}</div>`;
}
function refreshContributionTable() {
  const el = $("#contributionTable");
  if (!el) return;
  el.innerHTML = contributionTable(
    $("#contributionSearch")?.value || "",
    $("#contributionDateFilter")?.value || "",
  );
}

function renderExpenses() {
  return `<div class="view"><section class="cards">${stat("Total Expenses", money(state.expenses.reduce((a, x) => a + Number(x.amount), 0)), "All expense records", "↗")}${stat("Expense Records", state.expenses.length, "Logged expenses", "≡")}${stat("Categories", new Set(state.expenses.map((x) => x.category)).size, "Used categories", "◈")}${stat("Average", state.expenses.length ? money(state.expenses.reduce((a, x) => a + Number(x.amount), 0) / state.expenses.length) : money(0), "Per expense", "≈")}</section><section class="panel glass"><div class="panel-header"><div><h3>Class expenses</h3><span class="muted">Money spent by the class</span></div>${button("+ Add Expense", "primary-btn", 'data-action="add-expense"')}</div><div class="search-row"><input class="input search-input" id="expenseSearch" placeholder="Search category or description..."><input class="input" type="date" id="expenseDateFilter" style="width:180px"></div><div id="expenseTable"></div></section></div>`;
}
function expenseTable(q = "", date = "") {
  let rows = [...state.expenses]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .filter(
      (x) =>
        (!q ||
          `${x.category} ${x.description}`
            .toLowerCase()
            .includes(q.toLowerCase())) &&
        (!date || x.date.slice(0, 10) === date),
    );
  if (!rows.length) return `<div class="empty">No expenses found.</div>`;
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Recorded by</th><th>Actions</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${dateOnly(x.date)}</td><td><span class="badge expense">${esc(x.category)}</span></td><td>${esc(x.description)}</td><td><strong>${money(x.amount)}</strong></td><td>${esc(x.by)}</td><td><div class="actions">${button("Edit", "small-btn", 'data-edit-expense="' + x.id + '"')}${button("Delete", "small-btn danger", 'data-delete-expense="' + x.id + '"')}</div></td></tr>`).join("")}</tbody></table></div>`;
}

const REP_IC = {
  briefcase: `<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3h3A2.5 2.5 0 0 1 16 5.5V7"/><path d="M3 12h18"/>`,
  users: `<circle cx="9" cy="8" r="3.1"/><path d="M3.6 20c0-3 2.6-5 5.4-5s5.4 2 5.4 5"/><path d="M16.6 5.3a3.1 3.1 0 0 1 0 6"/><path d="M20.5 20c0-2.3-1.5-4.1-3.6-4.7"/>`,
  usersCheck: `<circle cx="9" cy="8" r="3.1"/><path d="M3.6 20c0-3 2.6-5 5.4-5s5.4 2 5.4 5"/><path d="M15 11.6l1.8 1.8 3.7-3.8"/>`,
  cash: `<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9v6M18 9v6"/>`,
  receipt: `<path d="M6 2.5h12v19l-3-1.7-3 1.7-3-1.7-3 1.7z"/><path d="M9 7.5h6M9 11.5h6M9 15.5h4"/>`,
  balance: `<path d="M12 3v18"/><path d="M5 7h14"/><path d="M7 7l-3 6.5a3 3 0 0 0 6 0z"/><path d="M17 7l-3 6.5a3 3 0 0 0 6 0z"/>`,
  coins: `<ellipse cx="8.5" cy="6.5" rx="5.5" ry="2.5"/><path d="M3 6.5v4c0 1.4 2.5 2.5 5.5 2.5"/><ellipse cx="15.5" cy="13" rx="5.5" ry="2.5"/><path d="M10 13v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-4"/>`,
  chart: `<path d="M4 4v16h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/>`,
  check: `<circle cx="12" cy="12" r="9"/><path d="M8.3 12.3l2.4 2.4 4.8-5.2"/>`,
  partial: `<circle cx="12" cy="12" r="9"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/>`,
  alert: `<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.2"/><path d="M12 16.3h.01"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7.2V12l3.2 2"/>`,
  download: `<path d="M12 3v11"/><path d="M7.5 10 12 14.5 16.5 10"/><path d="M5 20h14"/>`,
  bolt: `<path d="M13 2 5 13h5l-1 9 8-12h-5l1-8z"/>`,
  list: `<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>`,
};
function reportsIcon(paths) {
  return `<span class="rep-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg></span>`;
}
function collectionOverview() {
  const daily = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const active = state.students.filter((s) => s.status === "Active");
  let expected = 0,
    remaining = 0;
  const counts = { paid: 0, partial: 0, unpaid: 0, advance: 0 };
  for (const s of active) {
    const l = studentLedger(s.id);
    expected += l.due.length * daily;
    remaining += l.outstanding;
    if (l.outstanding > 0) {
      if (l.paid.length > 0) counts.partial++;
      else counts.unpaid++;
    } else if (l.advance.length > 0) {
      counts.advance++;
    } else {
      counts.paid++;
    }
  }
  const collected = Math.max(0, expected - remaining);
  const pct =
    expected > 0
      ? Math.min(100, (collected / expected) * 100)
      : active.length
        ? 100
        : 0;
  return { active: active.length, expected, collected, remaining, pct, counts };
}
function renderReports() {
  const collected = state.contributions.reduce(
      (a, x) => a + Number(x.amount),
      0,
    ),
    spent = state.expenses.reduce((a, x) => a + Number(x.amount), 0),
    balance = collected - spent,
    contributors = new Set(state.contributions.map((x) => x.studentId)).size;
  const ov = collectionOverview();
  return `<div class="view reports-view">
    <section class="report-box glass">
      <div class="report-head">${reportsIcon(REP_IC.briefcase)}<div><p class="eyebrow">TREASURY SUMMARY</p><h3>${esc(state.settings.className)} — ${esc(state.settings.eventName)}</h3>${state.settings.departmentName ? `<p class="muted" style="margin:2px 0 0">${esc(state.settings.departmentName)}</p>` : ""}</div></div>
      <div class="report-hero">
        <div class="report-hero-card collected">${reportsIcon(REP_IC.cash)}<span>Collected</span><strong>${money(collected)}</strong></div>
        <div class="report-hero-card spent">${reportsIcon(REP_IC.receipt)}<span>Expenses</span><strong>${money(spent)}</strong></div>
        <div class="report-hero-card balance">${reportsIcon(REP_IC.balance)}<span>Balance</span><strong>${money(balance)}</strong></div>
      </div>
      <div class="report-meta-grid">
        <div>${reportsIcon(REP_IC.users)}<div><span>Students</span><b>${state.students.length}</b></div></div>
        <div>${reportsIcon(REP_IC.usersCheck)}<div><span>Contributors</span><b>${contributors}</b></div></div>
        <div>${reportsIcon(REP_IC.coins)}<div><span>Daily amount</span><b>${money(state.settings.contributionAmount)}</b></div></div>
        <div>${reportsIcon(REP_IC.alert)}<div><span>Unpaid dues</span><b class="${ov.remaining ? "warn-text" : "good-text"}">${money(ov.remaining)}</b></div></div>
      </div>
    </section>

    <section class="panel glass report-section">
      <div class="panel-header with-ic">${reportsIcon(REP_IC.chart)}<div><h3>Collection Overview</h3><span class="muted">Dues expected so far vs collected</span></div><span class="badge ${ov.remaining ? "expense" : "paid"}">${Math.round(ov.pct)}%</span></div>
      <div class="collection-overview-grid">
        <div><span>Expected</span><strong>${money(ov.expected)}</strong></div>
        <div><span>Collected</span><strong class="good-text">${money(ov.collected)}</strong></div>
        <div><span>Remaining</span><strong class="${ov.remaining ? "warn-text" : "good-text"}">${money(ov.remaining)}</strong></div>
      </div>
      <div class="progress-wrap"><div class="progress-track"><div class="progress-bar" style="width:${ov.pct}%"></div></div><div class="progress-meta"><span>${Math.round(ov.pct)}% collected</span><span>${money(ov.collected)} of ${money(ov.expected)}</span></div></div>
    </section>

    <section class="panel glass report-section">
      <div class="panel-header with-ic">${reportsIcon(REP_IC.users)}<div><h3>Student Contribution Status</h3><span class="muted">${ov.active} participating</span></div></div>
      <div class="status-overview-grid">
        <div class="status-tile paid">${reportsIcon(REP_IC.check)}<b>${ov.counts.paid}</b><span>Paid</span></div>
        <div class="status-tile partial">${reportsIcon(REP_IC.partial)}<b>${ov.counts.partial}</b><span>Partially paid</span></div>
        <div class="status-tile unpaid">${reportsIcon(REP_IC.alert)}<b>${ov.counts.unpaid}</b><span>Unpaid</span></div>
        <div class="status-tile advance">${reportsIcon(REP_IC.clock)}<b>${ov.counts.advance}</b><span>Paid in advance</span></div>
      </div>
    </section>

    <section class="panel glass report-section">
      <div class="panel-header with-ic">${reportsIcon(REP_IC.receipt)}<div><h3>Expense Breakdown</h3><span class="muted">${state.expenses.length} expense${state.expenses.length === 1 ? "" : "s"}</span></div><span class="report-total">${money(spent)}</span></div>
      ${reportExpenses()}
    </section>

    <section class="panel glass export-panel">
      <div class="panel-header with-ic">${reportsIcon(REP_IC.download)}<div><h3>Export & Print</h3><span class="muted">Save or share this report</span></div></div>
      <div class="export-actions">${button("Export JSON Backup", "primary-btn", 'data-action="export-json"')}${button("Export Transactions CSV", "ghost-btn", 'data-action="export-csv"')}${button("Print Report", "ghost-btn", 'data-action="print-report"')}</div>
      <p class="footer-note">Data is stored on this device only — keep a JSON backup somewhere safe.</p>
    </section>
  </div>`;
}
function reportExpenses() {
  if (!state.expenses.length)
    return `<div class="empty">No expenses recorded yet. Add expenses and they'll appear here with categories, dates, and a running total.</div>`;
  const map = {};
  state.expenses.forEach(
    (x) => (map[x.category] = (map[x.category] || 0) + Number(x.amount)),
  );
  const cats = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...cats.map((x) => x[1]));
  const bars = cats
    .map(
      ([cat, val]) =>
        `<div class="progress-wrap"><div class="progress-meta"><span>${esc(cat)}</span><strong>${money(val)}</strong></div><div class="progress-track"><div class="progress-bar" style="width:${(val / max) * 100}%"></div></div></div>`,
    )
    .join("");
  const recent = [...state.expenses]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 6);
  const list = recent
    .map(
      (x) =>
        `<div class="report-expense-row"><div class="report-expense-info"><strong>${esc(x.category)}</strong><span>${esc(x.description || "—")} · ${dateOnly(x.date)}</span></div><b>${money(x.amount)}</b></div>`,
    )
    .join("");
  const more =
    state.expenses.length > recent.length
      ? `<div class="report-expense-more muted">+${state.expenses.length - recent.length} more in Expenses</div>`
      : "";
  return `<div class="report-expense-bars">${bars}</div><div class="report-expense-list">${list}${more}</div>`;
}

function renderRecycle() {
  const rows = [...state.recycle].sort(
    (a, b) => new Date(b.deletedAt) - new Date(a.deletedAt),
  );
  if (!rows.length)
    return `<div class="view"><section class="panel glass"><div class="panel-header"><div><h3>Recycle Bin</h3><span class="muted">Deleted records can be restored.</span></div></div><div class="empty">Recycle bin is empty.</div></section></div>`;
  return `<div class="view"><section class="panel glass"><div class="panel-header"><div><h3>Recycle Bin</h3><span class="muted">${rows.length} deleted record(s)</span></div>${button("Empty permanently", "danger-btn", 'data-action="empty-recycle"')}</div><div class="table-wrap"><table class="data-table"><thead><tr><th>Type</th><th>Details</th><th>Deleted</th><th>Actions</th></tr></thead><tbody>${rows.map((x) => `<tr><td><span class="badge deleted">${esc(x.type)}</span></td><td>${esc(x.type === "Contribution" ? `${displayStudent(state.students.find((s) => s.id === x.data.studentId))} — ${money(x.data.amount)}` : x.data.name || x.data.description || x.originalId)}</td><td>${dateTime(x.deletedAt)}</td><td><div class="actions">${button("Restore", "small-btn", 'data-restore="' + x.id + '"')}${button("Delete forever", "small-btn danger", 'data-purge="' + x.id + '"')}</div></td></tr>`).join("")}</tbody></table></div></section></div>`;
}
function renderActivity() {
  return `<div class="view"><section class="panel glass"><div class="panel-header"><div><h3>Activity Log</h3><span class="muted">Audit history for this browser</span></div></div><div class="search-row"><input class="input search-input" id="activitySearch" placeholder="Search action, details, or user..."><input class="input" type="date" id="activityDateFilter" style="width:180px"></div><div id="activityList"></div></section></div>`;
}
function activityList(q = "", date = "") {
  const query = q.trim().toLowerCase();
  const filtering = !!query || !!date;
  let rows = [...state.activity].sort((a, b) => new Date(b.at) - new Date(a.at));
  if (query)
    rows = rows.filter((x) =>
      `${x.action} ${x.details} ${x.by}`.toLowerCase().includes(query),
    );
  if (date) rows = rows.filter((x) => (x.at || "").slice(0, 10) === date);
  const total = rows.length;
  const shown = filtering ? rows.slice(0, 200) : rows.slice(0, ACTIVITY_RECENT_LIMIT);
  if (!shown.length)
    return `<div class="empty">${filtering ? "No matching activity found." : "No activity recorded yet."}</div>`;
  const note = filtering
    ? `<div class="footer-note">${total} matching entr${total === 1 ? "y" : "ies"}${total > shown.length ? ` · showing first ${shown.length}` : ""}.</div>`
    : `<div class="footer-note">Showing the ${shown.length} most recent of ${total}. Search or pick a date to find older entries.</div>`;
  return `${note}${shown.map((x) => `<div class="activity-item"><span class="activity-dot"></span><div><strong>${esc(x.action)}</strong><p>${esc(x.details)} · ${dateTime(x.at)} · ${esc(x.by)}</p></div></div>`).join("")}`;
}
function guideIcon(paths) {
  return `<span class="guide-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg></span>`;
}
function guideRow(iconPaths, title, bodyHtml) {
  return `<details class="guide-item"><summary class="guide-summary">${guideIcon(iconPaths)}<span class="guide-title">${title}</span><span class="guide-arrow" aria-hidden="true">›</span></summary><div class="guide-body">${bodyHtml}</div></details>`;
}
function howItWorksGuide() {
  const dailyStr = money(
    Math.max(0.01, Number(state.settings.contributionAmount) || 5),
  );
  const rows = [
    [
      `<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="11" width="7" height="10" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>`,
      "Dashboard",
      `<p>Your home overview — total collected, total expenses, current balance, and how many students are fully paid.</p><p><b>Recent transactions</b> shows the latest activity; tap <b>View all</b> to open full records grouped by day.</p>`,
    ],
    [
      `<path d="M13 2 5 13h5l-1 9 8-12h-5l1-8z"/>`,
      "Quick Record",
      `<p>The fastest way to collect. Search a name and tap <b>Record ${dailyStr}</b> to log one class-day payment.</p><p>Turn on <b>Override amount</b> to collect several days in one payment (e.g. a bigger amount). A running total and an <b>Undo</b> button appear as you record.</p>`,
    ],
    [
      `<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3 2.6-5 5.5-5s5.5 2 5.5 5"/><path d="M16.5 5.2a3.2 3.2 0 0 1 0 6.1"/><path d="M20.5 20c0-2.4-1.6-4.2-3.8-4.8"/>`,
      "Students",
      `<p>Your class list, grouped into <b>Boys</b> and <b>Girls</b> (with an Unspecified group until you set gender). Filter by gender and status, e.g. Girls + Participating.</p><p><b>Tap any student</b> to open their details — balance, today's status, full payment history, and Edit/Delete. Mark each <b>Participating</b> or <b>Not participating</b>; only Participating are counted for dues.</p>`,
    ],
    [
      `<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>`,
      "Collection Sessions",
      `<p>For counting physical cash. <b>Start a session</b> before collecting, add the payments you take (or tap <b>Add all from this day</b>), then <b>Close</b> it and enter the cash you counted.</p><p>The app compares counted cash to recorded payments and flags a shortage or a match.</p>`,
    ],
    [
      `<path d="M6 2.5h12v19l-3-1.7-3 1.7-3-1.7-3 1.7z"/><path d="M9 7h6M9 11h6M9 15h4"/>`,
      "Expenses",
      `<p>Money the class spends. Record each expense with a category, amount, and description.</p><p>Expenses subtract from your balance and appear in <b>Reports</b>.</p>`,
    ],
    [
      `<path d="M4 4v16h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/>`,
      "Reports",
      `<p>A one-glance financial overview: the <b>Treasury Summary</b> shows Collected, Expenses, and Balance, plus students, contributors, and unpaid dues.</p><p><b>Collection Overview</b> shows expected vs collected with a progress bar; <b>Student Contribution Status</b> counts who's paid, partial, unpaid, or in advance; and <b>Expense Breakdown</b> lists spending by category.</p><p>Use <b>Export JSON Backup</b> to save all data, <b>Export Transactions CSV</b> for a spreadsheet, or <b>Print Report</b> for a paper copy.</p>`,
    ],
    [
      `<rect x="3.5" y="4.5" width="17" height="16" rx="2"/><path d="M3.5 9h17M8 2.5v4M16 2.5v4"/>`,
      "Recording Date",
      `<p>Use this only to <b>back-date</b>. Forgot to collect on a past day? Set the recording date to that day, record everyone, then tap <b>Back to today</b>.</p><p>Future dates aren't allowed. A yellow banner reminds you on the dashboard while you're back-dated.</p>`,
    ],
    [
      `<circle cx="12" cy="12" r="8.5"/><path d="M12 12V3.5M12 12l7.4 4.2"/>`,
      "Payment Allocation",
      `<p>How one payment is split across class days. Each class day (Mon–Fri, minus holidays you set) costs the fixed daily amount.</p><p>When you record a payment you choose how much covers <b>past due</b> days, <b>today</b>, and <b>advance</b> (future) days. Amounts are whole multiples of the daily amount — no partial days.</p>`,
    ],
    [
      `<path d="M12 3l7 3v5.5c0 4.3-3 7.4-7 8.5-4-1.1-7-4.2-7-8.5V6z"/><path d="M9 12l2 2 4-4.5"/>`,
      "Backup & Data Safety",
      `<p>Your data is saved <b>only on this device</b> — there is no cloud. Export a <b>JSON backup</b> often from <b>Data &amp; backup</b>.</p><p><b>Restore</b> replaces everything with a backup; <b>Merge</b> adds payments collected on another phone. Always back up before big changes.</p>`,
    ],
    [
      `<path d="M4 7h16M9 7V4.2h6V7M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/>`,
      "Recycle Bin",
      `<p>A safety net. Deleted students, payments, and expenses go here and can be <b>Restored</b> or removed for good.</p><p>Note: <b>Delete all</b> in Contribution records is permanent and does <b>not</b> use the bin.</p>`,
    ],
    [
      `<circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.3 1.3c0 1.9-2.6 2.3-2.6 3.8"/><path d="M12 17.3h.01"/>`,
      "Which feature should I use?",
      `<div class="guide-tasks"><div class="guide-task"><span>Collect today's dues</span><b>Quick Record</b></div><div class="guide-task"><span>One student pays many days</span><b>Quick Record · Override</b></div><div class="guide-task"><span>Missed a past day</span><b>Recording date</b></div><div class="guide-task"><span>Count physical cash</span><b>Collection Sessions</b></div><div class="guide-task"><span>Add or rename a classmate</span><b>Students</b></div><div class="guide-task"><span>See one person's payments</span><b>Students · History</b></div><div class="guide-task"><span>Class spent money</span><b>Expenses</b></div><div class="guide-task"><span>Save or move data</span><b>Data &amp; backup</b></div><div class="guide-task"><span>Start a new school year</span><b>Backup, then Delete all</b></div></div>`,
    ],
    [
      `<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>`,
      "Important Things to Know",
      `<ul class="guide-steps"><li>Data lives on <b>this device only</b> — clearing browser data or uninstalling erases it. Keep backups.</li><li>No cloud sync; each device is separate. Use Backup/Merge to move data.</li><li>Your password is stored on this device. If forgotten, there's no recovery except clearing data.</li><li>Only <b>Participating</b> students are counted for dues and collection.</li><li>Works fully offline once installed.</li></ul>`,
    ],
  ];
  return `<p class="guide-intro">This is an offline class-treasury tracker for your section. Record daily contributions, see who has paid, log expenses, and reconcile cash — everything is saved on this device. Tap a topic to learn more.</p><div class="guide-list">${rows.map(([ic, t, b]) => guideRow(ic, t, b)).join("")}</div>`;
}
function renderSettings() {
  return `<div class="view settings-view"><details class="settings-section panel glass" open><summary class="settings-summary"><span class="settings-summary-title">General</span><span class="settings-chevron" aria-hidden="true">⌄</span></summary><div class="settings-subhead">Treasury identity</div><div class="form-field"><label>Class / Organization name</label><input class="input" id="settingClass" maxlength="40" value="${esc(state.settings.className)}"></div><div class="form-field" style="margin-top:13px"><label>Department <span class="muted">(optional)</span></label><input class="input" id="settingDepartment" maxlength="80" value="${esc(state.settings.departmentName || "")}" placeholder="e.g. College of Computer Studies"></div><div class="form-field" style="margin-top:13px"><label>Tagline <span class="muted">(optional)</span></label><input class="input" id="settingTagline" maxlength="80" value="${esc(state.settings.tagline || "")}" placeholder="e.g. Offline-first Treasurer Dashboard"></div><div class="form-field" style="margin-top:13px"><label>Event</label><input class="input" id="settingEvent" value="${esc(state.settings.eventName)}"></div><div class="settings-subhead">Contribution settings</div><div class="form-field"><label>Daily contribution amount</label><input class="input" id="settingAmount" type="number" min="0.01" step="0.01" value="${Number(state.settings.contributionAmount) || 5}"><div class="footer-note">Each class day creates exactly this amount. Payments must be whole multiples of it.</div></div><div class="form-field" style="margin-top:13px"><label>Contribution start date</label><input class="input" id="settingStartDate" type="date" max="${localDateKey(new Date())}" value="${esc(state.settings.contributionStartDate || "")}"><div class="footer-note">The first class day contributions count from. Leave blank to use the earliest student's date.</div></div>${noClassDatesSection()}<button class="primary-btn" style="margin-top:15px" data-action="save-settings">Save settings</button></details><details class="settings-section panel glass"><summary class="settings-summary"><span class="settings-summary-title">Data & backup</span><span class="settings-chevron" aria-hidden="true">⌄</span></summary><div class="data-actions"><div class="data-action-card kind-export"><div class="data-action-icon">⬇</div><div class="data-action-body"><strong>Export full backup</strong><p>Download students, transactions, settings and audit data.</p></div><button class="data-action-btn" data-action="export-json">Download JSON</button></div><div class="data-action-card kind-restore"><div class="data-action-icon">↻</div><div class="data-action-body"><strong>Restore backup</strong><p>Import a JSON backup into this browser.</p><span class="data-action-tag warn">⚠ Replaces all current data</span></div><label class="data-action-btn file-btn">Choose file<input type="file" id="importFile" accept="application/json"></label></div><div class="data-action-card kind-merge"><div class="data-action-icon">⇄</div><div class="data-action-body"><strong>Merge from another device</strong><p>Add payment records collected on another phone (e.g. by an assistant), matched to your existing students.</p><span class="data-action-tag safe">✓ Adds only, doesn't replace</span></div><label class="data-action-btn file-btn">Choose file<input type="file" id="mergeFile" accept="application/json"></label></div><div class="data-action-card kind-csv"><div class="data-action-icon">▤</div><div class="data-action-body"><strong>Export CSV</strong><p>Spreadsheet-friendly transaction history.</p></div><div class="data-action-btn-group"><button class="data-action-btn" data-action="export-csv">Transactions</button><button class="data-action-btn" data-action="export-students-csv">Students</button></div></div></div><p class="footer-note">IndexedDB is used as the primary local database. Keep a JSON backup somewhere safe.</p></details><details class="settings-section panel glass"><summary class="settings-summary"><span class="settings-summary-title">Recording date</span><span class="badge ${state.settings.appDateKey ? "expense" : "active"} settings-summary-badge">${state.settings.appDateKey ? "Back-dated" : "Today"}</span><span class="settings-chevron" aria-hidden="true">⌄</span></summary><p class="settings-section-sub muted">The date new payments and "today" totals are recorded against. Leave on Today for normal use.</p><div class="app-date-controls"><div><strong>${dateOnly(effectiveTodayDate())}</strong><span class="muted">${state.settings.appDateKey ? `Back-dated from today (${dateOnly(new Date())})` : "Using your device date"}</span></div><input class="input app-date-input" id="recordingDatePicker" type="date" max="${localDateKey(new Date())}" value="${effectiveTodayKey()}" aria-label="Recording date">${state.settings.appDateKey ? button("Back to today", "ghost-btn", 'data-action="reset-app-date"') : ""}</div><div class="footer-note">Pick a date and it applies right away. Forgot to collect last Friday? Set the date to that Friday, record everyone, then tap "Back to today" — you can repeat this for several past days.</div></details><details class="settings-section panel glass"><summary class="settings-summary"><span class="settings-summary-title">How it works</span><span class="settings-chevron" aria-hidden="true">⌄</span></summary>${howItWorksGuide()}</details><details class="settings-section panel glass"><summary class="settings-summary"><span class="settings-summary-title">Security</span><span class="settings-chevron" aria-hidden="true">⌄</span></summary><div class="setting-row"><div><strong>Treasurer password</strong><p>${isCustomPasswordSet() ? "Custom password set · unlocks this dashboard on this device." : "Using the default password · set your own to secure the dashboard."}</p></div>${button("Change password", "small-btn", 'data-action="change-password"')}</div><div class="setting-row"><div><strong>Offline mode</strong><p>Service worker caches the application shell.</p></div><span class="badge paid">PWA ready</span></div></details></div>`;
}

function bindViewEvents() {
  $("#quickRecordSearch")?.addEventListener("input", (e) => {
    const list = $("#quickStudentList");
    if (list) list.innerHTML = quickStudentList(e.target.value);
    updateQuickRecordButtons();
  });
  $("#quickOverrideToggle")?.addEventListener("change", (e) => {
    quickOverrideOn = e.target.checked;
    const input = $("#quickOverrideAmount");
    if (input) {
      input.disabled = !e.target.checked;
      if (e.target.checked) {
        input.focus();
        input.select();
      }
      updateQuickRecordButtons();
    }
  });
  $("#quickOverrideAmount")?.addEventListener("input", (e) => {
    quickOverrideValue = e.target.value;
    updateQuickRecordButtons();
  });
  if ($("#quickStudentList")) updateQuickRecordButtons();
  if (bulkRecordMode) {
    const bulkDate = $("#bulkDateInput");
    if (bulkDate) {
      bulkDate.addEventListener("change", (e) => {
        bulkRecordDate = e.target.value;
        renderBulkUpdate();
      });
    }
    const bulkAmount = $("#bulkAmountInput");
    if (bulkAmount) {
      bulkAmount.addEventListener("input", (e) => {
        bulkRecordAmount = e.target.value;
        renderBulkUpdate();
      });
    }
    const bulkSearch = $("#bulkSearchInput");
    if (bulkSearch) {
      bulkSearch.addEventListener("input", (e) => {
        renderBulkUpdate(e.target.value);
      });
    }
    renderBulkUpdate();
  }
  const refreshStudentsTable = () => {
    const el = $("#studentsTable");
    if (el)
      el.innerHTML = studentsTable(
        $("#studentSearch")?.value || "",
        $("#studentStatusFilter")?.value || "all",
        $("#studentGenderFilter")?.value || "all",
      );
  };
  $("#studentSearch")?.addEventListener("input", refreshStudentsTable);
  $("#studentStatusFilter")?.addEventListener("change", refreshStudentsTable);
  $("#studentGenderFilter")?.addEventListener("change", refreshStudentsTable);
  if ($("#studentsTable")) refreshStudentsTable();
  $("#contributionSearch")?.addEventListener("input", () => {
    refreshContributionTable();
  });
  $("#contributionDateFilter")?.addEventListener("change", () => {
    refreshContributionTable();
  });
  if ($("#contributionTable")) refreshContributionTable();
  $("#expenseSearch")?.addEventListener("input", (e) => {
    $("#expenseTable").innerHTML = expenseTable(
      e.target.value,
      $("#expenseDateFilter").value,
    );
  });
  $("#expenseDateFilter")?.addEventListener("change", (e) => {
    $("#expenseTable").innerHTML = expenseTable(
      $("#expenseSearch").value,
      e.target.value,
    );
  });
  if ($("#expenseTable")) $("#expenseTable").innerHTML = expenseTable();
  $("#activitySearch")?.addEventListener("input", (e) => {
    $("#activityList").innerHTML = activityList(
      e.target.value,
      $("#activityDateFilter").value,
    );
  });
  $("#activityDateFilter")?.addEventListener("change", (e) => {
    $("#activityList").innerHTML = activityList(
      $("#activitySearch").value,
      e.target.value,
    );
  });
  if ($("#activityList")) $("#activityList").innerHTML = activityList();
  $("#importFile")?.addEventListener("change", handleImport);
  $("#mergeFile")?.addEventListener("change", handleMergeFile);
  $("#addNoClassDateBtn")?.addEventListener("click", addNoClassDate);
  $("#recordingDatePicker")?.addEventListener("change", async (e) => {
    const key = e.target.value;
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key))
      return showToast("Choose a valid date.", "error");
    const deviceKey = localDateKey(new Date());
    if (key > deviceKey) {
      render();
      return showToast(
        "You can't set a future recording date. Pick today or a past day.",
        "error",
      );
    }
    if (key === deviceKey) {
      await saveSetting("appDateKey", "");
      await log("Reset recording date", "Recording date returned to today.");
    } else {
      await saveSetting("appDateKey", key);
      await log(
        "Set recording date",
        `Recording date set to ${dateOnly(dateFromKey(key))}.`,
      );
    }
    await refresh();
    render();
    showToast(
      key === deviceKey
        ? "Recording date: Today"
        : `Recording date: ${dateOnly(dateFromKey(key))}`,
    );
  });
}

function displayStudent(s) {
  return s?.alias ? `${s.name} — ${s.alias}` : s?.name || "Unknown student";
}
function effectiveTodayKey() {
  return state.settings.appDateKey || localDateKey(new Date());
}
function effectiveTodayDate() {
  return dateFromKey(effectiveTodayKey());
}
function localDateKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dateFromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
function nextDateKey(key) {
  const d = dateFromKey(key);
  d.setDate(d.getDate() + 1);
  return localDateKey(d);
}
function isNoClassDate(key) {
  return (
    Array.isArray(state.settings.noClassDates) &&
    state.settings.noClassDates.some(
      (x) => (typeof x === "string" ? x : x?.date) === key,
    )
  );
}
function noClassDatesList() {
  return (
    Array.isArray(state.settings.noClassDates)
      ? state.settings.noClassDates
      : []
  )
    .map((x) =>
      typeof x === "string"
        ? { date: x, label: "" }
        : { date: x.date, label: x.label || "" },
    )
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}
async function addNoClassDate() {
  const dateInput = $("#noClassDateInput");
  const labelInput = $("#noClassLabelInput");
  const date = dateInput?.value;
  if (!date) return showToast("Pick a date first.", "error");
  const label = (labelInput?.value || "").trim();
  const current = noClassDatesList().filter((x) => x.date !== date);
  current.push({ date, label });
  await saveSetting(
    "noClassDates",
    current.sort((a, b) => a.date.localeCompare(b.date)),
  );
  await log(
    "Added no-class date",
    `${dateOnly(dateFromKey(date))}${label ? ` — ${label}` : ""} marked as no class.`,
  );
  await refresh();
  render();
  showToast("No-class date added");
}
async function removeNoClassDate(date) {
  const current = noClassDatesList().filter((x) => x.date !== date);
  await saveSetting("noClassDates", current);
  await log(
    "Removed no-class date",
    `${dateOnly(dateFromKey(date))} is no longer marked as no class.`,
  );
  await refresh();
  render();
  showToast("No-class date removed");
}
function noClassDatesSection() {
  const items = noClassDatesList();
  const rows = items.length
    ? items
        .map(
          (x) =>
            `<div class="noclass-row"><div class="noclass-row-info"><strong>${dateOnly(dateFromKey(x.date))}</strong>${x.label ? `<span>${esc(x.label)}</span>` : ""}</div>${button("Remove", "small-btn danger", `data-remove-noclass="${x.date}"`)}</div>`,
        )
        .join("")
    : '<div class="empty">No holidays added yet.</div>';
  return `<div class="form-field"><label>No-class / holiday dates</label><div class="noclass-add-row"><input class="input" id="noClassDateInput" type="date"><input class="input" id="noClassLabelInput" type="text" placeholder="Label (optional)"><button type="button" class="ghost-btn" id="addNoClassDateBtn">+ Add</button></div><div class="noclass-list">${rows}</div><div class="footer-note">Weekends are automatically skipped — only add specific weekday holidays or breaks here.</div></div>`;
}
function isClassDay(key) {
  const d = dateFromKey(key);
  const day = d.getDay();
  return day !== 0 && day !== 6 && !isNoClassDate(key);
}
function addClassDay(startKey, offset) {
  let key = startKey,
    count = 0,
    guard = 0;
  while (guard++ < 3700) {
    if (isClassDay(key)) {
      if (count === offset) return key;
      count++;
    }
    key = nextDateKey(key);
  }
  return startKey;
}
function classDaysThrough(startKey, endKey) {
  const out = [];
  let key = startKey,
    guard = 0;
  while (key <= endKey && guard++ < 3700) {
    if (isClassDay(key)) out.push(key);
    key = nextDateKey(key);
  }
  return out;
}
function classStartKey() {
  if (
    typeof state.settings.contributionStartDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(state.settings.contributionStartDate)
  )
    return state.settings.contributionStartDate;
  if (!state.students.length) return effectiveTodayKey();
  return state.students
    .map((x) => localDateKey(x.createdAt || new Date()))
    .reduce((min, d) => (d < min ? d : min));
}
function studentLedger(studentId, asOfKey = effectiveTodayKey()) {
  const s = state.students.find((x) => x.id === studentId);
  if (!s)
    return {
      due: [],
      paid: [],
      unpaid: [],
      advance: [],
      outstanding: 0,
      totalReceived: 0,
      allocByPayment: {},
    };
  const daily = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const start = classStartKey();
  const payments = state.contributions
    .filter((x) => x.studentId === studentId)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const allocatedDates = [];
  const allocByPayment = {};
  for (const p of payments) {
    const arr = Array.isArray(p.allocations) ? p.allocations : [];
    if (arr.length)
      allocByPayment[p.id] = arr.map((a) => ({
        ...a,
        amount: Number(a.amount) || daily,
      }));
    else allocByPayment[p.id] = [];
    for (const a of allocByPayment[p.id])
      if (a.date)
        allocatedDates.push({ ...a, paymentAt: p.at, paymentId: p.id });
  }
  let maxDate = asOfKey;
  for (const a of allocatedDates) if (a.date > maxDate) maxDate = a.date;
  const allDates = classDaysThrough(start, maxDate);
  const dueMap = new Map(
    allDates.map((k) => [
      k,
      { date: k, amount: daily, status: "unpaid", sourcePaymentId: null },
    ]),
  );
  for (const a of allocatedDates) {
    if (!dueMap.has(a.date))
      dueMap.set(a.date, {
        date: a.date,
        amount: daily,
        status: a.status === "advance" ? "advance" : "paid",
        sourcePaymentId: a.paymentId,
      });
    const d = dueMap.get(a.date);
    d.status = a.status === "advance" ? "advance" : "paid";
    d.sourcePaymentId = a.paymentId;
  }
  const due = [...dueMap.values()].filter((x) => x.date <= asOfKey);
  const unpaid = due.filter((x) => x.status === "unpaid");
  const paid = due.filter((x) => x.status === "paid");
  const advance = [...dueMap.values()].filter((x) => x.status === "advance");
  return {
    daily,
    start,
    due,
    paid,
    unpaid,
    advance,
    outstanding: unpaid.length * daily,
    totalReceived: payments.reduce((a, x) => a + (Number(x.amount) || 0), 0),
    allocByPayment,
  };
}
function ledgerBeforePayment(studentId, paymentId, paymentAt) {
  const original = state.contributions;
  state.contributions = original.filter((x) => x.id !== paymentId);
  const l = studentLedger(studentId, localDateKey(paymentAt || new Date()));
  state.contributions = original;
  return l;
}
function allocationForAmount(studentId, amount, paymentAt) {
  const daily = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const key = effectiveTodayKey();
  const before = ledgerBeforePayment(
    studentId,
    "__new__",
    effectiveTodayDate(),
  );
  const past = before.unpaid.filter((x) => x.date < key);
  const today = before.due.find((x) => x.date === key && x.status === "unpaid");
  return {
    daily,
    key,
    past,
    today,
    maxPast: past.length * daily,
    maxToday: today ? daily : 0,
    advanceStart: past.length ? past[past.length - 1].date : key,
  };
}
function allocationSummary(studentId) {
  const l = studentLedger(studentId);
  return `${l.unpaid.length} unpaid · ${l.advance.length} advance`;
}
function persistStudentAllocations(studentId) {
  const payments = state.contributions.filter((x) => x.studentId === studentId);
  const l = studentLedger(studentId);
  return Promise.all(
    payments.map(async (p) => {
      p.allocations = l.allocByPayment[p.id] || [];
      p.unallocatedAmount = 0;
      await put("contributions", p);
    }),
  );
}

async function studentModal(student) {
  const s = student || { id: "", name: "", alias: "", status: "Active", gender: "" };
  modal(
    student ? "Edit Student" : "Add Student",
    `<form id="studentForm"><div class="form-field"><label>Name</label><input class="input" id="studentName" required maxlength="100" value="${esc(s.name)}" placeholder="e.g. Juan Dela Cruz"></div><div class="form-field" style="margin-top:13px"><label>Another name / identifier <span class="muted">(optional)</span></label><input class="input" id="studentAlias" maxlength="60" value="${esc(s.alias || "")}" placeholder="e.g. Juan 2, J. Dela Cruz, or nickname"><div class="footer-note">Use this when two classmates have the same name. It makes contribution records easier to identify.</div></div><div class="form-field" style="margin-top:13px"><label>Status</label><select class="select" id="studentStatus"><option value="Active" ${s.status === "Active" ? "selected" : ""}>Participating</option><option value="Inactive" ${s.status === "Inactive" ? "selected" : ""}>Not participating</option></select></div><div class="form-field" style="margin-top:13px"><label>Gender <span class="muted">(optional)</span></label><div class="seg-group" id="studentGenderGroup"><button type="button" class="seg-btn${!s.gender ? " active" : ""}" data-gender="">Not set</button><button type="button" class="seg-btn${s.gender === "Male" ? " active" : ""}" data-gender="Male">Male</button><button type="button" class="seg-btn${s.gender === "Female" ? " active" : ""}" data-gender="Female">Female</button></div><input type="hidden" id="studentGender" value="${esc(s.gender || "")}"><div class="footer-note">For grouping and filtering only — it does not affect any calculations.</div></div><div class="modal-actions"><button type="button" class="ghost-btn" data-close-modal>Cancel</button><button class="primary-btn">Save student</button></div></form>`,
  );
  $$("#studentGenderGroup .seg-btn").forEach((b) => {
    b.onclick = () => {
      $("#studentGender").value = b.dataset.gender;
      $$("#studentGenderGroup .seg-btn").forEach((x) =>
        x.classList.toggle("active", x === b),
      );
    };
  });
  $("#studentForm").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#studentName").value.trim(),
      alias = $("#studentAlias").value.trim();
    if (!name) return;
    const obj = {
      id: s.id || uid("stu"),
      name,
      alias,
      status: $("#studentStatus").value,
      gender: $("#studentGender").value || "",
      createdAt: s.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await put("students", obj);
    await log(
      student ? "Updated student" : "Added student",
      displayStudent(obj),
    );
    await refresh();
    closeModal();
    render();
    showToast(student ? "Student updated" : "Student added");
  };
}

async function contributionModal(existing, studentId) {
  const activeStudents = state.students
    .filter((s) => s.status === "Active")
    .sort((a, b) => displayStudent(a).localeCompare(displayStudent(b)));
  if (
    existing?.studentId &&
    !activeStudents.some((s) => s.id === existing.studentId)
  ) {
    const cur = state.students.find((s) => s.id === existing.studentId);
    if (cur) activeStudents.unshift(cur);
  }
  if (!activeStudents.length)
    return showToast("No participating students available.", "error");
  const daily = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const c = existing || {
    id: "",
    amount: daily,
    at: effectivePaymentISO(),
    studentId: studentId || "",
  };
  let selectedId = existing?.studentId || studentId || "";
  const preselect = selectedId
    ? activeStudents.find((s) => s.id === selectedId)
    : null;
  const rowsHtml = (q = "") => {
    const ql = q.trim().toLowerCase();
    const list = activeStudents.filter((s) =>
      displayStudent(s).toLowerCase().includes(ql),
    );
    if (!list.length)
      return '<div class="empty">No students match your search.</div>';
    return list
      .map(
        (s) =>
          `<button type="button" class="student-pick${s.id === selectedId ? " selected" : ""}" data-pick-student="${s.id}"><span>${esc(displayStudent(s))}</span>${s.id === selectedId ? '<span class="student-pick-check">✓</span>' : ""}</button>`,
      )
      .join("");
  };
  const initialQuery = preselect ? displayStudent(preselect) : "";
  modal(
    existing ? "Edit Contribution" : "Record Contribution",
    `<form id="contributionForm"><input type="hidden" id="contributionStudent" value="${esc(selectedId)}"><div class="form-field"><label>Student</label><input class="input" id="contributionStudentSearch" value="${esc(initialQuery)}" placeholder="Search student name or identifier..." autocomplete="off"><div class="student-pick-list" id="contributionStudentList">${rowsHtml(initialQuery)}</div></div><div class="form-grid" style="margin-top:13px"><div class="form-field"><label>Amount received</label><input class="input" id="contributionAmount" type="number" min="${daily}" step="${daily}" value="${Number(c.amount)}" required></div><div class="form-field"><label>Date & time</label><input class="input" id="contributionAt" type="datetime-local" value="${toLocalInput(c.at)}" required><div class="footer-note">New payments use the current recording date. The real recording time is kept separately for the audit trail.</div></div></div><div class="footer-note">Pick a student, enter the amount, then choose how much goes to past balance, today, and advance payment.</div><div class="modal-actions"><button type="button" class="ghost-btn" data-close-modal>Cancel</button><button class="primary-btn">Continue to allocation</button></div></form>`,
  );
  const listEl = $("#contributionStudentList");
  const searchEl = $("#contributionStudentSearch");
  const hidden = $("#contributionStudent");
  searchEl?.addEventListener("input", (e) => {
    listEl.innerHTML = rowsHtml(e.target.value);
  });
  listEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pick-student]");
    if (!btn) return;
    selectedId = btn.dataset.pickStudent;
    hidden.value = selectedId;
    listEl.innerHTML = rowsHtml(searchEl.value);
  });
  $("#contributionForm").onsubmit = (e) => {
    e.preventDefault();
    const sid = $("#contributionStudent").value;
    if (!sid) return showToast("Choose a student first.", "error");
    const value = Number($("#contributionAmount").value);
    const entered = $("#contributionAt").value;
    const at = existing
      ? new Date(entered)
      : new Date(effectivePaymentISO(entered));
    if (
      !Number.isFinite(value) ||
      value < daily ||
      Math.abs(value / daily - Math.round(value / daily)) > 1e-9
    )
      return showToast(
        `Amount must be ${money(daily)} or a multiple of it.`,
        "error",
      );
    closeModal();
    manualAllocationModal({
      existing,
      studentId: sid,
      amount: value,
      at: at.toISOString(),
    });
  };
}
function manualAllocationModal({ existing, studentId, amount, at, source }) {
  const s = state.students.find((x) => x.id === studentId);
  if (!s) return;
  const daily = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const info = allocationForAmount(studentId, amount, at);
  const prior = existing?.allocations || [];
  const priorPast = prior
    .filter((a) => a.date < info.key && a.status !== "advance")
    .reduce((a, x) => a + (Number(x.amount) || daily), 0);
  const priorToday = prior
    .filter((a) => a.date === info.key && a.status !== "advance")
    .reduce((a, x) => a + (Number(x.amount) || daily), 0);
  const priorAdvance = prior
    .filter((a) => a.status === "advance")
    .reduce((a, x) => a + (Number(x.amount) || daily), 0);
  const defaultPast = Math.min(
    amount,
    priorPast || Math.min(amount, Math.max(0, amount - daily)),
  );
  const defaultToday = Math.min(
    daily,
    priorToday || Math.max(0, Math.min(daily, amount - defaultPast)),
  );
  const defaultAdvance = Math.max(0, amount - defaultPast - defaultToday);
  const todayIsClassDay = isClassDay(info.key);
  modal(
    "Allocate Payment",
    `<form id="allocationForm"><div class="history-summary"><div><span class="muted">Student</span><strong>${esc(displayStudent(s))}</strong></div><div><span class="muted">Payment received</span><strong>${money(amount)}</strong></div><div><span class="muted">Date</span><strong>${dateTime(at)}</strong></div></div><div class="allocation-grid"><div class="form-field"><label>Past balance</label><input class="input" id="allocPast" type="number" min="0" max="${amount}" step="${daily}" value="${defaultPast}"><div class="footer-note">Manual past balance. Enter the amount you want this payment to settle; no past date is required.</div></div><div class="form-field"><label>Today's contribution</label><input class="input" id="allocToday" type="number" min="0" max="${todayIsClassDay ? daily : 0}" step="${daily}" value="${defaultToday}"><div class="footer-note">${todayIsClassDay ? `Today: ${dateOnly(info.key)} · ${money(daily)}` : "No class today."}</div></div><div class="form-field"><label>Advance payment</label><input class="input" id="allocAdvance" type="number" min="0" max="${amount}" step="${daily}" value="${defaultAdvance}"><div class="footer-note">Covers future class days.</div></div></div><div class="allocation-total"><span>Allocated</span><strong id="allocationTotal">${money(defaultPast + defaultToday + defaultAdvance)}</strong><span id="allocationRemaining">${Math.abs(defaultPast + defaultToday + defaultAdvance - amount) < 0.001 ? "✓ Fully allocated" : `Remaining ${money(amount - defaultPast - defaultToday - defaultAdvance)}`}</span></div><div class="modal-actions"><button type="button" class="ghost-btn" data-close-modal>Cancel</button><button class="primary-btn">${existing ? "Save allocation" : "Record payment"}</button></div></form>`,
  );
  const update = () => {
    const p = Number($("#allocPast").value) || 0,
      t = Number($("#allocToday").value) || 0,
      a = Number($("#allocAdvance").value) || 0,
      total = p + t + a;
    $("#allocationTotal").textContent = money(total);
    $("#allocationRemaining").textContent =
      Math.abs(total - amount) < 0.001
        ? "✓ Fully allocated"
        : total < amount
          ? `Remaining ${money(amount - total)}`
          : `Over by ${money(total - amount)}`;
  };
  ["#allocPast", "#allocToday", "#allocAdvance"].forEach((sel) =>
    $(sel).addEventListener("input", update),
  );
  $("#allocationForm").onsubmit = async (e) => {
    e.preventDefault();
    const past = Number($("#allocPast").value) || 0,
      today = Number($("#allocToday").value) || 0,
      advance = Number($("#allocAdvance").value) || 0,
      total = past + today + advance;
    if (Math.abs(total - amount) > 0.001)
      return showToast(
        `Allocation must equal the received amount of ${money(amount)}.`,
        "error",
      );
    if (today > 0 && !isClassDay(info.key))
      return showToast(
        "Today is not a class day, so today's contribution must be 0.",
        "error",
      );
    if (today > daily + 0.001)
      return showToast(
        `Today's contribution can only be ${money(daily)}.`,
        "error",
      );
    if (
      [past, today, advance].some(
        (v) => v < 0 || Math.abs(v / daily - Math.round(v / daily)) > 1e-9,
      )
    )
      return showToast(
        `Each allocation must use ${money(daily)} units.`,
        "error",
      );
    const allocations = [];
    let pastRemaining = past;
    for (const d of info.past) {
      if (pastRemaining + 1e-9 < daily) break;
      allocations.push({ date: d.date, amount: daily, status: "paid" });
      pastRemaining -= daily;
    }
    const manualPast = Math.max(0, pastRemaining);
    if (manualPast > 0)
      allocations.push({ date: null, amount: manualPast, status: "past" });
    if (today > 0)
      allocations.push({ date: info.key, amount: daily, status: "paid" });
    let cursor = addClassDay(info.key, 1);
    let remainingAdvance = advance;
    while (remainingAdvance + 1e-9 >= daily) {
      allocations.push({ date: cursor, amount: daily, status: "advance" });
      remainingAdvance -= daily;
      cursor = addClassDay(cursor, 1);
    }
    const activeSession = getCollectionSession(localDateKey(at));
    const sessionId =
      existing?.sessionId ||
      (!existing && activeSession && activeSession.status === "open"
        ? activeSession.id
        : "");
    const obj = {
      id: existing?.id || uid("pay"),
      studentId,
      amount,
      at,
      recordedAt: existing?.recordedAt || new Date().toISOString(),
      by: existing?.by || ADMIN,
      event: existing?.event || state.settings.eventName,
      allocations,
      unallocatedAmount: 0,
      sessionId,
    };
    await put("contributions", obj);
    if (
      sessionId &&
      activeSession &&
      !activeSession.paymentIds.includes(obj.id)
    ) {
      activeSession.paymentIds.push(obj.id);
      await persistCollectionSessions();
    }
    await refresh();
    await log(
      existing ? "Updated contribution" : "Recorded contribution",
      `${displayStudent(s)} — ${money(amount)} (${money(past)} past · ${money(today)} today · ${money(advance)} advance)`,
    );
    await refresh();
    closeModal();
    render();
    if (source === "quickRecord" && !existing) {
      quickSessionTotal += amount;
      quickSessionCount += 1;
      vibrate();
      showActionToast(
        `Recorded ${money(amount)} for ${displayStudent(s)}`,
        "Undo",
        () => undoQuickRecordPayment(obj.id, amount),
      );
    } else {
      showToast(
        existing ? "Contribution updated" : "Payment recorded and allocated",
      );
    }
  };
}
function paymentHistoryModal(studentId) {
  const s = state.students.find((x) => x.id === studentId);
  if (!s) return;
  const ledger = studentLedger(studentId);
  const payments = state.contributions
    .filter((x) => x.studentId === studentId)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  const total = payments.reduce((a, x) => a + Number(x.amount || 0), 0);
  const todayKey = effectiveTodayKey();
  const todayDue = ledger.due.find((x) => x.date === todayKey);
  const todayStatus = !isClassDay(todayKey)
    ? "No class today"
    : todayDue?.status === "paid"
      ? "Paid today"
      : todayDue?.status === "advance"
        ? "Paid in advance"
        : "Due today";
  const balanceText = ledger.outstanding
    ? money(ledger.outstanding) + " due"
    : ledger.advance.length
      ? `${ledger.advance.length} day${ledger.advance.length === 1 ? "" : "s"} ahead`
      : "Up to date";
  const statusClass = ledger.outstanding
    ? "expense"
    : ledger.advance.length
      ? "paid"
      : "active";
  const paymentCards = payments.length
    ? payments
        .map((x) => {
          const alloc = ledger.allocByPayment[x.id] || [];
          const allocTotal = alloc.reduce(
            (a, v) => a + Number(v.amount || 0),
            0,
          );
          const allocationRows = alloc
            .map((a) => {
              const label =
                a.status === "advance"
                  ? "Advance"
                  : a.date
                    ? "Settled"
                    : "Past balance";
              const sub = a.date
                ? dateOnly(a.date)
                : "Previously unpaid contribution";
              return `<div class="allocation-row"><div><strong>${label}</strong><span>${sub}</span></div><b>${money(a.amount)}</b></div>`;
            })
            .join("");
          return `<article class="payment-history-card">
      <div class="payment-history-main">
        <div class="payment-history-date"><span class="payment-dot"></span><div><strong>${dateOnly(x.at)}</strong><span>${new Date(x.at).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</span></div></div>
        <div class="payment-history-amount">${money(x.amount)}</div>
      </div>
      <div class="payment-history-meta"><span>${esc(x.event || state.settings.eventName)}</span><span>Recorded by ${esc(x.by || ADMIN)}</span></div>
      ${alloc.length ? `<details class="allocation-details"><summary><span>View allocation</span><span>${alloc.length} item${alloc.length === 1 ? "" : "s"} · ${money(allocTotal)}</span></summary><div class="allocation-list">${allocationRows}</div></details>` : '<div class="allocation-empty">No allocation details recorded.</div>'}
      <div class="payment-history-actions">${button("Edit", "small-btn", 'data-edit-contribution="' + x.id + '"')}${button("Delete", "small-btn danger", 'data-delete-contribution="' + x.id + '"')}</div>
    </article>`;
        })
        .join("")
    : '<div class="empty">No contribution payments recorded for this student yet.</div>';
  const unpaidSection = `<details class="ledger-section" ${ledger.unpaid.length ? "" : "open"}><summary><div><strong>Unpaid class days</strong><span>${ledger.unpaid.length ? `${ledger.unpaid.length} day${ledger.unpaid.length === 1 ? "" : "s"} · ${money(ledger.outstanding)} outstanding` : "None"}</span></div><span class="ledger-section-badge ${ledger.unpaid.length ? "danger" : "ok"}">${ledger.unpaid.length ? money(ledger.outstanding) : "Clear"}</span></summary><div class="ledger-list">${ledger.unpaid.length ? ledger.unpaid.map((x) => `<div><span>${dateOnly(x.date)}</span><strong>${money(x.amount)}</strong></div>`).join("") : '<span class="muted">No unpaid class days.</span>'}</div></details>`;
  const advanceSection = `<details class="ledger-section"><summary><div><strong>Paid in advance</strong><span>${ledger.advance.length ? `${ledger.advance.length} future class day${ledger.advance.length === 1 ? "" : "s"}` : "None"}</span></div><span class="ledger-section-badge ${ledger.advance.length ? "ok" : "neutral"}">${ledger.advance.length ? `${ledger.advance.length} day${ledger.advance.length === 1 ? "" : "s"}` : "None"}</span></summary><div class="ledger-list">${ledger.advance.length ? ledger.advance.map((x) => `<div><span>${dateOnly(x.date)}</span><strong>${money(x.amount)}</strong></div>`).join("") : '<span class="muted">No advance payments.</span>'}</div></details>`;
  const body = `
    <div class="history-profile-head">
      <div class="history-avatar">${esc((s.name || "?").trim().charAt(0).toUpperCase())}</div>
      <div><strong>${esc(displayStudent(s))}</strong><span>${s.status === "Active" ? "Participating student" : "Not participating"}${s.gender ? ` · ${esc(s.gender)}` : ""}</span></div>
    </div>
    <div class="history-status-card"><div><span class="muted">Current balance</span><strong class="status-value ${statusClass}">${balanceText}</strong></div><div class="today-status"><span class="muted">Today</span><strong>${todayStatus}</strong></div></div>
    <div class="history-metrics"><div><span>Total received</span><strong>${money(total)}</strong></div><div><span>Payments</span><strong>${payments.length}</strong></div><div><span>Daily contribution</span><strong>${money(ledger.daily)}</strong></div></div>
    <div class="history-section-title"><div><strong>Payment history</strong><span>Actual money received</span></div></div>
    <div class="payment-history-list redesigned-history-list">${paymentCards}</div>
    <div class="history-ledger-stack">${unpaidSection}${advanceSection}</div>`;
  modal(
    "Student details",
    body,
    `<div class="modal-actions">${s.status === "Active" ? button("+ Record Payment", "primary-btn", 'data-record-student="' + s.id + '"') : ""}${button("Edit", "ghost-btn", 'data-edit-student="' + s.id + '"')}${button("Delete", "danger-btn", 'data-delete-student="' + s.id + '"')}<button class="ghost-btn" data-close-modal>Close</button></div>`,
  );
}

async function persistCollectionSessions() {
  await saveSetting("collectionSessions", state.collectionSessions);
}
async function startCollectionSessionForDate(dateKey) {
  if (getCollectionSession(dateKey))
    return showToast(
      "A collection session already exists for that date.",
      "error",
    );
  const session = {
    id: uid("sess"),
    date: dateKey,
    status: "open",
    startedAt: new Date().toISOString(),
    paymentIds: [],
    cashCounted: 0,
    difference: 0,
    note: "",
  };
  state.collectionSessions.unshift(session);
  await persistCollectionSessions();
  await log(
    "Started collection session",
    `Collection session started for ${dateOnly(dateFromKey(dateKey))}.`,
  );
  render();
  showToast("Collection session started");
}
async function startCollectionSession() {
  return startCollectionSessionForDate(effectiveTodayKey());
}
async function attachAllPaymentsToSession(sessionId) {
  const session = sessionId
    ? state.collectionSessions.find((x) => x.id === sessionId)
    : getCollectionSession();
  if (!session || session.status !== "open")
    return showToast("This collection session is not open.", "error");
  const assigned = new Set(session.paymentIds || []);
  const matches = state.contributions.filter(
    (p) => !assigned.has(p.id) && localDateKey(p.at) === session.date,
  );
  if (!matches.length)
    return showToast(
      `No unattached payments found for ${dateOnly(dateFromKey(session.date))}.`,
      "error",
    );
  for (const p of matches) session.paymentIds.push(p.id);
  await persistCollectionSessions();
  await log(
    "Added all payments to collection session",
    `${matches.length} payment${matches.length === 1 ? "" : "s"} from ${dateOnly(dateFromKey(session.date))} attached.`,
  );
  closeModal();
  render();
  showToast(
    `Added ${matches.length} payment${matches.length === 1 ? "" : "s"} to the session`,
  );
}
async function attachPaymentToSession(sessionId) {
  const session = sessionId
    ? state.collectionSessions.find((x) => x.id === sessionId)
    : getCollectionSession();
  if (!session || session.status !== "open")
    return showToast("This collection session is not open.", "error");
  const assigned = new Set(session.paymentIds || []);
  const options = state.contributions
    .filter((p) => !assigned.has(p.id))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .map((p) => {
      const s = state.students.find((x) => x.id === p.studentId);
      return `<option value="${p.id}">${esc(displayStudent(s))} — ${money(p.amount)} — ${dateTime(p.at)}</option>`;
    })
    .join("");
  if (!options)
    return showToast(
      "All payment records are already attached to sessions.",
      "error",
    );
  modal(
    "Add payment to session",
    `<form id="attachSessionForm"><div class="form-field"><label>Payment</label><select class="select" id="sessionPaymentSelect" required>${options}</select><div class="footer-note">This does not change the payment date or amount. It only groups the payment into the ${dateOnly(dateFromKey(session.date))} collection session.</div></div><div class="modal-actions"><button type="button" class="ghost-btn" data-close-modal>Cancel</button><button class="primary-btn">Add to session</button></div></form>`,
  );
  $("#attachSessionForm").onsubmit = async (e) => {
    e.preventDefault();
    const id = $("#sessionPaymentSelect").value;
    if (!session.paymentIds.includes(id)) session.paymentIds.push(id);
    await persistCollectionSessions();
    await log(
      "Attached payment to collection session",
      `Payment ${id} attached to ${dateOnly(dateFromKey(session.date))}.`,
    );
    closeModal();
    render();
    showToast("Payment added to session");
  };
}
async function deleteCollectionSession(sessionId, sessionDate) {
  let session = state.collectionSessions.find((x) => x.id === sessionId);
  if (!session && sessionId) {
    session = state.collectionSessions.find(
      (x) => String(x.id) === String(sessionId),
    );
  }
  if (!session && sessionDate) {
    session = state.collectionSessions.find((x) => x.date === sessionDate);
  }
  if (!session) return showToast("Collection session not found.", "error");
  const payments = state.contributions.filter((p) =>
    (session.paymentIds || []).includes(p.id),
  );
  const isClosed = session.status === "closed";
  const warning = isClosed
    ? "This session is already closed and reconciled. It will be moved to the Recycle Bin. Its payments will remain as normal payments, detached from the session."
    : "The session will be moved to the Recycle Bin. Its payments will remain as normal payments, detached from the session.";
  confirmAction(
    "Delete collection session?",
    `${warning} ${payments.length} payment${payments.length === 1 ? "" : "s"} will remain.`,
    async () => {
      await put("recycle", {
        id: uid("del"),
        originalId: session.id,
        store: "collectionSessions",
        type: "Collection Session",
        data: JSON.parse(JSON.stringify(session)),
        deletedAt: new Date().toISOString(),
        deletedBy: ADMIN,
      });
      for (const payment of payments) {
        if (payment.sessionId === session.id) {
          const updated = { ...payment };
          delete updated.sessionId;
          await put("contributions", updated);
        }
      }
      state.collectionSessions = state.collectionSessions.filter(
        (x) => x.id !== session.id,
      );
      await persistCollectionSessions();
      await log(
        "Deleted collection session",
        `${dateOnly(dateFromKey(session.date))} moved to recycle bin; ${payments.length} payment${payments.length === 1 ? "" : "s"} detached and preserved.`,
      );
      closeModal();
      await refresh();
      render();
      showToast("Session moved to recycle bin. Payments were preserved.");
    },
  );
}

async function closeCollectionSession() {
  const session = getCollectionSession();
  if (!session || session.status !== "open")
    return showToast("No open collection session today.", "error");
  const total = sessionTotal(session);
  modal(
    "Close collection session",
    `<form id="closeSessionForm"><div class="history-summary"><div><span class="muted">Collected</span><strong>${money(total)}</strong></div><div><span class="muted">Payments</span><strong>${(session.paymentIds || []).length}</strong></div><div><span class="muted">Date</span><strong>${dateOnly(dateFromKey(session.date))}</strong></div></div><div class="form-field"><label>Cash counted</label><input class="input" id="sessionCashCounted" type="number" min="0" step="0.01" value="${total.toFixed(2)}" required></div><div class="form-field" style="margin-top:13px"><label>Reconciliation note <span class="muted">(optional)</span></label><textarea class="textarea" id="sessionNote" rows="3" placeholder="e.g. Short by ₱5 — one payment was not yet recorded."></textarea></div><div class="modal-actions"><button type="button" class="ghost-btn" data-close-modal>Cancel</button><button class="primary-btn">Close session</button></div></form>`,
  );
  $("#closeSessionForm").onsubmit = async (e) => {
    e.preventDefault();
    const cash = Number($("#sessionCashCounted").value);
    if (!Number.isFinite(cash) || cash < 0)
      return showToast("Enter a valid cash count.", "error");
    session.cashCounted = cash;
    session.difference = cash - total;
    session.note = $("#sessionNote").value.trim();
    session.status = "closed";
    session.closedAt = new Date().toISOString();
    await persistCollectionSessions();
    await log(
      "Closed collection session",
      `${dateOnly(dateFromKey(session.date))} — collected ${money(total)}, cash counted ${money(cash)}, difference ${money(session.difference)}.`,
    );
    closeModal();
    render();
    showToast(
      Math.abs(session.difference) < 0.001
        ? "Session balanced and closed"
        : "Session closed with a cash difference",
      "success",
    );
  };
}
function renderTodayUnpaid() {
  const today = effectiveTodayKey();
  if (!isClassDay(today))
    return modal(
      "Today’s Collection",
      '<div class="empty">No class today, so there is no daily contribution to collect.</div>',
    );
  const daily = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const rows = state.students
    .filter((s) => s.status === "Active")
    .map((s) => {
      const l = studentLedger(s.id, today);
      const d = l.due.find((x) => x.date === today);
      return d?.status === "unpaid"
        ? `<div class="today-unpaid-row"><div><strong>${esc(displayStudent(s))}</strong><span>${l.outstanding ? `${money(l.outstanding)} total due` : "Due today"}</span></div>${button("Record " + money(daily), "small-btn primary-btn", 'data-record-student="' + s.id + '"')}</div>`
        : "";
    })
    .filter(Boolean)
    .join("");
  modal(
    "Not paid today",
    rows
      ? `<div class="today-unpaid-list">${rows}</div>`
      : '<div class="empty">Everyone is covered for today. 🎉</div>',
  );
}

async function undoQuickRecordPayment(paymentId, amount) {
  const x = state.contributions.find((c) => c.id === paymentId);
  if (!x)
    return showToast("That payment was already changed elsewhere.", "error");
  await softDelete("contributions", x, "Contribution");
  quickSessionTotal = Math.max(0, quickSessionTotal - amount);
  quickSessionCount = Math.max(0, quickSessionCount - 1);
  await refresh();
  render();
  showToast("Payment undone");
}
async function quickRecordContribution(studentId, amount) {
  const s = state.students.find((x) => x.id === studentId);
  if (!s) return;
  const daily = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const value = Number(amount);
  if (
    !Number.isFinite(value) ||
    value < daily ||
    Math.abs(value / daily - Math.round(value / daily)) > 1e-9
  )
    return showToast(
      `Amount must be ${money(daily)} or a multiple of it.`,
      "error",
    );
  const today = effectiveTodayKey();
  const already = state.contributions.filter(
    (x) => x.studentId === studentId && localDateKey(x.at) === today,
  );
  const save = async () => {
    closeModal();
    manualAllocationModal({
      studentId,
      amount: value,
      at: effectivePaymentISO(),
      source: "quickRecord",
    });
  };
  if (already.length)
    return confirmAction(
      "Record another payment?",
      `${esc(displayStudent(s))} already has ${already.length} payment${already.length === 1 ? "" : "s"} today. Record another ${money(value)} payment?`,
      save,
    );
  await save();
}
function updateQuickRecordButtons() {
  const fixed = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const override = $("#quickOverrideToggle")?.checked;
  const input = $("#quickOverrideAmount");
  const raw = override ? input?.value || "" : fixed;
  const value = Number(raw);
  document.querySelectorAll("[data-quick-record]").forEach((btn) => {
    btn.textContent = `Record ${Number.isFinite(value) && value > 0 ? money(value) : money(fixed)}`;
  });
}
function renderBulkUpdate(searchQ = undefined) {
  const fixed = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const todayLabel = bulkRecordDate || effectiveTodayKey();
  const todayDateStr = todayLabel ? dateOnly(dateFromKey(todayLabel)) : "Today";
  let activeStudents = state.students.filter(s => s.status === "Active").sort((a, b) => displayStudent(a).localeCompare(displayStudent(b)));
  if (searchQ !== undefined) {
    activeStudents = activeStudents.filter(s => displayStudent(s).toLowerCase().includes(searchQ.toLowerCase()));
  }
  const list = $("#bulkStudentList");
  if (list) {
    const checkedIds = new Set(bulkRecordSelected || []);
    const rows = activeStudents.map(s => {
      const ledger = studentLedger(s.id);
      const today = effectiveTodayKey();
      const todayDue = ledger.due.find(x => x.date === today);
      const status = todayDue?.status === "paid" ? "Paid today" : todayDue?.status === "advance" ? "Paid in advance" : todayDue ? "Due today" : "No class today";
      const balance = ledger.outstanding ? `${money(ledger.outstanding)} due` : ledger.advance.length ? `${ledger.advance.length} day${ledger.advance.length === 1 ? "" : "s"} ahead` : "Up to date";
      const checked = checkedIds.has(s.id) ? "checked" : "";
      return `<label class="bulk-student-row"><input type="checkbox" class="bulk-student-check" data-student-id="${s.id}" ${checked}><div class="bulk-student-info"><strong>${esc(displayStudent(s))}</strong><span>${status} · ${balance}</span></div></label>`;
    }).join("") || '<div class="empty">No active students.</div>';
    list.innerHTML = rows;
    document.querySelectorAll(".bulk-student-check").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = e.target.dataset.studentId;
        if (e.target.checked) {
          if (!bulkRecordSelected.includes(id)) bulkRecordSelected.push(id);
        } else {
          bulkRecordSelected = bulkRecordSelected.filter((x) => x !== id);
        }
        renderBulkUpdate(searchQ);
      });
    });
  }
  const countEl = document.querySelector(".bulk-selected-count");
  if (countEl) {
    const cnt = bulkRecordSelected.length;
    countEl.textContent = `${cnt} student${cnt !== 1 ? "s" : ""} selected`;
  }
  const totalEl = $("#bulkTotalDisplay");
  if (totalEl) {
    const amt = Number(bulkRecordAmount) || 0;
    totalEl.textContent = money(amt * (bulkRecordSelected.length));
  }
  const btn = $("#bulkRecordBtn");
  if (btn) {
    const amt = Number(bulkRecordAmount) || 0;
    btn.disabled = bulkRecordSelected.length === 0 || amt <= 0;
    btn.textContent = `Record ${bulkRecordSelected.length} Payment${bulkRecordSelected.length !== 1 ? "s" : ""}`;
  }
  const dateDisplay = document.querySelector(".bulk-date-display");
  if (dateDisplay) dateDisplay.textContent = todayDateStr;
}
async function bulkRecordPayments() {
  const fixed = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const amount = Number(bulkRecordAmount) || fixed;
  if (!Number.isFinite(amount) || amount <= 0)
    return showToast("Enter a valid payment amount.", "error");
  if (amount < fixed || Math.abs(amount / fixed - Math.round(amount / fixed)) > 1e-9)
    return showToast(`Amount must be ${money(fixed)} or a multiple of it.`, "error");
  if (bulkRecordSelected.length === 0)
    return showToast("Select at least one student.", "error");
  const paymentDateKey = bulkRecordDate || effectiveTodayKey();
  const d = dateFromKey(paymentDateKey);
  const now = new Date();
  d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
  const paymentAt = d.toISOString();
  const total = amount * bulkRecordSelected.length;
  confirmAction(
    `Record ${bulkRecordSelected.length} payment${bulkRecordSelected.length !== 1 ? "s" : ""}?`,
    `${money(amount)} × ${bulkRecordSelected.length} students\nTotal: ${money(total)}`,
    async () => {
      closeModal();
      let recorded = 0;
      let lastId = "";
      let lastAmt = 0;
      const activeSession = getCollectionSession(paymentDateKey);
      for (const studentId of bulkRecordSelected) {
        const s = state.students.find((x) => x.id === studentId);
        if (!s) continue;
        const allocations = autoAllocateAsOf(studentId, amount, paymentAt);
        const sessionId = activeSession && activeSession.status === "open" ? activeSession.id : "";
        const obj = {
          id: uid("pay"),
          studentId,
          amount,
          at: paymentAt,
          recordedAt: new Date().toISOString(),
          by: ADMIN,
          event: state.settings.eventName,
          allocations,
          unallocatedAmount: 0,
          sessionId,
        };
        await put("contributions", obj);
        if (sessionId && activeSession && !activeSession.paymentIds.includes(obj.id)) {
          activeSession.paymentIds.push(obj.id);
        }
        recorded++;
        lastId = obj.id;
        lastAmt = amount;
      }
      if (activeSession && activeSession.status === "open") {
        await persistCollectionSessions();
      }
      await refresh();
      await log(
        "Bulk recorded contributions",
        `${bulkRecordSelected.length} payment${bulkRecordSelected.length !== 1 ? "s" : ""} — ${money(total)} total (${money(amount)} each)`,
      );
      quickSessionTotal += total;
      quickSessionCount += recorded;
      vibrate();
      bulkRecordSelected = [];
      bulkRecordAmount = "";
      render();
      showActionToast(
        `${recorded} payment${recorded !== 1 ? "s" : ""} recorded — ${money(total)} total.`,
        "Undo",
        () => undoQuickRecordPayment(lastId, lastAmt),
      );
    },
  );
}
function toLocalInput(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function effectivePaymentISO(timeValue) {
  const d = effectiveTodayDate();
  const now = new Date();
  let h = now.getHours(),
    m = now.getMinutes();
  if (timeValue) {
    const match = String(timeValue).match(/T(\d{2}):(\d{2})/);
    if (match) {
      h = Number(match[1]);
      m = Number(match[2]);
    }
  }
  d.setHours(h, m, now.getSeconds(), 0);
  return d.toISOString();
}
async function expenseModal(existing) {
  const x = existing || {
    id: "",
    amount: "",
    category: "Food",
    description: "",
    date: new Date().toISOString(),
  };
  const cats = [
    "Food",
    "Decorations",
    "Supplies",
    "Transportation",
    "Venue",
    "Printing",
    "Miscellaneous",
  ];
  modal(
    existing ? "Edit Expense" : "Add Expense",
    `<form id="expenseForm"><div class="form-grid"><div class="form-field"><label>Date & time</label><input class="input" id="expenseDate" type="datetime-local" value="${toLocalInput(x.date)}" required></div><div class="form-field"><label>Amount</label><input class="input" id="expenseAmount" type="number" min="0" step="0.01" value="${Number(x.amount) || ""}" required></div><div class="form-field"><label>Category</label><select class="select" id="expenseCategory">${cats.map((c) => `<option ${c === x.category ? "selected" : ""}>${c}</option>`).join("")}</select></div><div class="form-field full-width"><label>Description</label><textarea class="textarea" id="expenseDescription" required placeholder="What was this expense for?">${esc(x.description)}</textarea></div></div><div class="modal-actions"><button type="button" class="ghost-btn" data-close-modal>Cancel</button><button class="primary-btn">Save expense</button></div></form>`,
  );
  $("#expenseForm").onsubmit = async (e) => {
    e.preventDefault();
    const obj = {
      id: x.id || uid("exp"),
      date: new Date($("#expenseDate").value).toISOString(),
      amount: Number($("#expenseAmount").value),
      category: $("#expenseCategory").value,
      description: $("#expenseDescription").value.trim(),
      by: ADMIN,
    };
    await put("expenses", obj);
    await log(
      existing ? "Updated expense" : "Added expense",
      `${obj.category} — ${money(obj.amount)} — ${obj.description}`,
    );
    await refresh();
    closeModal();
    render();
    showToast(existing ? "Expense updated" : "Expense added");
  };
}

function confirmAction(title, text, fn) {
  modal(
    title,
    `<p class="muted" style="line-height:1.6">${text}</p>`,
    `<div class="modal-actions"><button class="ghost-btn" data-close-modal>Cancel</button><button class="danger-btn" id="confirmDanger">Continue</button></div>`,
  );
  $("#confirmDanger").onclick = async () => {
    await fn();
    closeModal();
    render();
  };
}

async function exportJSON() {
  await refresh();
  const backup = {
    format: "BSCS2C-TREASURY",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      students: state.students,
      contributions: state.contributions,
      expenses: state.expenses,
      activity: state.activity,
      recycle: state.recycle,
      settings: state.settings,
    },
  };
  download(
    `${brandSlug()}-treasury-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(backup, null, 2),
    "application/json",
  );
  showToast("Backup exported");
}
function csvEscape(v) {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}
function exportStudentsCSV() {
  const lines = [
    ["Student Name", "Status", "Paid", "Last Payment"],
    ...state.students
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => {
        const p = state.contributions
          .filter((x) => x.studentId === s.id)
          .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
        return [s.name, statusLabel(s.status), p ? "Yes" : "No", p ? p.at : ""];
      }),
  ];
  download(
    `${brandSlug()}-students-${new Date().toISOString().slice(0, 10)}.csv`,
    lines.map((r) => r.map(csvEscape).join(",")).join("\n"),
    "text/csv;charset=utf-8",
  );
  showToast("Student CSV exported");
}
function exportCSV() {
  const lines = [
    [
      "Type",
      "Student",
      "Amount",
      "Date",
      "Category",
      "Description",
      "Recorded By",
    ],
    ...state.contributions.map((x) => [
      "Contribution",
      displayStudent(state.students.find((s) => s.id === x.studentId)),
      x.amount,
      x.at,
      "",
      "",
      x.by,
    ]),
    ...state.expenses.map((x) => [
      "Expense",
      "",
      x.amount,
      x.date,
      x.category,
      x.description,
      x.by,
    ]),
  ];
  download(
    `${brandSlug()}-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
    lines.map((r) => r.map(csvEscape).join(",")).join("\n"),
    "text/csv;charset=utf-8",
  );
  showToast("CSV exported");
}
function download(name, data, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function handleMergeFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== "BSCS2C-TREASURY") throw new Error("Invalid backup");
    const importStudents = Array.isArray(data.data?.students)
      ? data.data.students
      : [];
    const importContributions = Array.isArray(data.data?.contributions)
      ? data.data.contributions
      : [];
    if (!importStudents.length) throw new Error("No students found in file");
    mergePreviewModal(importStudents, importContributions);
  } catch (err) {
    showToast("Could not read that backup file.", "error");
  }
  e.target.value = "";
}
function normalizeName(n) {
  return String(n || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
function findLocalStudentMatch(importStudent) {
  const n = normalizeName(importStudent.name);
  const a = normalizeName(importStudent.alias);
  return (
    state.students.find(
      (s) =>
        normalizeName(s.name) === n ||
        (a && normalizeName(s.alias) === a) ||
        (a && normalizeName(s.name) === a) ||
        normalizeName(s.alias) === n,
    ) || null
  );
}
function mergePreviewModal(importStudents, importContributions) {
  const localOptions = state.students
    .slice()
    .sort((a, b) => displayStudent(a).localeCompare(displayStudent(b)));
  const rows = importStudents
    .map((is) => {
      const payments = importContributions.filter((c) => c.studentId === is.id);
      const total = payments.reduce((a, x) => a + (Number(x.amount) || 0), 0);
      const match = findLocalStudentMatch(is);
      const optionsHtml = [
        `<option value="__new__">+ Create as new student</option>`,
        `<option value="__skip__">Skip (don't import)</option>`,
        ...localOptions.map(
          (s) =>
            `<option value="${s.id}" ${match && match.id === s.id ? "selected" : ""}>${esc(displayStudent(s))}</option>`,
        ),
      ].join("");
      return `<div class="merge-row" data-import-student="${is.id}"><div class="merge-row-info"><strong>${esc(displayStudent(is))}</strong><span>${payments.length} payment${payments.length === 1 ? "" : "s"} · ${money(total)}</span></div><select class="select merge-map-select" data-import-student-select="${is.id}">${optionsHtml}</select></div>`;
    })
    .join("");
  const totalPayments = importContributions.length;
  modal(
    "Merge from another device",
    `<p class="footer-note" style="margin-bottom:14px">Match each name to your existing student, or create it new. Payments will be recalculated day-by-day so balances stay accurate.</p><div class="merge-list">${rows}</div><p class="footer-note" style="margin-top:14px">${totalPayments} payment record(s) found in this file.</p>`,
    `<div class="modal-actions"><button type="button" class="ghost-btn" data-close-modal>Cancel</button><button class="primary-btn" id="confirmMerge">Merge payments</button></div>`,
  );
  $("#confirmMerge").onclick = async () => {
    const mapping = {};
    for (const is of importStudents) {
      const sel = $(`[data-import-student-select="${is.id}"]`);
      mapping[is.id] = sel ? sel.value : "__skip__";
    }
    await performMerge(importStudents, importContributions, mapping);
    closeModal();
  };
}
async function performMerge(importStudents, importContributions, mapping) {
  const resolved = {};
  for (const is of importStudents) {
    const choice = mapping[is.id];
    if (choice === "__skip__") continue;
    if (choice === "__new__") {
      const newStudent = {
        id: uid("stu"),
        name: is.name,
        alias: is.alias || "",
        status: is.status || "Active",
        createdAt: is.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await put("students", newStudent);
      state.students.push(newStudent);
      resolved[is.id] = newStudent.id;
    } else {
      resolved[is.id] = choice;
    }
  }
  const toImport = importContributions
    .filter((c) => resolved[c.studentId])
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  let imported = 0,
    skippedDuplicate = 0;
  for (const c of toImport) {
    const localStudentId = resolved[c.studentId];
    const amount = Number(c.amount) || 0;
    if (amount <= 0) continue;
    const isDuplicate = state.contributions.some(
      (x) =>
        x.studentId === localStudentId &&
        Math.abs(Number(x.amount) - amount) < 0.001 &&
        Math.abs(new Date(x.at) - new Date(c.at)) < 60000,
    );
    if (isDuplicate) {
      skippedDuplicate++;
      continue;
    }
    const allocations = autoAllocateAsOf(localStudentId, amount, c.at);
    const obj = {
      id: uid("pay"),
      studentId: localStudentId,
      amount,
      at: c.at,
      recordedAt: c.recordedAt || c.at,
      by: c.by ? `${c.by} (merged)` : "Merged import",
      event: c.event || state.settings.eventName,
      allocations,
      unallocatedAmount: 0,
      sessionId: "",
    };
    state.contributions.push(obj);
    await put("contributions", obj);
    imported++;
  }
  await refresh();
  await log(
    "Merged payments from device",
    `Imported ${imported} payment(s)${skippedDuplicate ? `, skipped ${skippedDuplicate} duplicate(s)` : ""} from another device's backup.`,
  );
  await refresh();
  render();
  showToast(
    imported
      ? `Merged ${imported} payment${imported === 1 ? "" : "s"}${skippedDuplicate ? ` (${skippedDuplicate} duplicate${skippedDuplicate === 1 ? "" : "s"} skipped)` : ""}`
      : "No new payments to merge",
  );
}
function allocationInfoAsOf(studentId, amount, atISO) {
  const daily = Math.max(0.01, Number(state.settings.contributionAmount) || 5);
  const key = localDateKey(atISO);
  const before = ledgerBeforePayment(studentId, "__merge__", atISO);
  const past = before.unpaid.filter((x) => x.date < key);
  const today = before.due.find((x) => x.date === key && x.status === "unpaid");
  return {
    daily,
    key,
    past,
    today,
    maxPast: past.length * daily,
    maxToday: today ? daily : 0,
  };
}
function autoAllocateAsOf(studentId, amount, atISO) {
  const info = allocationInfoAsOf(studentId, amount, atISO);
  const daily = info.daily;
  let remaining = amount;
  const pastAmount = Math.min(remaining, info.maxPast);
  remaining -= pastAmount;
  const todayAmount = Math.min(remaining, info.maxToday);
  remaining -= todayAmount;
  const advanceAmount = Math.max(0, remaining);
  const allocations = [];
  let pastRemaining = pastAmount;
  for (const d of info.past) {
    if (pastRemaining + 1e-9 < daily) break;
    allocations.push({ date: d.date, amount: daily, status: "paid" });
    pastRemaining -= daily;
  }
  if (todayAmount > 0)
    allocations.push({ date: info.key, amount: daily, status: "paid" });
  let cursor = addClassDay(info.key, 1);
  let remainingAdvance = advanceAmount;
  while (remainingAdvance + 1e-9 >= daily) {
    allocations.push({ date: cursor, amount: daily, status: "advance" });
    remainingAdvance -= daily;
    cursor = addClassDay(cursor, 1);
  }
  return allocations;
}
async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== "BSCS2C-TREASURY") throw new Error("Invalid backup");
    confirmAction(
      "Restore backup?",
      `This will replace the current local data with the selected backup. This cannot be undone unless you have another backup.`,
      async () => {
        for (const store of STORE_NAMES) {
          const old = await getAll(store);
          for (const x of old) await del(store, x.id);
        }
        for (const [store, items] of Object.entries(data.data)) {
          if (store === "settings") {
            for (const [key, value] of Object.entries(items))
              await put("settings", { id: key, key, value });
          } else if (STORE_NAMES.includes(store)) {
            for (const x of items) await put(store, x);
          }
        }
        await refresh();
        await log("Restored backup", "Imported a full JSON treasury backup.");
        await refresh();
        showToast("Backup restored");
      },
    );
  } catch (err) {
    showToast("Could not read backup file.", "error");
  }
  e.target.value = "";
}

function isCustomPasswordSet() {
  const rec = state.settings.passwordAuth;
  return (
    !!rec &&
    typeof rec === "object" &&
    (rec.algo === "sha256" ? !!rec.hash : !!rec.value)
  );
}
function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function randomSaltHex(len = 16) {
  if (window.crypto?.getRandomValues) {
    const arr = new Uint8Array(len);
    window.crypto.getRandomValues(arr);
    return bytesToHex(arr.buffer);
  }
  let s = "";
  for (let i = 0; i < len * 2; i++)
    s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await window.crypto.subtle.digest("SHA-256", data);
  return bytesToHex(digest);
}
async function makePasswordRecord(password) {
  const pw = String(password);
  if (window.crypto?.subtle) {
    const salt = randomSaltHex(16);
    const hash = await sha256Hex(`${salt}:${pw}`);
    return { algo: "sha256", salt, hash };
  }
  return { algo: "plain", value: pw };
}
function hexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifyPassword(input) {
  const pw = String(input ?? "").trim();
  const rec = state.settings.passwordAuth;
  if (!rec || typeof rec !== "object") return pw === PASSWORD;
  if (rec.algo === "sha256") {
    if (!window.crypto?.subtle) return false;
    const hash = await sha256Hex(`${rec.salt}:${pw}`);
    return hexEqual(hash, rec.hash);
  }
  if (rec.algo === "plain") return pw === String(rec.value);
  return false;
}
async function changePasswordModal() {
  modal(
    "Change treasurer password",
    `<form id="passwordForm"><div class="form-field"><label>Current password</label><input class="input" id="pwCurrent" type="password" autocomplete="current-password" placeholder="Enter current password" required></div><div class="form-field" style="margin-top:13px"><label>New password</label><input class="input" id="pwNew" type="password" autocomplete="new-password" placeholder="At least 4 characters" required></div><div class="form-field" style="margin-top:13px"><label>Confirm new password</label><input class="input" id="pwConfirm" type="password" autocomplete="new-password" placeholder="Re-enter new password" required></div><div class="footer-note">Stored only on this device, scrambled. There is no recovery if you forget it — keep a JSON backup.</div><div class="modal-actions"><button type="button" class="ghost-btn" data-close-modal>Cancel</button><button class="primary-btn">Update password</button></div></form>`,
  );
  $("#passwordForm").onsubmit = async (e) => {
    e.preventDefault();
    const current = $("#pwCurrent").value;
    const next = String($("#pwNew").value || "").trim();
    const confirm = String($("#pwConfirm").value || "").trim();
    if (!(await verifyPassword(current)))
      return showToast("Current password is incorrect.", "error");
    if (next.length < 4)
      return showToast("New password must be at least 4 characters.", "error");
    if (next !== confirm)
      return showToast("New passwords do not match.", "error");
    const rec = await makePasswordRecord(next);
    await saveSetting("passwordAuth", rec);
    await log(
      "Changed treasurer password",
      "The dashboard unlock password was updated.",
    );
    await refresh();
    closeModal();
    render();
    showToast("Password updated");
  };
}
function currentBranding() {
  const section =
    (state.settings.className && String(state.settings.className).trim()) ||
    "BSCS2C";
  const department =
    (state.settings.departmentName &&
      String(state.settings.departmentName).trim()) ||
    "";
  const tagline =
    (state.settings.tagline && String(state.settings.tagline).trim()) || "";
  return { section, department, tagline };
}
function applyBrandingValues(b) {
  const eyebrow = $("#loginEyebrowText") || $("#loginEyebrow");
  if (eyebrow) eyebrow.textContent = b.department || "CLASS TREASURY";
  const title = $("#loginTitle");
  if (title) title.textContent = b.section;
  const tag = $("#loginTaglineText") || $("#loginTagline");
  if (tag)
    tag.textContent = b.tagline || "Offline-first Treasurer Dashboard";
  const brandName = $("#brandName");
  if (brandName) brandName.textContent = b.section;
  document.title = `${b.section} · ${APP_NAME}`;
}
function applyBranding() {
  const b = currentBranding();
  applyBrandingValues(b);
  try {
    localStorage.setItem("bscs2c-branding", JSON.stringify(b));
  } catch {}
}
function applyBrandingFromMirror() {
  let b = { section: "BSCS2C", department: "", tagline: "" };
  try {
    const m = JSON.parse(localStorage.getItem("bscs2c-branding") || "{}");
    b = {
      section: (m.section && String(m.section).trim()) || "BSCS2C",
      department: (m.department && String(m.department).trim()) || "",
      tagline: (m.tagline && String(m.tagline).trim()) || "",
    };
  } catch {}
  applyBrandingValues(b);
}
function brandSlug() {
  const section = currentBranding().section;
  const slug = section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "treasury";
}
function needsSetup() {
  return !(
    state.settings.setupComplete ||
    state.settings.brandingConfigured ||
    isCustomPasswordSet() ||
    state.students.length > 0 ||
    state.contributions.length > 0
  );
}
function showSetupScreen() {
  $("#loginScreen")?.classList.add("hidden");
  $("#appShell")?.classList.add("hidden");
  $("#setupScreen")?.classList.remove("hidden");
  const nameEl = $("#setupAppName");
  if (nameEl) nameEl.textContent = APP_NAME;
  document.title = `Set up · ${APP_NAME}`;
  $("#setupSection")?.focus();
}
function showLoginScreen() {
  $("#setupScreen")?.classList.add("hidden");
  $("#appShell")?.classList.add("hidden");
  $("#loginScreen")?.classList.remove("hidden");
  applyBranding();
  $("#passwordInput")?.focus();
}
async function handleSetupSubmit(e) {
  e.preventDefault();
  const section = $("#setupSection").value.trim();
  const department = $("#setupDepartment").value.trim();
  const tagline = $("#setupTagline").value.trim();
  const event = $("#setupEvent").value.trim();
  const amount = Number($("#setupAmount").value);
  const startDate = $("#setupStartDate").value;
  const pw = String($("#setupPassword").value || "").trim();
  const pwc = String($("#setupPasswordConfirm").value || "").trim();
  if (!section)
    return showToast("Enter your class or organization name.", "error");
  if (!event) return showToast("Enter the event or fund purpose.", "error");
  if (!Number.isFinite(amount) || amount <= 0)
    return showToast("Enter a daily contribution amount above zero.", "error");
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
    return showToast("Choose a contribution start date.", "error");
  if (startDate > localDateKey(new Date()))
    return showToast("The start date can't be in the future.", "error");
  if (pw.length < 4)
    return showToast("Password must be at least 4 characters.", "error");
  if (pw !== pwc) return showToast("Passwords do not match.", "error");
  const cfg = { section, department, tagline, event, amount, startDate, pw };
  modal(
    "Ready to create your treasury?",
    `<div class="setup-confirm"><div><span>Class / Organization</span><strong>${esc(section)}</strong></div><div><span>Event</span><strong>${esc(event)}</strong></div><div><span>Daily contribution</span><strong>${money(amount)}</strong></div><div><span>Start date</span><strong>${dateOnly(dateFromKey(startDate))}</strong></div></div>`,
    `<div class="modal-actions"><button type="button" class="ghost-btn" data-close-modal>Cancel</button><button type="button" class="primary-btn" id="confirmCreateTreasury">Create Dashboard</button></div>`,
  );
  $("#confirmCreateTreasury").onclick = () => createTreasury(cfg);
}
async function createTreasury(cfg) {
  try {
    await initializeData();
  } catch (err) {
    return showToast(
      err.message || `Could not open local data. Reopen ${APP_NAME} and retry.`,
      "error",
    );
  }
  const rec = await makePasswordRecord(cfg.pw);
  await saveSetting("passwordAuth", rec);
  await saveSetting("className", cfg.section);
  await saveSetting("departmentName", cfg.department);
  await saveSetting("tagline", cfg.tagline);
  await saveSetting("eventName", cfg.event);
  await saveSetting("contributionAmount", cfg.amount);
  await saveSetting("contributionStartDate", cfg.startDate);
  await saveSetting("brandingConfigured", true);
  await saveSetting("setupComplete", true);
  await log(
    "Completed dashboard setup",
    `Section "${cfg.section}" · ${cfg.event} · ${money(cfg.amount)}/day from ${dateOnly(dateFromKey(cfg.startDate))}.`,
  );
  await refresh();
  applyBranding();
  closeModal();
  sessionStorage.setItem("bscs2c-unlocked", "1");
  unlock();
  showToast("Dashboard ready");
}
async function handleSetupRestore(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== "BSCS2C-TREASURY" || !data.data)
      throw new Error("Invalid backup");
    try {
      await initializeData();
    } catch (err) {
      showToast(
        err.message || `Could not open local data. Reopen ${APP_NAME} and retry.`,
        "error",
      );
      e.target.value = "";
      return;
    }
    for (const store of STORE_NAMES) {
      const old = await getAll(store);
      for (const x of old) await del(store, x.id);
    }
    for (const [store, items] of Object.entries(data.data)) {
      if (store === "settings") {
        for (const [key, value] of Object.entries(items))
          await put("settings", { id: key, key, value });
      } else if (STORE_NAMES.includes(store)) {
        for (const x of items) await put(store, x);
      }
    }
    await saveSetting("setupComplete", true);
    await refresh();
    applyBranding();
    await log(
      "Restored backup at setup",
      "Imported a JSON backup during first-time setup.",
    );
    showToast("Backup restored. Log in with your backup's password.");
    showLoginScreen();
  } catch (err) {
    showToast("Could not read that backup file.", "error");
  }
  e.target.value = "";
}
function bindSetupScreen() {
  $("#setupForm")?.addEventListener("submit", handleSetupSubmit);
  $("#setupRestoreFile")?.addEventListener("change", handleSetupRestore);
  const sd = $("#setupStartDate");
  if (sd) {
    const today = localDateKey(new Date());
    sd.max = today;
    if (!sd.value) sd.value = today;
  }
  $("#setupTogglePassword")?.addEventListener("click", () => {
    const p = $("#setupPassword"),
      c = $("#setupPasswordConfirm"),
      b = $("#setupTogglePassword");
    const show = p.type === "password";
    p.type = c.type = show ? "text" : "password";
    b.textContent = show ? "Hide" : "Show";
  });
}
async function initializeData() {
  if (dataInitPromise) return dataInitPromise;
  dataInitPromise = (async () => {
    try {
      db = await openDB();
      dbReadyPromise = Promise.resolve(db);
      await refresh();
      dataReady = true;
      applyBranding();
      if (!$("#appShell")?.classList.contains("hidden")) render();
      return db;
    } catch (err) {
      dataReady = false;
      db = null;
      dbReadyPromise = Promise.reject(err);
      dbReadyPromise.catch(() => {});
      console.error(err);
      throw err;
    }
  })();
  return dataInitPromise;
}
async function init() {
  const loginForm = $("#loginForm");
  const passwordInput = $("#passwordInput");
  applyBrandingFromMirror();
  bindSetupScreen();
  if (loginForm)
    loginForm.onsubmit = async (e) => {
      e.preventDefault();
      const password = (passwordInput?.value || "").trim();
      try {
        await initializeData();
      } catch (err) {
        return showToast(
          err.message ||
            `Local data could not be opened. Close other ${APP_NAME} tabs and try again.`,
          "error",
        );
      }
      if (!(await verifyPassword(password)))
        return showToast("Incorrect password.", "error");
      sessionStorage.setItem("bscs2c-unlocked", "1");
      unlock();
    };
  $("#quickContributionBtn").onclick = () => {
    if (!dataReady)
      return showToast("Loading local data… please wait a moment.", "error");
    currentView = "quickRecord";
    render();
  };
  $("#togglePassword").onclick = () => {
    const input = $("#passwordInput");
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    $("#togglePassword").textContent = visible ? "Hide" : "Show";
    $("#togglePassword").setAttribute(
      "aria-label",
      visible ? "Hide password" : "Show password",
    );
  };
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  updateOnline();
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  try {
    await initializeData();
  } catch (err) {
    showToast(err.message || "Could not open local data.", "error");
    return;
  }
  if (sessionStorage.getItem("bscs2c-unlocked") === "1" && !needsSetup()) {
    unlock();
    return;
  }
  if (needsSetup()) showSetupScreen();
}
function unlock() {
  $("#setupScreen")?.classList.add("hidden");
  $("#loginScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  render();
  applyBranding();
}
function updateOnline() {
  const p = $("#onlinePill");
  if (!navigator.onLine) {
    p.classList.add("offline");
    p.innerHTML = "<i></i> Offline mode";
  } else {
    p.classList.remove("offline");
    p.innerHTML = "<i></i> Online · data local";
  }
}
function lock() {
  sessionStorage.removeItem("bscs2c-unlocked");
  $("#appShell").classList.add("hidden");
  $("#loginScreen").classList.remove("hidden");
  $("#passwordInput").value = "";
  $("#passwordInput").focus();
}

document.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-view]");
  if (nav && !dataReady) {
    showToast("Local data is still loading. Please wait a moment.", "error");
    return;
  }
  if (
    !dataReady &&
    !e.target.closest("#menuBtn") &&
    !e.target.closest("#lockBtn")
  ) {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (
      action ||
      e.target.closest("[data-quick-record]") ||
      e.target.closest("[data-payment-history]") ||
      e.target.closest("[data-student-detail]") ||
      e.target.closest("[data-edit-student]") ||
      e.target.closest("[data-delete-student]") ||
      e.target.closest("[data-record-student]") ||
      e.target.closest("[data-edit-contribution]") ||
      e.target.closest("[data-delete-contribution]") ||
      e.target.closest("[data-edit-expense]") ||
      e.target.closest("[data-delete-expense]") ||
      e.target.closest("[data-remove-noclass]")
    ) {
      showToast("Local data is still loading. Please wait a moment.", "error");
      return;
    }
  }
  const nav2 = e.target.closest("[data-view]");
  if (nav) {
    currentView = nav.dataset.view;
    render();
    $("#sidebar").classList.remove("open");
    return;
  }
  if (e.target.closest("#menuBtn")) {
    $("#sidebar").classList.toggle("open");
    return;
  }
  if (e.target.closest("#lockBtn")) {
    lock();
    return;
  }
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "add-student") return studentModal();
  if (action === "add-contribution") return contributionModal();
  if (action === "delete-all-contributions") {
    const count = state.contributions.length;
    if (!count)
      return showToast("There are no contribution records to delete.", "error");
    return confirmAction(
      "Delete ALL contribution records?",
      `Are you sure? This permanently deletes all ${count} contribution record${count === 1 ? "" : "s"}. It cannot be undone and they will NOT go to the recycle bin. Students, expenses, and settings are kept — export a JSON backup first if you might need them.`,
      async () => {
        for (const x of [...state.contributions])
          await del("contributions", x.id);
        await log(
          "Deleted all contributions",
          `${count} contribution record${count === 1 ? "" : "s"} permanently deleted.`,
        );
        await refresh();
      },
    );
  }
  if (action === "add-expense") return expenseModal();
  if (action === "change-password") return changePasswordModal();
  if (action === "quick-record")
    return ((currentView = "quickRecord"), render());
  if (action === "export-json") return exportJSON();
  if (action === "export-csv") return exportCSV();
  if (action === "export-students-csv") return exportStudentsCSV();
  if (action === "start-session") return startCollectionSession();
  if (action === "reset-quick-session") {
    quickSessionTotal = 0;
    quickSessionCount = 0;
    render();
    return showToast("Counter reset");
  }
  if (action === "set-quick-mode") {
    const mode = e.target.closest("[data-mode]")?.dataset.mode;
    bulkRecordMode = mode === "bulk";
    if (bulkRecordMode) {
      bulkRecordAmount = String(Math.max(0.01, Number(state.settings.contributionAmount) || 5));
    }
    if (!bulkRecordMode) {
      bulkRecordSelected = [];
      bulkRecordAmount = "";
      bulkRecordDate = "";
    }
    return render();
  }
  if (action === "bulk-select-all") {
    const activeIds = state.students.filter(s => s.status === "Active").map(s => s.id);
    bulkRecordSelected = [...activeIds];
    renderBulkUpdate(document.getElementById("bulkSearchInput")?.value);
    return;
  }
  if (action === "bulk-clear-all") {
    bulkRecordSelected = [];
    renderBulkUpdate(document.getElementById("bulkSearchInput")?.value);
    return;
  }
  if (action === "bulk-confirm") {
    return bulkRecordPayments();
  }
  if (action === "close-session") return closeCollectionSession();
  if (action === "attach-all-session") {
    const abtn = e.target.closest("[data-attach-session]");
    return attachAllPaymentsToSession(abtn?.dataset.attachSession);
  }
  if (action === "attach-session-payment") {
    const abtn = e.target.closest("[data-attach-session]");
    return attachPaymentToSession(abtn?.dataset.attachSession);
  }
  if (action === "delete-session") {
    const btn = e.target.closest("[data-session-delete]");
    const id = btn?.dataset.sessionDelete;
    const date = btn?.dataset.sessionDate;
    if (id) return deleteCollectionSession(id, date);
  }
  const sr = e.target.closest("[data-session-id]");
  if (sr) return collectionSessionDetail(sr.dataset.sessionId);
  if (action === "view-today-unpaid") return renderTodayUnpaid();
  if (action === "reset-app-date") {
    await saveSetting("appDateKey", "");
    await log("Reset recording date", "Recording date returned to today.");
    await refresh();
    render();
    return showToast("Recording date: Today");
  }
  if (action === "print-report") return window.print();
  if (action === "empty-recycle")
    return confirmAction(
      "Empty recycle bin?",
      "All deleted records will be permanently removed.",
      async () => {
        for (const x of state.recycle) await del("recycle", x.id);
        await log(
          "Emptied recycle bin",
          `${state.recycle.length} records permanently removed.`,
        );
        await refresh();
      },
    );
  if (action === "save-settings") {
    const amount = Number($("#settingAmount").value);
    if (!Number.isFinite(amount) || amount <= 0)
      return showToast(
        "Daily contribution amount must be greater than zero.",
        "error",
      );
    const startDate = ($("#settingStartDate")?.value || "").trim();
    if (
      startDate &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
        startDate > localDateKey(new Date()))
    )
      return showToast(
        "Contribution start date must be a valid date, not in the future.",
        "error",
      );
    await saveSetting("className", $("#settingClass").value.trim() || "BSCS2C");
    await saveSetting(
      "departmentName",
      ($("#settingDepartment")?.value || "").trim(),
    );
    await saveSetting("tagline", ($("#settingTagline")?.value || "").trim());
    await saveSetting(
      "eventName",
      $("#settingEvent").value.trim() || "Christmas Party",
    );
    await saveSetting("contributionAmount", amount);
    await saveSetting("contributionStartDate", startDate);
    await log(
      "Updated settings",
      "Class, event, daily amount, or start date changed.",
    );
    await refresh();
    applyBranding();
    render();
    return showToast("Settings saved");
  }
  const sd = e.target.closest("[data-student-detail]");
  if (sd) return paymentHistoryModal(sd.dataset.studentDetail);
  const ph = e.target.closest("[data-payment-history]");
  if (ph) return paymentHistoryModal(ph.dataset.paymentHistory);
  const qr = e.target.closest("[data-quick-record]");
  if (qr) {
    const override = $("#quickOverrideToggle")?.checked;
    const input = $("#quickOverrideAmount");
    const raw = override
      ? input?.value || ""
      : state.settings.contributionAmount;
    if (override && !String(raw).trim())
      return showToast("Enter an override amount first.", "error");
    return quickRecordContribution(qr.dataset.quickRecord, raw);
  }
  const es = e.target.closest("[data-edit-student]");
  if (es) {
    const s = state.students.find((x) => x.id === es.dataset.editStudent);
    return studentModal(s);
  }
  const ds = e.target.closest("[data-delete-student]");
  if (ds) {
    const s = state.students.find((x) => x.id === ds.dataset.deleteStudent);
    return confirmAction(
      "Delete student?",
      `Move ${esc(s.name)} to the recycle bin?`,
      async () => {
        await softDelete("students", s, "Student");
        await refresh();
      },
    );
  }
  const rnc = e.target.closest("[data-remove-noclass]");
  if (rnc) return removeNoClassDate(rnc.dataset.removeNoclass);
  const rs = e.target.closest("[data-record-student]");
  if (rs) return contributionModal(null, rs.dataset.recordStudent);
  const ec = e.target.closest("[data-edit-contribution]");
  if (ec)
    return contributionModal(
      state.contributions.find((x) => x.id === ec.dataset.editContribution),
    );
  const dc = e.target.closest("[data-delete-contribution]");
  if (dc) {
    const x = state.contributions.find(
      (x) => x.id === dc.dataset.deleteContribution,
    );
    return confirmAction(
      "Delete contribution?",
      `Move this ${money(x.amount)} payment to the recycle bin?`,
      async () => {
        await softDelete("contributions", x, "Contribution");
        await refresh();
      },
    );
  }
  const ee = e.target.closest("[data-edit-expense]");
  if (ee)
    return expenseModal(
      state.expenses.find((x) => x.id === ee.dataset.editExpense),
    );
  const de = e.target.closest("[data-delete-expense]");
  if (de) {
    const x = state.expenses.find((x) => x.id === de.dataset.deleteExpense);
    return confirmAction(
      "Delete expense?",
      `Move this ${money(x.amount)} expense to the recycle bin?`,
      async () => {
        await softDelete("expenses", x, "Expense");
        await refresh();
      },
    );
  }
  const rr = e.target.closest("[data-restore]");
  if (rr) {
    const r = state.recycle.find((x) => x.id === rr.dataset.restore);
    if (!r) return;
    if (r.type === "Collection Session") {
      const restored = r.data;
      if (getCollectionSession(restored.date))
        return showToast(
          "A collection session already exists for that date. Delete or remove it first.",
          "error",
        );
      state.collectionSessions.unshift(restored);
      await persistCollectionSessions();
      for (const id of restored.paymentIds || []) {
        const payment = state.contributions.find((p) => p.id === id);
        if (payment && !payment.sessionId) {
          await put("contributions", { ...payment, sessionId: restored.id });
        }
      }
      await del("recycle", r.id);
      await log(
        "Restored collection session",
        `${dateOnly(dateFromKey(restored.date))} restored from recycle bin with ${restored.paymentIds?.length || 0} preserved payment(s).`,
      );
      await refresh();
      render();
      return showToast("Collection session restored");
    }
    await put(r.store, r.data);
    await del("recycle", r.id);
    await log("Restored record", `${r.type} restored from recycle bin.`);
    await refresh();
    render();
    return showToast("Record restored");
  }
  const pp = e.target.closest("[data-purge]");
  if (pp) {
    const r = state.recycle.find((x) => x.id === pp.dataset.purge);
    return confirmAction(
      "Permanently delete?",
      `This ${r.type} cannot be recovered after deletion.`,
      async () => {
        await del("recycle", r.id);
        await log(
          "Permanently deleted record",
          `${r.type} permanently removed.`,
        );
        await refresh();
      },
    );
  }
});

document.addEventListener("DOMContentLoaded", init);
