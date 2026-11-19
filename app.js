/* MACHBERET_APP — מחברת: הקלטה, עריכה ב-Claude, מגירה, אישור לכספת */
const WEB_VERSION = '2026-11-19.4';
'use strict';

const Cap = window.capacitorExports || window.Capacitor;
const Vault = Cap.registerPlugin('Vault');
const Dict = Cap.registerPlugin('Dictation');
const Prefs = Cap.registerPlugin('Preferences');
const AppP = Cap.registerPlugin('App');
const Kbd = Cap.registerPlugin('Keyboard');
const Notif = Cap.registerPlugin('LocalNotifications');

const FOLDERS = { source: 'מקורות', idea: 'הגינה', course: 'קורסים', inbox: 'זמני', gate: 'שערים' };
const DRAWER = '_מחברת/מגירה';
const LOG = '_מחברת/יומן';
const STATUS_TAGS = ['לפיתוח', 'לבדוק-מקור', 'לשאלה'];

const state = {
  apiKey: '', model: 'claude-sonnet-5-5', vaultName: null,
  drafts: [], current: null,
  rec: { active: false, committed: '', partial: '' },
};

/* ---------- עזרים ---------- */
const $ = (id) => document.getElementById(id);
function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }
let toastTimer;
function toast(msg, ms = 2800) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms); }
const pad = (n) => String(n).padStart(2, '0');
function isoDate(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function stamp(d = new Date()) { return `${isoDate(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
function heDate(d = new Date()) { return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
function safeName(s) { return (s || 'ללא כותרת').replace(/[\\/:*?"<>|#^\[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function quoteLines(text, prefix = '> ') { return String(text).split('\n').map(l => prefix + l).join('\n'); }

async function getPref(k) { const r = await Prefs.get({ key: k }); return r.value; }
async function setPref(k, v) { await Prefs.set({ key: k, value: v }); }

/* ---------- כספת ---------- */
async function vaultReady() { try { const r = await withTimeout(Vault.getFolder(), 4000, 'כספת'); state.vaultName = r.name; return !!r.uri; } catch { return false; } }
async function readNote(path) { try { return (await Vault.readFile({ path })).content; } catch { return null; } }
async function writeNote(path, content) { await Vault.writeFile({ path, content }); }
async function noteExists(path) { try { return (await Vault.exists({ path })).exists; } catch { return false; } }
async function listNotes(folder = '') { try { return (await Vault.listNotes({ folder })).files || []; } catch { return []; } }

/** מפת הכספת ל-Claude: כותרות לפי תיקייה, כותרות-משנה בדפי מקור וקורס, ותגיות קיימות. */
async function buildVaultMap() {
  const files = (await listNotes()).filter(f => !f.path.startsWith('_'));
  const map = { sources: [], ideas: [], courses: [], gates: [], other: [], tags: new Set() };
  for (const f of files.slice(0, 400)) {
    const parts = f.path.split('/');
    const title = parts[parts.length - 1].replace(/\.md$/i, '');
    const top = parts.length > 1 ? parts[0] : '';
    let content = '';
    if (files.length <= 250 || top === FOLDERS.source || top === FOLDERS.course) content = (await readNote(f.path)) || '';
    (content.match(/(^|\s)#([\p{L}\p{N}_\-\/]+)/gu) || []).forEach(t => map.tags.add(t.trim().slice(1)));
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (fm) (fm[1].match(/tags:\s*\[([^\]]*)\]/) || [, ''])[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).forEach(t => map.tags.add(t));
    const headings = (content.match(/^##\s+.+$/gm) || []).map(h => h.replace(/^##\s+/, '')).slice(0, 40);
    if (top === FOLDERS.source) map.sources.push({ title, headings });
    else if (top === FOLDERS.course) map.courses.push({ title, headings: headings.slice(-5) });
    else if (top === FOLDERS.idea) map.ideas.push(title);
    else if (top === FOLDERS.gate) map.gates.push(title);
    else if (top !== FOLDERS.inbox) map.other.push(title);
  }
  map.tags = [...map.tags].filter(t => !/^\d+$/.test(t)).slice(0, 150);
  return map;
}

/* ---------- Claude ---------- */
const SYSTEM_PROMPT = `אתה העורך של הערות קוליות שהמשתמש מקליט בזמן קריאה ולימוד, ומכניס לכספת אובסידיאן שלו. המשתמש עורך ספרים בעברית, ומקפיד על לשון מדויקת.

משימה: לקבל תמלול גולמי (STT, עם שגיאות זיהוי, מילות מילוי וחזרות) ולהחזיר הצעה מובנית בפורמט JSON בלבד.

כללי עריכה:
- ערוך לעברית כתובה, רהוטה וקולחת, בלשונו ובסגנונו של המשתמש. שמור על כל התוכן ועל כוונתו.
- אל תוסיף רעיונות, טענות, מקורות או הסברים משלך. אל תקצר עד כדי איבוד תוכן.
- תקן שגיאות זיהוי דיבור ברורות (במיוחד מונחים תורניים, שמות ספרים וארמית). אם אינך בטוח במילה, השאר אותה וסמן [?].
- הסר מילות מילוי, היסוסים וחזרות.
- ציטוטים שהמשתמש מצטט — סמן במירכאות.
- הוראות מפורשות שהמשתמש אומר בהקלטה ("כותרת:", "תגיות:", "תוסיף ל...", "תקשר ל...", "זה לגינה", "לזמני") — בצע אותן והסר אותן מהטקסט הערוך. הוראה מפורשת גוברת תמיד.

קביעת יעד (kind):
- "source": ההערה עוסקת בספר או במאמר מסוים. target = שם דף המקור הקיים מהרשימה אם מתאים (בדיוק כפי שהוא), אחרת שם הספר כפי שנאמר. section = פרק/חלק אם הוזכר (למשל "פרק ז׳"), התאם לכותרות קיימות בדף אם יש.
- "course": רק אם המשתמש הזכיר במפורש קורס/סמינריון/שיעור מהרשימה. target = שם הקורס בדיוק. section ריק.
- "inbox" (תיקיית זמני): ברירת המחדל לכל הערה שאינה על מקור או קורס מסוים. כל מחשבה כללית נכנסת לכאן, ומשם המשתמש יעביר אותה בסקירה השבועית.
- "idea" (הגינה): רק אם המשתמש אמר במפורש "לגינה", "זה רעיון לגינה" או דומה. title = המחשבה עצמה כמשפט קצר. target ריק.
- אם המשתמש הזכיר בתחילת ההקלטה שם של ספר, מאמר או קורס מהרשימה (גם בקיצור, למשל מילה ראשונה מהשם) — זו הוראה מפורשת, והיעד הוא אותו מקור.
- why: משפט קצר אחד שמסביר למה נבחר היעד (למשל: אמרת "בתניא פרק ז׳").

כותרת (title): חובה תמיד, גם בהערה קצרה. 2–7 מילים שמנסחות את עיקר ההערה. בהערת "idea" — המחשבה עצמה כמשפט.

תגיות: רק מתוך רשימת התגיות הקיימות ותגיות המצב (לפיתוח, לבדוק-מקור, לשאלה). מותר להציע לכל היותר תגית חדשה אחת, ב-newTag. אל תוסיף תגיות נושא בכוח; עדיף מעט.

קשרים:
- כל קישור שהמשתמש ביקש במפורש: requested=true, title כשם ההערה הקיימת אם יש התאמה, אחרת כפי שנאמר.
- הצעות שלך: עד 3, רק להערות שמופיעות ברשימות (כותרת מדויקת), ורק אם יש קשר ממשי. reason = סוג הקשר (מחזק / סותר / מרחיב / מקביל) ומשפט קצר למה.

החזר JSON בלבד, ללא טקסט נוסף, במבנה:
{"kind":"source|idea|course|inbox","target":"","section":"","title":"","text":"","tags":[],"newTag":"","links":[{"title":"","reason":"","requested":false}],"why":""}`;

/** שם ספר/קורס שנאמר בתחילת ההקלטה הוא הוראה מפורשת — מזהים אותו בקוד, לא משאירים לניחוש. */
function detectExplicitTarget(transcript, map) {
  const norm = (x) => String(x || '').replace(/[״"׳'.,:;!?\-–—()]/g, ' ').replace(/\s+/g, ' ').trim();
  const head = ' ' + norm(transcript).split(' ').slice(0, 8).join(' ') + ' ';
  const cands = [
    ...map.sources.map(x => ({ kind: 'source', title: x.title })),
    ...map.courses.map(x => ({ kind: 'course', title: x.title })),
  ];
  let best = null;
  for (const c of cands) {
    const t = norm(c.title);
    const words = t.split(' ').filter(w => w.length >= 3);
    // התאמה לשם המלא, או למילה הראשונה המשמעותית בשם (למשל "קייסמנט")
    const keys = [t, words[0], words.slice(0, 2).join(' ')].filter(k => k && k.length >= 3);
    for (const k of keys) {
      const variants = [k, 'ב' + k, 'ה' + k, 'ל' + k];
      if (variants.some(v => head.includes(' ' + v + ' '))) {
        if (!best || k.length > best.len) best = { ...c, len: k.length };
      }
    }
  }
  return best;
}

async function callClaude(transcript, map) {
  const explicit = detectExplicitTarget(transcript, map);
  if (!state.apiKey) throw new Error('חסר מפתח API — הוסף אותו בהגדרות');
  const user = `רשימות הכספת:
דפי מקורות (וכותרות בתוכם): ${JSON.stringify(map.sources)}
קורסים: ${JSON.stringify(map.courses.map(c => c.title))}
הערות בגינה: ${JSON.stringify(map.ideas)}
שערים: ${JSON.stringify(map.gates)}
הערות אחרות: ${JSON.stringify(map.other.slice(0, 100))}
תגיות קיימות: ${JSON.stringify(map.tags)}
תאריך היום: ${heDate()}
${await personalContext()}${explicit ? `\nהוראה מפורשת: המשתמש פתח את ההקלטה בשם "${explicit.title}". היעד הוא kind="${explicit.kind}" ו-target="${explicit.title}" — גם אם ההערה קצרה או נראית כבדיקה. הסר את שם המקור מתחילת הטקסט הערוך.\n` : ''}
התמלול:
"""
${transcript}
"""`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': state.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: state.model, max_tokens: 2500, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = data?.error?.message || res.status;
    if (res.status === 401) throw new Error('המפתח לא תקין או שפג תוקפו — עדכן אותו בהגדרות');
    throw new Error('שגיאה מ-Claude: ' + m);
  }
  const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude לא החזיר תשובה במבנה הצפוי');
  const p = JSON.parse(m[0]);
  if (p.kind === 'idea' && !/לגינה|לגן|לתיקיית הגינה/.test(transcript)) p.kind = 'inbox';
  if (explicit) { p.kind = explicit.kind; p.target = explicit.title; if (!p.why || /לא ברור/.test(p.why)) p.why = `אמרת "${explicit.title.split(' ')[0]}" בתחילת ההקלטה`; }
  return {
    kind: ['source', 'idea', 'course', 'inbox'].includes(p.kind) ? p.kind : 'inbox',
    target: p.target || '', section: p.section || '', title: p.title || '', text: p.text || transcript,
    tags: Array.isArray(p.tags) ? p.tags : [], newTag: p.newTag || '',
    links: (Array.isArray(p.links) ? p.links : []).map(l => ({ title: l.title, reason: l.reason || '', requested: !!l.requested, accepted: !!l.requested })),
    why: p.why || '',
  };
}

/* ---------- טיוטות במגירה (קבצים בכספת, כדי שיסתנכרנו) ---------- */
/* טיוטות ויומן נשמרים בתוך האפליקציה — לא בכספת, כדי לא להעמיס עליך קבצים פנימיים באובסידיאן */
function fileToDraft(content) {
  const m = content.match(/^---\nmachberet: (.*)\n---/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
async function readJSON(key) { try { return JSON.parse((await getPref(key)) || '[]'); } catch { return []; } }
async function writeJSON(key, v) { await setPref(key, JSON.stringify(v)); }
async function saveDraft(d) {
  const all = (await readJSON('drafts')).filter(x => x.id !== d.id);
  all.push(d); await writeJSON('drafts', all);
}
async function loadDrafts() {
  const out = await readJSON('drafts');
  out.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  state.drafts = out;
  return out;
}
async function deleteDraft(d) { await writeJSON('drafts', (await readJSON('drafts')).filter(x => x.id !== d.id)); }

/** העברה חד-פעמית: קבצים פנימיים שנכתבו בעבר לתיקייה _מחברת בכספת עוברים לאפליקציה, והתיקייה נמחקת. */
async function migrateFromVault() {
  if ((await getPref('migrated1')) === 'yes') return;
  for (const [folder, key] of [[DRAWER, 'drafts'], [LOG, 'log']]) {
    const files = await listNotes(folder);
    if (!files.length) continue;
    const list = await readJSON(key);
    for (const f of files) {
      const c = await readNote(f.path); const e = c && fileToDraft(c);
      if (e && !list.some(x => x.id === e.id)) list.push(e);
    }
    await writeJSON(key, list);
  }
  try { await Vault.deleteFile({ path: '_מחברת' }); } catch { }
  await setPref('migrated1', 'yes');
}

/** תיקון חד-פעמי: הערות שהאפליקציה שמה בגינה בלי שביקשת — עוברות לזמני. רק כאלה שהאפליקציה עצמה כתבה (לפי היומן). */
async function moveMisplacedIdeas() {
  if ((await getPref('migrated2')) === 'yes') return 0;
  const log = await readJSON('log');
  let moved = 0;
  for (const e of log) {
    if (e.kind !== 'idea' || !e.path || !e.path.startsWith(FOLDERS.idea + '/')) continue;
    if (/לגינה|לגן/.test(e.transcript || '')) continue;
    const content = await readNote(e.path);
    if (content == null) continue;
    const name = e.path.split('/').pop().replace(/\.md$/i, '');
    const dest = await uniquePath(FOLDERS.inbox, safeName(`${isoDate(new Date(e.created))} ${name}`));
    await writeNote(dest, content);
    await Vault.deleteFile({ path: e.path });
    e.path = dest; e.kind = 'inbox';
    moved++;
  }
  await writeJSON('log', log);
  await setPref('migrated2', 'yes');
  return moved;
}

function destLabel(p) {
  if (!p) return 'ממתין לעריכה';
  if (p.kind === 'source') return `תוספת ל״${p.target}״${p.section ? ' ← ' + p.section : ''}`;
  if (p.kind === 'course') return `תוספת לקורס ״${p.target}״`;
  if (p.kind === 'idea') return 'הערה חדשה בגינה';
  return 'לתיקיית זמני';
}

async function refreshWidget() {
  const log = state.log || [];
  const last = log[0]?.title || '';
  try { await Vault.setWidgetInfo({ count: log.length, last }); } catch { }
}

/* ---------- יומן: מה נכנס לכספת השבוע (בשביל הסקירה השבועית) ---------- */
async function writeLog(d, path) {
  const p = d.proposal;
  const entry = { id: d.id, created: d.created, inserted: new Date().toISOString(), path, kind: p.kind, target: p.target, section: p.section,
    title: p.title, text: p.text, tags: p.tags, links: p.links.filter(l => l.accepted).map(l => ({ title: l.title, reason: l.reason })),
    suggested: p.links.filter(l => !l.accepted).map(l => ({ title: l.title, reason: l.reason })), newTag: p.newTag, why: p.why, transcript: d.transcript, reviewed: false };
  const cutoff = Date.now() - 60 * 864e5;
  const all = (await readJSON('log')).filter(x => new Date(x.inserted).getTime() >= cutoff && x.id !== entry.id);
  all.push(entry);
  await writeJSON('log', all);
}
async function loadLog(days = 7) {
  const since = Date.now() - days * 864e5;
  const out = (await readJSON('log')).filter(e => new Date(e.inserted).getTime() >= since);
  out.sort((a, b) => (b.inserted || '').localeCompare(a.inserted || ''));
  state.log = out;
  return out;
}

let renderGen = 0;
async function renderHome() {
  const gen = ++renderGen;
  const ready = await vaultReady();
  const hint = $('setup-hint');
  if (!ready || !state.apiKey) {
    hint.classList.remove('hidden');
    hint.innerHTML = !ready ? 'כדי להתחיל, בחר את תיקיית הכספת בהגדרות.' : 'כדי שהעריכה תעבוד, הדבק את מפתח ה-API בהגדרות.';
    hint.onclick = openSettings;
  } else hint.classList.add('hidden');
  if (ready) { await loadDrafts(); await loadLog().catch(() => { state.log = []; }); } else { state.drafts = []; state.log = []; }
  const list = document.createElement('div');
  const n = state.log.length;
  $('drawer-count').textContent = n ? (n === 1 ? 'הערה אחת השבוע' : `${n} הערות השבוע`) : '';
  $('drawer-empty').classList.toggle('hidden', state.drafts.length + n > 0);
  const pendingReview = state.log.filter(e => !e.reviewed).length;
  $('review-sub').textContent = pendingReview ? (pendingReview === 1 ? 'הערה אחת מחכה לסקירה' : `${pendingReview} הערות מחכות לסקירה`) : 'הכול נסקר';
  const tab = state.tab || 'notes';
  for (const t of ['notes', 'tasks', 'rem']) { $('tab-' + t).classList.toggle('on', tab === t); $('tab-' + t).setAttribute('aria-selected', tab === t); }
  $('list-title').textContent = tab === 'tasks' ? 'נשלח לצלול השבוע' : tab === 'rem' ? 'תזכורות' : 'השבוע';
  const draftTab = (d) => (d.route === 'tzalul' || isTaskRecording(d.transcript)) ? 'tasks' : (d.route === 'reminder' || isReminderRecording(d.transcript)) ? 'rem' : 'notes';
  for (const d of state.drafts.filter(d => draftTab(d) === tab)) {
    const b = document.createElement('button');
    b.className = (tab === 'tasks' ? 'task-card' : 'note-card') + (d.error ? ' err' : '');
    const pend = tab === 'tasks' ? '⏳ נשלח לצלול…' : tab === 'rem' ? '⏳ קובע תזכורת…' : 'בעיבוד…';
    b.innerHTML = `<div class="top"><span>${esc(d.error ? (tab === 'tasks' ? '✕ לא נשלח לצלול — ' : 'עוד לא הצליח — ') + d.error + ' · הקש לניסיון חוזר' : pend)}</span></div><div class="ex">${esc(d.transcript)}</div>`;
    b.onclick = () => processPending();
    list.appendChild(b);
  }
  if (tab === 'tasks') {
    const all = await readJSON('taskLog');
    const tl = all.filter(x => Date.now() - new Date(x.inserted).getTime() < 7 * 864e5).sort((a, b) => b.inserted.localeCompare(a.inserted));
    for (const x of tl) {
      const shown = x.tasks.map((t, i) => ({ t, i })).filter(o => !o.t.hidden);
      if (!shown.length) continue;
      const c = document.createElement('div'); c.className = 'task-card';
      c.innerHTML = `<div class="top"><span class="sent-ok">✓ נכנס לצלול</span><span>${esc(whenText(x.inserted))}</span></div>`;
      for (const { t, i } of shown) {
        const where = [t.project ? 'פרויקט ' + t.project : '', TZ_LISTS[t.list] || '', t.due ? 'עד ' + t.due.split('-').reverse().slice(0, 2).join('.') : ''].filter(Boolean).join(' · ');
        const row = document.createElement('div'); row.className = 'task-item';
        row.innerHTML = `<span class="box"></span><div class="ti"><div class="tt">${esc(t.title)}</div><div class="where">${esc(where)}</div></div>
          <button class="ti-del" aria-label="הסרה מהרשימה"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
        row.querySelector('.ti-del').onclick = async () => {
          const log = await readJSON('taskLog'); const e = log.find(z => z.id === x.id && z.inserted === x.inserted);
          if (e && e.tasks[i]) e.tasks[i].hidden = true;
          await writeJSON('taskLog', log); renderHome();
        };
        c.appendChild(row);
      }
      list.appendChild(c);
    }
    $('drawer-empty').textContent = 'עוד לא נשלחו משימות השבוע. התחל הקלטה במילה "משימה".';
    $('drawer-empty').classList.toggle('hidden', list.children.length > 0);
  } else if (tab === 'rem') {
    await renderReminders(list);
    $('drawer-empty').textContent = 'אין תזכורות. התחל הקלטה ב"תזכיר לי", למשל: "תזכיר לי ב-2:40 את השיחה עם נועה".';
    $('drawer-empty').classList.toggle('hidden', list.children.length > 0);
  } else {
    for (const e of state.log) {
      const b = document.createElement('button');
      b.className = 'note-card';
      b.innerHTML = `<div class="top"><span class="chip-dest ${e.kind}">${esc(shortDest(e))}</span><span class="when">${esc(whenText(e.inserted))}</span></div>
        <div class="t">${esc(e.title || 'הערה')}</div>
        <div class="ex">${esc(e.text)}</div>`;
      b.onclick = () => openNote(e);
      list.appendChild(b);
    }
    $('drawer-empty').textContent = 'עוד לא נכנסו הערות השבוע. הקש על המיקרופון ודבר.';
    $('drawer-empty').classList.toggle('hidden', list.children.length > 0);
  }
  if (gen !== renderGen) return;
  $('drawer-list').replaceChildren(...list.childNodes);
  refreshWidget();
}

/* ---------- הקלטה ---------- */
let doneResolver = null;

async function startRecording() {
  if (state.rec.active) return;
  if (!(await vaultReady())) { toast('קודם בחר את תיקיית הכספת בהגדרות'); openSettings(); return; }
  try {
    const avail = await Dict.available();
    if (!avail.available) { toast('זיהוי דיבור לא זמין במכשיר'); return; }
  } catch { }
  state.rec = { active: true, committed: '', partial: '' };
  $('rec-text').textContent = '';
  $('rec-status').textContent = 'מקשיב…';
  show('recording');
  const mode = (await getPref('inputMode')) || 'keyboard';
  if (mode === 'keyboard') { keyboardMode(); return; }
  if (mode === 'popup') { popupLoop(); return; }
  $('recording').classList.remove('kbd'); $('rec-input').classList.add('hidden'); $('rec-text').classList.remove('hidden');
  try {
    const r = await Dict.start({ language: (await getPref('speechLang')) || 'iw-IL', engine: (await getPref('speechEngine')) || '' });
    state.rec.service = (r && r.service) || '';
  }
  catch (e) {
    state.rec.active = false; show('home');
    toast(e.message === 'permission-denied' ? 'צריך הרשאת מיקרופון כדי להקליט' : 'לא הצלחתי להתחיל הקלטה: ' + e.message, 4000);
  }
}

function recText() { return (state.rec.committed + ' ' + state.rec.partial).trim(); }

async function setupSpeechListeners() {
  await Dict.removeAllListeners().catch(() => { });
  Dict.addListener('partial', ({ text }) => { state.rec.partial = text || ''; $('rec-text').textContent = recText(); });
  Dict.addListener('final', ({ text }) => {
    if (text) state.rec.committed = (state.rec.committed + ' ' + text).trim();
    state.rec.partial = '';
    $('rec-text').textContent = recText();
  });
  const ERR = { 1: 'רשת: זמן קצוב', 2: 'רשת', 3: 'שמע', 4: 'שרת', 5: 'לקוח', 6: 'שקט ארוך', 7: 'לא זוהו מילים', 8: 'המנוע עסוק', 9: 'אין הרשאה', 10: 'יותר מדי בקשות', 11: 'שרת התנתק', 12: 'השפה לא נתמכת', 13: 'השפה לא זמינה' };
  Dict.addListener('engine', ({ service, language }) => { setPref('speechEngine', service); setPref('speechLang', language); });
  Dict.addListener('ready', () => { $('rec-status').textContent = 'מקשיב…'; });
  Dict.addListener('status', ({ what, code }) => {
    if (what === 'speech') $('rec-status').textContent = 'שומע אותך…';
    else if (what === 'error') { state.rec.lastErr = code; $('rec-status').textContent = 'מקשיב… (' + (ERR[code] || ('קוד ' + code)) + ')'; }
  });
  Dict.addListener('error', async ({ code, message }) => {
    if (message === 'no-hebrew-engine') {
      // אף מנוע רציף לא תומך בעברית — עוברים לחלון ההכתבה של גוגל, וזוכרים את הבחירה
      await setPref('inputMode', 'keyboard');
      state.rec.active = false;
      toast('המנוע המובנה לא תומך בעברית — עובר למיקרופון של המקלדת', 4000);
      keyboardMode();
      return;
    }
    toast('שגיאת זיהוי דיבור (' + code + ')', 3500);
  });
  Dict.addListener('done', () => { if (doneResolver) { doneResolver(); doneResolver = null; } });
}

function keyboardMode() {
  state.rec = { active: true, committed: '', partial: '', kbd: true };
  const box = $('rec-input');
  box.value = '';
  $('recording').classList.add('kbd');
  box.classList.remove('hidden');
  $('rec-text').classList.add('hidden');
  $('rec-status').textContent = 'הקש על המיקרופון במקלדת ודבר. כשתסיים — לחץ "סיום".';
  show('recording');
  setTimeout(() => { box.focus(); try { Kbd.show(); } catch { } }, 150);
}

async function popupLoop() {
  state.rec = { active: true, committed: state.rec.committed || '', partial: '', popup: true };
  show('recording');
  $('rec-status').textContent = 'דבר בחלון של גוגל. כשתסיים — סגור את החלון.';
  $('rec-text').textContent = state.rec.committed;
  const lang = (await getPref('speechLang')) || 'iw-IL';
  while (state.rec.active) {
    let r;
    try { r = await Dict.prompt({ language: lang, prompt: 'דבר עכשיו' }); }
    catch (e) { toast('חלון ההכתבה לא זמין: ' + e.message, 5000); break; }
    if (!r || r.cancelled || !r.text) break;
    state.rec.committed = (state.rec.committed + ' ' + r.text).trim();
    $('rec-text').textContent = state.rec.committed;
  }
  state.rec.active = false;
  const transcript = state.rec.committed.trim();
  if (!transcript) { show('home'); toast('לא נקלט דיבור'); return; }
  await processTranscript(transcript);
}

async function stopRecording(cancel = false) {
  if (state.rec.popup) { state.rec.active = false; return; }
  if (state.rec.kbd) {
    state.rec.active = false;
    try { Kbd.hide(); } catch { }
    const t = $('rec-input').value.trim();
    if (cancel || !t) { show('home'); if (!cancel) toast('לא נכתב כלום'); return; }
    await processTranscript(t);
    return;
  }
  if (!state.rec.active && !cancel) return;
  state.rec.active = false;
  if (cancel) { try { await Dict.cancel(); } catch { } show('home'); return; }
  $('rec-status').textContent = 'מסיים…';
  const done = new Promise(r => { doneResolver = r; setTimeout(r, 3500); });
  try { await Dict.stop(); } catch { }
  await done;
  if (state.rec.partial) { state.rec.committed = (state.rec.committed + ' ' + state.rec.partial).trim(); state.rec.partial = ''; }
  const transcript = state.rec.committed.trim();
  if (!transcript) {
    show('home');
    const ERRM = { 7: 'לא זוהו מילים', 6: 'לא נשמע דיבור', 12: 'השפה עברית לא נתמכת במנוע', 13: 'עברית לא זמינה במנוע', 9: 'אין הרשאת מיקרופון', 2: 'אין חיבור רשת', 3: 'בעיית שמע', 5: 'שגיאת לקוח' };
    toast('לא נקלט דיבור' + (state.rec.lastErr ? ' — ' + (ERRM[state.rec.lastErr] || 'קוד ' + state.rec.lastErr) : '') + (state.rec.service ? ' · מנוע: ' + state.rec.service : ''), 9000);
    return;
  }
  await processTranscript(transcript);
}

/** אחרי "סיום": שומרים מיד וחוזרים — העריכה ב-Claude רצה ברקע, בלי שום פעולה מצדך. */
async function processTranscript(transcript) {
  const d = { id: stamp(), created: new Date().toISOString(), transcript, proposal: null, error: null };
  try { await saveDraft(d); }
  catch (e) { toast('לא הצלחתי לשמור: ' + e.message, 5000); show('home'); return; }
  state.drafts.unshift(d);
  toast(isTaskRecording(transcript) ? 'נשמר ✓ — נשלח לצלול בעוד רגע' : isReminderRecording(transcript) ? 'נשמר ✓ — קובע תזכורת…' : 'נשמר ✓ — ייכנס לכספת בעוד רגע', 2200);
  await renderHome().catch(() => { });
  show('home');
  if (state.fromWidget) { state.fromWidget = false; setTimeout(() => { try { AppP.minimizeApp(); } catch { } }, 700); }
  processPending();
}


/* ===================== קליטה מהאייפד ===================== */
const IPAD_INBOX = '_הגיגית/מהאייפד.md';
const IPAD_MARK = /^<<הגיגית(?:\s+([^>]*))?>>\s*$/;

/** קורא את קובץ הקליטה שקיצור הדרך באייפד מוסיף אליו, הופך כל קטע להקלטה, ומרוקן את הקובץ. */
async function pullIpadInbox() {
  const content = await readNote(IPAD_INBOX);
  if (!content || !content.trim()) return 0;
  const entries = []; let cur = null;
  for (const line of content.split('\n')) {
    const m = line.trim().match(IPAD_MARK);
    if (m) { if (cur && cur.text.trim()) entries.push(cur); cur = { when: m[1] || '', text: '' }; }
    else if (cur) cur.text += line + '\n';
    else if (line.trim()) { cur = { when: '', text: line + '\n' }; }
  }
  if (cur && cur.text.trim()) entries.push(cur);
  if (!entries.length) return 0;
  let n = 0;
  for (const e of entries) {
    const d = { id: stamp() + '-' + (n++), created: new Date().toISOString(), transcript: e.text.trim(), proposal: null, error: null, from: 'ipad' };
    await saveDraft(d);
  }
  await writeNote(IPAD_INBOX, '');
  return n;
}

let processing = false;
/** מעבד ברקע כל טיוטה שעוד לא נערכה (גם כאלה שנשארו מפעם קודמת, למשל בלי רשת). */
async function processPending() {
  if (processing || !state.apiKey) return;
  processing = true;
  try {
    try { const n = await pullIpadInbox(); if (n) toast(n === 1 ? 'הגיעה הקלטה מהאייפד' : `הגיעו ${n} הקלטות מהאייפד`, 2500); } catch { }
    const drafts = await loadDrafts();
    const pending = drafts.filter(d => !d.proposal);
    if (!pending.length) return;
    const map = await buildVaultMap();
    for (const d of pending) {
      if (isReminderRecording(d.transcript)) {
        try { const r = await createReminder(d); await deleteDraft(d); await confirmReminder(r); }
        catch (e) { d.error = e.message; d.route = 'reminder'; await saveDraft(d).catch(() => { }); }
        continue;
      }
      if (isTaskRecording(d.transcript)) {
        try { const sent = await sendToTzalul(d); await deleteDraft(d); toast(sent.length === 1 ? 'משימה נכנסה לצלול' : `${sent.length} משימות נכנסו לצלול`, 2500); }
        catch (e) { d.error = e.message; d.route = 'tzalul'; await saveDraft(d).catch(() => { }); }
        continue;
      }
      try { d.proposal = await callClaude(d.transcript, map); d.error = null; }
      catch (e) { d.error = e.message; await saveDraft(d).catch(() => { }); continue; }
      // נכנס לכספת מיד — בלי אישור. הסקירה השבועית תאפשר לתקן בדיעבד.
      try {
        if ((d.proposal.kind === 'source' || d.proposal.kind === 'course') && !d.proposal.target) d.proposal.kind = 'inbox';
        const path = await approve(d);
        await writeLog(d, path);
        await deleteDraft(d);
      } catch (e) { d.error = 'כתיבה לכספת: ' + e.message; await saveDraft(d).catch(() => { }); }
    }
    if (document.querySelector('.screen.active')?.id === 'home') await renderHome();
    else { await loadDrafts(); refreshWidget(); }
  } finally { processing = false; }
}

/* ---------- מסך טיוטה ---------- */
async function openDraft(d) {
  if (!d.proposal) { toast(d.error ? 'עוד לא נערכה: ' + d.error : 'Claude עדיין עורך את ההערה…', 3500); processPending(); return; }
  state.current = JSON.parse(JSON.stringify(d));
  const p = state.current.proposal;
  $('draft-status').textContent = 'נשמר במגירה · יחכה לאישורך';
  $('draft-kind').value = p.kind;
  $('draft-dest').value = p.target;
  $('draft-section').value = p.section;
  $('draft-why').textContent = p.why;
  $('draft-title').value = p.title;
  $('draft-text').value = p.text;
  $('draft-transcript').textContent = state.current.transcript;
  updateDestFields();
  fillDestOptions();
  renderTags();
  renderLinks();
  show('draft');
}

async function fillDestOptions() {
  const kind = $('draft-kind').value;
  const folder = kind === 'course' ? FOLDERS.course : FOLDERS.source;
  const files = await listNotes(folder);
  $('dest-options').innerHTML = files.map(f => `<option value="${esc(f.path.split('/').pop().replace(/\.md$/i, ''))}">`).join('');
}
function updateDestFields() {
  const k = $('draft-kind').value;
  $('draft-dest').classList.toggle('hidden', !(k === 'source' || k === 'course'));
  $('draft-section').classList.toggle('hidden', k !== 'source');
}

function renderTags() {
  const p = state.current.proposal;
  const box = $('draft-tags');
  box.innerHTML = '';
  const all = [...p.tags.map(t => ({ t, isNew: false }))];
  if (p.newTag) all.push({ t: p.newTag, isNew: true });
  for (const { t, isNew } of all) {
    const c = document.createElement('span');
    c.className = 'chip' + (isNew ? ' new' : '');
    c.innerHTML = `${isNew ? 'הצעה: ' : ''}#${esc(t)} <button aria-label="הסרת תגית">×</button>`;
    c.querySelector('button').onclick = () => { if (isNew) p.newTag = ''; else p.tags = p.tags.filter(x => x !== t); renderTags(); };
    if (isNew) c.ondblclick = () => { p.tags.push(t); p.newTag = ''; renderTags(); };
    box.appendChild(c);
  }
}

function renderLinks() {
  const p = state.current.proposal;
  const box = $('draft-links');
  box.innerHTML = p.links.length ? '' : '<div class="muted small">אין הצעות קישור להערה הזו.</div>';
  p.links.forEach((l) => {
    const row = document.createElement('div');
    row.className = 'link-card' + (l.accepted ? '' : ' off');
    row.innerHTML = `<div class="info"><div class="lt">${esc(l.title)}</div><div class="lr">${l.requested ? 'ביקשת לקשר · ' : 'הצעה של Claude · '}${esc(l.reason)}</div></div>
      <button class="toggle ${l.accepted ? 'on' : ''}" aria-label="${l.accepted ? 'בטל קישור' : 'אשר קישור'}">${l.accepted ? '✓' : '+'}</button>`;
    row.querySelector('button').onclick = () => { l.accepted = !l.accepted; renderLinks(); };
    box.appendChild(row);
  });
}

function collectDraft() {
  const p = state.current.proposal;
  p.kind = $('draft-kind').value;
  p.target = $('draft-dest').value.trim();
  p.section = $('draft-section').value.trim();
  p.title = $('draft-title').value.trim();
  p.text = $('draft-text').value.trim();
  return state.current;
}

/* ---------- כתיבה לכספת ---------- */
function sourceTemplate(title) {
  return `---\nסוג: מקור\nמחבר:\nשנה:\nהוצאה:\nסטטוס: בקריאה\nהפניה:\n---\n# ${title}\n`;
}
function courseTemplate(title) { return `---\nסוג: קורס\n---\n# ${title}\n`; }

function blockFor(d) {
  // הערה סופית ונקייה: כותרת, הטקסט, קישורים ותגיות. בלי תיבה, בלי תאריך ובלי תמלול.
  const p = d.proposal;
  const links = p.links.filter(l => l.accepted).map(l => `[[${l.title}]]`);
  const tags = p.tags.map(t => '#' + t.replace(/\s+/g, '-'));
  let b = `### ${p.title || 'הערה'}\n\n${p.text}`;
  if (links.length) b += `\n\nראו גם: ${links.join(' · ')}`;
  if (tags.length) b += `\n${tags.join(' ')}`;
  return b;
}

/** מוסיף בלוק תחת כותרת ## מתאימה (יוצר אותה אם חסרה) — בלי לגעת בתוכן הקיים. */
function insertUnderHeading(content, heading, block) {
  if (!heading) return content.replace(/\s*$/, '') + '\n\n' + block + '\n';
  const lines = content.split('\n');
  const norm = (s) => s.replace(/^##\s+/, '').replace(/[׳'"״]/g, '').trim();
  const idx = lines.findIndex(l => /^##\s+/.test(l) && norm(l) === norm('## ' + heading));
  if (idx === -1) return content.replace(/\s*$/, '') + `\n\n## ${heading}\n\n${block}\n`;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) if (/^#{1,2}\s+/.test(lines[i])) { end = i; break; }
  const before = lines.slice(0, end).join('\n').replace(/\s*$/, '');
  const after = lines.slice(end).join('\n');
  return before + '\n\n' + block + '\n' + (after ? '\n' + after : '');
}

async function uniquePath(folder, name) {
  let path = `${folder}/${name}.md`; let n = 2;
  while (await noteExists(path)) { path = `${folder}/${name} ${n}.md`; n++; }
  return path;
}

async function approve(d) {
  const p = d.proposal;
  if ((p.kind === 'source' || p.kind === 'course') && !p.target) { toast('חסר שם יעד'); return false; }
  if (p.kind === 'source' || p.kind === 'course') {
    const folder = p.kind === 'source' ? FOLDERS.source : FOLDERS.course;
    const path = `${folder}/${safeName(p.target)}.md`;
    let content = await readNote(path);
    if (content == null) content = p.kind === 'source' ? sourceTemplate(p.target) : courseTemplate(p.target);
    const heading = p.kind === 'course' ? heDate(new Date(d.created)) : p.section;
    await writeNote(path, insertUnderHeading(content, heading, blockFor(d)));
    return path;
  }
  if (p.kind === 'idea') {
    const links = p.links.filter(l => l.accepted);
    const tags = p.tags.map(t => `"${t}"`).join(', ');
    let c = `---\nסוג: רעיון\nנוצר: ${isoDate(new Date(d.created))}\ntags: [${tags}]\n---\n# ${p.title}\n\n${p.text}\n`;
    if (links.length) c += `\n## קשרים\n${links.map(l => `- [[${l.title}]] — ${l.reason}`).join('\n')}\n`;
    const path = await uniquePath(FOLDERS.idea, safeName(p.title));
    await writeNote(path, c);
    return path;
  }
  const path = await uniquePath(FOLDERS.inbox, safeName(`${isoDate(new Date(d.created))} ${p.title}`));
  await writeNote(path, `# ${p.title}\n\n${p.text}\n`);
  return path;
}

function openObsidian(path) {
  const vault = state.vaultName || '';
  const url = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path.replace(/\.md$/i, ''))}`;
  window.location.href = url;
}

/* ---------- הגדרות ---------- */
async function openSettings() {
  const ready = await vaultReady();
  $('vault-name').textContent = ready ? state.vaultName : 'לא נבחרה תיקייה';
  $('api-key').value = state.apiKey;
  $('model').value = state.model;
  $('speech-mode').value = (await getPref('inputMode')) || 'keyboard';
  renderDictionary();
  renderTzStatus();
  $('key-status').textContent = state.apiKey ? 'יש מפתח שמור' : '';
  show('settings');
}

async function testKey() {
  $('key-status').textContent = 'בודק…';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': $('api-key').value.trim(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: $('model').value, max_tokens: 5, messages: [{ role: 'user', content: 'שלום' }] }),
    });
    const data = await res.json().catch(() => ({}));
    $('key-status').textContent = res.ok ? '✓ המפתח עובד' : ('לא עובד: ' + (data?.error?.message || res.status));
  } catch (e) { $('key-status').textContent = 'לא עובד: ' + e.message; }
}



/* ===================== למידה מתיקונים ===================== */
const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);
const clean = (w) => w.replace(/^[״"׳'(\[«]+|[.,:;!?״"׳')\]»]+$/g, '');

/** משווה מילה-מילה ומחלץ החלפות קצרות (1–3 מילים) — אלה כנראה טעויות תמלול חוזרות. */
function extractSubs(a, b) {
  const A = words(a), B = words(b), n = A.length, m = B.length;
  if (!n || !m || n * m > 250000) return [];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = clean(A[i]) === clean(B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const subs = []; let i = 0, j = 0, da = [], db = [];
  const flush = () => {
    if (da.length && db.length && da.length <= 3 && db.length <= 3) {
      const w = da.map(clean).join(' '), r = db.map(clean).join(' ');
      if (w && r && w !== r) subs.push([w, r]);
    }
    da = []; db = [];
  };
  while (i < n && j < m) {
    if (clean(A[i]) === clean(B[j])) { flush(); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) da.push(A[i++]); else db.push(B[j++]);
  }
  while (i < n) da.push(A[i++]); while (j < m) db.push(B[j++]); flush();
  return subs;
}

async function learnFromEdit(before, after) {
  before = String(before || '').trim(); after = String(after || '').trim();
  if (!before || !after || before === after) return;
  const dict = await readJSON('dictionary');
  for (const [w, r] of extractSubs(before, after)) {
    const x = dict.find(d => d.wrong === w && d.right === r);
    if (x) x.count++; else dict.push({ wrong: w, right: r, count: 1 });
  }
  await writeJSON('dictionary', dict.slice(-300));
  const ex = await readJSON('styleExamples');
  ex.push({ before: before.slice(0, 600), after: after.slice(0, 600), at: new Date().toISOString() });
  await writeJSON('styleExamples', ex.slice(-8));
}

/** הנוסח הנוכחי של הערה בכספת (אחרי עריכה ידנית באובסידיאן), או null אם לא נמצאה במקומה. */
async function currentText(e) {
  const content = await readNote(e.path);
  if (content == null) return null;
  const strip = (body) => body.split('\n').filter(l => !/^ראו גם:/.test(l) && !/^(#[^\s#]+\s*)+$/.test(l.trim()) && !/^>/.test(l)).join('\n').trim();
  if (e.kind === 'source' || e.kind === 'course') {
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.trim() === `### ${e.title}`);
    if (idx === -1) return null;
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) if (/^#{1,3}\s/.test(lines[i])) { end = i; break; }
    return strip(lines.slice(idx + 1, end).join('\n'));
  }
  let body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  body = body.replace(/^\s*#\s+.*\n/, '');
  body = body.split(/\n##\s+קשרים/)[0];
  return strip(body);
}

/** עובר על ההערות של החודשיים האחרונים: אם תיקנת באובסידיאן — לומד, ומעדכן את היומן לנוסח שלך. */
async function scanObsidianEdits() {
  const all = await readJSON('log');
  let changed = 0;
  for (const e of all) {
    if (!e.path || !e.text) continue;
    let cur;
    try { cur = await currentText(e); } catch { cur = null; }
    if (!cur || cur === e.text.trim()) continue;
    await learnFromEdit(e.text, cur);
    e.text = cur; changed++;
  }
  if (changed) await writeJSON('log', all);
  await setPref('lastScan', String(Date.now()));
  return changed;
}

async function personalContext() {
  const dict = (await readJSON('dictionary')).filter(d => d.manual || d.count >= 2);
  const ex = (await readJSON('styleExamples')).slice(-5);
  let t = '';
  if (dict.length) t += `\nמילון אישי — טעויות תמלול חוזרות אצל המשתמש (תקן תמיד):\n${dict.map(d => `"${d.wrong}" → "${d.right}"`).join('\n')}\n`;
  if (ex.length) t += `\nדוגמאות לתיקונים שהמשתמש עשה בעריכות קודמות שלך — למד מהן את הסגנון שלו (מה הוא משנה, מוחק ומשאיר):\n${ex.map((x, i) => `${i + 1}. לפני: ${x.before}\n   אחרי: ${x.after}`).join('\n')}\n`;
  return t;
}

async function renderDictionary() {
  const box = $('dict-list'); if (!box) return;
  const dict = await readJSON('dictionary');
  const shown = dict.filter(d => d.manual || d.count >= 2);
  box.innerHTML = shown.length ? '' : '<div class="muted small">עדיין אין. המילון יתמלא מהתיקונים שלך.</div>';
  shown.forEach(d => {
    const row = document.createElement('div'); row.className = 'dict-row';
    row.innerHTML = `<span>${esc(d.wrong)} ← <b>${esc(d.right)}</b></span><button class="dict-del" aria-label="הסרה">×</button>`;
    row.querySelector('button').onclick = async () => { await writeJSON('dictionary', (await readJSON('dictionary')).filter(x => !(x.wrong === d.wrong && x.right === d.right))); renderDictionary(); };
    box.appendChild(row);
  });
}




/* ===================== תזכורות ===================== */
function isReminderRecording(t) { return /^\s*(תזכיר|תזכירי|תזכרי|תזכורת|הזכר|להזכיר|תזכור)[\s:,.\-–—]/.test(String(t) + ' '); }

const REMINDER_PROMPT = `אתה ממיר הקלטה קולית לתזכורת בטלפון.
החזר JSON בלבד: {"at":"YYYY-MM-DDTHH:MM","title":"","body":""}
כללים:
- at: הזמן המקומי (שעון ישראל) שבו להזכיר. חשב לפי התאריך והשעה הנוכחיים שתקבל.
- שעה בלי "בבוקר/בצהריים/בערב/בלילה" (למשל "ב-2:40"): בחר את המועד הקרוב ביותר בעתיד מבין שתי האפשרויות (02:40 או 14:40). אם שתיהן עברו היום — מחר.
- "בעוד רבע שעה", "בעוד שעתיים", "מחר בבוקר" (= 08:00), "בערב" (= 20:00), "יום חמישי ב-10" — חשב בהתאם.
- אם נאמר יום בלי שעה — 09:00 באותו יום.
- title: מה להזכיר, קצר ובלשונו, בלי "תזכיר לי" ובלי הזמן ("השיחה עם נועה אלזס").
- body: פרטים נוספים שאמר, אם יש. אחרת ריק.
- אם לא נאמר שום זמן — at ריק.`;

async function parseReminder(transcript) {
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const now = new Date();
  const user = `עכשיו: יום ${days[now.getDay()]}, ${isoDate(now)}, השעה ${pad(now.getHours())}:${pad(now.getMinutes())}\n${await personalContext()}\nההקלטה:\n"""\n${transcript}\n"""`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': state.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: state.model, max_tokens: 400, system: REMINDER_PROMPT, messages: [{ role: 'user', content: user }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'המפתח לא תקין או שפג תוקפו' : 'שגיאה מ-Claude: ' + (data?.error?.message || res.status));
  const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = txt.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : {};
}

/** "2026-11-19T14:40" → Date בשעון המכשיר; אם יצא בעבר — מקדמים ב-12 שעות (עד פעמיים). */
function reminderDate(at) {
  const m = String(at || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
  for (let i = 0; i < 2 && d.getTime() < Date.now() - 60000; i++) d.setTime(d.getTime() + 12 * 3600e3);
  return d.getTime() < Date.now() - 60000 ? null : d;
}

function reminderWhen(t) {
  const d = new Date(t), now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - day0) / 864e5);
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  if (diff === 0) return 'היום ב-' + hm;
  if (diff === 1) return 'מחר ב-' + hm;
  if (diff === -1) return 'אתמול ב-' + hm;
  if (diff > 1 && diff < 7) return `יום ${days[d.getDay()]} ב-${hm}`;
  return `${d.getDate()}.${d.getMonth() + 1} ב-${hm}`;
}

let remReady = null;
async function setupReminders() {
  if (remReady) return remReady;
  remReady = (async () => {
    let p = await Notif.checkPermissions();
    if (p.display !== 'granted') p = await Notif.requestPermissions();
    try {
      await Notif.createChannel({ id: 'reminders', name: 'תזכורות', description: 'תזכורות שהקלטת בהגיגית', importance: 5, visibility: 1, vibration: true });
      await Notif.createChannel({ id: 'confirm', name: 'אישור תזכורת', description: 'הודעה שקטה שהתזכורת נקבעה', importance: 2, visibility: 1, vibration: false });
    } catch { }
    return p.display === 'granted';
  })().catch((e) => { remReady = null; throw e; });
  return remReady;
}

function notifErr(e) {
  const m = String(e?.message || e);
  return /not implemented|not available|unimplemented/i.test(m) ? 'צריך להתקין את הגרסה החדשה של הגיגית (APK) כדי לקבוע תזכורות' : 'לא הצלחתי לקבוע תזכורת: ' + m;
}

async function createReminder(d) {
  let ok;
  try { ok = await setupReminders(); } catch (e) { throw new Error(notifErr(e)); }
  if (!ok) throw new Error('הגיגית צריכה הרשאה להתראות — אשר אותה בהגדרות הטלפון');
  const existing = (await readJSON('reminders')).find(x => x.id === d.id);
  if (existing) return existing;
  const r = await parseReminder(d.transcript);
  const when = reminderDate(r.at);
  if (!when) throw new Error('לא הבנתי מתי להזכיר — הקלט שוב עם שעה');
  const notifId = Math.floor(Date.now() / 1000) % 2000000000;
  const title = (r.title || d.transcript).trim();
  await scheduleReminder({ notifId, title, body: r.body || '', at: when.getTime() });
  const rem = { id: d.id, notifId, at: when.getTime(), title, body: r.body || '', transcript: d.transcript, created: new Date().toISOString() };
  const list = await readJSON('reminders');
  list.push(rem);
  await writeJSON('reminders', list.filter(x => x.at > Date.now() - 7 * 864e5));
  return rem;
}

/** אישור: הודעה קצרה בתוך האפליקציה, או התראה שקטה אם האפליקציה כבר ממוזערת. */
async function confirmReminder(r) {
  const msg = `תזכורת ${reminderWhen(r.at)}: ${r.title}`;
  let active = true;
  try { active = (await AppP.getState()).isActive; } catch { }
  if (active) { toast(msg, 4000); return; }
  try { await Notif.schedule({ notifications: [{ id: (r.notifId + 1) % 2000000000, title: 'נקבעה ' + msg.replace(/^תזכורת/, 'תזכורת'), body: '', channelId: 'confirm', smallIcon: 'ic_stat_hagigit', iconColor: '#4886D8' }] }); } catch { }
}

async function scheduleReminder(r) {
  try {
    await Notif.schedule({ notifications: [{ id: r.notifId, title: '⏰ ' + r.title, body: r.body || reminderWhen(r.at), channelId: 'reminders',
      smallIcon: 'ic_stat_hagigit', iconColor: '#4886D8', schedule: { at: new Date(r.at), allowWhileIdle: true } }] });
  } catch (e) { throw new Error(notifErr(e)); }
}

/* ---------- עריכת תזכורת ---------- */
let remEdit = null;
function openReminder(r) {
  remEdit = r;
  const d = new Date(r.at);
  $('rem-title').value = r.title;
  $('rem-body').value = r.body || '';
  $('rem-date').value = isoDate(d);
  $('rem-time').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('rem-orig').textContent = r.transcript || '';
  show('reminder');
}
async function saveReminder() {
  const r = remEdit; if (!r) return;
  const [y, mo, da] = $('rem-date').value.split('-').map(Number);
  const [h, mi] = $('rem-time').value.split(':').map(Number);
  const at = new Date(y, mo - 1, da, h, mi, 0, 0);
  const title = $('rem-title').value.trim();
  if (!title) { toast('חסר נושא לתזכורת'); return; }
  if (isNaN(at) || at.getTime() < Date.now()) { toast('השעה שבחרת כבר עברה'); return; }
  try { await Notif.cancel({ notifications: [{ id: r.notifId }] }); } catch { }
  const upd = { ...r, title, body: $('rem-body').value.trim(), at: at.getTime() };
  try { await scheduleReminder(upd); } catch (e) { toast(e.message, 5000); return; }
  const list = (await readJSON('reminders')).filter(x => x.id !== r.id);
  list.push(upd); await writeJSON('reminders', list);
  toast('התזכורת עודכנה: ' + reminderWhen(upd.at));
  remEdit = null; await renderHome(); show('home');
}
async function openNotifSettings() {
  try { await Vault.openNotificationSettings({ channel: 'reminders' }); }
  catch { toast('בהגדרות הטלפון: אפליקציות ← הגיגית ← התראות ← תזכורות', 6000); }
}

async function deleteReminder(r) {
  try { await Notif.cancel({ notifications: [{ id: r.notifId }] }); } catch { }
  const list = await readJSON('reminders');
  await writeJSON('reminders', list.filter(x => x.id !== r.id));
}

async function renderReminders(list) {
  const all = (await readJSON('reminders')).filter(x => x.at > Date.now() - 864e5);
  const up = all.filter(x => x.at >= Date.now()).sort((a, b) => a.at - b.at);
  const past = all.filter(x => x.at < Date.now()).sort((a, b) => b.at - a.at);
  for (const r of [...up, ...past]) {
    const c = document.createElement('div'); c.className = 'task-card rem-card' + (r.at < Date.now() ? ' past' : '');
    c.innerHTML = `<div class="top"><span class="rem-when">${esc(reminderWhen(r.at))}</span><button class="rem-del" aria-label="מחיקת התזכורת"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/></svg></button></div><div class="rem-t">${esc(r.title)}</div>${r.body ? `<div class="ex">${esc(r.body)}</div>` : ''}`;
    c.querySelector('.rem-del').onclick = async (ev) => { ev.stopPropagation(); await deleteReminder(r); toast('התזכורת נמחקה'); renderHome(); };
    c.onclick = () => openReminder(r);
    list.appendChild(c);
  }
}

/* ===================== צלול ===================== */
const TZ = { apiKey: 'AIzaSyA2tDkYASuqqOnUiR19EqBu7QiaT7NgpxY', project: 'tzalul-b75d5' };
const TZ_LISTS = { inbox: 'תיבת דואר נכנס', next: 'הפעולה הבאה', waiting: 'ממתין ל…', scheduled: 'מתוזמן', someday: 'יום מן הימים', later: 'מאוחר יותר' };

function isTaskRecording(t) { return /^\s*(משימה|משימות|לצלול|צלול)[\s:,.\-–—]/.test(String(t) + ' '); }

async function tzLogin(email, password) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${TZ.apiKey}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = d?.error?.message || '';
    throw new Error(/INVALID|PASSWORD|EMAIL_NOT_FOUND/.test(m) ? 'האימייל או הסיסמה שגויים' : 'ההתחברות נכשלה: ' + m);
  }
  await setPref('tzAuth', JSON.stringify({ uid: d.localId, email: d.email, refresh: d.refreshToken, token: d.idToken, exp: Date.now() + (+d.expiresIn - 60) * 1000 }));
}
async function tzAuth() {
  let a; try { a = JSON.parse((await getPref('tzAuth')) || 'null'); } catch { a = null; }
  if (!a) return null;
  if (Date.now() < a.exp) return a;
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${TZ.apiKey}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(a.refresh)}` });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('החיבור לצלול פג — התחבר מחדש בהגדרות');
  a.token = d.id_token; a.refresh = d.refresh_token; a.exp = Date.now() + (+d.expires_in - 60) * 1000;
  await setPref('tzAuth', JSON.stringify(a));
  return a;
}
const tzDocs = (uid) => `https://firestore.googleapis.com/v1/projects/${TZ.project}/databases/(default)/documents/users/${uid}/items`;

function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
}
function fromFs(f) {
  if (!f) return null;
  if ('stringValue' in f) return f.stringValue; if ('booleanValue' in f) return f.booleanValue;
  if ('integerValue' in f) return +f.integerValue; if ('doubleValue' in f) return f.doubleValue;
  if ('nullValue' in f) return null;
  if ('arrayValue' in f) return (f.arrayValue.values || []).map(fromFs);
  if ('mapValue' in f) return Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}

/** הפרויקטים הפעילים בצלול — כדי ש-Claude ישייך משימות לפרויקט קיים. */
async function tzProjects(a) {
  const out = []; let page = '';
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${tzDocs(a.uid)}?pageSize=300${page ? '&pageToken=' + page : ''}`, { headers: { authorization: 'Bearer ' + a.token } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('אין גישה לצלול: ' + (d?.error?.message || r.status));
    for (const doc of d.documents || []) {
      const it = Object.fromEntries(Object.entries(doc.fields || {}).map(([k, x]) => [k, fromFs(x)]));
      if (it.type === 'project' && !it.done && it.list !== 'trash') out.push({ id: doc.name.split('/').pop(), title: it.title });
    }
    if (!d.nextPageToken) break; page = d.nextPageToken;
  }
  return out;
}

const TASK_PROMPT = `אתה מפרק הקלטה קולית למשימות עבור אפליקציית ניהול המשימות "צלול" (שיטת GTD).
החזר JSON בלבד: {"tasks":[{"title":"","note":"","list":"inbox","due":"","start":"","project":"","tags":[],"focus":false}]}
כללים:
- כל פעולה נפרדת שהמשתמש אמר = משימה נפרדת. title: פעולה קצרה וברורה שמתחילה בפועל, בלשונו ("להתקשר לדפוס בנוגע להגהות"). note: פרטים נוספים שאמר, אם יש.
- התעלם ממילת הפתיחה ("משימה", "לצלול").
- list: "next" אם זו פעולה ברורה לביצוע בהקדם; "waiting" אם הוא מחכה למישהו אחר; "scheduled" אם אמר מתי להתחיל (אז start); "someday" ל"אולי פעם"; "later" ל"לא עכשיו אבל בטוח"; "inbox" אם לא ברור.
- due: תאריך יעד (דדליין) בפורמט YYYY-MM-DD, רק אם נאמר. start: תאריך התחלה, רק אם נאמר. חשב תאריכים יחסיים ("יום חמישי", "מחר", "בעוד שבוע") לפי התאריך של היום שתקבל.
- project: רק אם הוזכר פרויקט מהרשימה — כתוב את שמו בדיוק כמו ברשימה. אחרת ריק.
- focus: true רק אם אמר "היום", "דחוף" או "לפוקוס".
- tags: רק אם אמר במפורש תגית.`;

async function parseTasks(transcript, projects) {
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const now = new Date();
  const user = `היום: יום ${days[now.getDay()]}, ${isoDate(now)}\nפרויקטים פעילים בצלול: ${JSON.stringify(projects.map(p => p.title))}\n${await personalContext()}\nההקלטה:\n"""\n${transcript}\n"""`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': state.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: state.model, max_tokens: 2000, system: TASK_PROMPT, messages: [{ role: 'user', content: user }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'המפתח לא תקין או שפג תוקפו' : 'שגיאה מ-Claude: ' + (data?.error?.message || res.status));
  const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = txt.match(/\{[\s\S]*\}/);
  const tasks = (m ? JSON.parse(m[0]).tasks : []) || [];
  return tasks.filter(t => t && t.title).map(t => ({ ...t, list: TZ_LISTS[t.list] ? t.list : 'inbox' }));
}

async function sendToTzalul(d) {
  const a = await tzAuth();
  if (!a) throw new Error('לא מחובר לצלול — התחבר בהגדרות');
  const projects = await tzProjects(a);
  const tasks = await parseTasks(d.transcript, projects);
  if (!tasks.length) throw new Error('לא זוהו משימות בהקלטה');
  const sent = [];
  let k = 0;
  for (const t of tasks) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const proj = t.project ? projects.find(p => p.title === t.project) : null;
    const item = { type: 'task', title: t.title, note: t.note || '', list: t.list, parent: proj ? proj.id : '', area: '', tags: t.tags || [],
      due: t.due || '', start: t.start || '', focus: !!t.focus, energy: '', time: 0, repeat: null, done: false, completedAt: 0,
      created: Date.now(), order: Date.now() + (k++), updated: Date.now() };
    const r = await fetch(`${tzDocs(a.uid)}/${id}`, { method: 'PATCH',
      headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(item).map(([x, v]) => [x, toFs(v)])) }) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error('הכתיבה לצלול נכשלה: ' + (e?.error?.message || r.status)); }
    sent.push({ id, title: t.title, list: t.list, due: t.due || '', project: proj ? proj.title : '' });
  }
  const log = await readJSON('taskLog');
  log.push({ id: d.id, created: d.created, inserted: new Date().toISOString(), transcript: d.transcript, tasks: sent });
  await writeJSON('taskLog', log.filter(x => Date.now() - new Date(x.inserted).getTime() < 60 * 864e5));
  return sent;
}

async function renderTzStatus() {
  let a = null; try { a = JSON.parse((await getPref('tzAuth')) || 'null'); } catch { }
  $('tz-status').textContent = a ? `✓ מחובר לצלול (${a.email})` : 'לא מחובר';
  $('tz-form').classList.toggle('hidden', !!a);
  $('btn-tz-logout').classList.toggle('hidden', !a);
}

/* ===================== מסך קריאה ועריכה ===================== */
function shortDest(e) {
  if (e.kind === 'source' || e.kind === 'course') return e.target + (e.section ? ' ← ' + e.section : '');
  return e.kind === 'idea' ? 'הגינה' : 'זמני';
}
function whenText(iso) {
  const d = new Date(iso), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return 'היום, ' + hm;
  if (diff === 1) return 'אתמול, ' + hm;
  return heDate(d);
}
const nt = { e: null, editable: true, editing: false };

async function openNote(e) {
  nt.e = e; nt.editing = false; nt.editable = true;
  $('note-warn').classList.add('hidden');
  try {
    const cur = await currentText(e);
    if (cur == null) { nt.editable = false; }
    else if (cur !== (e.text || '').trim()) { await learnFromEdit(e.text, cur); e.text = cur; await updateLogEntry(e); }
  } catch { nt.editable = false; }
  renderNote();
  show('note');
}

function renderNote() {
  const e = nt.e;
  const where = e.kind === 'source' ? `${e.target}${e.section ? ' ← ' + e.section : ''}` : e.kind === 'course' ? `קורס: ${e.target}` : e.kind === 'idea' ? 'הגינה' : 'זמני';
  $('note-meta').textContent = `${where} · ${heDate(new Date(e.inserted))}`;
  $('note-title').textContent = e.title || 'הערה';
  $('note-text').textContent = e.text || '';
  const links = e.links || [];
  $('note-links').innerHTML = links.length ? 'ראו גם: ' + links.map(l => `<b>${esc(l.title)}</b>`).join(' · ') : '';
  $('note-tags').innerHTML = (e.tags || []).map(t => `<span>#${esc(t)}</span>`).join('');
  $('note-orig').textContent = e.transcript || '';
  const ed = nt.editing;
  $('note-title').classList.toggle('hidden', ed); $('note-text').classList.toggle('hidden', ed);
  $('note-title-in').classList.toggle('hidden', !ed); $('note-text-in').classList.toggle('hidden', !ed);
  $('note-actions').classList.toggle('hidden', !ed);
  $('btn-note-edit').classList.toggle('hidden', ed);
  $('btn-note-delete').classList.toggle('hidden', ed);
  if (!nt.editable) {
    const w = $('note-warn'); w.classList.remove('hidden');
    w.textContent = 'לא מצאתי את ההערה במקום שבו נשמרה — אולי הועברה או ששינית לה כותרת באובסידיאן. אפשר לערוך אותה שם.';
  }
}

function startNoteEdit() {
  if (!nt.editable) { toast('את ההערה הזאת אפשר לערוך רק באובסידיאן', 3500); return; }
  nt.editing = true;
  $('note-title-in').value = nt.e.title || '';
  $('note-text-in').value = nt.e.text || '';
  renderNote();
  setTimeout(() => $('note-text-in').focus(), 100);
}

async function deleteNote() {
  if (!confirm('למחוק את ההערה? היא תימחק גם מהכספת באובסידיאן.')) return;
  try {
    await removeEntry(nt.e);
    await dropLogEntry(nt.e);
    toast('ההערה נמחקה');
    nt.editing = false;
    await renderHome(); show('home');
  } catch (err) {
    const w = $('note-warn'); w.classList.remove('hidden'); w.textContent = err.message;
  }
}

async function saveNote() {
  const title = $('note-title-in').value.trim(), text = $('note-text-in').value.trim();
  if (!text) { toast('הנוסח ריק'); return; }
  if (title === nt.e.title && text === nt.e.text) { nt.editing = false; renderNote(); return; }
  $('btn-note-save').disabled = true;
  try {
    nt.e = await rewriteEntry(nt.e, { title, text });
    nt.editing = false; renderNote(); toast('נשמר בכספת');
  } catch (err) {
    const w = $('note-warn'); w.classList.remove('hidden'); w.textContent = err.message;
  }
  $('btn-note-save').disabled = false;
}

/* ===================== סקירה שבועית ===================== */
const KIND_LABEL = { source: 'מקורות', course: 'קורסים', idea: 'הגינה', inbox: 'זמני' };
const rv = { entries: [], analysis: null, busy: false };

function weekRange() {
  const end = new Date(), start = new Date(Date.now() - 6 * 864e5);
  return `${pad(start.getDate())}.${pad(start.getMonth() + 1)}–${pad(end.getDate())}.${pad(end.getMonth() + 1)}`;
}

/** מאתר את ההערה בכספת: בלוק ### בתוך דף מקור/קורס, או קובץ שלם בזמני/בגינה. מחזיר null אם שונתה ידנית. */
async function locateEntry(e) {
  const content = await readNote(e.path);
  if (content == null) return { missing: true };
  const probe = (e.text || '').trim();
  if (e.kind === 'source' || e.kind === 'course') {
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.trim() === `### ${e.title}`);
    if (idx === -1) return { edited: true };
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) if (/^#{1,3}\s/.test(lines[i])) { end = i; break; }
    const block = lines.slice(idx, end).join('\n');
    if (probe && !block.includes(probe)) return { edited: true };
    return { content, lines, idx, end, file: false };
  }
  if (probe && !content.includes(probe)) return { edited: true };
  return { content, file: true };
}

async function removeEntry(e) {
  const loc = await locateEntry(e);
  if (loc.missing) return true;
  if (loc.edited) throw new Error('ההערה שונתה ידנית באובסידיאן — לא נוגע בה');
  if (loc.file) { await Vault.deleteFile({ path: e.path }); return true; }
  const before = loc.lines.slice(0, loc.idx).join('\n').replace(/\s*$/, '');
  const after = loc.lines.slice(loc.end).join('\n').replace(/^\s*/, '');
  await writeNote(e.path, before + (after ? '\n\n' + after : '') + '\n');
  return true;
}

async function insertEntry(e) {
  const d = { id: e.id, created: e.created, transcript: e.transcript,
    proposal: { kind: e.kind, target: e.target || '', section: e.section || '', title: e.title, text: e.text,
      tags: e.tags || [], newTag: '', links: (e.links || []).map(l => ({ ...l, accepted: true })), why: e.why } };
  return await approve(d);
}

async function updateLogEntry(e) {
  const all = await readJSON('log');
  const i = all.findIndex(x => x.id === e.id);
  if (i >= 0) all[i] = e; else all.push(e);
  await writeJSON('log', all);
}
async function dropLogEntry(e) { await writeJSON('log', (await readJSON('log')).filter(x => x.id !== e.id)); }

/** שינוי הערה: מוציאים אותה ממקומה ומכניסים מחדש (אותו יעד או יעד חדש). */
async function rewriteEntry(e, changes) {
  if (changes.text && changes.text !== e.text) await learnFromEdit(e.text, changes.text);
  await removeEntry(e);
  const ne = { ...e, ...changes };
  ne.path = await insertEntry(ne);
  await updateLogEntry(ne);
  return ne;
}

const REVIEW_PROMPT = `אתה עוזר למשתמש בסקירה שבועית של ההערות שהקליט השבוע ונכנסו לכספת אובסידיאן שלו (שיטת תיבת הפתקים של זונקה אהרנס).
קבל את רשימת ההערות של השבוע ואת מפת הכספת, והחזר JSON בלבד:
{"threads":[{"title":"","ids":[],"why":"","draft":""}],"moves":[{"id":"","kind":"source|course|idea","target":"","section":"","why":""}],"links":[{"id":"","title":"","reason":""}],"summary":""}

- threads: רעיון שחזר ביותר מהערה אחת השבוע (גם במקורות שונים). title = הרעיון כמשפט קצר. draft = טיוטה קצרה (3–6 משפטים) של הערה עצמאית בלשונו של המשתמש, שמגבשת את החוט — רק ממה שכתוב בהערות, בלי להוסיף תוכן. אם אין חוט אמיתי — מערך ריק. עד 2.
- moves: רק להערות שנמצאות בזמני (kind=inbox). הצע יעד אם ברור: מקור/קורס קיים מהרשימה (target בדיוק כמו ברשימה), או "idea" לגינה אם זו מחשבה עצמאית ומגובשת. אם לא ברור — אל תציע.
- links: קישור מהערה של השבוע להערה קיימת בכספת (כותרת מדויקת מהרשימה) שיש ביניהן קשר ממשי. reason = סוג הקשר (מחזק/סותר/מרחיב/מקביל) ומשפט קצר. עד 5 בסך הכול.
- summary: משפט אחד על מה עסק השבוע.`;

async function analyzeWeek(entries, map) {
  const notes = entries.map(e => ({ id: e.id, kind: e.kind, where: e.path.replace(/\.md$/, ''), title: e.title, text: e.text }));
  const user = `מפת הכספת:
מקורות: ${JSON.stringify(map.sources.map(x => x.title))}
קורסים: ${JSON.stringify(map.courses.map(x => x.title))}
הגינה: ${JSON.stringify(map.ideas)}
שערים: ${JSON.stringify(map.gates)}
אחרות: ${JSON.stringify(map.other.slice(0, 100))}

ההערות של השבוע:
${JSON.stringify(notes)}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': state.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: state.model, max_tokens: 3000, system: REVIEW_PROMPT, messages: [{ role: 'user', content: user }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || res.status);
  const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = txt.match(/\{[\s\S]*\}/);
  const a = m ? JSON.parse(m[0]) : {};
  return { threads: a.threads || [], moves: a.moves || [], links: a.links || [], summary: a.summary || '' };
}

async function openReview() {
  if (!(await vaultReady())) { toast('קודם בחר את תיקיית הכספת בהגדרות'); return; }
  try { const n = await scanObsidianEdits(); if (n) toast(n === 1 ? 'למדתי מתיקון אחד שעשית באובסידיאן' : `למדתי מ-${n} תיקונים שעשית באובסידיאן`, 3500); } catch { }
  rv.entries = (await loadLog(7)).filter(e => !e.reviewed);
  rv.analysis = null;
  $('review-range').textContent = weekRange();
  show('review');
  renderReview();
  if (rv.entries.length && state.apiKey) {
    try { const map = await buildVaultMap(); rv.analysis = await analyzeWeek(rv.entries, map); }
    catch (e) { rv.analysis = { threads: [], moves: [], links: [], summary: '', error: e.message }; }
    renderReview();
  }
}

function renderReview() {
  const box = $('review-content');
  box.innerHTML = '';
  const E = rv.entries;
  if (!E.length) { box.innerHTML = '<div class="empty">אין השבוע הערות שמחכות לסקירה.</div>'; return; }

  // סיכום
  const counts = {};
  for (const e of E) { const k = e.kind === 'source' || e.kind === 'course' ? e.target : KIND_LABEL[e.kind]; counts[k] = (counts[k] || 0) + 1; }
  const max = Math.max(...Object.values(counts));
  const sum = document.createElement('div'); sum.className = 'rv-card';
  sum.innerHTML = `<h3>במה עסקת השבוע · ${E.length === 1 ? 'הערה אחת' : E.length + ' הערות'}</h3>
    ${rv.analysis?.summary ? `<div class="rv-why">${esc(rv.analysis.summary)}</div>` : ''}
    ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div><div class="rv-row"><span>${esc(k)}</span><span>${n}</span></div><div class="rv-bar"><span style="width:${Math.round(n / max * 100)}%"></span></div></div>`).join('')}`;
  box.appendChild(sum);

  if (!rv.analysis) { const l = document.createElement('div'); l.className = 'rv-loading'; l.textContent = state.apiKey ? 'Claude עובר על השבוע…' : ''; box.appendChild(l); }
  else if (rv.analysis.error) { const l = document.createElement('div'); l.className = 'rv-loading'; l.textContent = 'הניתוח לא הצליח: ' + rv.analysis.error; box.appendChild(l); }

  // חוטים
  for (const t of (rv.analysis?.threads || [])) {
    if (t.done) continue;
    const c = document.createElement('div'); c.className = 'rv-card rv-thread';
    c.innerHTML = `<div class="rv-dest">חוט שחזר השבוע</div><h3>${esc(t.title)}</h3><div class="rv-why">${esc(t.why || '')}</div>
      <textarea aria-label="טיוטת הערה לגינה">${esc(t.draft || '')}</textarea>
      <div class="rv-actions"><button class="sbtn primary">יצירת הערה בגינה</button><button class="sbtn">לא עכשיו</button></div>`;
    const [mk, skip] = c.querySelectorAll('button');
    mk.onclick = async () => {
      const text = c.querySelector('textarea').value.trim(); if (!text) return;
      const related = E.filter(e => (t.ids || []).includes(e.id));
      const links = related.map(e => ({ title: e.kind === 'source' || e.kind === 'course' ? e.target : e.title, reason: 'מקור החוט' }));
      const ne = { id: 'thread-' + stamp(), created: new Date().toISOString(), kind: 'idea', title: t.title, text, tags: [], links, transcript: '', why: 'חוט מהסקירה השבועית' };
      try { ne.path = await insertEntry(ne); ne.inserted = new Date().toISOString(); ne.reviewed = true; await updateLogEntry(ne); t.done = true; toast('נוצרה הערה בגינה'); renderReview(); }
      catch (e) { toast('לא הצליח: ' + e.message, 4000); }
    };
    skip.onclick = () => { t.done = true; renderReview(); };
    box.appendChild(c);
  }

  // הערות
  for (const e of E) box.appendChild(reviewCard(e));
}

function reviewCard(e) {
  const c = document.createElement('div'); c.className = 'rv-card' + (e._done ? ' rv-done' : '');
  const where = e.kind === 'source' || e.kind === 'course' ? `${KIND_LABEL[e.kind]} ← ${e.target}${e.section ? ' ← ' + e.section : ''}` : KIND_LABEL[e.kind];
  const move = (rv.analysis?.moves || []).find(m => m.id === e.id && !m.done);
  const links = (rv.analysis?.links || []).filter(l => l.id === e.id && !l.done);
  const sugg = (e.suggested || []).filter(l => !(e.links || []).some(x => x.title === l.title));
  c.innerHTML = `<div class="rv-dest">${esc(where)} · ${heDate(new Date(e.inserted))}</div>
    <input class="rv-title" value="${esc(e.title)}" aria-label="כותרת">
    <textarea class="rv-text" aria-label="נוסח">${esc(e.text)}</textarea>
    ${move ? `<div class="rv-suggest"><span>להעביר ל${esc(move.kind === 'idea' ? 'גינה' : move.target + (move.section ? ' ← ' + move.section : ''))}? <span class="rv-why">${esc(move.why || '')}</span></span><button class="sbtn primary mv-acc">העברה</button></div>` : ''}
    ${(links.length || sugg.length) ? `<div class="rv-why">קשרים מוצעים:</div><div class="rv-chips">${[...links, ...sugg].map((l, i) => `<button class="rv-chip" data-i="${i}" title="${esc(l.reason || '')}">+ ${esc(l.title)}</button>`).join('')}</div>` : ''}
    <div class="rv-move hidden">
      <select class="mv-kind" aria-label="יעד"><option value="inbox">זמני</option><option value="source">מקור</option><option value="course">קורס</option><option value="idea">הגינה</option></select>
      <input class="mv-target" placeholder="שם הספר / הקורס" list="dest-options">
      <input class="mv-section" placeholder="פרק (לא חובה)">
      <button class="sbtn primary mv-go">העבר לשם</button>
    </div>
    <div class="rv-warn hidden"></div>
    <div class="rv-actions">
      <button class="sbtn primary b-ok">✓ נסקר</button>
      <button class="sbtn b-save">שמירת שינויים</button>
      <button class="sbtn b-move">העברה</button>
      <button class="sbtn b-open">פתיחה באובסידיאן</button>
      <button class="sbtn danger b-del">מחיקה</button>
    </div>`;
  const warn = (m) => { const w = c.querySelector('.rv-warn'); w.textContent = m; w.classList.remove('hidden'); };
  const run = async (fn) => { try { await fn(); } catch (err) { warn(err.message); } };
  const replace = (ne) => { const i = rv.entries.findIndex(x => x.id === e.id); rv.entries[i] = ne; renderReview(); };

  c.querySelector('.b-ok').onclick = () => run(async () => { e.reviewed = true; await updateLogEntry(e); e._done = true; c.classList.add('rv-done'); });
  c.querySelector('.b-open').onclick = () => openObsidian(e.path);
  c.querySelector('.b-save').onclick = () => run(async () => {
    const title = c.querySelector('.rv-title').value.trim(), text = c.querySelector('.rv-text').value.trim();
    if (title === e.title && text === e.text) { toast('אין שינויים'); return; }
    replace(await rewriteEntry(e, { title, text })); toast('נשמר בכספת');
  });
  c.querySelector('.b-del').onclick = () => run(async () => {
    if (!confirm('למחוק את ההערה מהכספת?')) return;
    await removeEntry(e); await dropLogEntry(e);
    rv.entries = rv.entries.filter(x => x.id !== e.id); renderReview(); toast('נמחק');
  });
  c.querySelector('.b-move').onclick = () => { c.querySelector('.rv-move').classList.toggle('hidden'); fillDestOptionsFor('source'); };
  c.querySelector('.mv-kind').onchange = (ev) => fillDestOptionsFor(ev.target.value);
  c.querySelector('.mv-go').onclick = () => run(async () => {
    const kind = c.querySelector('.mv-kind').value, target = c.querySelector('.mv-target').value.trim(), section = c.querySelector('.mv-section').value.trim();
    if ((kind === 'source' || kind === 'course') && !target) { warn('חסר שם ספר או קורס'); return; }
    replace(await rewriteEntry(e, { kind, target, section, title: c.querySelector('.rv-title').value.trim(), text: c.querySelector('.rv-text').value.trim() }));
    toast('הועבר');
  });
  if (move) c.querySelector('.mv-acc').onclick = () => run(async () => {
    replace(await rewriteEntry(e, { kind: move.kind, target: move.target || '', section: move.section || '' })); move.done = true; toast('הועבר');
  });
  c.querySelectorAll('.rv-chip').forEach(b => b.onclick = () => run(async () => {
    const l = [...links, ...sugg][+b.dataset.i];
    replace(await rewriteEntry(e, { links: [...(e.links || []), { title: l.title, reason: l.reason || '' }] })); l.done = true; toast('הקישור נוסף');
  }));
  return c;
}

async function fillDestOptionsFor(kind) {
  const folder = kind === 'course' ? FOLDERS.course : FOLDERS.source;
  const files = await listNotes(folder);
  $('dest-options').innerHTML = files.map(f => `<option value="${esc(f.path.split('/').pop().replace(/\.md$/i, ''))}">`).join('');
}

async function finishReview() {
  const all = await readJSON('log');
  const ids = new Set(rv.entries.map(e => e.id));
  for (const x of all) if (ids.has(x.id)) x.reviewed = true;
  await writeJSON('log', all);
  await setPref('lastReview', new Date().toISOString());
  toast('הסקירה הושלמה', 2500);
  await renderHome(); show('home');
}

/* ---------- חיבור אירועים ---------- */
function wire() {
  $('btn-record').onclick = startRecording;
  $('btn-rec-stop').onclick = () => stopRecording(false);
  $('btn-rec-cancel').onclick = () => stopRecording(true);
  $('btn-settings').onclick = openSettings;
  $('btn-review').onclick = openReview;
  $('tab-notes').onclick = () => { state.tab = 'notes'; renderHome(); };
  $('tab-tasks').onclick = () => { state.tab = 'tasks'; renderHome(); };
  $('tab-rem').onclick = () => { state.tab = 'rem'; renderHome(); };
  $('btn-rem-back').onclick = async () => { remEdit = null; await renderHome(); show('home'); };
  $('btn-rem-save').onclick = saveReminder;
  $('btn-rem-delete').onclick = async () => { if (!remEdit) return; await deleteReminder(remEdit); remEdit = null; toast('התזכורת נמחקה'); await renderHome(); show('home'); };
  $('btn-rem-sound').onclick = openNotifSettings;
  $('btn-notif-settings').onclick = openNotifSettings;
  $('btn-tz-login').onclick = async () => {
    const em = $('tz-email').value.trim(), pw = $('tz-pass').value;
    if (!em || !pw) { toast('צריך אימייל וסיסמה'); return; }
    try { await tzLogin(em, pw); $('tz-pass').value = ''; await renderTzStatus(); toast('מחובר לצלול'); processPending(); }
    catch (e) { $('tz-status').textContent = e.message; }
  };
  $('btn-tz-logout').onclick = async () => { await setPref('tzAuth', ''); renderTzStatus(); };
  $('btn-note-back').onclick = async () => { await renderHome(); show('home'); };
  $('btn-note-edit').onclick = startNoteEdit;
  $('btn-note-save').onclick = saveNote;
  $('btn-note-cancel').onclick = () => { nt.editing = false; renderNote(); };
  $('btn-note-delete').onclick = deleteNote;
  $('btn-note-obsidian').onclick = () => openObsidian(nt.e.path);
  $('btn-review-back').onclick = async () => { await renderHome(); show('home'); };
  $('btn-review-done').onclick = finishReview;
  $('btn-settings-back').onclick = async () => { await renderHome(); show('home'); };
  $('btn-draft-back').onclick = async () => { await saveDraft(collectDraft()).catch(() => { }); await renderHome(); show('home'); };
  $('draft-kind').onchange = () => { updateDestFields(); fillDestOptions(); };
  $('btn-tag-add').onclick = () => {
    const v = $('tag-input').value.trim().replace(/^#/, '').replace(/\s+/g, '-');
    if (v && !state.current.proposal.tags.includes(v)) state.current.proposal.tags.push(v);
    $('tag-input').value = ''; renderTags();
  };
  $('btn-keep').onclick = async () => { await saveDraft(collectDraft()); toast('נשמר במגירה'); await renderHome(); show('home'); };
  $('btn-delete').onclick = async () => {
    if (!confirm('למחוק את הטיוטה?')) return;
    await deleteDraft(state.current); toast('נמחק'); await renderHome(); show('home');
  };
  $('btn-approve').onclick = async () => {
    const d = collectDraft();
    $('btn-approve').disabled = true;
    try {
      const path = await approve(d);
      if (path) {
        await deleteDraft(d);
        await renderHome(); show('home');
        toast('נכנס לכספת: ' + path.replace(/\.md$/, ''), 3500);
      }
    } catch (e) { toast('שגיאה בכתיבה לכספת: ' + e.message, 4500); }
    $('btn-approve').disabled = false;
  };
  $('btn-pick-vault').onclick = async () => {
    try { const r = await Vault.pickFolder(); state.vaultName = r.name; $('vault-name').textContent = r.name; toast('הכספת נבחרה'); }
    catch (e) { if (e.message !== 'cancelled') toast('לא נבחרה תיקייה: ' + e.message); }
  };
  $('btn-save-key').onclick = async () => { state.apiKey = $('api-key').value.trim(); await setPref('apiKey', state.apiKey); $('key-status').textContent = 'נשמר'; };
  $('btn-test-key').onclick = testKey;
  $('btn-dict-add').onclick = async () => {
    const w = $('dict-wrong').value.trim(), r = $('dict-right').value.trim();
    if (!w || !r) return;
    const dict = await readJSON('dictionary'); dict.push({ wrong: w, right: r, count: 99, manual: true });
    await writeJSON('dictionary', dict); $('dict-wrong').value = ''; $('dict-right').value = ''; renderDictionary();
  };
  $('speech-mode').onchange = async () => { await setPref('inputMode', $('speech-mode').value); };
  $('model').onchange = async () => { state.model = $('model').value; await setPref('model', state.model); };

  try {
  AppP.addListener('appUrlOpen', (e) => handleUrl(e.url));
  AppP.addListener('backButton', async () => {
    const active = document.querySelector('.screen.active')?.id;
    if (active === 'recording') return stopRecording(true);
    if (active === 'home') return AppP.exitApp();
    if (active === 'draft') { await saveDraft(collectDraft()).catch(() => { }); }
    if (active === 'review') { await renderHome(); show('home'); return; }
    if (active === 'note' && nt.editing) { nt.editing = false; renderNote(); return; }
    await renderHome(); show('home');
  });
  AppP.addListener('resume', () => { if (document.querySelector('.screen.active')?.id === 'home') renderHome(); processPending(); });
  } catch (e) { showError('אירועי מערכת', e); }
}

function handleUrl(url) {
  if (!url) return;
  if (url.startsWith('machberet://record')) { state.fromWidget = true; startRecording(); }
  else if (url.startsWith('machberet://drawer')) { renderHome(); show('home'); }
}

function showError(where, e) {
  const hint = $('setup-hint');
  hint.classList.remove('hidden');
  hint.textContent = `תקלה (${where}): ${e && e.message ? e.message : e}`;
}

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('לא הגיבה תשובה: ' + label)), ms))]);
}

async function init() {
  // קודם מחברים את הכפתורים — כדי שהממשק יגיב גם אם משהו אחר נתקע
  try { wire(); } catch (e) { showError('חיבור כפתורים', e); }
  $('drawer-empty').classList.remove('hidden');
  try {
    state.apiKey = (await withTimeout(getPref('apiKey'), 4000, 'הגדרות')) || '';
    state.model = (await withTimeout(getPref('model'), 4000, 'הגדרות')) || 'claude-sonnet-5-5';
  } catch (e) { showError('הגדרות', e); }
  try { const info = await withTimeout(AppP.getInfo(), 3000, 'גרסה'); $('version').textContent = 'גרסה ' + info.version + ' · ממשק ' + WEB_VERSION + ' (' + (window.MACHBERET_SOURCE || '') + ')'; } catch { }
  try { await withTimeout(setupSpeechListeners(), 4000, 'מיקרופון'); } catch (e) { showError('מיקרופון', e); }
  try {
    if (await vaultReady()) {
      await withTimeout(migrateFromVault(), 15000, 'העברה');
      const n = await withTimeout(moveMisplacedIdeas(), 15000, 'העברה');
      if (n) toast(n === 1 ? 'הערה אחת הועברה מהגינה לזמני' : `${n} הערות הועברו מהגינה לזמני`, 4000);
    }
  } catch { }
  try { await withTimeout(renderHome(), 8000, 'מסך הבית'); } catch (e) { showError('מסך הבית', e); }
  setupReminders().catch(() => { });
  processPending();
  try { const l = await withTimeout(AppP.getLaunchUrl(), 3000, 'קישור'); if (l && l.url) handleUrl(l.url); } catch { }
}
window.addEventListener('error', (e) => showError('כללי', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError('כללי', e.reason));

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
