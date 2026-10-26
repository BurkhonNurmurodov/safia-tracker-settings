"use strict";

// The bot's private repository and the files this page reads and writes there.
const OWNER = "BurkhonNurmurodov";
const REPO = "safia-tracker-bot";
const BRANCH = "main";
const SETTINGS_PATH = "data/settings.json";
const STATUS_PATH = "data/status.json";
const BOT_TOKEN_SECRET = "TELEGRAM_BOT_TOKEN";
const TZ = "Asia/Tashkent";
const TOKEN_KEY = "reminder-settings:github-token";
const TAB_KEY = "reminder-settings:tab";
const DEFAULT_BOT = "Safia_Tracker_agent";

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const USERNAME_RE = /^[A-Za-z]\w{3,31}$/;  // the bot accepts the same
const CHAT_ID_RE = /^-?\d{5,20}$/;          // and the same
const BOT_TOKEN_RE = /^\d{5,}:[\w-]{30,}$/;
const LATE_AFTER_MIN = 90;                  // GitHub runs hourly and can lag; later than this, say so
const TOKEN_SETTINGS_URL = "https://github.com/settings/personal-access-tokens";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ------------------------------------------------------------------ elements

const ui = {
  connect: $("#connect"), connectForm: $("#connect-form"), token: $("#token"), tokenError: $("#token-error"),
  remember: $("#remember"),
  loading: $("#loading"), failed: $("#failed"), failedText: $("#failed-text"), retry: $("#retry"),
  form: $("#settings"), disconnect: $("#disconnect"), botHandle: $("#bot-handle"),
  statusDot: $("#status-dot"), statusWord: $("#status-word"), statusNext: $("#status-next"), statusNextSub: $("#status-next-sub"),
  statusLast: $("#status-last"), statusLastSub: $("#status-last-sub"), statusReach: $("#status-reach"), statusReachSub: $("#status-reach-sub"),
  alerts: $("#alerts"),
  tabs: $$('[role="tab"]'),
  enabled: $("#enabled"), enabledHint: $("#enabled-hint"),
  sendAt: $("#send-at"), sendAtHint: $("#send-at-hint"),
  days: $("#days"), daysError: $("#days-error"), sectionsHint: $("#sections-hint"),
  preview: $("#preview"),
  team: $("#team"), teamCount: $("#team-count"), teamAlert: $("#team-alert"), people: $("#notion-people"), addPerson: $("#add-person"),
  groups: $("#groups"), addGroup: $("#add-group"), groupSuggestions: $("#group-suggestions"), groupsFoot: $("#groups-foot"),
  botTokenHint: $("#bot-token-hint"), botTokenOpen: $("#bot-token-open"), botTokenForm: $("#bot-token-form"),
  botToken: $("#bot-token"), botTokenSave: $("#bot-token-save"), botTokenMsg: $("#bot-token-msg"), botTokenCancel: $("#bot-token-cancel"),
  rowTemplate: $("#row-template"), groupTemplate: $("#group-template"),
  savebar: $("#savebar"), saveText: $("#save-text"), discard: $("#discard"), save: $("#save"),
  toast: $("#toast"),
};

// ------------------------------------------------------------------ state

let token = null;
let remote = null;   // { raw, sha, settings }: settings.json as GitHub has it
let status = {};     // status.json, written by the bot
let draft = null;    // what the form shows; rows carry an id
let touched = new Set();
let triedSave = false;
let saving = false;
let rowSeq = 0;
let conflict = false;  // a save hit a newer version on GitHub: Discard becomes Reload
let alertsKey = "";    // what the alerts show now, so typing doesn't re-announce them
let secretInfo = { state: "loading" };  // the bot token secret: loading | set | missing | forbidden | error
let pendingBot = null; // a bot token that Telegram accepted, waiting for "Save anyway" or confirmation

// ------------------------------------------------------------------ token storage (never required to work)

function storedToken() {
  try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function storeToken(value, remember) {
  try {
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value);
    (remember ? sessionStorage : localStorage).removeItem(TOKEN_KEY);
  } catch { /* private mode: the token lives only in memory */ }
}
function forgetToken() {
  try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
}

// ------------------------------------------------------------------ GitHub

class GitHubError extends Error {
  constructor(status, message, rateLimited = false) {
    super(message || `GitHub HTTP ${status}`);
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

async function github(path, { method = "GET", body } = {}) {
  let res;
  const url = path.startsWith("/") ? `https://api.github.com${path}` : `https://api.github.com/repos/${OWNER}/${REPO}/${path}`;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GitHubError(0, "network");
  }
  if (!res.ok) {
    let message = "";
    try { message = (await res.json()).message || ""; } catch { /* no JSON body */ }
    throw new GitHubError(res.status, message, res.headers.get("x-ratelimit-remaining") === "0");
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

function decodeBase64(text) {
  const binary = atob(text.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
function encodeBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}
function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

async function readFile(path) {
  const file = await github(`contents/${path}?ref=${BRANCH}`);
  return { sha: file.sha, data: JSON.parse(decodeBase64(file.content)) };
}

async function writeFile(path, data, sha, message) {
  const result = await github(`contents/${path}`, {
    method: "PUT",
    body: { message, content: encodeBase64(JSON.stringify(data, null, 2) + "\n"), sha, branch: BRANCH },
  });
  return result.content.sha;
}

/** Save an Actions secret. GitHub takes it only sealed with the repository's public key. */
async function writeSecret(name, value) {
  const key = await github("actions/secrets/public-key");
  const publicKey = Uint8Array.from(atob(key.key), (c) => c.charCodeAt(0));
  const sealed = window.sealedBox(new TextEncoder().encode(value), publicKey);
  await github(`actions/secrets/${name}`, { method: "PUT", body: { encrypted_value: bytesToBase64(sealed), key_id: key.key_id } });
}

/** Cleans up a pasted token: spaces, line breaks, quotes and a "Bearer" prefix sneak in when copying. */
function cleanToken(value) {
  return value.replace(/^\s*(bearer|token)\s+/i, "").replace(/["'`\s]/g, "");
}

/**
 * Loading failed with 401/403/404. Ask GitHub step by step which part is missing,
 * so the message names the one setting to change. Sets error.diagnosis and error.notToken.
 */
async function diagnose(error) {
  const githubSays = error.message && !/^GitHub HTTP/.test(error.message) ? ` (GitHub says: “${error.message}”)` : "";
  try {
    await github("/user");
  } catch (e) {
    if (e.status === 401) {
      error.diagnosis = "GitHub doesn’t recognise this token. Check that you copied the whole token (it starts with github_pat_ and is about 90 characters long), or create a new one.";
      return;
    }
    if (e.status === 0) return;
  }
  try {
    await github(`/repos/${OWNER}/${REPO}`);
  } catch (e) {
    if (e.status === 404) {
      error.diagnosis = `The token works, but it can’t see the private ${REPO} repository. On GitHub, open the token, and under Repository access choose “Only select repositories” and pick ${REPO}. (“Public repositories” is GitHub’s default and doesn’t include it.) Also check that Resource owner is ${OWNER}.`;
      return;
    }
    if (e.status === 0) return;
  }
  if (error.status === 404) {
    error.notToken = true;
    error.diagnosis = `The token is fine, but ${SETTINGS_PATH} isn’t in the ${REPO} repository on the ${BRANCH} branch. The bot creates it; open the repository on GitHub to check it’s there.`;
    return;
  }
  if (error.status === 403) {
    error.diagnosis = `The token can see ${REPO} but isn’t allowed to read its files${githubSays}. On GitHub, open the token, and under Repository permissions set Contents to “Read and write”.`;
    return;
  }
  error.diagnosis = `GitHub refused the token (${error.status})${githubSays}.`;
}

/** What went wrong, in words, and what to do about it. */
function explain(error, during) {
  const s = error.status;
  if (s === 0) return "Can’t reach GitHub. Check the internet connection and try again.";
  if (error.diagnosis) return error.diagnosis;
  if (s === 401) return "GitHub didn’t accept the token. It may have expired or been deleted. Create a new one and paste it below.";
  if (s === 403 && error.rateLimited) return "GitHub’s limit on requests was reached. Wait a few minutes and try again.";
  if (s === 403 && during === "secret") return "This GitHub token isn’t allowed to save secrets. On GitHub, open the token and set Secrets to “Read and write” under Repository permissions, then try again.";
  if (s === 403 && during === "save") return "This token can only read the settings. On GitHub, edit the token and set Contents to “Read and write”.";
  if (s === 403) return "This token can’t read the repository’s files. On GitHub, edit the token and set Contents to “Read and write”.";
  if (s === 404) return `This token can’t see the ${REPO} repository. On GitHub, edit the token: under Repository access, add ${REPO}.`;
  if (s === 409 || s === 422) return "The settings were changed somewhere else after this page loaded. Reload to get the latest version, then make your change again.";
  if (s >= 500) return "GitHub is having trouble right now. Try again in a minute.";
  return `GitHub answered with an error (${s}${error.message ? `: ${error.message}` : ""}). Try again.`;
}

// ------------------------------------------------------------------ settings <-> form

const cleanName = (name) => String(name || "").replace(/\s+/g, " ").trim();
const cleanUser = (user) => String(user || "").trim().replace(/^@+/, "");
const cleanChatId = (id) => String(id == null ? "" : id).replace(/[\s−–]/g, (c) => (/\s/.test(c) ? "" : "-"));
const nameKey = (name) => cleanName(name).toLocaleLowerCase();

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function fromMinutes(total) {
  const t = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** The group the bot uses while settings.json lists none: the TELEGRAM_CHAT_ID secret's, which the bot reports. */
function fallbackGroups() {
  const id = status.default_group;
  if (!id) return [];
  const title = ((status.groups || {})[String(id)] || {}).title;
  return [{ name: title || "Team group", chat_id: String(id) }];
}

/** settings.json as the bot reads it, with the bot's defaults filled in. */
function normalize(raw) {
  const sendAt = /^\d{1,2}:\d{2}$/.test(raw.send_at || "") && toMinutes(raw.send_at) < 1440
    ? fromMinutes(toMinutes(raw.send_at)) : "08:00";
  return {
    enabled: raw.enabled !== false,
    send_at: sendAt,
    days: Array.isArray(raw.days) ? DAY_KEYS.filter((d) => raw.days.includes(d)) : [...DAY_KEYS],
    remind_days: [0, 1, 2, 3].includes(raw.remind_days) ? raw.remind_days : 2,
    sections_open: raw.sections_open === true,
    team: (Array.isArray(raw.team) ? raw.team : [])
      .map((p) => ({ name: cleanName(p && p.name), telegram: "@" + cleanUser(p && p.telegram) })),
    groups: Array.isArray(raw.groups) && raw.groups.length
      ? raw.groups.map((g) => ({ name: cleanName(g && g.name), chat_id: cleanChatId(g && g.chat_id) }))
      : fallbackGroups(),
  };
}

function toDraft(settings) {
  return {
    ...settings,
    days: [...settings.days],
    team: settings.team.map((p) => ({ id: ++rowSeq, name: p.name, user: cleanUser(p.telegram), isNew: false })),
    groups: settings.groups.map((g) => ({ id: ++rowSeq, name: g.name, chat_id: g.chat_id, isNew: false })),
  };
}

/** The draft as it would be saved: blank rows dropped, names tidied, "@" added. */
function fromDraft(d) {
  return {
    enabled: d.enabled,
    send_at: d.send_at,
    days: DAY_KEYS.filter((k) => d.days.includes(k)),
    remind_days: d.remind_days,
    sections_open: d.sections_open,
    team: d.team
      .filter((r) => cleanName(r.name) || cleanUser(r.user))
      .map((r) => ({ name: cleanName(r.name), telegram: "@" + cleanUser(r.user) })),
    groups: d.groups
      .filter((g) => cleanName(g.name) || cleanChatId(g.chat_id))
      .map((g) => ({ name: cleanName(g.name), chat_id: cleanChatId(g.chat_id) })),
  };
}

/** What gets written to settings.json: chat IDs as numbers, as Telegram has them. */
function toFile(settings) {
  return { ...settings, groups: settings.groups.map((g) => ({ name: g.name, chat_id: Number(g.chat_id) })) };
}

const isDirty = () => draft && remote && JSON.stringify(fromDraft(draft)) !== JSON.stringify(remote.settings);

/** Which tabs hold unsaved changes. */
function dirtyTabs() {
  if (!draft || !remote) return new Set();
  const a = fromDraft(draft), b = remote.settings, tabs = new Set();
  const same = (key) => JSON.stringify(a[key]) === JSON.stringify(b[key]);
  if (!["enabled", "send_at", "days", "remind_days", "sections_open"].every(same)) tabs.add("reminders");
  if (!same("team")) tabs.add("team");
  if (!same("groups")) tabs.add("config");
  return tabs;
}

function validate(d) {
  const errors = { days: null, rows: new Map(), groups: new Map(), noGroups: null };
  if (d.enabled && d.days.length === 0) errors.days = "Pick at least one day, or turn reminders off.";
  const named = new Map();
  for (const row of d.team) {
    const key = nameKey(row.name);
    if (key) named.set(key, (named.get(key) || 0) + 1);
  }
  for (const row of d.team) {
    const name = cleanName(row.name);
    const user = cleanUser(row.user);
    if (!name && !user) continue;
    const e = {};
    if (!name) e.name = "Add the name exactly as it is in Notion.";
    else if (named.get(nameKey(name)) > 1) {
      e.name = "This name is in the list twice.";
      e.showNow = true;  // the other row may never be touched, so don't wait
    }
    if (!user) e.user = "Add their username, or remove the row.";
    else if (!USERNAME_RE.test(user)) e.user = "4–32 letters, digits or _, starting with a letter.";
    if (e.name || e.user) errors.rows.set(row.id, e);
  }
  const ids = new Map();
  for (const g of d.groups) {
    const id = cleanChatId(g.chat_id);
    if (id) ids.set(id, (ids.get(id) || 0) + 1);
  }
  for (const g of d.groups) {
    const name = cleanName(g.name);
    const id = cleanChatId(g.chat_id);
    if (!name && !id) continue;
    const e = {};
    if (!name) e.name = "Give the group a name.";
    if (!id) e.chat_id = "Add the group’s chat ID.";
    else if (!CHAT_ID_RE.test(id)) e.chat_id = "A chat ID is a number, like -1001234567890.";
    else if (ids.get(id) > 1) { e.chat_id = "This group is in the list twice."; e.showNow = true; }
    if (e.name || e.chat_id) errors.groups.set(g.id, e);
  }
  const anyGroup = d.groups.some((g) => cleanChatId(g.chat_id));
  if (!anyGroup && (remote.settings.groups.length || Array.isArray(remote.raw.groups))) {
    errors.noGroups = "Keep at least one group, or nobody gets the messages.";
  }
  return errors;
}

function errorCount(errors) {
  const count = (map, keys) => [...map.values()].reduce((n, e) => n + keys.filter((k) => e[k]).length, 0);
  return (errors.days ? 1 : 0) + (errors.noGroups ? 1 : 0) + count(errors.rows, ["name", "user"]) + count(errors.groups, ["name", "chat_id"]);
}

// ------------------------------------------------------------------ time in Tashkent

function tashkentNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekday(iso) {  // Monday = 0
  const [y, m, d] = iso.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
function dayLabel(iso, today) {
  if (iso === today) return "today";
  if (iso === addDays(today, 1)) return "tomorrow";
  if (iso === addDays(today, -1)) return "yesterday";
  const [, m, d] = iso.split("-").map(Number);
  return `${DAY_NAMES[weekday(iso)]}, ${d} ${MONTHS[m - 1]}`;
}
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function clockIn(isoStamp) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(isoStamp));
}
function dateIn(isoStamp) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(isoStamp));
}
function shortDate(isoStamp) {
  const [, m, d] = dateIn(isoStamp).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** When the bot sends next with these settings: { day, due, late } or null when it never will. */
function nextSend(settings, lastSentDate) {
  if (!settings.enabled || settings.days.length === 0) return null;
  const now = tashkentNow();
  const at = toMinutes(settings.send_at);
  for (let i = 0; i <= 7; i++) {
    const day = addDays(now.date, i);
    if (!settings.days.includes(DAY_KEYS[weekday(day)])) continue;
    if (i === 0 && lastSentDate === now.date) continue;
    const due = i === 0 && now.minutes >= at;
    return { day, due, late: due && now.minutes >= at + LATE_AFTER_MIN, today: now.date };
  }
  return null;
}

// ------------------------------------------------------------------ small DOM helpers

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svgIcon(viewBox, d, className, strokeWidth = "1.8") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  if (className) svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  for (const [k, v] of Object.entries({ d, fill: "none", stroke: "currentColor", "stroke-width": strokeWidth, "stroke-linecap": "round", "stroke-linejoin": "round" })) {
    path.setAttribute(k, v);
  }
  svg.append(path);
  return svg;
}

const externalLink = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);

// ------------------------------------------------------------------ the bot's own report (status.json)

const botName = () => (status.bot && status.bot.username) || DEFAULT_BOT;
const groupState = (chatId) => (status.groups || {})[cleanChatId(chatId)] || null;

function renderIdentity() {
  ui.botHandle.textContent = `@${botName()}`;
}

// ------------------------------------------------------------------ hero (what the bot does with the saved settings)

function renderStatus() {
  const s = remote.settings;
  const last = status.last_sent || null;
  const next = nextSend(s, last && last.date);
  const today = tashkentNow().date;
  const failing = Boolean(status.error && status.error.text) || (status.bot && status.bot.ok === false);
  const on = s.enabled && s.days.length > 0;

  ui.statusDot.className = `dot ${!on ? "" : failing ? "dot-bad" : next && next.late ? "dot-warn" : "dot-on"}`;
  ui.statusWord.textContent = !on ? "Paused" : failing ? "On · last run failed" : "On · next messages";
  if (!s.enabled) {
    ui.statusNext.textContent = "Paused";
    ui.statusNextSub.textContent = "Nobody is reminded until you turn it on";
    ui.statusWord.textContent = "Reminders";
  } else if (!s.days.length) {
    ui.statusNext.textContent = "No days set";
    ui.statusNextSub.textContent = "Pick the days to send on";
  } else if (next && next.due) {
    ui.statusNext.textContent = "Within the hour";
    ui.statusNextSub.textContent = `Due at ${s.send_at} today`;
  } else if (next) {
    ui.statusNext.textContent = `${capital(dayLabel(next.day, today))}, ${s.send_at}`;
    ui.statusNextSub.textContent = s.days.length === 7 ? "Every day" : s.days.map((d) => DAY_NAMES[DAY_KEYS.indexOf(d)]).join(", ");
  }

  if (last) {
    ui.statusLast.textContent = last.at ? `${capital(dayLabel(dateIn(last.at), today))}, ${clockIn(last.at)}` : capital(dayLabel(last.date, today));
    ui.statusLastSub.textContent = last.messages ? plural(last.messages, "message", "messages") : "Nothing was due";
  } else {
    ui.statusLast.textContent = "Not yet";
    ui.statusLastSub.textContent = "From GitHub";
  }

  const groups = s.groups;
  if (groups.length === 1) {
    const state = groupState(groups[0].chat_id);
    ui.statusReach.textContent = groups[0].name || (state && state.title) || "1 group";
  } else if (groups.length) {
    ui.statusReach.textContent = plural(groups.length, "group", "groups");
  } else {
    ui.statusReach.textContent = "Team group";
  }
  const people = s.team.length;
  ui.statusReachSub.textContent = plural(people, "person", "people");

  renderAlerts(next);
}

function alertBox(kind, title, text, action) {
  return h("div", { class: `alert${kind === "bad" ? " alert-bad" : ""}`, role: kind === "bad" ? "alert" : null },
    h("span", { class: `dot ${kind === "bad" ? "dot-bad" : "dot-warn"}` }),
    h("div", { class: "alert-body" }, h("p", { class: "alert-title" }, title), text ? h("p", { class: "alert-text" }, text) : null),
    action ? h("div", { class: "alert-action" }, action) : null);
}

function renderAlerts(next = nextSend(remote.settings, status.last_sent && status.last_sent.date)) {
  const runs = `https://github.com/${OWNER}/${REPO}/actions`;
  const known = new Set(draft.team.map((r) => nameKey(r.name)).filter(Boolean));
  const missing = (status.notion_people || []).filter((name) => !known.has(nameKey(name)));
  const key = JSON.stringify([status.error, status.bot, next && next.late, missing, remote.settings.send_at]);
  if (key === alertsKey) return;
  alertsKey = key;

  const items = [];
  if (status.bot && status.bot.ok === false) {
    items.push(alertBox("bad", "Telegram rejected the bot token", "Nothing can be sent until it’s replaced.",
      h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => { selectTab("config"); openBotToken(); } }, "Replace token")));
  } else if (status.error && status.error.text) {
    const at = status.error.at ? ` · ${capital(dayLabel(dateIn(status.error.at), tashkentNow().date))}, ${clockIn(status.error.at)}` : "";
    items.push(alertBox("bad", `The last run failed${at}`, status.error.text, externalLink(runs, "Run history")));
  } else if (next && next.late) {
    items.push(alertBox("warn", "Today’s messages are late",
      `They were due at ${remote.settings.send_at}. GitHub’s hourly schedule sometimes lags; the bot tries again every hour.`,
      externalLink(runs, "Run history")));
  }
  ui.alerts.replaceChildren(...items);

  ui.teamAlert.replaceChildren(missing.length ? alertBox("warn",
    missing.length === 1 ? "1 person in Notion has no username here" : `${missing.length} people in Notion have no username here`,
    `Their messages don’t notify them: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` and ${missing.length - 4} more` : ""}.`,
    h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => addPeople(missing) }, missing.length === 1 ? "Add" : "Add all"))
    : "");
}

// ------------------------------------------------------------------ tabs

function selectTab(name, focus = false) {
  for (const tab of ui.tabs) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#${tab.getAttribute("aria-controls")}`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  try { sessionStorage.setItem(TAB_KEY, name); } catch { /* fine */ }
  if (name === "config" && secretInfo.state === "loading") loadSecretInfo();
}

function renderTabDots() {
  const dirty = dirtyTabs();
  for (const tab of ui.tabs) $(".tab-dot", tab).hidden = !dirty.has(tab.id.replace("tab-", ""));
}

// ------------------------------------------------------------------ form

function buildStaticControls() {
  ui.days.replaceChildren(...DAY_KEYS.map((key, i) => h("label", { title: DAY_FULL[i] },
    h("input", { type: "checkbox", value: key, "aria-label": DAY_FULL[i] }),
    h("span", { "aria-hidden": "true" }, DAY_LETTERS[i]))));
}

/** Put the draft into every control. */
function fillForm() {
  ui.enabled.checked = draft.enabled;

  const hours = Array.from({ length: 24 }, (_, i) => fromMinutes(i * 60));
  if (!hours.includes(draft.send_at)) hours.push(draft.send_at);
  hours.sort();
  ui.sendAt.replaceChildren(...hours.map((t) => h("option", { value: t }, t)));
  ui.sendAt.value = draft.send_at;

  $$("input", ui.days).forEach((box) => { box.checked = draft.days.includes(box.value); });
  $$('input[name="remind_days"]').forEach((r) => { r.checked = Number(r.value) === draft.remind_days; });
  $$('input[name="sections"]').forEach((r) => { r.checked = (r.value === "expanded") === draft.sections_open; });

  ui.people.replaceChildren(...(status.notion_people || []).map((name) => h("option", { value: name })));
  renderTeam();
  renderGroups();
  refresh();
}

function bindRow(li, row, fields) {
  li.dataset.id = row.id;
  li.classList.toggle("is-new", row.isNew);
  for (const field of fields) {
    const input = $(`[data-field="${field}"]`, li);
    const label = input.closest(".cell").querySelector("label");
    const msg = $(`[data-msg="${field}"]`, li);
    input.id = `row-${row.id}-${field}`;
    msg.id = `row-${row.id}-${field}-msg`;
    label.htmlFor = input.id;
    input.setAttribute("aria-describedby", msg.id);
    input.value = row[field];
  }
  return li;
}

function renderTeam() {
  if (!draft.team.length) {
    ui.team.replaceChildren(h("li", { class: "list-empty" }, h("b", {}, "Nobody yet"), "Add the people who have tasks in Notion."));
    return;
  }
  ui.team.replaceChildren(...draft.team.map((row) => bindRow(ui.rowTemplate.content.firstElementChild.cloneNode(true), row, ["name", "user"])));
}

function renderGroups() {
  if (!draft.groups.length) {
    const waiting = !Array.isArray(remote.raw.groups) && !status.default_group;
    ui.groups.replaceChildren(h("li", { class: "list-empty" },
      h("b", {}, waiting ? "Using the group from the bot’s setup" : "No groups"),
      waiting ? "Its name and ID show here after the bot’s next hourly run." : `Add @${botName()} to a Telegram group. It shows up below within an hour.`));
  } else {
    ui.groups.replaceChildren(...draft.groups.map((row) => bindRow(ui.groupTemplate.content.firstElementChild.cloneNode(true), row, ["name", "chat_id"])));
  }
  renderGroupSuggestions();
}

/** Groups the bot was added to in Telegram but that aren't in the list: one click adds them. */
function renderGroupSuggestions() {
  const listed = new Set(draft.groups.map((g) => cleanChatId(g.chat_id)));
  const found = (status.bot_groups || []).filter((g) => !listed.has(String(g.chat_id)));
  ui.groupSuggestions.replaceChildren(...found.map((g) => h("div", { class: "suggest" },
    h("div", { class: "suggest-text" },
      h("p", { class: "suggest-title" }, g.title || "Untitled group"),
      h("p", { class: "suggest-sub" }, `@${botName()} was added to this group · `, h("span", { class: "mono" }, String(g.chat_id)))),
    h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => addGroup({ name: g.title || "", chat_id: String(g.chat_id) }) }, "Add"))));
  const waiting = !draft.groups.length && !Array.isArray(remote.raw.groups) && !status.default_group;
  ui.addGroup.disabled = waiting;
  ui.groupsFoot.textContent = waiting ? ""
    : `To add a group, add @${botName()} to it in Telegram. It appears here after the bot’s next hourly run.`;
}

/** The line under a group's name: whether the bot can post there, from its last hourly check. */
function groupStatusLine(row, saved) {
  const id = cleanChatId(row.chat_id);
  if (!CHAT_ID_RE.test(id)) return null;
  const state = groupState(id);
  if (!saved || !state) return { kind: "", text: "Checked after saving, at the next hourly run" };
  if (state.moved_to) return { kind: "warn", text: `Telegram moved this group to a new ID`, fix: String(state.moved_to) };
  if (!state.ok) return { kind: "bad", text: state.error ? capital(state.error) : "The bot can’t post here" };
  return { kind: "on", text: state.title && nameKey(state.title) !== nameKey(row.name) ? `Connected · “${state.title}” in Telegram` : "Connected" };
}

/** Re-render everything that depends on the draft, except the inputs themselves. */
function refresh() {
  const errors = validate(draft);
  const show = (key) => triedSave || touched.has(key);

  ui.enabledHint.textContent = draft.enabled ? "Everyone with a deadline gets a message" : "Paused: nobody gets messages";
  ui.sendAtHint.textContent = `Tashkent time · arrives by ${fromMinutes(toMinutes(draft.send_at) + 30)}`;
  ui.sectionsHint.textContent = draft.sections_open ? "Every task is visible right away" : "Counts only; a tap opens the tasks";
  setMessage(ui.daysError, show("days") ? errors.days : null, "error");

  const notion = new Set((status.notion_people || []).map(nameKey));
  for (const row of draft.team) {
    const li = $(`.item[data-id="${row.id}"]`, ui.team);
    if (!li) continue;
    const e = errors.rows.get(row.id) || {};
    const nameError = show(`${row.id}:name`) || e.showNow ? e.name : null;
    const userError = show(`${row.id}:user`) ? e.user : null;
    const unknown = !nameError && notion.size > 0 && cleanName(row.name) && !notion.has(nameKey(row.name));
    setMessage($('[data-msg="name"]', li), nameError || (unknown ? "No open Notion tasks under this name" : null), nameError ? "error" : "warn");
    setMessage($('[data-msg="user"]', li), userError, "error");
    $('[data-field="name"]', li).setAttribute("aria-invalid", nameError ? "true" : "false");
    $('[data-field="user"]', li).setAttribute("aria-invalid", userError ? "true" : "false");
    $("[data-remove]", li).setAttribute("aria-label", cleanName(row.name) ? `Remove ${cleanName(row.name)}` : "Remove this row");
  }

  const savedIds = new Set(remote.settings.groups.map((g) => g.chat_id));
  for (const row of draft.groups) {
    const li = $(`.item[data-id="${row.id}"]`, ui.groups);
    if (!li) continue;
    const e = errors.groups.get(row.id) || {};
    const nameError = show(`${row.id}:name`) ? e.name : null;
    const idError = show(`${row.id}:chat_id`) || e.showNow ? e.chat_id : null;
    setMessage($('[data-msg="name"]', li), nameError, "error");
    setMessage($('[data-msg="chat_id"]', li), idError, "error");
    $('[data-field="name"]', li).setAttribute("aria-invalid", nameError ? "true" : "false");
    $('[data-field="chat_id"]', li).setAttribute("aria-invalid", idError ? "true" : "false");
    $("[data-remove]", li).setAttribute("aria-label", cleanName(row.name) ? `Remove ${cleanName(row.name)}` : "Remove this group");
    const line = groupStatusLine(row, savedIds.has(cleanChatId(row.chat_id)));
    const holder = $("[data-status]", li);
    holder.hidden = !line;
    if (line) {
      holder.replaceChildren(...[h("span", { class: `dot ${line.kind ? `dot-${line.kind}` : ""}` }), h("span", {}, line.text),
        line.fix && h("button", { type: "button", class: "btn btn-link btn-sm", onclick: () => { row.chat_id = line.fix; renderGroups(); refresh(); } }, "Use new ID")]
        .filter(Boolean));
    }
  }
  if (errors.noGroups && (triedSave || touched.has("groups"))) {
    ui.groupsFoot.textContent = errors.noGroups;
    ui.groupsFoot.className = "group-foot msg-error";
  } else {
    ui.groupsFoot.className = "group-foot";
    renderGroupSuggestions();
  }

  const people = draft.team.filter((r) => cleanName(r.name)).length;
  ui.teamCount.textContent = String(people);

  renderPreview();
  renderAlerts();
  renderTabDots();
  renderSavebar(errors);
}

function setMessage(node, text, kind) {
  node.hidden = !text;
  node.textContent = text || "";
  node.className = `msg ${kind === "warn" ? "msg-warn" : kind === "ok" ? "msg-ok" : "msg-error"}`;
}

function renderSavebar(errors = validate(draft)) {
  const dirty = isDirty();
  ui.savebar.hidden = !dirty && !saving;
  document.body.classList.toggle("has-savebar", !ui.savebar.hidden);
  if (saving) return;
  const count = errorCount(errors);
  const blocked = triedSave && count > 0;
  ui.saveText.classList.toggle("is-error", blocked);
  ui.saveText.textContent = blocked ? `Fix ${count === 1 ? "1 field" : `${count} fields`} to save` : "Unsaved changes";
}

// ------------------------------------------------------------------ preview (sample tasks, the bot's real layout)

const RU_DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const RU_MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const SAMPLE_TASKS = [
  { left: -3, title: "Инвентаризация склада муки" },
  { left: -1, title: "Отчёт по браку за неделю" },
  { left: 0, title: "График смен на ноябрь" },
  { left: 1, title: "Обновить техкарты круассанов" },
  { left: 2, title: "Заказ упаковки для тортов" },
  { left: 3, title: "Сверка остатков с 1С" },
];

function ruDate(iso) {
  const [, m, d] = iso.split("-").map(Number);
  return `${RU_DAYS[weekday(iso)]}, ${d} ${RU_MONTHS[m - 1]}`;
}
function ruDays(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  const word = b === 1 && a !== 11 ? "день" : b >= 2 && b <= 4 && (a < 12 || a > 14) ? "дня" : "дней";
  return `${n} ${word}`;
}

function renderPreview() {
  const today = tashkentNow().date;
  const person = draft.team.find((r) => cleanName(r.name) && USERNAME_RE.test(cleanUser(r.user)));
  const name = person ? cleanName(person.name) : "Имя Фамилия";  // this file is public: no real names in it
  const handle = person ? `@${cleanUser(person.user)}` : "@username";

  const sections = [{ icon: "🚨", title: "Просрочено", word: "просрочено", match: (l) => l < 0 },
    { icon: "🔴", title: "Сегодня", word: "сегодня", match: (l) => l === 0 },
    { icon: "🟠", title: "Завтра", word: "завтра", match: (l) => l === 1 },
    ...[2, 3].map((n) => ({ icon: "🟡", title: `Через ${ruDays(n)}`, word: `через ${ruDays(n)}`, match: (l) => l === n }))]
    .map((s) => ({ ...s, tasks: SAMPLE_TASKS.filter((t) => t.left <= draft.remind_days && s.match(t.left)) }))
    .filter((s) => s.tasks.length);

  const counts = [];
  sections.forEach((s, i) => {
    if (i) counts.push(" · ");
    counts.push(`${s.icon} `, h("b", {}, String(s.tasks.length)), ` ${s.word}`);
  });

  const bubble = h("div", { class: "tg-bubble" },
    h("p", { class: "tg-title" }, `👤 ${name} · ${ruDate(today)}`),
    h("p", { class: "tg-line" }, h("span", { class: "tg-link" }, handle), " · ", counts),
    sections.map((s) => h("div", { class: `tg-section${draft.sections_open ? " is-open" : ""}` },
      h("div", { class: "tg-summary" }, svgIcon("0 0 14 14", "M3 5l4 4 4-4", "tg-chevron"), `${s.icon} ${s.title} · ${s.tasks.length}`),
      draft.sections_open && s.tasks.map((t, i) => sampleTable(t, i + 1, today)))),
    h("span", { class: "tg-time" }, draft.send_at.replace(/:00$/, ":04")));
  ui.preview.replaceChildren(bubble);
}

function sampleTable(task, number, today) {
  const due = ruDate(addDays(today, task.left));
  return h("table", { class: "tg-table" },
    h("tr", {}, h("th", { colspan: "2" }, `${number}. ${task.title}`)),
    h("tr", {}, h("td", {}, "⏳ Срок"), h("td", {}, due, task.left < 0 ? [" · ", h("b", {}, `просрочено на ${ruDays(-task.left)}`)] : null)),
    h("tr", {}, h("td", {}, "🔗 Notion"), h("td", {}, h("span", { class: "tg-link" }, "Открыть задачу"))));
}

// ------------------------------------------------------------------ list actions

function addPeople(names) {
  selectTab("team");
  const rows = (names.length ? names : [""]).map((name) => ({ id: ++rowSeq, name, user: "", isNew: true }));
  draft.team.push(...rows);
  renderTeam();
  refresh();
  $(`#row-${rows[0].id}-${names.length ? "user" : "name"}`).focus();
}

function addGroup(group) {
  const row = { id: ++rowSeq, name: group ? group.name : "", chat_id: group ? group.chat_id : "", isNew: true };
  draft.groups.push(row);
  renderGroups();
  refresh();
  $(`#row-${row.id}-${group && group.name ? "chat_id" : "name"}`).focus();
}

function removeRow(list, id, fallbackFocus) {
  const index = list.findIndex((r) => r.id === id);
  if (index < 0) return;
  list.splice(index, 1);
  if (list === draft.groups) { touched.add("groups"); renderGroups(); } else renderTeam();
  refresh();
  const next = list[index] || list[index - 1];
  (next ? $(`#row-${next.id}-name`) : fallbackFocus).focus();
}

function bindList(container, list, rerenderKey) {
  container.addEventListener("input", (event) => {
    const input = event.target.closest("[data-field]");
    const li = event.target.closest(".item");
    if (!input || !li) return;
    const row = list().find((r) => r.id === Number(li.dataset.id));
    if (input.dataset.field === "user" && input.value.startsWith("@")) input.value = input.value.replace(/^@+/, "");
    row[input.dataset.field] = input.value;
    refresh();
  });
  container.addEventListener("focusout", (event) => {
    const input = event.target.closest("[data-field]");
    const li = event.target.closest(".item");
    if (!input || !li) return;
    touched.add(`${li.dataset.id}:${input.dataset.field}`);
    refresh();
  });
  container.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (button) removeRow(list(), Number(button.closest(".item").dataset.id), rerenderKey);
  });
}

// ------------------------------------------------------------------ bot token (a GitHub Actions secret)

async function loadSecretInfo() {
  secretInfo = { state: "loading" };
  renderBotToken();
  try {
    const secret = await github(`actions/secrets/${BOT_TOKEN_SECRET}`);
    secretInfo = { state: "set", updated: secret.updated_at };
  } catch (error) {
    secretInfo = { state: error.status === 404 ? "missing" : error.status === 403 ? "forbidden" : "error" };
  }
  renderBotToken();
}

function renderBotToken() {
  const hint = ui.botTokenHint;
  hint.className = "row-hint";
  const bot = status.bot;
  const parts = [];
  if (bot && bot.ok === false) {
    hint.classList.add("is-bad");
    parts.push("Telegram rejected the saved token");
  } else if (bot && bot.username) {
    parts.push(`Working · @${bot.username}`);
    hint.classList.add("is-ok");
  } else if (secretInfo.state === "missing") {
    parts.push("Not set");
  }
  if (secretInfo.state === "set" && secretInfo.updated) parts.push(`updated ${shortDate(secretInfo.updated)}`);
  if (!parts.length) parts.push(secretInfo.state === "loading" ? "Checking…" : "Saved as a GitHub secret");
  hint.textContent = capital(parts.join(" · "));
}

function openBotToken() {
  ui.botTokenForm.hidden = false;
  ui.botTokenOpen.hidden = true;
  pendingBot = null;
  ui.botTokenSave.textContent = "Check and save";
  setMessage(ui.botTokenMsg, secretInfo.state === "forbidden"
    ? "This GitHub token can’t save secrets yet. On GitHub, open the token and set Secrets to “Read and write”." : null, "warn");
  ui.botToken.focus();
}

function closeBotToken() {
  ui.botTokenForm.hidden = true;
  ui.botTokenOpen.hidden = false;
  ui.botToken.value = "";
  pendingBot = null;
  setMessage(ui.botTokenMsg, null);
  ui.botTokenOpen.focus();
}

/** Ask Telegram whose token it is. Returns { username } or { error }, or null when Telegram can't be reached. */
async function checkBotToken(value) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${value}/getMe`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (data.ok) return { username: data.result.username, id: data.result.id };
    return { error: res.status === 401 || res.status === 404 ? "Telegram doesn’t recognise this token. Copy it again from @BotFather." : `Telegram answered: ${data.description || res.status}` };
  } catch {
    return null;
  }
}

async function saveBotToken() {
  const value = cleanToken(ui.botToken.value);
  const fail = (text, kind = "error") => {
    setMessage(ui.botTokenMsg, text, kind);
    ui.botToken.setAttribute("aria-invalid", kind === "error" ? "true" : "false");
  };
  if (!value) return fail("Paste the token from @BotFather first.");
  if (!BOT_TOKEN_RE.test(value)) return fail("That doesn’t look like a bot token. It looks like 123456789:AAH… (numbers, a colon, then about 35 letters).");

  ui.botTokenSave.disabled = true;
  try {
    if (!pendingBot || pendingBot.value !== value) {
      ui.botTokenSave.textContent = "Checking…";
      const check = await checkBotToken(value);
      if (check && check.error) return fail(check.error);
      const current = status.bot && status.bot.username;
      pendingBot = { value, username: check && check.username };
      if (!check) {
        ui.botTokenSave.textContent = "Save anyway";
        return fail("Couldn’t reach Telegram from this browser to check the token. Check it’s copied right, then save anyway.", "warn");
      }
      if (current && check.username.toLowerCase() !== current.toLowerCase()) {
        ui.botTokenSave.textContent = `Switch to @${check.username}`;
        return fail(`This token is for a different bot, @${check.username}. It must be added to every group in the list before it can post there.`, "warn");
      }
    }
    ui.botTokenSave.textContent = "Saving…";
    await writeSecret(BOT_TOKEN_SECRET, value);
    const username = pendingBot.username;
    closeBotToken();
    secretInfo = { state: "set", updated: new Date().toISOString() };
    if (username) status.bot = { ...(status.bot || {}), ok: true, username };
    renderBotToken();
    renderIdentity();
    alertsKey = "";
    renderStatus();
    toast(username ? `Saved. The bot runs as @${username} from its next hourly run.` : "Saved. The bot uses it from its next hourly run.");
  } catch (error) {
    if (error instanceof GitHubError && error.status === 403) secretInfo.state = "forbidden";
    fail(error instanceof GitHubError ? explain(error, "secret") : "Couldn’t encrypt the token in this browser. Reload the page and try again.");
  } finally {
    ui.botTokenSave.disabled = false;
    if (!ui.botTokenForm.hidden && !pendingBot) ui.botTokenSave.textContent = "Check and save";
  }
}

// ------------------------------------------------------------------ screens

function show(screen) {
  for (const name of ["connect", "loading", "failed", "form"]) ui[name].hidden = name !== screen;
  ui.disconnect.hidden = screen === "connect" || !token;
  if (screen !== "form") {
    ui.savebar.hidden = true;
    document.body.classList.remove("has-savebar");
  }
}

function showConnect(message) {
  show("connect");
  ui.token.value = "";
  setMessage(ui.tokenError, message || null, "error");
  ui.token.setAttribute("aria-invalid", message ? "true" : "false");
}

async function load() {
  show("loading");
  try {
    const [settingsFile, statusFile] = await Promise.all([
      readFile(SETTINGS_PATH),
      readFile(STATUS_PATH).catch((e) => { if (e.status === 404) return { data: {} }; throw e; }),
    ]);
    status = statusFile.data || {};
    const settings = normalize(settingsFile.data);
    remote = { raw: settingsFile.data, sha: settingsFile.sha, settings: fromDraft(toDraft(settings)) };
    draft = toDraft(remote.settings);
    touched = new Set();
    triedSave = false;
    alertsKey = "";
    secretInfo = { state: "loading" };
    show("form");
    renderIdentity();
    fillForm();
    renderStatus();
    renderBotToken();
    let tab = "reminders";
    try { tab = sessionStorage.getItem(TAB_KEY) || tab; } catch { /* fine */ }
    selectTab(["reminders", "team", "config"].includes(tab) ? tab : "reminders");
  } catch (error) {
    if (error instanceof GitHubError && [401, 403, 404].includes(error.status) && !error.rateLimited) await diagnose(error);
    if (error instanceof GitHubError && [401, 403, 404].includes(error.status) && !error.rateLimited && !error.notToken) {
      token = null;
      forgetToken();
      showConnect(explain(error, "load"));
    } else {
      ui.failedText.textContent = error instanceof GitHubError ? explain(error, "load")
        : "The settings file couldn’t be read. Open the bot repository on GitHub to check data/settings.json.";
      show("failed");
    }
  }
}

function describeChanges(before, after) {
  const parts = [];
  if (before.enabled !== after.enabled) parts.push(after.enabled ? "turn on" : "pause");
  if (before.send_at !== after.send_at) parts.push(`send at ${after.send_at}`);
  if (before.days.join() !== after.days.join()) parts.push(`days ${after.days.join(", ") || "none"}`);
  if (before.remind_days !== after.remind_days) parts.push(`${after.remind_days} days ahead`);
  if (before.sections_open !== after.sections_open) parts.push(after.sections_open ? "sections expanded" : "sections collapsed");
  if (JSON.stringify(before.team) !== JSON.stringify(after.team)) parts.push("team");
  if (JSON.stringify(before.groups) !== JSON.stringify(after.groups)) parts.push("groups");
  return `Settings: ${parts.join(", ") || "update"} (from the settings page)`;
}

/** The tab holding the first problem, so Save can take the user to it. */
function firstErrorTab(errors) {
  if (errors.days) return "reminders";
  if (errors.rows.size) return "team";
  return "config";
}

async function save() {
  triedSave = true;
  const errors = validate(draft);
  refresh();
  if (errorCount(errors)) {
    selectTab(firstErrorTab(errors));
    const first = $('.tabpanel:not([hidden]) [aria-invalid="true"]') || (errors.days ? $("input", ui.days) : null);
    if (first) first.focus();
    return;
  }
  const next = fromDraft(draft);
  saving = true;
  ui.save.disabled = ui.discard.disabled = true;
  ui.save.textContent = "Saving…";
  ui.saveText.classList.remove("is-error");
  ui.saveText.textContent = "Saving to GitHub…";
  try {
    const raw = { ...remote.raw, ...toFile(next) };
    if (!next.groups.length && !Array.isArray(remote.raw.groups)) delete raw.groups;
    const sha = await writeFile(SETTINGS_PATH, raw, remote.sha, describeChanges(remote.settings, next));
    remote = { raw, sha, settings: next };
    draft = toDraft(next);
    touched = new Set();
    triedSave = false;
    saving = false;
    fillForm();
    renderStatus();
    toast("Saved. The bot uses it from its next hourly run.");
  } catch (error) {
    saving = false;
    ui.saveText.classList.add("is-error");
    ui.saveText.textContent = error instanceof GitHubError ? explain(error, "save") : "Couldn’t save. Try again.";
    if (error instanceof GitHubError && (error.status === 409 || error.status === 422)) {
      conflict = true;
      ui.discard.textContent = "Reload";
    }
    if (error instanceof GitHubError && error.status === 401) {
      token = null;
      forgetToken();
    }
  } finally {
    ui.save.disabled = ui.discard.disabled = false;
    ui.save.textContent = "Save";
  }
}

let toastTimer = 0;
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 6000);
}

// ------------------------------------------------------------------ events

ui.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = cleanToken(ui.token.value);
  if (!value) {
    setMessage(ui.tokenError, "Paste the token from GitHub first.", "error");
    ui.token.setAttribute("aria-invalid", "true");
    ui.token.focus();
    return;
  }
  if (!/^(github_pat_|ghp_)\w+$/.test(value)) {
    setMessage(ui.tokenError, "That doesn’t look like a GitHub token. A token starts with github_pat_ (or ghp_ for a classic one). Copy it again from GitHub: it’s shown only once, right after you press Generate token.", "error");
    ui.token.setAttribute("aria-invalid", "true");
    ui.token.focus();
    return;
  }
  token = value;
  storeToken(value, ui.remember.checked);
  await load();
});

ui.retry.addEventListener("click", load);

ui.disconnect.addEventListener("click", () => {
  if (isDirty() && !window.confirm("Disconnect and lose your unsaved changes?")) return;
  token = null;
  remote = draft = null;
  forgetToken();
  showConnect();
  ui.token.focus();
});

ui.tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => selectTab(tab.id.replace("tab-", "")));
  tab.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    selectTab(ui.tabs[(i + step + ui.tabs.length) % ui.tabs.length].id.replace("tab-", ""), true);
  });
});

ui.enabled.addEventListener("change", () => { draft.enabled = ui.enabled.checked; refresh(); });
ui.sendAt.addEventListener("change", () => { draft.send_at = ui.sendAt.value; refresh(); });
ui.days.addEventListener("change", () => {
  draft.days = $$("input:checked", ui.days).map((box) => box.value);
  touched.add("days");
  refresh();
});
$$('input[name="remind_days"]').forEach((r) => r.addEventListener("change", () => { draft.remind_days = Number(r.value); refresh(); }));
$$('input[name="sections"]').forEach((r) => r.addEventListener("change", () => { draft.sections_open = r.value === "expanded"; refresh(); }));

bindList(ui.team, () => draft.team, ui.addPerson);
bindList(ui.groups, () => draft.groups, ui.addGroup);
ui.addPerson.addEventListener("click", () => addPeople([]));
ui.addGroup.addEventListener("click", () => addGroup(null));

ui.botTokenOpen.addEventListener("click", openBotToken);
ui.botTokenCancel.addEventListener("click", closeBotToken);
ui.botTokenSave.addEventListener("click", saveBotToken);
ui.botToken.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); saveBotToken(); }
  if (event.key === "Escape") closeBotToken();
});
ui.botToken.addEventListener("input", () => {
  if (pendingBot) { pendingBot = null; ui.botTokenSave.textContent = "Check and save"; }
  setMessage(ui.botTokenMsg, null);
  ui.botToken.setAttribute("aria-invalid", "false");
});

ui.save.addEventListener("click", save);
ui.discard.addEventListener("click", () => {
  if (conflict) {
    conflict = false;
    ui.discard.textContent = "Discard";
    load();
    return;
  }
  draft = toDraft(remote.settings);
  touched = new Set();
  triedSave = false;
  fillForm();
});
ui.form.addEventListener("submit", (event) => { event.preventDefault(); save(); });

window.addEventListener("beforeunload", (event) => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = "";
});

// ------------------------------------------------------------------ start

buildStaticControls();
token = storedToken();
if (token) load();
else showConnect();
