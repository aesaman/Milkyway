import * as shamsi from "./shamsi.js";
import * as db from "./db.js";
import * as timer from "./timer.js";
import { lineChart, monthKeys, MONTHS } from "./charts.js";
import { buildReportModel, renderShareCanvas, encodeSnapshot, decodeSnapshot, scoreText, scorePercent } from "./share.js";

const { toFaDigits, formatLong, formatShort, todayKey, parseKey, compareKeys, daysInJalaliMonth } = shamsi;
const { formatHM, formatHMS, parseHM, elapsedMs, createTimer, pauseTimer, resumeTimer, finishTimer, uid } = timer;

const DEFAULT_SUBJECTS = [
  ["زیست", "#00A693"], ["شیمی", "#800040"], ["فیزیک", "#848482"], ["ریاضی", "#FF8200"],
  ["زمین", "#FE28A2"], ["فارسی", "#1C39BB"], ["عربی", "#93C572"], ["دینی", "#3E2723"], ["انگلیسی", "#FAD6A5"]
];
const GOLD = "#E6A817";

const appEl = document.getElementById("app");
const miniEl = document.getElementById("mini");
const overlay = document.getElementById("overlay");
const sheet = document.getElementById("sheet");
const focusEl = document.getElementById("focus");
const printEl = document.getElementById("print");

const state = {
  today: todayKey(),
  viewing: todayKey(),
  settings: { dailyTargetSec: 10 * 3600, overlay: 0.45, streak: 0 },
  catalog: [],
  day: null,
  sessions: [],
  notes: [],
  timer: null,
  focusUrl: "",
  expanded: null
};

const FONTS = {
  system: "inherit",
  rounded: '"SF Pro Rounded", "Segoe UI", Tahoma, sans-serif',
  mono: 'ui-monospace, "Cascadia Mono", "SF Mono", monospace',
  cond: '"Arial Narrow", "Segoe UI", Tahoma, sans-serif',
  soft: 'Georgia, "Noto Naskh Arabic", Tahoma, serif'
};

function fa(n) { return toFaDigits(n); }
function spoken(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h && m) return `${fa(h)} ساعت و ${fa(m)} دقیقه`;
  if (h) return `${fa(h)} ساعت`;
  return `${fa(m)} دقیقه`;
}
function clock(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  return `${fa(Math.floor(sec / 3600))}:${fa(String(Math.floor((sec % 3600) / 60)).padStart(2, "0"))}`;
}
function applyFont() {
  document.documentElement.style.setProperty("--timer-font", FONTS[state.settings.timerFont] || FONTS.system);
}
function clampPct(n) { if (!Number.isFinite(n)) return 0; return Math.max(0, Math.min(100, n)); }
function subjectTotal(s) { return (s.studySec || 0) + (s.testSec || 0); }
function dayTotal(day) {
  return Object.values(day?.subjects || {}).reduce((a, s) => a + subjectTotal(s), 0);
}
function sleepDuration(bed, wake) {
  const b = parseHM(bed);
  const w = parseHM(wake);
  if (b == null || w == null) return null;
  let d = w - b;
  if (d <= 0) d += 24 * 3600;
  return d;
}
function used(s) { return subjectTotal(s) > 0 || s.correct || s.wrong || s.blank || s.dailyNote; }

async function boot() {
  if (location.hash.startsWith("#r=")) return renderReadonly(location.hash.slice(3));
  let settings = await db.kvGet("settings");
  if (!settings) {
    settings = { dailyTargetSec: 10 * 3600, overlay: 0.45 };
    await db.kvSet("settings", settings);
  }
  state.settings = settings;
  state.catalog = await db.all("subjects");
  if (!state.catalog.length) {
    state.catalog = DEFAULT_SUBJECTS.map(([name, color]) => ({
      id: uid("sub"), name, color, targetSec: 4 * 3600, active: true, createdAt: Date.now(), updatedAt: Date.now()
    }));
    for (const s of state.catalog) await db.put("subjects", s);
  }
  state.notes = await db.all("notes");
  state.sessions = await db.all("sessions");
  state.days = await db.all("days");
  if (!state.settings.timeUnitFixed) {
    const fix = (sec) => (sec >= 60 && sec <= 24 * 60 && sec % 60 === 0) ? sec * 60 : sec;
    state.settings.dailyTargetSec = fix(state.settings.dailyTargetSec || 10 * 3600);
    state.settings.timeUnitFixed = true;
    await saveSettings();
    for (const sub of state.catalog) {
      const next = fix(sub.targetSec || 0);
      if (next !== sub.targetSec) { sub.targetSec = next; await db.put("subjects", sub); }
    }
    for (const day of state.days) {
      day.targetSec = fix(day.targetSec || 0);
      Object.values(day.subjects || {}).forEach((s) => { s.targetSec = fix(s.targetSec || 0); });
      await db.put("days", day);
    }
  }
  state.timer = await db.kvGet("activeTimer") || null;
  const blob = await db.blobGet("focusImage");
  if (blob) state.focusUrl = URL.createObjectURL(blob);
  const vid = await db.blobGet("focusVideo");
  if (vid) state.focusVideo = URL.createObjectURL(vid);
  applyFont();
  await ensureDay(state.today);
  state.viewing = state.today;
  state.day = await db.get("days", state.viewing);
  bindChrome();
  render();
  if (state.timer && state.timer.status !== "finished") openRecover();
  tick();
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      const t = todayKey();
      if (t !== state.today) {
        state.today = t;
        await ensureDay(t);
        if (state.viewing === state.today || compareKeys(state.viewing, t) > 0) state.viewing = t;
        state.day = await db.get("days", state.viewing);
      }
      render();
    }
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

async function ensureDay(date) {
  let day = await db.get("days", date);
  const target = state.settings.dailyTargetSec || 10 * 3600;
  if (!day) {
    day = { date, targetSec: target, sleep: null, subjects: {} };
    for (const sub of state.catalog.filter((s) => s.active !== false)) day.subjects[sub.id] = snapshotSubject(sub);
    await db.put("days", day);
    return day;
  }
  if (date === todayKey()) {
    let changed = false;
    for (const sub of state.catalog.filter((s) => s.active !== false)) {
      if (!day.subjects[sub.id]) {
        day.subjects[sub.id] = snapshotSubject(sub);
        changed = true;
      } else if (day.subjects[sub.id].name !== sub.name || day.subjects[sub.id].color !== sub.color || day.subjects[sub.id].targetSec !== sub.targetSec) {
        day.subjects[sub.id].name = sub.name;
        day.subjects[sub.id].color = sub.color;
        day.subjects[sub.id].targetSec = sub.targetSec;
        changed = true;
      }
    }
    if (changed) await db.put("days", day);
  }
  return day;
}

function snapshotSubject(sub) {
  return { id: sub.id, name: sub.name, color: sub.color, targetSec: sub.targetSec, studySec: 0, testSec: 0, correct: 0, wrong: 0, blank: 0, dailyNote: "" };
}

async function saveDay() {
  state.day.updatedAt = Date.now();
  await db.put("days", state.day);
  const i = state.days.findIndex((d) => d.date === state.day.date);
  if (i >= 0) state.days[i] = state.day; else state.days.push(state.day);
}
async function saveSettings() { await db.kvSet("settings", state.settings); }
async function saveTimer() {
  if (state.timer) await db.kvSet("activeTimer", state.timer);
  else await db.kvSet("activeTimer", null);
}

function bindChrome() {
  document.getElementById("dock").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-nav]");
    if (!btn) return;
    const nav = btn.dataset.nav;
    if (nav === "manage") openManage();
    if (nav === "history") openHistory();
    if (nav === "stats") openStats();
    if (nav === "share") openShare();
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSheet(); });
  appEl.addEventListener("click", onAppClick);
  appEl.addEventListener("dblclick", onDouble);
  let last = { id: "", t: 0 };
  appEl.addEventListener("touchend", (e) => {
    const el = e.target.closest("[data-dbl]");
    if (!el) return;
    const now = Date.now();
    if (last.id === el.dataset.dbl && now - last.t < 350) {
      e.preventDefault();
      handleDouble(el.dataset.dbl);
    }
    last = { id: el.dataset.dbl, t: now };
  });
  miniEl.addEventListener("click", onMini);
}

function onDouble(e) {
  const el = e.target.closest("[data-dbl]");
  if (el) handleDouble(el.dataset.dbl);
}

function handleDouble(key) {
  const [kind, id] = key.split(":");
  if (kind === "study" || kind === "test") startTimer(id, kind);
  if (kind === "edit-study" || kind === "edit-test" || kind === "edit-c" || kind === "edit-w" || kind === "edit-b") openEdit(id, kind);
}

function onAppClick(e) {
  const name = e.target.closest("[data-open]");
  if (name) openSubjectMenu(name.dataset.open);
  const back = e.target.closest("[data-today]");
  if (back) goDate(state.today);
  const note = e.target.closest("[data-note]");
  if (note) openNotes(note.dataset.note);
}

function render() {
  const day = state.day;
  if (!day) { appEl.innerHTML = "<p>در حال آماده‌سازی…</p>"; return; }
  const total = dayTotal(day);
  const target = day.targetSec || 1;
  const pct = clampPct((total / target) * 100);
  const remain = Math.max(0, target - total);
  const remainPct = clampPct(100 - pct);
  const past = state.viewing !== state.today;
  const subjects = Object.values(day.subjects);
  const updated = day.updatedAt ? new Date(day.updatedAt) : null;
  const upd = updated ? `${fa(String(updated.getHours()).padStart(2, "0"))}:${fa(String(updated.getMinutes()).padStart(2, "0"))}` : "";
  appEl.innerHTML = `
    <div class="topbar">
      <div class="when"><small>تاریخ</small><b>${formatLong(state.viewing)}</b></div>
      <div class="goal"><small>هدف مطالعه</small><b>${spoken(target)}</b></div>
    </div>
    <div class="updated">${upd ? `آخرین تغییر ${upd}` : ""}</div>
    ${past ? `<div class="past-banner"><span>در حال مشاهده ${formatShort(state.viewing)}. ثبت‌ها فقط روی همین روز ذخیره می‌شوند.</span><button class="ghost" data-today>امروز</button></div>` : ""}
    <section class="glass" id="panel">
      <div class="daily">
        ${ring(pct, GOLD, fa(Math.round(pct)) + "٪", "پیشرفت روز")}
        <div>
          <div class="meter-top">
            <div><span class="k">مطالعه شده</span><span class="v timer-font">${clock(total)}</span></div>
            <div class="l"><span class="k">باقی مانده</span><span class="v timer-font">${spoken(remain)}</span></div>
          </div>
          <div class="track"><i style="width:${pct}%;background:${GOLD}"></i></div>
          <div class="meter-bot">
            <div><span class="k">درصد باقی مانده</span><span class="v">${fa(remainPct.toFixed(0))}٪</span></div>
            <div class="l"><span class="k">تا هدف</span><span class="v">${fa(remainPct.toFixed(0))}٪</span></div>
          </div>
          <div class="done-line">${clock(total)} انجام شده . هدف ${spoken(target)}</div>
        </div>
      </div>
      ${sleepBlock(day)}
      ${subjects.map(renderSubject).join("")}
    </section>
  `;
  renderMini();
}

function ring(pct, color, main, sub, size = 108) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const dash = (clampPct(pct) / 100) * c;
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}" viewBox="0 0 108 108">
      <circle cx="54" cy="54" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="7"/>
      <circle cx="54" cy="54" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${dash} ${c}"/>
    </svg>
    <div class="lab"><strong>${main}</strong><small>${sub}</small></div>
  </div>`;
}

function sleepBlock(day) {
  if (!day.sleep?.bed || !day.sleep?.wake) return "";
  const dur = sleepDuration(day.sleep.bed, day.sleep.wake);
  const { jy, jm } = parseKey(day.date);
  const same = (state.days || []).filter((d) => d.date.startsWith(`${jy}-${String(jm).padStart(2, "0")}`) && d.sleep?.bed && d.sleep?.wake);
  const avg = same.length ? same.reduce((a, d) => a + (sleepDuration(d.sleep.bed, d.sleep.wake) || 0), 0) / same.length : dur;
  return `<div class="sleep-grid">
    <div class="sq"><small>ساعت خواب</small><b class="timer-font">${fa(day.sleep.bed)}</b></div>
    <div class="sq"><small>ساعت بیداری</small><b class="timer-font">${fa(day.sleep.wake)}</b></div>
    <div class="sq"><small>مقدار خواب امروز</small><b>${dur == null ? "—" : spoken(dur)}</b></div>
    <div class="sq"><small>میانگین ماه</small><b>${avg == null ? "—" : spoken(avg)}</b></div>
  </div>`;
}

function renderSubject(s) {
  const total = subjectTotal(s);
  const pct = s.targetSec ? clampPct((total / s.targetSec) * 100) : 0;
  const remain = Math.max(0, (s.targetSec || 0) - total);
  const studyShare = total ? (s.studySec / total) * 100 : 0;
  const testShare = total ? (s.testSec / total) * 100 : 0;
  const tests = (s.correct || 0) + (s.wrong || 0) + (s.blank || 0);
  const maxT = Math.max(1, s.correct || 0, s.wrong || 0, s.blank || 0);
  const perm = state.notes.find((n) => n.subjectId === s.id && n.kind === "permanent");
  const peek = s.dailyNote || perm?.text || "";
  return `<article class="subject">
    <div class="subject-head">
      <button class="subject-name" data-open="${s.id}" style="color:${s.color}">${s.name}</button>
      <span class="pct">${fa(Math.round(pct))}٪</span>
    </div>
    <div class="track bar"><i style="width:${pct}%;background:${s.color}"></i></div>
    <div class="fine"><span>${spoken(total)} مجموع</span><span>هدف ${spoken(s.targetSec || 0)}</span><span>مانده ${spoken(remain)}</span></div>
    ${used(s) ? `
      <div class="split">
        <div>
          <div class="fine"><span data-dbl="study:${s.id}">مطالعه / ویدئو</span><span data-dbl="edit-study:${s.id}">${spoken(s.studySec || 0)}</span></div>
          <div class="track thin" data-dbl="study:${s.id}"><i style="width:${studyShare}%;background:${s.color}"></i></div>
        </div>
        <div class="mini-ring" data-dbl="test:${s.id}">
          <svg width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r="28" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="5"/><circle cx="36" cy="36" r="28" fill="none" stroke="${s.color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(testShare / 100) * 176} 176"/></svg>
          <span class="timer-font" data-dbl="edit-test:${s.id}">${clock(s.testSec || 0)}</span>
        </div>
      </div>
      <div class="share-quiet">سهم مطالعه ${fa(studyShare.toFixed(0))}٪ · تست ${fa(testShare.toFixed(0))}٪</div>
      ${tests ? `<div class="tests">
        ${testRow("صحیح", s.correct, maxT, "#3dd68c", `edit-c:${s.id}`)}
        ${testRow("غلط", s.wrong, maxT, "#ff5d5d", `edit-w:${s.id}`)}
        ${testRow("نزده", s.blank, maxT, "#ffffff", `edit-b:${s.id}`)}
      </div>
      <div class="score"><span>مجموع تست ${fa(tests)}</span><span>درصد با نمره منفی ${scoreText(s.correct || 0, s.wrong || 0, s.blank || 0)}</span></div>` : ""}
      ${peek ? `<button class="note-peek" data-note="${s.id}">📝 ${peek.slice(0, 48)}</button>` : ""}
    ` : ""}
  </article>`;
}

function testRow(label, n, max, color, dbl) {
  const w = Math.round(((n || 0) / max) * 100);
  return `<div class="test-row"><span>${label}</span><i style="width:${w}%;color:${color};background:${color}"></i><b data-dbl="${dbl}">${fa(n || 0)}</b></div>`;
}

function renderMini() {
  const t = state.timer;
  if (!t || t.status === "finished" || focusEl.classList.contains("open")) { miniEl.classList.remove("show"); return; }
  const sub = state.day?.subjects[t.subjectId] || state.catalog.find((s) => s.id === t.subjectId);
  miniEl.classList.add("show");
  miniEl.innerHTML = `<div><small>${sub?.name || "درس"} / ${t.activity === "test" ? "تست" : "مطالعه"}</small><b>${formatHMS(elapsedMs(t))}</b><small>${t.status === "paused" ? "مکث" : "در حال مطالعه"}</small></div>
    <div class="row-actions">
      <button class="ghost" data-act="pause">${t.status === "paused" ? "ادامه" : "مکث"}</button>
      <button class="ghost" data-act="finish">پایان</button>
      <button class="ghost" data-act="full">تمام‌صفحه</button>
    </div>`;
}

function tick() {
  if (state.timer && state.timer.status === "running") {
    const b = miniEl.querySelector("b");
    if (b) b.textContent = formatHMS(elapsedMs(state.timer));
    const clock = focusEl.querySelector(".clock");
    if (clock) clock.textContent = formatHMS(elapsedMs(state.timer));
  }
  requestAnimationFrame(() => setTimeout(tick, 250));
}

function openSheet(html) {
  sheet.innerHTML = html;
  overlay.classList.add("open");
  sheet.querySelector("[data-close]")?.addEventListener("click", closeSheet);
}
function closeSheet() { overlay.classList.remove("open"); sheet.innerHTML = ""; }

function openSubjectMenu(id) {
  const s = state.day.subjects[id];
  if (!s) return;
  openSheet(`<h2>${s.name}</h2><div class="menu">
    <button class="ghost" data-a="add-study">افزودن زمان مطالعه</button>
    <button class="ghost" data-a="add-test">افزودن زمان تست</button>
    <button class="ghost" data-a="add-c">افزودن تست صحیح</button>
    <button class="ghost" data-a="add-w">افزودن تست غلط</button>
    <button class="ghost" data-a="add-b">افزودن تست نزده</button>
    <button class="ghost" data-a="notes">یادداشت‌ها</button>
    <button class="ghost" data-a="sessions">جلسه‌های این روز</button>
    <button class="ghost" data-close>بستن</button>
  </div>`);
  sheet.querySelector("[data-close]").addEventListener("click", closeSheet);
  sheet.onclick = (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    if (a === "notes") return openNotes(id);
    if (a === "sessions") return openSessions(id);
    if (a.startsWith("add-")) openAdder(id, a.slice(4));
  };
}

function openAdder(id, kind) {
  const time = kind === "study" || kind === "test";
  openSheet(`<h2>${time ? "افزودن زمان" : "افزودن تعداد"}</h2>
    <div class="field"><label>${time ? "مدت (ساعت:دقیقه)" : "تعداد"}</label><input id="val" inputmode="${time ? "text" : "numeric"}" placeholder="${time ? "01:30" : "5"}" /></div>
    <div class="row-actions"><button class="primary" id="ok">ثبت</button><button class="ghost" data-close>انصراف</button></div>`);
  sheet.querySelector("[data-close]").addEventListener("click", closeSheet);
  sheet.querySelector("#ok").onclick = async () => {
    const raw = sheet.querySelector("#val").value;
    const s = state.day.subjects[id];
    if (time) {
      const sec = parseHM(raw);
      if (sec == null) return alert("زمان نامعتبر است");
      if (kind === "study") s.studySec += sec; else s.testSec += sec;
    } else {
      const n = Number(String(raw).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
      if (!Number.isFinite(n) || n < 0 || n > 5000) return alert("تعداد نامعتبر است");
      if (kind === "c") s.correct += n;
      if (kind === "w") s.wrong += n;
      if (kind === "b") s.blank += n;
    }
    await saveDay();
    closeSheet();
    render();
  };
}

function openEdit(id, kind) {
  const s = state.day.subjects[id];
  const map = { "edit-study": ["studySec", true], "edit-test": ["testSec", true], "edit-c": ["correct", false], "edit-w": ["wrong", false], "edit-b": ["blank", false] };
  const [field, isTime] = map[kind];
  const current = isTime ? formatHM(s[field] || 0) : String(s[field] || 0);
  openSheet(`<h2>اصلاح مقدار</h2><p style="color:var(--dim);font-size:.8rem">این کار مقدار را جایگزین می‌کند، نه اینکه اضافه کند.</p>
    <div class="field"><input id="val" value="${current}" /></div>
    <div class="row-actions"><button class="primary" id="ok">ذخیره</button><button class="ghost" data-close>انصراف</button></div>`);
  sheet.querySelector("[data-close]").addEventListener("click", closeSheet);
  sheet.querySelector("#ok").onclick = async () => {
    const raw = sheet.querySelector("#val").value;
    if (isTime) {
      const sec = parseHM(raw);
      if (sec == null) return alert("زمان نامعتبر است");
      s[field] = sec;
    } else {
      const n = Number(String(raw).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
      if (!Number.isInteger(n) || n < 0 || n > 10000) return alert("تعداد نامعتبر است");
      s[field] = n;
    }
    await saveDay();
    closeSheet();
    render();
  };
}

async function startTimer(subjectId, activity) {
  if (state.timer && state.timer.status !== "finished") {
    if (state.timer.subjectId === subjectId && state.timer.activity === activity) {
      if (state.timer.status === "paused") state.timer = resumeTimer(state.timer);
      await saveTimer();
      render();
      return;
    }
    const other = state.catalog.find((s) => s.id === state.timer.subjectId);
    const ok = confirm(`تایمر ${other?.name || "درس"} در حال اجراست. متوقف شود و تایمر جدید شروع شود؟`);
    if (!ok) return;
    await finishActive(false);
  }
  state.timer = createTimer({ subjectId, activity, date: state.viewing });
  await saveTimer();
  render();
}

async function finishActive() {
  if (!state.timer || state.timer.persisted) return;
  state.timer.persisted = true;
  state.timer = finishTimer(state.timer);
  const sec = Math.round(elapsedMs(state.timer, state.timer.finishedAt) / 1000);
  const day = await db.get("days", state.timer.date);
  if (day?.subjects[state.timer.subjectId] && sec > 0) {
    const s = day.subjects[state.timer.subjectId];
    if (state.timer.activity === "test") s.testSec += sec; else s.studySec += sec;
    await db.put("days", day);
    if (day.date === state.viewing) state.day = day;
  }
  const session = {
    id: state.timer.id,
    subjectId: state.timer.subjectId,
    activity: state.timer.activity,
    date: state.timer.date,
    startTime: state.timer.segments[0]?.start,
    endTime: state.timer.finishedAt,
    duration: sec,
    status: "finished",
    persisted: true
  };
  await db.put("sessions", session);
  state.sessions.push(session);
  state.timer = null;
  await saveTimer();
  render();
}

function onMini(e) {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act || !state.timer) return;
  if (act === "pause") {
    state.timer = state.timer.status === "paused" ? resumeTimer(state.timer) : pauseTimer(state.timer);
    saveTimer().then(render);
  }
  if (act === "finish") finishActive();
  if (act === "full") openFocus();
}

function openFocus() {
  if (!state.timer) return;
  const sub = state.catalog.find((s) => s.id === state.timer.subjectId);
  focusEl.classList.add("open");
  focusEl.style.backgroundImage = !state.focusVideo && state.focusUrl ? `url(${state.focusUrl})` : "none";
  focusEl.innerHTML = `${state.focusVideo ? `<video class="bgvid" src="${state.focusVideo}" autoplay muted loop playsinline></video>` : ""}
    <div class="focus-dim" style="opacity:${state.settings.overlay ?? 0.45}"></div>
    <div class="focus-ui">
      <div>${sub?.name || ""}</div>
      <div style="color:var(--muted)">${state.timer.activity === "test" ? "تست" : "مطالعه"}</div>
      <div class="clock">${formatHMS(elapsedMs(state.timer))}</div>
      <div class="row-actions" style="justify-content:center">
        <button class="ghost" id="fp">مکث</button>
        <button class="primary" id="ff">پایان</button>
        <button class="ghost" id="fe">خروج</button>
      </div>
    </div>`;
  focusEl.querySelector("#fp").onclick = async () => {
    state.timer = state.timer.status === "paused" ? resumeTimer(state.timer) : pauseTimer(state.timer);
    await saveTimer();
    focusEl.querySelector("#fp").textContent = state.timer.status === "paused" ? "ادامه" : "مکث";
  };
  focusEl.querySelector("#ff").onclick = async () => { focusEl.classList.remove("open"); await finishActive(); };
  focusEl.querySelector("#fe").onclick = () => { focusEl.classList.remove("open"); render(); };
  miniEl.classList.remove("show");
}

function openRecover() {
  const sub = state.catalog.find((s) => s.id === state.timer.subjectId);
  openSheet(`<h2>جلسه ناتمام</h2><p>یک جلسه ${state.timer.activity === "test" ? "تست" : "مطالعه"} ناتمام برای ${sub?.name || "درس"} وجود دارد.</p>
    <div class="row-actions"><button class="primary" id="rc">ادامه</button><button class="ghost" id="rf">پایان دادن</button><button class="danger" id="rd">حذف</button></div>`);
  sheet.querySelector("#rc").onclick = async () => {
    if (state.timer.status === "paused") state.timer = resumeTimer(state.timer);
    await saveTimer();
    closeSheet();
    render();
  };
  sheet.querySelector("#rf").onclick = async () => { closeSheet(); await finishActive(); };
  sheet.querySelector("#rd").onclick = async () => {
    if (!confirm("این جلسه بدون ثبت حذف شود؟")) return;
    state.timer = null;
    await saveTimer();
    closeSheet();
    render();
  };
}

function openManage() {
  const subs = state.catalog.filter((s) => s.active !== false).map((s) => `
    <div class="subject-edit">
      <div class="field"><label>نام</label><input data-id="${s.id}" data-k="name" value="${s.name}" /></div>
      <div class="field"><label>هدف</label><input data-id="${s.id}" data-k="target" value="${formatHM(s.targetSec)}" /></div>
      <div class="row-actions">
        <input class="color-dot" type="color" data-id="${s.id}" data-k="color" value="${s.color}" />
        <button class="danger" data-del="${s.id}">حذف</button>
      </div>
    </div>`).join("");
  openSheet(`<h2>مدیریت</h2>
    <div class="field"><label>هدف روزانه</label><input id="dtarget" value="${formatHM(state.settings.dailyTargetSec)}" /></div>
    <div class="field"><label>ساعت خواب</label><input id="bed" placeholder="23:45" value="${state.day.sleep?.bed || ""}" /></div>
    <div class="field"><label>ساعت بیداری</label><input id="wake" placeholder="07:15" value="${state.day.sleep?.wake || ""}" /></div>
    <div class="field"><label>تیرگی پس‌زمینه تمرکز</label><input id="ov" type="range" min="0" max="0.85" step="0.05" value="${state.settings.overlay ?? 0.45}" /></div>
    <div class="field"><label>فونت تایمر</label><select id="font">
      <option value="system">سیستم</option><option value="rounded">گرد</option><option value="mono">مونو</option><option value="cond">فشرده</option><option value="soft">نرم</option>
    </select></div>
    <div class="row-actions"><button class="ghost" id="img">تصویر تمرکز</button><button class="ghost" id="vid">ویدیو تمرکز</button><input id="file" type="file" accept="image/*" hidden /><input id="vfile" type="file" accept="video/*" hidden /></div>
    <h2>درس‌ها</h2>${subs}
    <div class="field"><label>درس جدید</label><input id="newname" placeholder="نام درس" /></div>
    <div class="row-actions">
      <button class="primary" id="save">ذخیره</button>
      <button class="ghost" id="add">افزودن درس</button>
      <button class="ghost" id="exp">پشتیبان</button>
      <button class="ghost" id="imp">بازیابی</button>
      <button class="ghost" data-close>بستن</button>
    </div>`);
  sheet.querySelector("[data-close]").addEventListener("click", closeSheet);
  sheet.querySelector("#font").value = state.settings.timerFont || "system";
  sheet.querySelector("#img").onclick = () => sheet.querySelector("#file").click();
  sheet.querySelector("#vid").onclick = () => sheet.querySelector("#vfile").click();
  sheet.querySelector("#file").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await db.blobSet("focusImage", file);
    if (state.focusUrl) URL.revokeObjectURL(state.focusUrl);
    state.focusUrl = URL.createObjectURL(file);
  };
  sheet.querySelector("#vfile").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await db.blobSet("focusVideo", file);
    if (state.focusVideo) URL.revokeObjectURL(state.focusVideo);
    state.focusVideo = URL.createObjectURL(file);
  };
  sheet.querySelector("#add").onclick = async () => {
    const name = sheet.querySelector("#newname").value.trim();
    if (!name) return;
    const sub = { id: uid("sub"), name, color: GOLD, targetSec: 2 * 3600, active: true, createdAt: Date.now(), updatedAt: Date.now() };
    state.catalog.push(sub);
    await db.put("subjects", sub);
    state.day.subjects[sub.id] = snapshotSubject(sub);
    await saveDay();
    openManage();
    render();
  };
  sheet.querySelectorAll("[data-del]").forEach((btn) => btn.onclick = async () => {
    if (!confirm("درس از فهرست حذف شود؟ روزهای قبلی باقی می‌مانند.")) return;
    const id = btn.dataset.del;
    const sub = state.catalog.find((s) => s.id === id);
    sub.active = false;
    sub.updatedAt = Date.now();
    await db.put("subjects", sub);
    const rec = state.day.subjects[id];
    if (rec && !used(rec)) delete state.day.subjects[id];
    await saveDay();
    openManage();
    render();
  });
  sheet.querySelector("#save").onclick = async () => {
    const dt = parseHM(sheet.querySelector("#dtarget").value);
    if (dt == null) return alert("هدف روزانه نامعتبر است");
    state.settings.dailyTargetSec = dt;
    state.settings.overlay = Number(sheet.querySelector("#ov").value);
    state.settings.timerFont = sheet.querySelector("#font").value;
    await saveSettings();
    applyFont();
    state.day.targetSec = dt;
    const bed = sheet.querySelector("#bed").value.trim();
    const wake = sheet.querySelector("#wake").value.trim();
    if (bed || wake) {
      if (parseHM(bed) == null || parseHM(wake) == null) return alert("ساعت خواب نامعتبر است");
      state.day.sleep = { bed, wake };
    }
    sheet.querySelectorAll("[data-id]").forEach((input) => {
      const sub = state.catalog.find((s) => s.id === input.dataset.id);
      if (!sub) return;
      if (input.dataset.k === "name") sub.name = input.value.trim() || sub.name;
      if (input.dataset.k === "color") sub.color = input.value;
      if (input.dataset.k === "target") {
        const sec = parseHM(input.value);
        if (sec != null) sub.targetSec = sec;
      }
      sub.updatedAt = Date.now();
    });
    for (const sub of state.catalog) await db.put("subjects", sub);
    if (state.viewing === state.today) {
      for (const sub of state.catalog.filter((s) => s.active !== false)) {
        if (state.day.subjects[sub.id]) {
          state.day.subjects[sub.id].name = sub.name;
          state.day.subjects[sub.id].color = sub.color;
          state.day.subjects[sub.id].targetSec = sub.targetSec;
        }
      }
    }
    await saveDay();
    closeSheet();
    render();
  };
  sheet.querySelector("#exp").onclick = async () => {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "study-backup.json";
    a.click();
  };
  sheet.querySelector("#imp").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!confirm("داده‌های فعلی با پشتیبان جایگزین شوند؟")) return;
      const data = JSON.parse(await file.text());
      await db.importAll(data);
      location.reload();
    };
    input.click();
  };
}

async function goDate(date) {
  await ensureDay(date);
  state.viewing = date;
  state.day = await db.get("days", date);
  closeSheet();
  render();
}

function openHistory() {
  const { jy } = parseKey(state.today);
  openSheet(`<h2>تاریخچه ${fa(jy)}</h2><div class="month-grid">${MONTHS.map((m, i) => `<button class="ghost" data-m="${i + 1}">${m}</button>`).join("")}</div>
    <div class="row-actions" style="margin-top:12px"><button class="ghost" data-close>بستن</button></div>`);
  sheet.querySelector("[data-close]").addEventListener("click", closeSheet);
  sheet.querySelectorAll("[data-m]").forEach((btn) => btn.onclick = () => openMonth(jy, Number(btn.dataset.m)));
}

async function openMonth(year, month) {
  const dim = daysInJalaliMonth(year, month);
  const days = await db.all("days");
  const map = Object.fromEntries(days.map((d) => [d.date, d]));
  const items = [];
  for (let d = 1; d <= dim; d++) {
    const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const rec = map[key];
    const total = rec ? dayTotal(rec) : 0;
    const tests = rec ? Object.values(rec.subjects).reduce((a, s) => a + (s.correct || 0) + (s.wrong || 0) + (s.blank || 0), 0) : 0;
    items.push(`<button class="ghost ${total || tests ? "" : "muted-day"}" data-date="${key}">${fa(d)} ${MONTHS[month - 1]}${total ? ` · ${fa(formatHM(total))}` : ""}${tests ? ` · ${fa(tests)} تست` : ""}</button>`);
  }
  openSheet(`<h2>${MONTHS[month - 1]} ${fa(year)}</h2><div class="day-list">${items.join("")}</div>
    <div class="row-actions" style="margin-top:12px"><button class="ghost" id="back">ماه‌ها</button></div>`);
  sheet.querySelector("#back").onclick = openHistory;
  sheet.querySelectorAll("[data-date]").forEach((btn) => btn.onclick = () => goDate(btn.dataset.date));
}

async function openStats() {
  const { jy, jm } = parseKey(state.viewing);
  openSheet(`<h2>آمار ماهانه</h2>
    <div class="field"><label>ماه</label><select id="ms">${MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === jm ? "selected" : ""}>${m}</option>`).join("")}</select></div>
    <div class="tabs"><button class="ghost active" data-tab="study">مطالعه</button><button class="ghost" data-tab="test">تست</button><button class="ghost" data-tab="sleep">خواب</button></div>
    <div id="chart"></div><button class="ghost" data-close>بستن</button>`);
  sheet.querySelector("[data-close]").addEventListener("click", closeSheet);
  const draw = async (tab) => {
    const month = Number(sheet.querySelector("#ms").value);
    const days = await db.all("days");
    const map = Object.fromEntries(days.map((d) => [d.date, d]));
    const keys = monthKeys(jy, month).slice(0, daysInJalaliMonth(jy, month));
    const points = keys.map((date) => {
      const rec = map[date];
      if (!rec) return { date, value: 0 };
      if (tab === "study") return { date, value: Math.round(dayTotal(rec) / 60) };
      if (tab === "test") return { date, value: Object.values(rec.subjects).reduce((a, s) => a + (s.correct || 0) + (s.wrong || 0) + (s.blank || 0), 0) };
      const dur = rec.sleep?.bed ? sleepDuration(rec.sleep.bed, rec.sleep.wake) : 0;
      return { date, value: Math.round((dur || 0) / 60) };
    });
    const color = tab === "test" ? "#ff5d5d" : tab === "sleep" ? "#7eb6ff" : GOLD;
    const unit = (sum) => tab === "test" ? `مجموع تست: ${fa(sum)}` : `مجموع دقیقه: ${fa(sum)}`;
    lineChart(sheet.querySelector("#chart"), points, color, unit);
  };
  sheet.querySelector("#ms").onchange = () => draw(sheet.querySelector(".tabs .active").dataset.tab);
  sheet.querySelectorAll("[data-tab]").forEach((btn) => btn.onclick = () => {
    sheet.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    draw(btn.dataset.tab);
  });
  draw("study");
}

function openNotes(id) {
  const s = state.day.subjects[id];
  const perm = state.notes.filter((n) => n.subjectId === id && n.kind === "permanent");
  openSheet(`<h2>یادداشت ${s.name}</h2>
    <div class="field"><label>یادداشت دائمی</label><textarea id="perm" rows="4">${perm[0]?.text || ""}</textarea></div>
    <div class="field"><label>یادداشت همین روز</label><textarea id="daily" rows="3">${s.dailyNote || ""}</textarea></div>
    <div class="row-actions"><button class="primary" id="ok">ذخیره</button><button class="ghost" data-close>بستن</button></div>`);
  sheet.querySelector("[data-close]").addEventListener("click", closeSheet);
  sheet.querySelector("#ok").onclick = async () => {
    const text = sheet.querySelector("#perm").value.trim();
    if (perm[0]) {
      perm[0].text = text;
      perm[0].updatedAt = Date.now();
      await db.put("notes", perm[0]);
    } else if (text) {
      const note = { id: uid("note"), subjectId: id, kind: "permanent", text, updatedAt: Date.now() };
      state.notes.push(note);
      await db.put("notes", note);
    }
    s.dailyNote = sheet.querySelector("#daily").value.trim();
    await saveDay();
    closeSheet();
    render();
  };
}

function openSessions(id) {
  const list = state.sessions.filter((s) => s.subjectId === id && s.date === state.viewing && s.status === "finished");
  const rows = list.length ? list.map((s) => {
    const start = new Date(s.startTime);
    const end = new Date(s.endTime);
    const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `<div class="fine"><span>${s.activity === "test" ? "تست" : "مطالعه"} ${fa(hm(start))}–${fa(hm(end))}</span><span>${fa(formatHM(s.duration))}</span><button class="ghost" data-es="${s.id}">اصلاح</button></div>`;
  }).join("") : "<p>جلسه‌ای ثبت نشده.</p>";
  openSheet(`<h2>جلسه‌ها</h2>${rows}<button class="ghost" data-close>بستن</button>`);
  sheet.querySelector("[data-close]").addEventListener("click", closeSheet);
  sheet.querySelectorAll("[data-es]").forEach((btn) => btn.onclick = () => editSession(btn.dataset.es));
}

async function editSession(id) {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;
  const next = prompt("مدت جدید ساعت:دقیقه", formatHM(session.duration));
  if (next == null) return;
  const sec = parseHM(next);
  if (sec == null) return alert("زمان نامعتبر است");
  const s = state.day.subjects[session.subjectId];
  if (s) {
    const delta = sec - session.duration;
    if (session.activity === "test") s.testSec = Math.max(0, (s.testSec || 0) + delta);
    else s.studySec = Math.max(0, (s.studySec || 0) + delta);
    await saveDay();
  }
  session.duration = sec;
  await db.put("sessions", session);
  closeSheet();
  render();
}

function shareOptions() {
  return {
    study: sheet.querySelector("#c-study")?.checked ?? true,
    tests: sheet.querySelector("#c-test")?.checked ?? true,
    subjects: sheet.querySelector("#c-sub")?.checked ?? true,
    notes: sheet.querySelector("#c-note")?.checked ?? false,
    sleep: sheet.querySelector("#c-sleep")?.checked ?? true
  };
}

function openShare() {
  openSheet(`<h2>چه چیزی به اشتراک گذاشته شود؟</h2>
    <label class="check"><input id="c-study" type="checkbox" checked /> مطالعه</label>
    <label class="check"><input id="c-test" type="checkbox" checked /> تست</label>
    <label class="check"><input id="c-sub" type="checkbox" checked /> درس‌ها</label>
    <label class="check"><input id="c-sleep" type="checkbox" checked /> خواب</label>
    <label class="check"><input id="c-note" type="checkbox" /> یادداشت‌ها</label>
    <p style="color:var(--dim);font-size:.78rem">فقط همین روز در گزارش می‌آید. لینک فقط‌خواندنی داخل خود آدرس رمزگذاری شده و سروری برای حذف یا انقضا ندارد.</p>
    <div class="row-actions">
      <button class="primary" id="img">تصویر</button>
      <button class="ghost" id="pdf">PDF</button>
      <button class="ghost" id="link">لینک فقط‌خواندنی</button>
      <button class="ghost" data-close>بستن</button>
    </div>`);
  sheet.querySelector("[data-close]").addEventListener("click", closeSheet);
  sheet.querySelector("#img").onclick = shareImage;
  sheet.querySelector("#pdf").onclick = sharePdf;
  sheet.querySelector("#link").onclick = shareLink;
}

async function shareImage() {
  const panel = document.getElementById("panel");
  if (!panel) return;
  const w = Math.ceil(panel.scrollWidth);
  const h = Math.ceil(panel.scrollHeight);
  const css = await (await fetch("./style.css")).text();
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" dir="rtl" style="width:${w}px;background:#000;color:#fff;font-family:Tahoma,sans-serif">
          <style>${css.replace(/</g, "")}</style>
          ${panel.outerHTML}
        </div>
      </foreignObject>
    </svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const img = new Image();
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = w * 2; canvas.height = h * 2;
    const g = canvas.getContext("2d");
    g.scale(2, 2);
    g.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    const file = new File([blob], `panel-${state.viewing}.png`, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "پنل مطالعه" }); return; } catch {}
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
  } catch {
    const a = document.createElement("a");
    a.href = url;
    a.download = `panel-${state.viewing}.svg`;
    a.click();
  }
}

function sharePdf() {
  const panel = document.getElementById("panel");
  printEl.innerHTML = panel ? panel.outerHTML : "";
  window.print();
}

async function shareLink() {
  const token = encodeSnapshot({ v: 2, day: state.day, title: formatLong(state.viewing) });
  const url = `${location.origin}${location.pathname}#r=${token}`;
  try { await navigator.clipboard.writeText(url); alert("لینک پنل همین روز کپی شد. سروری برای حذف لینک وجود ندارد."); }
  catch { prompt("لینک فقط‌خواندنی:", url); }
}

function renderReadonly(token) {
  document.getElementById("dock").style.display = "none";
  let data;
  try { data = decodeSnapshot(token); } catch { appEl.innerHTML = "<p>لینک نامعتبر است.</p>"; return; }
  state.day = data.day;
  state.viewing = data.day.date;
  state.today = data.day.date;
  state.days = [data.day];
  state.notes = [];
  state.catalog = [];
  render();
  appEl.insertAdjacentHTML("afterbegin", `<p style="color:#3dd68c;font-size:.75rem">نمای فقط‌خواندنی همین پنل</p>`);
}

boot().catch((err) => {
  appEl.innerHTML = `<p>خطا در شروع برنامه: ${err.message}</p>`;
});
