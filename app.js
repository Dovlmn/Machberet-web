/* MACHBERET_APP — מחברת: הקלטה, עריכה ב-Claude, מגירה, אישור לכספת */
const WEB_VERSION = '2026-11-15.2';
'use strict';

const Cap = window.capacitorExports || window.Capacitor;
const Vault = Cap.registerPlugin('Vault');
const Dict = Cap.registerPlugin('Dictation');
const Prefs = Cap.registerPlugin('Preferences');
const AppP = Cap.registerPlugin('App');
const Kbd = Cap.registerPlugin('Keyboard');

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
  const files = (await listNotes()).filter(f => !f.path.startsWith('_מחברת'));
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
${explicit ? `\nהוראה מפורשת: המשתמש פתח את ההקלטה בשם "${explicit.title}". היעד הוא kind="${explicit.kind}" ו-target="${explicit.title}" — גם אם ההערה קצרה או נראית כבדיקה. הסר את שם המקור מתחילת הטקסט הערוך.\n` : ''}
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

async function renderHome() {
  const ready = await vaultReady();
  const hint = $('setup-hint');
  if (!ready || !state.apiKey) {
    hint.classList.remove('hidden');
    hint.innerHTML = !ready ? 'כדי להתחיל, בחר את תיקיית הכספת בהגדרות.' : 'כדי שהעריכה תעבוד, הדבק את מפתח ה-API בהגדרות.';
    hint.onclick = openSettings;
  } else hint.classList.add('hidden');
  if (ready) { await loadDrafts(); await loadLog().catch(() => { state.log = []; }); } else { state.drafts = []; state.log = []; }
  const list = $('drawer-list');
  list.innerHTML = '';
  const n = state.log.length;
  $('drawer-count').textContent = n ? (n === 1 ? 'הערה אחת השבוע' : `${n} הערות השבוע`) : '';
  $('drawer-empty').classList.toggle('hidden', state.drafts.length + n > 0);
  for (const d of state.drafts) {
    const b = document.createElement('button');
    b.className = 'draft-card' + (d.error ? ' err' : '');
    const when = new Date(d.created);
    b.innerHTML = `<div class="dest-line">${esc(d.error ? 'לא נערכה עדיין — תנסה שוב אוטומטית' : (d.proposal ? destLabel(d.proposal) : 'בעריכה…'))} · ${heDate(when)}</div>
      <div class="t">${esc(d.proposal?.title || 'הערה ללא כותרת')}</div>
      <div class="ex">${esc(d.proposal?.text || d.transcript)}</div>`;
    b.onclick = () => openDraft(d);
    list.appendChild(b);
  }
  for (const e of state.log) {
    const b = document.createElement('button');
    b.className = 'draft-card';
    b.innerHTML = `<div class="dest-line">נכנס ל${esc(e.path.replace(/\.md$/, '').replace('/', ' ← '))} · ${heDate(new Date(e.inserted))}</div>
      <div class="t">${esc(e.title || 'הערה')}</div>
      <div class="ex">${esc(e.text)}</div>
      ${e.why ? `<div class="why">למה לשם: ${esc(e.why)}</div>` : ''}`;
    b.onclick = () => openObsidian(e.path);
    list.appendChild(b);
  }
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
  toast('נשמר ✓ — ייכנס לכספת בעוד רגע', 2200);
  await renderHome().catch(() => { });
  show('home');
  if (state.fromWidget) { state.fromWidget = false; setTimeout(() => { try { AppP.minimizeApp(); } catch { } }, 700); }
  processPending();
}

let processing = false;
/** מעבד ברקע כל טיוטה שעוד לא נערכה (גם כאלה שנשארו מפעם קודמת, למשל בלי רשת). */
async function processPending() {
  if (processing || !state.apiKey) return;
  processing = true;
  try {
    const drafts = await loadDrafts();
    const pending = drafts.filter(d => !d.proposal);
    if (!pending.length) return;
    const map = await buildVaultMap();
    for (const d of pending) {
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

/* ---------- חיבור אירועים ---------- */
function wire() {
  $('btn-record').onclick = startRecording;
  $('btn-rec-stop').onclick = () => stopRecording(false);
  $('btn-rec-cancel').onclick = () => stopRecording(true);
  $('btn-settings').onclick = openSettings;
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
  $('speech-mode').onchange = async () => { await setPref('inputMode', $('speech-mode').value); };
  $('model').onchange = async () => { state.model = $('model').value; await setPref('model', state.model); };

  try {
  AppP.addListener('appUrlOpen', (e) => handleUrl(e.url));
  AppP.addListener('backButton', async () => {
    const active = document.querySelector('.screen.active')?.id;
    if (active === 'recording') return stopRecording(true);
    if (active === 'home') return AppP.exitApp();
    if (active === 'draft') { await saveDraft(collectDraft()).catch(() => { }); }
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
  processPending();
  try { const l = await withTimeout(AppP.getLaunchUrl(), 3000, 'קישור'); if (l && l.url) handleUrl(l.url); } catch { }
}
window.addEventListener('error', (e) => showError('כללי', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError('כללי', e.reason));

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
