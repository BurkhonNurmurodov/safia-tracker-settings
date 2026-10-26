"use strict";

// The bot's private repository and the files this page reads and writes there.
const OWNER = "BurkhonNurmurodov";
const REPO = "safia-tracker-bot";
const BRANCH = "main";
const SETTINGS_PATH = "data/settings.json";
const STATUS_PATH = "data/status.json";
const TZ = "Asia/Tashkent";
const TOKEN_KEY = "reminder-settings:github-token";

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const USERNAME_RE = /^[A-Za-z]\w{3,31}$/;  // the bot accepts the same
const LATE_AFTER_MIN = 90;                 // GitHub runs hourly and can lag; later than this, say so

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ------------------------------------------------------------------ elements

const ui = {
  connect: $("#connect"), connectForm: $("#connect-form"), token: $("#token"), tokenError: $("#token-error"),
  remember: $("#remember"), connectBtn: $("#connect-btn"),
  loading: $("#loading"), failed: $("#failed"), failedText: $("#failed-text"), retry: $("#retry"),
  form: $("#settings"), disconnect: $("#disconnect"),
  badge: $("#status-badge"), statusTitle: $("#status-title"), facts: $("#status-facts"), alerts: $("#alerts"),
  enabled: $("#enabled"), enabledHint: $("#enabled-hint"),
  sendAt: $("#send-at"), sendAtHint: $("#send-at-hint"),
  days: $("#days"), daysError: $("#days-error"),
  preview: $("#preview"),
  team: $("#team"), teamCount: $("#team-count"), people: $("#notion-people"), addPerson: $("#add-person"),
  rowTemplate: $("#row-template"),
  savebar: $("#savebar"), saveText: $("#save-text"), discard: $("#discard"), save: $("#save"),
  toast: $("#toast"),
};

// ------------------------------------------------------------------ state

let token = null;
let remote = null;   // { raw, sha, settings }: settings.json as GitHub has it
let status = {};     // status.json, written by the bot
let draft = null;    // what the form shows; team rows carry an id and the username without "@"
let touched = new Set();
let triedSave = false;
let saving = false;
let rowSeq = 0;
let conflict = false;  // a save hit a newer version on GitHub: Discard becomes Reload
let alertsKey = "";    // what the alerts show now, so typing doesn't re-announce them

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
  return res.json();
}

function decodeBase64(text) {
  const binary = atob(text.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
function encodeBase64(text) {
  let binary = "";
  new TextEncoder().encode(text).forEach((b) => { binary += String.fromCharCode(b); });
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
      error.diagnosis = `The token works, but it can’t see the private ${REPO} repository. On GitHub, open the token, and under Repository access choose “Only select repositories” and pick ${REPO}. (“Public repositories” is GitHub’s default and doesn’t include it.) Also check that Resource owner is BurkhonNurmurodov.`;
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
const nameKey = (name) => cleanName(name).toLocaleLowerCase();

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function fromMinutes(total) {
  const t = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
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
  };
}

function toDraft(settings) {
  return {
    ...settings,
    days: [...settings.days],
    team: settings.team.map((p) => ({ id: ++rowSeq, name: p.name, user: cleanUser(p.telegram), isNew: false })),
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
  };
}

const isDirty = () => draft && remote && JSON.stringify(fromDraft(draft)) !== JSON.stringify(remote.settings);

function validate(d) {
  const errors = { days: null, rows: new Map() };
  if (d.enabled && d.days.length === 0) errors.days = "Pick at least one day, or turn reminders off above.";
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
      e.name = "This name is in the list twice. Remove one of the rows.";
      e.showNow = true;  // the other row may never be touched, so don't wait
    }
    if (!user) e.user = "Add their Telegram username, or remove the row.";
    else if (!USERNAME_RE.test(user)) e.user = "4–32 letters, digits or _, starting with a letter.";
    if (e.name || e.user) errors.rows.set(row.id, e);
  }
  return errors;
}

function hasErrors(errors) {
  return Boolean(errors.days) || errors.rows.size > 0;
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
const sendWindow = (sendAt) => `${sendAt}–${fromMinutes(toMinutes(sendAt) + 30)}`;
function clockIn(isoStamp) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(isoStamp));
}
function dateIn(isoStamp) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(isoStamp));
}

/** When the bot sends next with these settings: { day, due } or null when it never will. */
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

// ------------------------------------------------------------------ small DOM helper

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

// ------------------------------------------------------------------ status card (what the bot does with the saved settings)

function renderStatus() {
  const s = remote.settings;
  const last = status.last_sent || null;
  const next = nextSend(s, last && last.date);
  const today = tashkentNow().date;

  const on = s.enabled && s.days.length > 0;
  ui.badge.className = `badge ${on ? "badge-on" : "badge-off"}`;
  ui.badge.textContent = on ? "On" : "Paused";
  if (!s.enabled) ui.statusTitle.textContent = "Reminders are paused";
  else if (!s.days.length) ui.statusTitle.textContent = "No reminder days are selected";
  else if (next && next.due) ui.statusTitle.textContent = "Today’s messages go out at the next hourly run";
  else if (next) ui.statusTitle.textContent = `Next messages: ${dayLabel(next.day, today)}, ${sendWindow(s.send_at)}`;

  let lastText = "No messages sent from GitHub yet";
  if (last) {
    const when = last.at ? `${capital(dayLabel(dateIn(last.at), today))} at ${clockIn(last.at)}` : capital(dayLabel(last.date, today));
    lastText = last.messages ? `${when} · ${last.messages} ${last.messages === 1 ? "message" : "messages"}`
      : `${when} · nothing was due, so no messages`;
  }
  const facts = [["Last sent", lastText]];
  if (!on) facts.push(["While paused", "Nobody is reminded. Overdue tasks are still listed when you turn it back on."]);
  else facts.push(["Sends on", s.days.length === 7 ? "Every day" : s.days.map((d) => DAY_NAMES[DAY_KEYS.indexOf(d)]).join(", ")]);
  ui.facts.replaceChildren(...facts.map(([term, value]) => h("div", {}, h("dt", {}, term), h("dd", {}, value))));

  renderAlerts(next);
}

function renderAlerts(next = nextSend(remote.settings, status.last_sent && status.last_sent.date)) {
  const runs = `https://github.com/${OWNER}/${REPO}/actions`;
  const known = new Set(draft.team.map((r) => nameKey(r.name)).filter(Boolean));
  const missing = (status.notion_people || []).filter((name) => !known.has(nameKey(name)));
  const key = JSON.stringify([status.error, next && next.late, missing, remote.settings.send_at]);
  if (key === alertsKey) return;
  alertsKey = key;
  const items = [];
  if (status.error && status.error.text) {
    const at = status.error.at ? ` · ${capital(dayLabel(dateIn(status.error.at), tashkentNow().date))} at ${clockIn(status.error.at)}` : "";
    items.push(h("div", { class: "alert alert-bad", role: "alert" },
      h("p", { class: "alert-title" }, `The last run failed${at}`),
      h("p", {}, status.error.text),
      h("a", { href: runs, target: "_blank", rel: "noopener noreferrer" }, "Open the run history")));
  } else if (next && next.late) {
    items.push(h("div", { class: "alert alert-warn" },
      h("p", { class: "alert-title" }, "Today’s messages are late"),
      h("p", {}, `They were due at ${remote.settings.send_at}. GitHub’s hourly schedule sometimes lags; the bot tries again every hour.`),
      h("a", { href: runs, target: "_blank", rel: "noopener noreferrer" }, "Open the run history")));
  }

  if (missing.length) {
    const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? ` and ${missing.length - 5} more` : "");
    items.push(h("div", { class: "alert alert-warn" },
      h("p", { class: "alert-title" },
        missing.length === 1 ? "1 person in Notion has no Telegram username" : `${missing.length} people in Notion have no Telegram username`),
      h("p", {}, `Their messages name them but don’t notify them: ${shown}.`),
      h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => addPeople(missing) },
        missing.length === 1 ? "Add to the team" : "Add them to the team")));
  }
  ui.alerts.replaceChildren(...items);
}

// ------------------------------------------------------------------ form

function buildStaticControls() {
  ui.days.replaceChildren(...DAY_KEYS.map((key, i) => h("label", { class: "pill" },
    h("input", { type: "checkbox", value: key, "aria-label": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i] }),
    h("span", {}, checkIcon(), DAY_NAMES[i]))));
}

function checkIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M5 10.5l3.2 3L15 7");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
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
  refresh();
}

function renderTeam() {
  if (!draft.team.length) {
    ui.team.replaceChildren(h("li", { class: "team-empty" }, "Nobody yet. Add the people who have tasks in Notion."));
    return;
  }
  ui.team.replaceChildren(...draft.team.map(teamRow));
}

function teamRow(row) {
  const li = ui.rowTemplate.content.firstElementChild.cloneNode(true);
  li.dataset.id = row.id;
  li.classList.toggle("is-new", row.isNew);
  for (const field of ["name", "user"]) {
    const input = $(`[data-field="${field}"]`, li);
    const label = input.closest(".field").querySelector("label");
    const msg = $(`[data-msg="${field}"]`, li);
    input.id = `row-${row.id}-${field}`;
    msg.id = `row-${row.id}-${field}-msg`;
    label.htmlFor = input.id;
    input.setAttribute("aria-describedby", msg.id);
    input.value = row[field];
  }
  const remove = $("[data-remove]", li);
  remove.setAttribute("aria-label", row.name ? `Remove ${row.name}` : "Remove this row");
  return li;
}

/** Re-render everything that depends on the draft, except the inputs themselves. */
function refresh() {
  const errors = validate(draft);
  const show = (key) => triedSave || touched.has(key);

  ui.enabledHint.textContent = draft.enabled
    ? "On: everyone with a deadline gets their message."
    : "Paused: nobody gets messages until you turn this back on.";
  ui.sendAtHint.textContent = `Tashkent time. Messages usually arrive by ${fromMinutes(toMinutes(draft.send_at) + 30)}: GitHub starts the bot once an hour and is often a few minutes late.`;

  setMessage(ui.daysError, show("days") ? errors.days : null, "error");

  const notion = new Set((status.notion_people || []).map(nameKey));
  for (const row of draft.team) {
    const li = $(`.team-row[data-id="${row.id}"]`, ui.team);
    if (!li) continue;
    const e = errors.rows.get(row.id) || {};
    const nameInput = $('[data-field="name"]', li);
    const userInput = $('[data-field="user"]', li);
    const nameError = show(`${row.id}:name`) || e.showNow ? e.name : null;
    const userError = show(`${row.id}:user`) ? e.user : null;
    const unknown = !nameError && notion.size > 0 && cleanName(row.name) && !notion.has(nameKey(row.name));
    setMessage($('[data-msg="name"]', li), nameError || (unknown ? "No open Notion tasks under this name. Check the spelling." : null),
      nameError ? "error" : "warn");
    setMessage($('[data-msg="user"]', li), userError, "error");
    nameInput.setAttribute("aria-invalid", nameError ? "true" : "false");
    userInput.setAttribute("aria-invalid", userError ? "true" : "false");
    $("[data-remove]", li).setAttribute("aria-label", cleanName(row.name) ? `Remove ${cleanName(row.name)}` : "Remove this row");
  }

  const people = draft.team.filter((r) => cleanName(r.name)).length;
  ui.teamCount.textContent = `${people} ${people === 1 ? "person" : "people"}`;

  renderPreview();
  renderAlerts();
  renderSavebar(errors);
}

function setMessage(node, text, kind) {
  node.hidden = !text;
  node.textContent = text || "";
  node.className = `msg ${kind === "warn" ? "msg-warn" : "msg-error"}`;
}

function renderSavebar(errors = validate(draft)) {
  const dirty = isDirty();
  ui.savebar.hidden = !dirty && !saving;
  document.body.classList.toggle("has-savebar", !ui.savebar.hidden);
  if (saving) return;
  const count = (errors.days ? 1 : 0) + [...errors.rows.values()].reduce((n, e) => n + (e.name ? 1 : 0) + (e.user ? 1 : 0), 0);
  const blocked = triedSave && hasErrors(errors);
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
      h("div", { class: "tg-summary" }, chevron(), `${s.icon} ${s.title} · ${s.tasks.length}`),
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

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("class", "tg-chevron");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 5l4 4 4-4");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

// ------------------------------------------------------------------ team actions

function addPeople(names) {
  const rows = (names.length ? names : [""]).map((name) => ({ id: ++rowSeq, name, user: "", isNew: Boolean(name) }));
  draft.team.push(...rows);
  renderTeam();
  refresh();
  $(`#row-${rows[0].id}-${names.length ? "user" : "name"}`).focus();
}

function removeRow(id) {
  const index = draft.team.findIndex((r) => r.id === id);
  if (index < 0) return;
  draft.team.splice(index, 1);
  renderTeam();
  refresh();
  const next = draft.team[index] || draft.team[index - 1];
  (next ? $(`#row-${next.id}-name`) : ui.addPerson).focus();
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
    const settings = normalize(settingsFile.data);
    remote = { raw: settingsFile.data, sha: settingsFile.sha, settings: fromDraft(toDraft(settings)) };
    status = statusFile.data || {};
    draft = toDraft(remote.settings);
    touched = new Set();
    triedSave = false;
    alertsKey = "";
    show("form");
    fillForm();
    renderStatus();
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
  return `Settings: ${parts.join(", ") || "update"} (from the settings page)`;
}

async function save() {
  triedSave = true;
  const errors = validate(draft);
  refresh();
  if (hasErrors(errors)) {
    const first = $('[aria-invalid="true"]', ui.form) || (errors.days ? $("input", ui.days) : null);
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
    const raw = { ...remote.raw, ...next };
    const sha = await writeFile(SETTINGS_PATH, raw, remote.sha, describeChanges(remote.settings, next));
    remote = { raw, sha, settings: next };
    draft = toDraft(next);
    touched = new Set();
    triedSave = false;
    saving = false;
    fillForm();
    renderStatus();
    toast("Saved. The bot uses the new settings from its next hourly run.");
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
    ui.save.textContent = "Save changes";
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

ui.enabled.addEventListener("change", () => { draft.enabled = ui.enabled.checked; refresh(); });
ui.sendAt.addEventListener("change", () => { draft.send_at = ui.sendAt.value; refresh(); });
ui.days.addEventListener("change", () => {
  draft.days = $$("input:checked", ui.days).map((box) => box.value);
  touched.add("days");
  refresh();
});
$$('input[name="remind_days"]').forEach((r) => r.addEventListener("change", () => { draft.remind_days = Number(r.value); refresh(); }));
$$('input[name="sections"]').forEach((r) => r.addEventListener("change", () => { draft.sections_open = r.value === "expanded"; refresh(); }));

ui.team.addEventListener("input", (event) => {
  const input = event.target.closest("[data-field]");
  const li = event.target.closest(".team-row");
  if (!input || !li) return;
  const row = draft.team.find((r) => r.id === Number(li.dataset.id));
  if (input.dataset.field === "user" && input.value.startsWith("@")) input.value = input.value.replace(/^@+/, "");
  row[input.dataset.field] = input.value;
  refresh();
});
ui.team.addEventListener("focusout", (event) => {
  const input = event.target.closest("[data-field]");
  const li = event.target.closest(".team-row");
  if (!input || !li) return;
  touched.add(`${li.dataset.id}:${input.dataset.field}`);
  refresh();
});
ui.team.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (button) removeRow(Number(button.closest(".team-row").dataset.id));
});
ui.addPerson.addEventListener("click", () => addPeople([]));

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
