/* Shared between the console and mobile apps — extracted 2026-07-13, after both apps had
   grown a Supabase backend, auth, and realtime sync in near-identical form.
   Only genuinely byte-identical code lives here (verified with `diff`, not just "looks similar").
   Deliberately excluded: guessBucket/guessTime/suggestFixer/etc. — they read alike but have real
   behavioral differences per app (different keyword lists, different return shapes), and the data
   mapping/persistence layer (rowToTask, loadAll, etc.) — the underlying object shapes genuinely
   differ between the two apps' UI code, not just superficially. Don't add anything here without
   diffing first; a plausible-looking merge that quietly changes one app's behavior is worse than
   the duplication it removes. */

const TODAY=new Date();
const RECURS={daily:"Daily",weekly:"Weekly",monthly:"Monthly",yearly:"Yearly"};
const BUCKETS={academic:"Academic",maintenance:"Maintenance",construction:"Construction",hr:"HR",accounts:"Accounts",administration:"Management",transport:"Transport",it:"IT & Systems"};
const BUCKET_COLORS={academic:'#39638f',maintenance:'#b06e12',construction:'#8a6a52',hr:'#a34d78',accounts:'#1a7a48',administration:'#5d6672',transport:'#0e7a8f',it:'#5b5ea6'};
const LABEL_TO_BUCKET=Object.fromEntries(Object.entries(BUCKETS).map(([k,v])=>[v,k]));
const bucketColor=b=>BUCKET_COLORS[b]||'#5d6672';
/* Admin-configurable, RECIPIENT-based routing (routing_rules table). Replaces the old hardcoded
   category→department-head mapping: an Administrator now edits, in Settings, which specific staff
   member receives each report/request. Loaded into each app's ROUTING_RULES global (declared in the
   app's own script, same pattern as ORG_NAME / clItems) by loadAll + realtime. Every helper below
   reads that global and no-ops safely before it's loaded.
     • maintenance categories = rows kind='maintenance' ({id,label,icon,staff_id,sort_order})
     • supply recipient       = the single row kind='supply' → staff_id
   A maintenance report stores routing_rule_id (its category) + target_staff_id (the recipient
   snapshot). issueRecipientId() resolves it LIVE from the category first, so re-configuring a
   category re-routes existing reports; it falls back to the stored snapshot, then to the default
   (first / 'Building') category for legacy pre-feature reports that carry neither. */
const routingRules=()=>(typeof ROUTING_RULES!=='undefined'&&ROUTING_RULES)?ROUTING_RULES:[];
const maintCats=()=>routingRules().filter(r=>r.kind==='maintenance').slice().sort((a,b)=>(a.sort_order-b.sort_order)||((a.created_at||'')<(b.created_at||'')?-1:1));
const catById=id=>maintCats().find(c=>c.id===id)||null;
const defaultMaintCat=()=>maintCats()[0]||null;              // legacy fallback = first (Building)
const supplyRule=()=>routingRules().find(r=>r.kind==='supply')||null;
const supplyRecipientId=()=>{const r=supplyRule();return r?r.staff_id:null;};
function issueRecipientId(r){                                  // live-resolved recipient staff id, or null
  const c=r&&r.routing_rule_id?catById(r.routing_rule_id):null;
  if(c)return c.staff_id||null;
  if(r&&r.target_staff_id)return r.target_staff_id;
  const d=defaultMaintCat();return d?d.staff_id:null;
}
/* mobile's superset — includes Teacher, which console never looks up (it has no console-facing
   Teacher role), so sharing the superset is harmless rather than trimming it per app.
   'Team Lead' sits between Team Member (jrm) and Teacher (worker) in the reporting chain — added
   for the org-chart People & roles view; behaves like jrm everywhere a role-key gate exists today.
   'Director' sits between Management (mgmt) and Manager (srm) — oversees several Sr. Managers'
   departments at once; behaves like srm everywhere a role-key gate exists today (self + full
   subtree scope, direct-reports-only approval authority — see console's canApprove/ctx.scope and
   mobile's team ternary in App()). */
const DB_ROLE_TO_KEY={Administrator:'admin',Management:'mgmt',Director:'dir',Manager:'srm','Team Lead':'lead','Team Member':'jrm',Teacher:'worker'};

const sb=window.supabase.createClient(
  "https://fumggrcamegejihenkhb.supabase.co",
  "sb_publishable_bEqR06srB99BHHdvLQy14g_-pLZPWwJ"
);

const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
/* YYYY-MM-DD -> DD-MM-YYYY, for CSV/XLSX cells only. On-screen dates keep their human forms
   (fmtDate "Jul 7", ord "31st") — this is just so raw ISO strings don't land in a spreadsheet. */
const dmy=s=>{if(!s)return '';const p=String(s).split('-');return p.length===3?p[2]+'-'+p[1]+'-'+p[0]:s;};
/* timestamptz (e.g. tasks.created_at, the "issued"/assigned date) -> DD-MM-YYYY in local time.
   Blank for missing (old daily-report snapshots that predate the issued column). */
const dmyTs=ts=>ts?dmy(iso(new Date(ts))):'';
/* ---- checklists: recurring schedule helpers (shared by console + mobile) ---- */
const CL_DOW=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];         // dow stored 0=Mon..6=Sun
const CL_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const clOrd=n=>{const s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);};
const clLastDom=(y,m)=>new Date(y,m,0).getDate();                 // m 1-based
const clDow=isoDate=>(new Date(isoDate+'T00:00:00').getDay()+6)%7; // Mon=0
function clDueOn(it,isoDate){const d=new Date(isoDate+'T00:00:00');
  if(it.freq==='daily')return true;
  if(it.freq==='weekly')return clDow(isoDate)===it.dow;
  if(it.freq==='monthly')return d.getDate()===Math.min(it.dom,clLastDom(d.getFullYear(),d.getMonth()+1));
  return (d.getMonth()+1)===it.y_mon && d.getDate()===Math.min(it.y_day,clLastDom(d.getFullYear(),it.y_mon));}
function clSchedLabel(it){
  if(it.freq==='daily')return 'Daily';
  if(it.freq==='weekly')return 'Every '+CL_DOW[it.dow];
  if(it.freq==='monthly')return 'Monthly · '+clOrd(it.dom);
  return 'Yearly · '+it.y_day+' '+CL_MON[(it.y_mon||1)-1];}
const CL_FREQMETA={daily:{label:'Daily',hint:'resets every morning'},weekly:{label:'Weekly',hint:'resets on the set weekday'},monthly:{label:'Monthly',hint:'resets on the set date'},yearly:{label:'Yearly',hint:'resets on the set day'}};
const CL_FREQORDER=['daily','weekly','monthly','yearly'];
/* read helpers over each app's clItems/clDone/clAbs globals (declared in the app's own script) */
const clItemsFor=id=>clItems.filter(i=>i.staff_id===id&&!i.archived).slice().sort((a,b)=>(a.sort_order-b.sort_order)||((a.created_at||'')<(b.created_at||'')?-1:1));
const clDoneSet=(id,date)=>{const s=new Set();clDone.forEach(c=>{if(c.staff_id===id&&c.occ_date===date)s.add(c.item_id);});return s;};
const clAbsOn=(id,date)=>(typeof clAbs!=='undefined'?clAbs:[]).some(a=>a.staff_id===id&&a.absent_date===date);
/* Organisation name (org_settings, e.g. JHPS) as a prominent header for every downloadable
   report/list. orgCsvRows: prepended by csvDownload so it lands in cell A1 of any CSV/XLSX.
   orgHeadHtml: prepended to every print/PDF's HTML so the org name heads the page above the
   TeamFlow line. Both no-op if ORG_NAME isn't set yet. */
const orgName=()=>(typeof ORG_NAME!=='undefined'&&ORG_NAME)?ORG_NAME:'';
const orgCsvRows=()=>orgName()?[[orgName()],[]]:[];
const orgHeadHtml=()=>orgName()?'<div style="font-family:Bricolage Grotesque,sans-serif;font-weight:800;font-size:23px;color:#0a5c54;margin:0 0 2px">'+orgName()+'</div>':'';
const fmtTime=t=>{if(!t)return '';const p=t.split(':'),h=+p[0],ap=h>=12?'PM':'AM';return (h%12||12)+':'+p[1]+' '+ap;};
/* full ISO timestamptz (e.g. a task_log row's created_at) -> "14 Jul · 2:45 PM" in the viewer's
   local timezone. Distinct from fmtDate/fmtD, which only ever take a plain YYYY-MM-DD string and
   append a fake T00:00:00 — they can't represent a real time. Used anywhere a job-log entry's
   posted-at needs to show both date and time. */
const fmtDateTime=t=>{if(!t)return '';const x=new Date(t);
  return x.toLocaleDateString('en',{day:'numeric',month:'short'})+' · '+x.toLocaleTimeString('en',{hour:'numeric',minute:'2-digit'});};
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ord=n=>{const s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);};
/* explicit calendar dates in free text ("20th July", "July 20", "on the 5th of August") -> an
   ISO date string. Checked before relative-phrase guessing (today/tomorrow/next week/etc. in
   each app's own guessDate/parseText) since a named date is a more certain signal than those.
   Rolls into next year if the day/month already passed this year (mentioning "5 January" in
   December means next January, not four months ago). Returns null if no explicit date phrase
   is found — callers keep their existing relative-phrase fallback unchanged.
   "may" is excluded from the general day-first pattern (e.g. "20th May") since it collides with
   the modal verb — "class 3 may need a substitute" would otherwise misparse "3 may" as a date.
   Bare digit-before-"may" only counts as a date with an explicit "of" ("3rd of May"); "May 20" /
   "May 3rd" (month-first) stay unambiguous either way, since the modal verb is never followed
   directly by a number, so that form doesn't need the same guard. */
function guessAbsoluteDate(t){
  const MI='jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  let m=t.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+may\\b','i')),day,monTxt;
  if(m){day=+m[1];monTxt='may';}
  else{
    m=t.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?('+MI+')\\b','i'));
    if(m){day=+m[1];monTxt=m[2];}
    else{
      m=t.match(new RegExp('\\b(may|'+MI+')\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b','i'));
      if(!m)return null;
      monTxt=m[1];day=+m[2];
    }
  }
  if(day<1||day>31)return null;
  const mi=MONTHS.findIndex(mm=>mm.toLowerCase()===monTxt.slice(0,3).toLowerCase());
  if(mi<0)return null;
  const today0=new Date(TODAY.getFullYear(),TODAY.getMonth(),TODAY.getDate());
  let d=new Date(TODAY.getFullYear(),mi,day);
  if(d<today0)d=new Date(TODAY.getFullYear()+1,mi,day);
  return {date:iso(d),why:'you said '+day+' '+MONTHS[mi]};
}
const recurLabel=(recur,on)=>{if(!recur)return '';
  if(recur==='weekly'&&on!=null)return 'Weekly · '+DOW[on];
  if(recur==='monthly'&&on!=null)return 'Monthly · '+ord(on);
  if(recur==='yearly'&&on)return 'Yearly · '+on.d+' '+MONTHS[on.m];
  return RECURS[recur];};
const defaultRecurOn=(recur,dateStr)=>{const d=new Date((dateStr||iso(TODAY))+'T00:00:00');
  return recur==='weekly'?d.getDay():recur==='monthly'?d.getDate():recur==='yearly'?{d:d.getDate(),m:d.getMonth()}:null;};
/* first date on/after `fromStr` matching the anchor */
function nextAnchor(recur,on,fromStr){const d=new Date((fromStr||iso(TODAY))+'T00:00:00');
  if(recur==='weekly'&&on!=null){d.setDate(d.getDate()+((on-d.getDay()+7)%7));return iso(d);}
  if(recur==='monthly'&&on!=null){let y=d.getFullYear(),m=d.getMonth();if(d.getDate()>on)m++;
    const dim=new Date(y,m+1,0).getDate();return iso(new Date(y,m,Math.min(on,dim)));}
  if(recur==='yearly'&&on){let y=d.getFullYear();
    let t=new Date(y,on.m,Math.min(on.d,new Date(y,on.m+1,0).getDate()));
    if(t<d)t=new Date(y+1,on.m,Math.min(on.d,new Date(y+1,on.m+1,0).getDate()));
    return iso(t);}
  return iso(d);}
function guessType(t){t=t.toLowerCase();
  if(/\b(order|buy|purchase|procure|stock|supplies)\b/.test(t))return 'purchase';
  if(/\b(repair|fix|broken|replace|not working|fault)\b/.test(t))return 'repair';
  if(/\b(clean|service|maintain|maintenance|inspect|paint)\b/.test(t))return 'maint';
  return 'work';}
function guessRecur(t){t=t.toLowerCase();
  if(/\b(every ?day|daily)\b/.test(t))return 'daily';
  if(/\b(every week|weekly)\b/.test(t))return 'weekly';
  if(/\b(every month|monthly)\b/.test(t))return 'monthly';
  if(/\b(every year|yearly|annually)\b/.test(t))return 'yearly';
  return null;}
/* persists a completed/spawned-next-occurrence pair: the task itself, plus the freshly-pushed
   next occurrence if recurring. Both apps call this the same way after their own local
   completeTask()/spawnNextRecur() mutation. */
function persistComplete(t,nd){
  saveTask(t).catch(console.error);
  if(nd)saveTask(tasks[tasks.length-1]).catch(console.error);
}
/* uploads to the private 'attachments' bucket and returns a signed URL (1y — long enough that
   staff won't hit a dead link mid-use, short enough to bound exposure if a URL ever leaks; only
   affects newly-issued URLs, doesn't shorten ones already handed out) */
async function uploadFile(file,folder){
  const path=folder+'/'+Date.now()+'-'+Math.random().toString(36).slice(2)+'-'+file.name.replace(/[^\w.\-]/g,'_');
  const {error}=await sb.storage.from('attachments').upload(path,file);
  if(error)throw error;
  const {data,error:signErr}=await sb.storage.from('attachments').createSignedUrl(path,31536000);
  if(signErr)throw signErr;
  return {name:file.name,url:data.signedUrl,path};
}
/* triggers a real browser save for an in-memory Blob — same 4 lines csvDownload and downloadFile
   both used to hand-roll separately (only how they got the Blob differed) */
function saveBlob(blob,name){
  const href=URL.createObjectURL(blob);const a=document.createElement('a');
  a.href=href;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(href),1500);
}
/* the plain `download` attribute doesn't reliably force-save a cross-origin Storage URL — some
   browsers just navigate the tab to it instead. Fetching the bytes and saving a same-origin blob
   URL works everywhere; falls back to opening the file if the fetch itself fails (e.g. offline). */
async function downloadFile(url,name){
  try{saveBlob(await (await fetch(url)).blob(),name);}
  catch(e){window.open(url,'_blank');}
}
/* best-effort — the file/task-log record removal is what matters to the user, so a failed
   Storage cleanup (e.g. already gone) shouldn't block or error out the actual remove action */
async function removeAttachment(path){
  if(!path)return;
  const {error}=await sb.storage.from('attachments').remove([path]);
  if(error)console.error(error);
}
/* Merges two notification sources for the real signed-in user into one chronological feed:
   task_notifications (cron-written overdue/due_today, RLS staff_id=auth_staff_id()) and
   task_activity_notifications (client-written job-log-entry pings, same RLS shape). Each row is
   tagged with `source` so mark-read (below) and the UI (which table it came from, how to render
   it) can tell them apart without a second bell/dropdown. */
async function loadNotifs(){
  const [a,b,c]=await Promise.all([
    sb.from('task_notifications').select('*').order('created_at',{ascending:false}),
    sb.from('task_activity_notifications').select('*').order('created_at',{ascending:false}),
    sb.from('checklist_notifications').select('*').order('created_at',{ascending:false})
  ]);
  if(a.error)console.error(a.error);
  if(b.error)console.error(b.error);
  if(c.error)console.error(c.error);
  return (a.data||[]).map(n=>({...n,source:'notif'}))
    .concat((b.data||[]).map(n=>({...n,source:'activity'})))
    .concat((c.data||[]).map(n=>({...n,source:'checklist'})))
    .sort((x,y)=>x.created_at<y.created_at?1:-1);
}
/* wrapped in async functions (not bare arrows returning the query builder) so the result is a
   real Promise — Supabase's builder is thenable but doesn't implement .catch(), and every call
   site here does `markNotifRead(n).catch(...)`. Takes the merged notification object (not just an
   id) so it can route the update to whichever table it actually came from. */
async function markNotifRead(n){
  const table=n.source==='activity'?'task_activity_notifications':n.source==='checklist'?'checklist_notifications':'task_notifications';
  return sb.from(table).update({read_at:new Date().toISOString()}).eq('id',n.id);
}
async function markAllNotifsRead(ns){
  if(!ns.length)return;
  const now=new Date().toISOString();
  const ids1=ns.filter(n=>n.source==='notif').map(n=>n.id);
  const ids2=ns.filter(n=>n.source==='activity').map(n=>n.id);
  const ids3=ns.filter(n=>n.source==='checklist').map(n=>n.id);
  return Promise.all([
    ids1.length?sb.from('task_notifications').update({read_at:now}).in('id',ids1):null,
    ids2.length?sb.from('task_activity_notifications').update({read_at:now}).in('id',ids2):null,
    ids3.length?sb.from('checklist_notifications').update({read_at:now}).in('id',ids3):null
  ]);
}
/* One task_activity_notifications row per recipient in `staffIds`, for the freshly-inserted
   task_log row `logId` on `taskId`, attributed to `actorId`. No-op when there's no one else to
   notify (solo/self-assigned task) — genuinely identical logic both apps need right after their
   own task_log insert.
   Inserted one row at a time, not batched — task_in_scope's RLS check is per-recipient (e.g. a
   task's instructedBy is a frozen string set at creation time, so it can point at someone who's
   since moved out of the assignee's real boss_id chain, the same staleness dept-mismatch already
   guards against). A single multi-row INSERT is all-or-nothing in Postgres: one recipient failing
   RLS would silently swallow the notification for every OTHER valid recipient too. Individual
   inserts mean a stale recipient just fails on their own row. */
async function notifyActivity(taskId,logId,actorId,staffIds){
  await Promise.all(staffIds.map(staff_id=>
    sb.from('task_activity_notifications').insert({staff_id,task_id:taskId,task_log_id:logId,actor_staff_id:actorId})
      .then(({error})=>{if(error)console.error(error);})));
}
/* Lightweight sibling of notifyActivity for events that already have their own synthesized
   Activity-timeline line (status change, extension request/approve/reject, completion submit/
   approve/reject, reassignment) — deliberately does NOT touch task_log, just a short system-
   written `label`, so the timeline doesn't end up rendering the same event twice. Same
   one-row-at-a-time reasoning as notifyActivity above. */
async function notifyEvent(taskId,actorId,label,staffIds){
  await Promise.all(staffIds.map(staff_id=>
    sb.from('task_activity_notifications').insert({staff_id,task_id:taskId,actor_staff_id:actorId,label})
      .then(({error})=>{if(error)console.error(error);})));
}
/* Edits a task_log row's text — the "fix a typo within 2 minutes of posting" feature. Real
   enforcement lives in the log_update RLS policy (author_id = auth_staff_id() AND now() -
   created_at < interval '2 minutes'); this is just the client call, and it deliberately does NOT
   swallow a rejected update the way saveTask does — the caller needs to know the write failed
   (most likely because the window closed) so it can tell the user, not pretend it worked.
   Chains .select().single() rather than a bare .update() — confirmed live against this project's
   own Supabase instance that a bare .update().eq() returns success (204, no error) even when RLS
   silently matches zero rows (e.g. the window already expired), because Postgres/PostgREST only
   errors on a REJECTED write (with_check failing on a row that WAS matched), not on a write that
   matched nothing at all. .single() forces exactly one row back, so "0 rows" becomes a real
   PGRST116 error instead of a false "it worked". Returns {ok:true} on success or {ok:false,error}
   on failure. */
async function editLogEntry(logId,newText){
  const {error}=await sb.from('task_log').update({body:newText}).eq('id',logId).select().single();
  if(error){console.error(error);return {ok:false,error};}
  return {ok:true};
}
const IMG_EXT=/\.(png|jpe?g|gif|webp|bmp|svg)$/i;
/* toast state + auto-dismiss timer — identical in both apps down to the 2400ms, just renamed
   local variables. `ctx.say(...)`/`useToast()` return the same {toast,say} shape either way. */
function useToast(){
  const [toast,setToast]=React.useState(null);
  const t=React.useRef();
  const say=React.useCallback(m=>{setToast(m);clearTimeout(t.current);t.current=setTimeout(()=>setToast(null),2400);},[]);
  return {toast,say};
}
/* the ~15 icon glyphs both apps draw identically (checked via diff, not just "looks similar") —
   written with React.createElement instead of JSX since this file isn't run through Babel.
   Each app spreads this into its own PATHS object alongside its own app-specific icons. */
const g=(tag,props,...kids)=>React.createElement(tag,props,...kids);
const SHARED_ICON_PATHS={
  checkc:g('g',null,g('circle',{cx:12,cy:12,r:9}),g('path',{d:"M8.5 12.2l2.4 2.4 4.6-5"})),
  cal:g('g',null,g('rect',{x:3.5,y:5,width:17,height:15.5,rx:2}),g('path',{d:"M3.5 9.5h17M8 3v4M16 3v4"})),
  chart:g('path',{d:"M4 20V10M10 20V4M16 20v-7M21 20H3"}),
  plus:g('path',{d:"M12 5v14M5 12h14"}),
  mic:g('g',null,g('rect',{x:9,y:3,width:6,height:11,rx:3}),g('path',{d:"M5.5 11.5a6.5 6.5 0 0013 0M12 18v3"})),
  x:g('path',{d:"M6 6l12 12M18 6L6 18"}),
  chevl:g('path',{d:"M14.5 6l-6 6 6 6"}),
  chevr:g('path',{d:"M9.5 6l6 6-6 6"}),
  clock:g('g',null,g('circle',{cx:12,cy:12,r:9}),g('path',{d:"M12 7v5.2l3.4 2"})),
  spark:g('path',{d:"M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"}),
  check:g('path',{d:"M5 12.5l4.5 4.5L19 7.5"}),
  bell:g('path',{d:"M18 16H6c1.2-1.4 1.8-2.4 1.8-5a4.2 4.2 0 018.4 0c0 2.6.6 3.6 1.8 5zM10 19a2 2 0 004 0"}),
  redo:g('path',{d:"M4 16v-5a5 5 0 015-5h10M15.5 2.5L19 6l-3.5 3.5"}),
  tool:g('path',{d:"M20.3 7.1a4.6 4.6 0 01-6 5.3l-6.4 6.4a2.1 2.1 0 11-3-3l6.4-6.4a4.6 4.6 0 015.3-6l-2.9 2.9 3.7 3.7z"}),
  box:g('g',null,g('path',{d:"M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16z"}),g('path',{d:"M3.5 8L12 12.5 20.5 8M12 12.5v8"})),
};

/* ============ Daily Report shared helpers + one-click PDF (v71) ============ */
/* Moved here from the console app verbatim when mobile gained the same Download PDF —
   everything below is app-agnostic: it reads only daily_reports/report_issues rows, the
   global `tasks` array (same `t`/`id` fields in both apps), and plain {n, dept} person
   objects supplied by the caller. */
const DR_SEGS=[{l:'Completed',c:'#1a7a48'},{l:'Overdue',c:'#c43a53'},{l:'Open · on track',c:'#dcdad2'}];
const snapStatusLabel=s=>s==='done'?'Completed':s==='overdue'?'Overdue':'Open · on track';
function issueResolutionText(x){
  if(x.status!=='resolved')return '—';
  if(x.resolved_task_id){const t=tasks.find(tk=>tk.id===x.resolved_task_id);return 'Task: '+(t?t.t:'(task)')+(x.resolution_note?' — '+x.resolution_note:'');}
  return x.resolution_note||'Resolved';
}
async function fetchIssuesByReport(rows){
  const ids=rows.map(({row})=>row.id);
  if(!ids.length)return {};
  const {data,error}=await sb.from('report_issues').select('*').in('daily_report_id',ids);
  if(error){console.error(error);return {};}
  const byReport={};
  (data||[]).forEach(x=>{(byReport[x.daily_report_id]=byReport[x.daily_report_id]||[]).push(x);});
  return byReport;
}
/* jsPDF + autotable lazy-loaded on first click from the same CDN family as everything else,
   so page weight is unchanged. Donut drawn on an offscreen canvas, embedded as an image. */
let pdfLibsP=null;
function ensurePdfLibs(){
  if(pdfLibsP)return pdfLibsP;
  const load=src=>new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;
    s.onload=res;s.onerror=()=>rej(new Error('Could not load '+src));document.head.appendChild(s);});
  pdfLibsP=load('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
    .then(()=>load('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'))
    .catch(e=>{pdfLibsP=null;throw e;}); // reset so a transient network failure can be retried
  return pdfLibsP;
}
function donutPng(segs){
  const size=240,stroke=40,c=document.createElement('canvas');c.width=size;c.height=size;
  const x=c.getContext('2d');const total=segs.reduce((a,s)=>a+s.v,0);
  const r=(size-stroke)/2,cx=size/2,cy=size/2;let a0=-Math.PI/2;
  if(!total){x.strokeStyle='#efeee7';x.lineWidth=stroke;x.beginPath();x.arc(cx,cy,r,0,2*Math.PI);x.stroke();}
  else segs.forEach(s=>{if(!s.v)return;const a1=a0+s.v/total*2*Math.PI;
    x.strokeStyle=s.c;x.lineWidth=stroke;x.beginPath();x.arc(cx,cy,r,a0,a1);x.stroke();a0=a1;});
  x.fillStyle='#1b1e21';x.font='700 44px sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(String(total),cx,cy-8);
  x.fillStyle='#71797f';x.font='600 18px sans-serif';x.fillText('tasks',cx,cy+22);
  return c.toDataURL('image/png');
}
const pdfDate=d=>{if(!d)return '—';return new Date(d+'T00:00:00').toLocaleDateString('en',{day:'numeric',month:'short'});};
async function downloadDailyReportPdf(rows,label,viewerName){
  await ensurePdfLibs();
  const issuesByReport=await fetchIssuesByReport(rows);
  const doc=new window.jspdf.jsPDF({unit:'pt',format:'a4'});
  let y=48;
  /* ORG_NAME is each app's script-global (loaded from org_settings in loadAll) — headline of the
     document in the accent ink, with the TeamFlow line demoted beneath it. */
  if(typeof ORG_NAME!=='undefined'&&ORG_NAME){
    doc.setFont('helvetica','bold');doc.setFontSize(24);doc.setTextColor(10,92,84);doc.text(ORG_NAME,40,y);y+=25;
  }
  doc.setFont('helvetica','bold');doc.setFontSize(14);doc.setTextColor(27,30,33);doc.text('TeamFlow — '+label,40,y);y+=16;
  doc.setFont('helvetica','normal');doc.setFontSize(10);doc.setTextColor(85,85,85);
  doc.text('Prepared for '+viewerName+' · '+new Date().toDateString()+' · '+rows.length+' report'+(rows.length!==1?'s':''),40,y);y+=26;
  rows.forEach(({row,p})=>{
    if(y>640){doc.addPage();y=48;}
    doc.setTextColor(27,30,33);doc.setFontSize(12);doc.setFont('helvetica','bold');
    doc.text((p?p.n:'—')+' · '+(p?p.dept:'')+' · '+pdfDate(row.report_date),40,y);y+=6;
    const issues=issuesByReport[row.id]||[];
    if(issues.length){
      doc.setFontSize(10);doc.text('Issues / incidents raised',40,y+14);
      doc.autoTable({startY:y+20,margin:{left:40,right:40},styles:{fontSize:8.5},headStyles:{fillColor:[14,122,111]},
        head:[['Issue','Priority','Status','Resolution']],
        body:issues.map(x=>[x.issue,x.priority,x.status==='resolved'?'Resolved':'Open',issueResolutionText(x)])});
      y=doc.lastAutoTable.finalY+18;
    }else y+=12;
    if(y>640){doc.addPage();y=48;}
    const pieSegs=[row.completed_count,row.overdue_count,row.pending_count].map((v,i)=>({...DR_SEGS[i],v}));
    doc.addImage(donutPng(pieSegs),'PNG',40,y,76,76);
    doc.setFontSize(9.5);doc.setFont('helvetica','normal');
    pieSegs.forEach((s,i)=>{const ly=y+22+i*16;
      doc.setFillColor(s.c);doc.rect(132,ly-7,8,8,'F');
      doc.setTextColor(27,30,33);doc.text(s.l+'   '+s.v,146,ly);});
    y+=92;
    const snap=row.task_snapshot||[];
    if(snap.length){
      doc.setFont('helvetica','bold');doc.setFontSize(10);doc.text('Tasks this period',40,y);
      doc.autoTable({startY:y+6,margin:{left:40,right:40},styles:{fontSize:8.5},headStyles:{fillColor:[14,122,111]},
        head:[['Task','Assignee','Department','Issued','Due','Status']],
        /* "Nd late" is relative to the report's own date, not today — the snapshot froze what
           was true at submit time, so an old report keeps saying how late things were THEN. */
        body:snap.map(t=>{let st=snapStatusLabel(t.status);
          if(t.status==='overdue'&&t.due){const d=Math.round((new Date(row.report_date+'T00:00:00')-new Date(t.due+'T00:00:00'))/86400000);
            if(d>0)st='Overdue · '+d+'d late';}
          return [t.title,t.assignee,t.department||'',dmyTs(t.issued),pdfDate(t.due),st];})});
      y=doc.lastAutoTable.finalY+24;
    }
    const clSnap=row.checklist_snapshot||[];
    if(clSnap.length){
      if(y>560){doc.addPage();y=48;}
      const cd=clSnap.filter(c=>c.done).length;
      doc.setFont('helvetica','bold');doc.setFontSize(10);doc.setTextColor(27,30,33);doc.text('Checklist — '+cd+' of '+clSnap.length+' done',40,y);
      doc.autoTable({startY:y+6,margin:{left:40,right:40},styles:{fontSize:8.5},headStyles:{fillColor:[14,122,111]},
        head:[['Checklist item','Schedule','Done']],
        body:clSnap.map(c=>[c.body,c.sched,c.done?'Done':'Not done']),
        didParseCell:function(data){if(data.section==='body'&&data.column.index===2){data.cell.styles.textColor=data.cell.raw==='Done'?[26,122,72]:[196,58,83];}}});
      y=doc.lastAutoTable.finalY+24;
    }
  });
  doc.save(iso(new Date())+'-teamflow-'+label.toLowerCase().replace(/\s+/g,'-')+'.pdf');
}
