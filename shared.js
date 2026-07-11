/* Shared between the console and mobile apps — extracted 2026-07-13, after both apps had
   grown a Supabase backend, auth, and realtime sync in near-identical form.
   Only genuinely byte-identical code lives here (verified with `diff`, not just "looks similar").
   Deliberately excluded: guessBucket/guessTime/suggestFixer/etc. — they read alike but have real
   behavioral differences per app (different keyword lists, different return shapes), and the data
   mapping/persistence layer (rowToTask, loadAll, etc.) — the underlying object shapes genuinely
   differ between the two apps' UI code, not just superficially. Don't add anything here without
   diffing first; a plausible-looking merge that quietly changes one app's behavior is worse than
   the duplication it removes. */

const TODAY=new Date(2026,6,6);
const RECURS={daily:"Daily",weekly:"Weekly",monthly:"Monthly",yearly:"Yearly"};
const BUCKETS={academic:"Academic",maintenance:"Maintenance",construction:"Construction",hr:"HR",accounts:"Accounts",administration:"Administration",transport:"Transport",it:"IT & Systems"};
const BUCKET_COLORS={academic:'#39638f',maintenance:'#b06e12',construction:'#8a6a52',hr:'#a34d78',accounts:'#1a7a48',administration:'#5d6672',transport:'#0e7a8f',it:'#5b5ea6'};
const LABEL_TO_BUCKET=Object.fromEntries(Object.entries(BUCKETS).map(([k,v])=>[v,k]));
const bucketColor=b=>BUCKET_COLORS[b]||'#5d6672';
/* mobile's superset — includes Teacher, which console never looks up (it has no console-facing
   Teacher role), so sharing the superset is harmless rather than trimming it per app.
   'Team Lead' sits between Team Member (jrm) and Teacher (worker) in the reporting chain — added
   for the org-chart People & roles view; behaves like jrm everywhere a role-key gate exists today. */
const DB_ROLE_TO_KEY={Administrator:'admin',Management:'mgmt',Manager:'srm','Team Lead':'lead','Team Member':'jrm',Teacher:'worker'};

const sb=window.supabase.createClient(
  "https://fumggrcamegejihenkhb.supabase.co",
  "sb_publishable_bEqR06srB99BHHdvLQy14g_-pLZPWwJ"
);

const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const fmtTime=t=>{if(!t)return '';const p=t.split(':'),h=+p[0],ap=h>=12?'PM':'AM';return (h%12||12)+':'+p[1]+' '+ap;};
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ord=n=>{const s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);};
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
/* uploads to the private 'attachments' bucket and returns a long-lived signed URL (10y — this
   app never rotates it, so anything longer just pushes the same ceiling further out) */
async function uploadFile(file,folder){
  const path=folder+'/'+Date.now()+'-'+Math.random().toString(36).slice(2)+'-'+file.name.replace(/[^\w.\-]/g,'_');
  const {error}=await sb.storage.from('attachments').upload(path,file);
  if(error)throw error;
  const {data,error:signErr}=await sb.storage.from('attachments').createSignedUrl(path,315360000);
  if(signErr)throw signErr;
  return {name:file.name,url:data.signedUrl,path};
}
/* the plain `download` attribute doesn't reliably force-save a cross-origin Storage URL — some
   browsers just navigate the tab to it instead. Fetching the bytes and saving a same-origin blob
   URL works everywhere; falls back to opening the file if the fetch itself fails (e.g. offline). */
async function downloadFile(url,name){
  try{
    const blob=await (await fetch(url)).blob();
    const href=URL.createObjectURL(blob);const a=document.createElement('a');
    a.href=href;a.download=name;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(href),1500);
  }catch(e){window.open(url,'_blank');}
}
/* best-effort — the file/task-log record removal is what matters to the user, so a failed
   Storage cleanup (e.g. already gone) shouldn't block or error out the actual remove action */
async function removeAttachment(path){
  if(!path)return;
  const {error}=await sb.storage.from('attachments').remove([path]);
  if(error)console.error(error);
}
