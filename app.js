

function loadSupabaseFallback(){
  var s=document.createElement('script');
  s.src='https://unpkg.com/@supabase/supabase-js@2.39.3/dist/umd/supabase.js';
  s.onerror=function(){ console.error('Both Supabase CDNs failed'); };
  document.head.appendChild(s);
}


// ═══════════════════════════════════════════════════════
//  SUPABASE — LIVE SHARED DATABASE + AUTH
// ═══════════════════════════════════════════════════════

// ROLE DEFINITIONS — what each role can access
var ROLE_PERMISSIONS = {
  // Owner / Admin: full access
  'admin': {all:true},

  // Production supervisor: operations only, NO accounting, NO user management/settings
  'supervisor': {dashboard:true,printing:true,pressing:true,cutting:true,receiving:true,fabric:true,batches:true,payments:true,reports:true,auditlog:true,workers:true},

  // Department staff: limited to own work log + dashboard
  'printing_staff': {dashboard:true,printing:true},
  'pressing_staff': {dashboard:true,pressing:true},
  'cutting_staff': {dashboard:true,cutting:true},
  'inventory_staff': {dashboard:true,receiving:true,fabric:true},

  // Accounting role: finance only + reports, NO production editing, NO user management/settings
  'accounting': {dashboard:true,accdashboard:true,cashIN:true,expenses:true,supplierpay:true,pandl:true,reports:true},

  // Read-only role
  'viewer': {dashboard:true,reports:true}
};

var currentUser = null;
var currentRole = 'viewer';

function canAccess(panel){
  var perms = ROLE_PERMISSIONS[currentRole] || {};
  return perms.all === true || perms[panel] === true;
}

function getUserRole(email){
  // Check users table for role, fallback to viewer
  return dbGetUserRole(email);
}

var SUPA_URL = 'https://jcugtlrwjpeuzwpakfsn.supabase.co';
var SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjdWd0bHJ3anBldXp3cGFrZnNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMTQ3NTQsImV4cCI6MjA5MjU5MDc1NH0.dOC9KJYxkI_sN_ueVM6ibZNi-suzfHkTZwmtbPjGHYE';
var _sb = null;
function initSB(){
  if(window.supabase && !_sb){
    try{
      _sb = window.supabase.createClient(SUPA_URL, SUPA_ANON, {
        auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, storageKey:'prodops-auth'},
        global:{headers:{'X-Client-Info':'prodops/1.0'}}
      });
      console.log('Supabase initialized OK');
    }catch(e){console.error('Supabase init error:',e);}
  }
}
function getSB(){
  if(!_sb) initSB();
  return _sb;
}

// TABLE MAPPING
var PROD_TABLES = {
  printing:'printing_records', pressing:'pressing_records',
  cutting:'cutting_records', receiving:'received_materials',
  fabric:'fabric_inventory', batches:'production_batches',
  payments:'payment_records', workers:'workers', audit:'audit_logs'
};
var ACC_TABLES_MAP = {cashin:'cash_in', expenses:'expenses', supplierpay:'supplier_payments'};

// In-memory cache — filled by dbReload()
var _cache = {};
var curPanel = 'dashboard';
var settings = { bizname:'ProdOps', username:'Admin', lowstock:10, overdue:7 };
var _loading = false;

// ── UTILS ──────────────────────────────────────────────
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function nowISO(){ return new Date().toISOString(); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function fmtDate(iso){ if(!iso)return'—'; var d=new Date(iso); return d.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'}); }
function fmtTime(iso){ if(!iso)return'—'; var d=new Date(iso); return d.toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'}); }
function peso(n){ return '₱'+Number(n||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function badge(type,text){ var m={success:'bs',warning:'bw',danger:'bd',info:'bi',gray:'bg',purple:'bpur'}; return '<span class="b '+(m[type]||'bg')+'">'+text+'</span>'; }
function avatar(name,color){ var i=(name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2); var c={'Printing':'var(--blue-bg)','Pressing':'var(--green-bg)','Cutting':'var(--amber-bg)','Inventory':'var(--purple-bg)','Encoding':'var(--blue-bg)','Admin':'var(--red-bg)'}; var tc={'Printing':'var(--blue-text)','Pressing':'var(--green-text)','Cutting':'var(--amber-text)','Inventory':'var(--purple-text)','Encoding':'var(--blue-text)','Admin':'var(--red-text)'}; return '<div class="avatar" style="background:'+(c[color]||'var(--bg3)')+'10;color:'+(tc[color]||'var(--text2)')+'">'+i+'</div>'; }

// ── FIELD MAPPING camelCase <-> snake_case ─────────────
var _toSnakeMap={workerId:'worker_id',workerName:'worker_name',fabricId:'fabric_id',fabricName:'fabric_name',encodedBy:'encoded_by',batchId:'batch_id',batchCode:'batch_code',recordedBy:'recorded_by',generatedBy:'generated_by',receivedBy:'received_by',processBy:'process_by',totalKilos:'total_kilos',holdingTax:'holding_tax',subCategory:'sub_category',paidTo:'paid_to',dateReceived:'date_received',poNumber:'po_number',totalQty:'total_qty',dueDate:'due_date',uploadedVia:'uploaded_via',username:'username'};
var _toCamelMap={worker_id:'workerId',worker_name:'workerName',fabric_id:'fabricId',fabric_name:'fabricName',encoded_by:'encodedBy',batch_id:'batchId',batch_code:'batchCode',recorded_by:'recordedBy',generated_by:'generatedBy',received_by:'receivedBy',process_by:'processBy',total_kilos:'totalKilos',holding_tax:'holdingTax',sub_category:'subCategory',paid_to:'paidTo',date_received:'dateReceived',po_number:'poNumber',total_qty:'totalQty',due_date:'dueDate',uploaded_via:'uploadedVia'};

function toSnake(obj){var out={};Object.keys(obj).forEach(function(k){var sk=_toSnakeMap[k]||k;if(obj[k]!==undefined)out[sk]=obj[k];});return out;}
function toCamel(obj){if(!obj)return{};var out={};Object.keys(obj).forEach(function(k){var ck=_toCamelMap[k]||k;out[ck]=obj[k];});return out;}

// ── SUPABASE CRUD ──────────────────────────────────────
async function sbLoad(table){
  var sb=getSB();
  if(!sb){
    console.warn('Supabase not ready for table:',table);
    // Try to init again
    initSB();
    sb=getSB();
    if(!sb) return [];
  }
  try{
    var res=await sb.from(table).select('*').order('ts',{ascending:false}).limit(1000);
    if(res.error){
      console.error('Load error on',table,':',res.error.message,res.error.code);
      return[];
    }
    console.log('Loaded',res.data.length,'rows from',table);
    if(res.data.length>0) console.log('Sample row from',table,':',JSON.stringify(res.data[0]));
    return res.data||[];
  }catch(e){console.error('Exception loading',table,e);return[];}
}

async function sbInsert(table,record){
  var sb=getSB();
  if(!sb){
    showToast('Not connected to database. Check your internet.','err');
    return false;
  }
  try{
    var snake=toSnake(record);
    // Remove null values that might cause issues
    Object.keys(snake).forEach(function(k){ if(snake[k]===null||snake[k]===undefined) delete snake[k]; });
    console.log('Inserting into',table,snake);
    var res=await sb.from(table).insert([snake]);
    if(res.error){
      console.error('Insert error on',table,':',JSON.stringify(res.error));
      showToast('Save failed: '+res.error.message,'err');
      return false;
    }
    console.log('Insert OK into',table);
    return true;
  }catch(e){
    console.error('Insert exception on',table,':',e);
    showToast('Save error: '+e.message,'err');
    return false;
  }
}

async function sbUpdate(table,id,updates){
  var sb=getSB();if(!sb)return false;
  try{
    var res=await sb.from(table).update(toSnake(updates)).eq('id',id);
    if(res.error){console.error('Update',table,res.error.message);return false;}
    return true;
  }catch(e){console.error(e);return false;}
}

async function sbDelete(table,id){
  var sb=getSB();if(!sb)return false;
  try{
    var res=await sb.from(table).delete().eq('id',id);
    if(res.error){console.error('Delete',table,res.error.message);return false;}
    return true;
  }catch(e){console.error(e);return false;}
}

async function sbBulkInsert(table,records){
  var sb=getSB();
  if(!sb){showToast('Not connected to database.','err');return 0;}
  if(!records||!records.length) return 0;
  // Clean records - remove nulls, convert snake_case
  // Known columns per table
  var KNOWN_COLS = {
    'cash_in':['id','date','amount','qty','holding_tax','platform','bank','process_by','status','notes','ts'],
    'expenses':['id','date','amount','category','sub_category','description','paid_to','bank','process_by','status','notes','ts'],
    'printing_records':['id','worker_id','worker_name','design','qty','remarks','date','encoded_by','ts'],
    'pressing_records':['id','worker_id','worker_name','design','qty','remarks','date','encoded_by','ts'],
    'cutting_records':['id','worker_id','worker_name','fabric_id','fabric_name','qty','kilos','remarks','date','encoded_by','ts'],
    'received_materials':['id','supplier','item','category','qty','unit','kilos','cost','received_by','remarks','date','encoded_by','ts'],
    'fabric_inventory':['id','type','color','supplier','total_kilos','rolls','date','ts'],
    'production_batches':['id','code','design','qty','amount','remarks','status','date','generated_by','ts'],
    'payment_records':['id','batch_id','batch_code','amount','method','reference','notes','date','recorded_by','ts'],
    'workers':['id','name','dept','ts'],
    'audit_logs':['id','username','action','module','detail','ts'],
    'supplier_payments':['id','date_received','po_number','supplier','total_qty','amount','timeline','due_date','status','notes','ts']
  };
  var allowedCols = KNOWN_COLS[table] || null;
  var cleaned = records.map(function(r){
    var s = toSnake(r);
    // Remove unknown columns and nulls
    Object.keys(s).forEach(function(k){
      if(s[k]===null||s[k]===undefined||s[k]==='') delete s[k];
      if(allowedCols && allowedCols.indexOf(k)===-1) delete s[k];
    });
    if(!s.id) s.id = uid();
    return s;
  });
  console.log('Bulk inserting',cleaned.length,'rows into',table,'sample:',JSON.stringify(cleaned[0]));
  try{
    // Insert in batches of 50 to avoid limits
    var total=0;
    for(var i=0;i<cleaned.length;i+=50){
      var batch=cleaned.slice(i,i+50);
      var res=await sb.from(table).insert(batch);
      if(res.error){
        console.error('Bulk insert error on',table,':',res.error.message,res.error.details);
        showToast('Bulk upload error: '+res.error.message,'err');
        return total;
      }
      total+=batch.length;
      console.log('Inserted batch',Math.floor(i/50)+1,': total so far=',total);
    }
    return total;
  }catch(e){
    console.error('Bulk insert exception:',e);
    showToast('Bulk upload failed: '+e.message,'err');
    return 0;
  }
}

// ── CACHE & RELOAD ─────────────────────────────────────
async function dbReload(){
  // Try to init Supabase if not ready
  if(!getSB()){
    initSB();
    await new Promise(function(r){setTimeout(r,1000);});
    if(!getSB()){
      console.error('Supabase still not ready after wait');
      showToast('Database not connected. Check internet.','err');
      return;
    }
  }
  showLoading(true);
  try{
    var results=await Promise.all([
      sbLoad('printing_records'),sbLoad('pressing_records'),sbLoad('cutting_records'),
      sbLoad('received_materials'),sbLoad('fabric_inventory'),sbLoad('production_batches'),
      sbLoad('payment_records'),sbLoad('workers'),sbLoad('audit_logs'),
      sbLoad('cash_in'),sbLoad('expenses'),sbLoad('supplier_payments')
    ]);
    var keys=['printing','pressing','cutting','receiving','fabric','batches','payments','workers','audit'];
    var accKeys=['cashin','expenses','supplierpay'];
    keys.forEach(function(k,i){_cache[k]=(results[i]||[]).map(toCamel);});
    accKeys.forEach(function(k,i){_cache['acc_'+k]=(results[9+i]||[]).map(toCamel);});
    console.log('dbReload complete. cashin rows:',(_cache['acc_cashin']||[]).length);
  }catch(e){
    console.error('dbReload failed:',e);
    showToast('Failed to load data: '+e.message,'err');
  }
  showLoading(false);
}

function showLoading(on){
  var el=document.getElementById('loading-bar');
  if(el) el.style.display=on?'block':'none';
}

// ── COMPAT LAYER — sync functions read from cache ──────
function load(k){return(_cache[k]||[]);}
function save(k,d){_cache[k]=d;} // local cache update only
function aload(k){return(_cache['acc_'+k]||[]);}
function asave(k,d){_cache['acc_'+k]=d;}
function loadSettings(){try{var s=JSON.parse(localStorage.getItem('po_settings')||'{}');settings=Object.assign(settings,s);}catch(e){}}
function saveSettingsToLS(){localStorage.setItem('po_settings',JSON.stringify(settings));}

// ── AUDIT ──────────────────────────────────────────────
async function addAudit(action,module,detail){
  var rec={id:uid(),username:settings.username||'Admin',action:action,module:module,detail:detail,ts:nowISO()};
  await sbInsert('audit_logs',rec);
  if(!_cache['audit'])_cache['audit']=[];
  _cache['audit'].unshift(Object.assign({},rec,{user:rec.username}));
}

// ═══════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════
var TITLES = {dashboard:'Dashboard',printing:'Printing Log',pressing:'Pressing Log',cutting:'Cutting Log',receiving:'Receive Materials',fabric:'Fabric Inventory',batches:'Batches / POs',payments:'Payment Tracking',reports:'Reports',auditlog:'Audit Log',workers:'Workers',settings:'Settings',accdashboard:'Accounting Dashboard',cashIN:'Cash In Monitoring',expenses:'Business Expenses',supplierpay:'Supplier Payments',pandl:'Profit & Loss'};

function nav(id, el){
  // Role permission check BEFORE opening the panel
  if(!canAccess(id)){
    showToast('Access denied: your role is not allowed to open this module.','err');
    return;
  }
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.nv').forEach(n=>n.classList.remove('on'));
  var p=document.getElementById('p-'+id);
  if(p) p.classList.add('on');
  if(el) el.classList.add('on');
  document.getElementById('ptitle').innerHTML=(TITLES[id]||id)+' <span class="live-dot"></span>';
  curPanel=id;
  // User management panel - admin only
  if(id==='usermgmt'){ renderUserMgmt(); return; }
  // Always reload fresh from Supabase on every navigation
  showLoading(true);
  dbReload().then(function(){
    showLoading(false);
    // Render production panels
    renderDashboard();
    renderPrinting(); renderPressing(); renderCutting();
    renderReceiving(); renderFabric(); renderBatches();
    renderPayments(); renderWorkers(); renderAudit();
    updateOverdueBadge();
    // Render accounting panels
    renderAccDashboard();
    renderCashIn();
    renderExpenses();
    renderSupplierPay();
  });
}

function openAddModal(){ openModal(curPanel==='dashboard'?'printing':curPanel); }

// ═══════════════════════════════════════════════════════
//  REFRESH ALL
// ═══════════════════════════════════════════════════════
function refreshAll(){
  renderDashboard();
  renderPrinting(); renderPressing(); renderCutting();
  renderReceiving(); renderFabric(); renderBatches();
  renderPayments(); renderWorkers(); renderAudit();
  updateOverdueBadge();
  // Always render accounting panels too
  renderAccDashboard();
  renderCashIn();
  renderExpenses();
  renderSupplierPay();
}

// ═══════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════
function renderDashboard(){
  var t=todayStr();
  var printing=load('printing'); var pressing=load('pressing'); var cutting=load('cutting');
  var receiving=load('receiving'); var fabric=load('fabric'); var batches=load('batches');
  var payments=load('payments'); var workers=load('workers');

  var tPrint=printing.filter(r=>r.date===t).reduce((s,r)=>s+Number(r.qty||0),0);
  var tPress=pressing.filter(r=>r.date===t).reduce((s,r)=>s+Number(r.qty||0),0);
  var tCut=cutting.filter(r=>r.date===t).reduce((s,r)=>s+Number(r.qty||0),0);
  var tRecv=receiving.filter(r=>r.date===t).length;

  setText('kpi-print',tPrint); setText('kpi-press',tPress);
  setText('kpi-cut',tCut); setText('kpi-mats',tRecv);

  var unpaid=batches.filter(b=>b.status!=='Paid'&&b.status!=='Cancelled');
  var totalOut=unpaid.reduce((s,b)=>s+Number(b.amount||0),0);
  var totalPaid=payments.reduce((s,p)=>s+Number(p.amount||0),0);
  setText('kpi-outstanding',peso(totalOut));
  setText('kpi-unpaid-count',unpaid.length+' unpaid');
  setText('kpi-paid',peso(totalPaid));
  setText('kpi-paid-count',payments.length+' payments');

  // Activity
  var audit=load('audit');
  var actEl=document.getElementById('dash-activity');
  if(audit.length===0){ actEl.innerHTML='<div class="empty">No activity yet. Start encoding records.</div>'; }
  else {
    actEl.innerHTML=audit.slice(0,6).map(l=>`
      <div class="ai">
        <div class="ad" style="background:${l.action==='Created'?'var(--accent)':'var(--amber)'}"></div>
        <div><div class="at">${esc(l.detail)}</div><div class="am">${fmtDate(l.ts)} ${fmtTime(l.ts)} · ${esc(l.user)}</div></div>
      </div>`).join('');
  }

  // Fabric summary
  var fabEl=document.getElementById('dash-fabric');
  if(fabric.length===0){ fabEl.innerHTML='<div class="empty">No fabric records yet.</div>'; }
  else {
    fabEl.innerHTML=fabric.map(f=>{
      var used=cutting.filter(c=>c.fabricId===f.id).reduce((s,c)=>s+Number(c.kilos||0),0);
      var rem=Math.max(0,Number(f.totalKilos||0)-used);
      var pct=f.totalKilos>0?Math.min(100,Math.round(used/f.totalKilos*100)):0;
      var col=rem<=settings.lowstock?'var(--red)':rem<=settings.lowstock*2?'var(--amber)':'var(--accent)';
      var txtcol=rem<=settings.lowstock?'var(--red-text)':rem<=settings.lowstock*2?'var(--amber-text)':'var(--green-text)';
      return `<div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px">
          <span>${esc(f.type)} — ${esc(f.color)}</span>
          <span style="font-family:var(--mono);color:${txtcol}">${rem.toFixed(1)} kg</span>
        </div>
        <div class="pw"><div class="pf" style="width:${pct}%;background:${col}"></div></div>
      </div>`;
    }).join('');
  }

  // Workers table
  var tbody=document.getElementById('dash-workers-body');
  if(workers.length===0){ tbody.innerHTML='<tr><td colspan="6"><div class="empty">No workers yet.</div></td></tr>'; return; }
  var rows=workers.map(w=>{
    var p=printing.filter(r=>r.workerId===w.id).reduce((s,r)=>s+Number(r.qty||0),0);
    var pp=pressing.filter(r=>r.workerId===w.id).reduce((s,r)=>s+Number(r.qty||0),0);
    var c=cutting.filter(r=>r.workerId===w.id).reduce((s,r)=>s+Number(r.qty||0),0);
    return {w,p,pp,c,total:p+pp+c};
  }).sort((a,b)=>b.total-a.total);
  tbody.innerHTML=rows.map(({w,p,pp,c,total})=>`
    <tr>
      <td style="padding:8px 9px"><div class="wc">${avatar(w.name,w.dept)}<span>${esc(w.name)}</span></div></td>
      <td style="padding:8px 9px">${badge('info',w.dept)}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700">${total}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${p}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${pp}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${c}</td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════════
//  PRINTING
// ═══════════════════════════════════════════════════════
function renderPrinting(){
  // Updated version - uses SKU-based columns
  var data = load('printing') || [];
  var today = todayStr();
  var fd = document.getElementById('f-print-date')?.value || '';
  var fw = document.getElementById('f-print-worker')?.value || '';
  var fs = document.getElementById('f-print-search')?.value?.toLowerCase() || '';

  var workers = load('workers') || [];
  var wsel = document.getElementById('f-print-worker');
  if(wsel && wsel.options.length <= 1){
    workers.forEach(function(w){ 
      if(!w.name) return;
      var o=document.createElement('option'); o.value=w.id; o.textContent=w.name; wsel.appendChild(o); 
    });
  }

  var filtered = data.filter(function(r){
    if(fd && r.date !== fd) return false;
    if(fw && r.workerId !== fw) return false;
    if(fs && !((r.sku||'').toLowerCase().includes(fs) || (r.itemDescription||r.design||'').toLowerCase().includes(fs))) return false;
    return true;
  });

  var todayRecs = data.filter(function(r){ return r.date === today; });
  setText('pk-today', todayRecs.reduce(function(s,r){ return s+Number(r.qty||0); }, 0));
  setText('pk-records', data.length);
  setText('pk-alltime', data.reduce(function(s,r){ return s+Number(r.qty||0); }, 0));

  var tbody = document.getElementById('tbl-printing');
  if(!tbody) return;
  if(!filtered.length){ tbody.innerHTML='<tr><td colspan="9"><div class="empty">No printing records found.</div></td></tr>'; return; }
  tbody.innerHTML = filtered.map(function(r){
    var desc = r.itemDescription || r.design || '—';
    var cat = r.category || '—';
    return '<tr>'+
      '<td style="padding:8px 10px" class="mono">'+(r.date||'—')+'</td>'+
      '<td style="padding:8px 10px;font-weight:600;color:var(--blue-text)">'+esc(r.sku||'—')+'</td>'+
      '<td style="padding:8px 10px;max-width:200px;white-space:normal;font-size:12px">'+esc(desc)+'</td>'+
      '<td style="padding:8px 10px">'+badge('info', cat)+'</td>'+
      '<td style="padding:8px 10px;font-family:var(--mono);font-weight:700">'+Number(r.qty||0).toLocaleString()+'</td>'+
      '<td style="padding:8px 10px">'+esc(r.workerName||'—')+'</td>'+
      '<td style="padding:8px 10px;color:var(--text2);font-size:12px">'+esc(r.remarks||'—')+'</td>'+
      '<td style="padding:8px 10px;font-size:11px;color:var(--text3)" class="mono">'+fmtTime(r.ts)+'</td>'+
      '<td style="padding:8px 10px"><button class="btn btn-d btn-sm" onclick="deleteRecord('printing',''+r.id+'')">Del</button></td>'+
    '</tr>';
  }).join('');
}

function renderPressing(){
  var data=load('pressing'); var workers=load('workers');
  var fd=document.getElementById('f-press-date')?.value;
  var fw=document.getElementById('f-press-worker')?.value;
  populateWorkerFilter('f-press-worker',workers,'Pressing');
  var filtered=data.filter(r=>{
    if(fd&&r.date!==fd)return false;
    if(fw&&r.workerId!==fw)return false;
    return true;
  });
  var t=todayStr();
  setText('ppk-today',data.filter(r=>r.date===t).reduce((s,r)=>s+Number(r.qty||0),0));
  setText('ppk-records',data.length);
  setText('ppk-alltime',data.reduce((s,r)=>s+Number(r.qty||0),0));
  var tbody=document.getElementById('tbl-pressing');
  if(filtered.length===0){tbody.innerHTML='<tr><td colspan="8"><div class="empty">No records found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(r=>`
    <tr>
      <td style="padding:8px 9px" class="mono">${fmtDate(r.ts)}</td>
      <td style="padding:8px 9px"><div class="wc">${avatar(r.workerName,'Pressing')}<span>${esc(r.workerName||'—')}</span></div></td>
      <td style="padding:8px 9px">${esc(r.design)}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700">${r.qty}</td>
      <td style="padding:8px 9px;color:var(--text2)">${esc(r.remarks||'—')}</td>
      <td style="padding:8px 9px">${esc(r.encodedBy||'—')}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-size:11px;color:var(--text3)">${fmtTime(r.ts)}</td>
      <td style="padding:8px 9px"><button class="btn btn-d btn-sm" onclick="deleteRecord('pressing','${r.id}')">Delete</button></td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════════
//  CUTTING
// ═══════════════════════════════════════════════════════
function renderCutting(){
  var data=load('cutting'); var fabric=load('fabric'); var workers=load('workers');
  var fd=document.getElementById('f-cut-date')?.value;
  var fw=document.getElementById('f-cut-worker')?.value;
  populateWorkerFilter('f-cut-worker',workers,'Cutting');
  var filtered=data.filter(r=>{
    if(fd&&r.date!==fd)return false;
    if(fw&&r.workerId!==fw)return false;
    return true;
  });
  var t=todayStr();
  setText('ck-today',data.filter(r=>r.date===t).reduce((s,r)=>s+Number(r.qty||0),0));
  setText('ck-records',data.length);
  setText('ck-kilos',data.reduce((s,r)=>s+Number(r.kilos||0),0).toFixed(1));
  var tbody=document.getElementById('tbl-cutting');
  if(filtered.length===0){tbody.innerHTML='<tr><td colspan="8"><div class="empty">No records found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(r=>{
    var fab=fabric.find(f=>f.id===r.fabricId);
    var fabName=fab?fab.type+' — '+fab.color:(r.fabricName||'—');
    return `<tr>
      <td style="padding:8px 9px" class="mono">${fmtDate(r.ts)}</td>
      <td style="padding:8px 9px"><div class="wc">${avatar(r.workerName,'Cutting')}<span>${esc(r.workerName||'—')}</span></div></td>
      <td style="padding:8px 9px">${esc(fabName)}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700">${r.qty}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${Number(r.kilos||0).toFixed(1)} kg</td>
      <td style="padding:8px 9px;color:var(--text2)">${esc(r.remarks||'—')}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-size:11px;color:var(--text3)">${fmtTime(r.ts)}</td>
      <td style="padding:8px 9px"><button class="btn btn-d btn-sm" onclick="deleteRecord('cutting','${r.id}')">Delete</button></td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════
//  RECEIVING
// ═══════════════════════════════════════════════════════
function renderReceiving(){
  var data=load('receiving');
  var fc=document.getElementById('f-recv-cat')?.value;
  var fd=document.getElementById('f-recv-date')?.value;
  var filtered=data.filter(r=>{
    if(fc&&r.category!==fc)return false;
    if(fd&&r.date!==fd)return false;
    return true;
  });
  var tbody=document.getElementById('tbl-receiving');
  if(filtered.length===0){tbody.innerHTML='<tr><td colspan="11"><div class="empty">No records found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(r=>`
    <tr>
      <td style="padding:8px 9px" class="mono">${fmtDate(r.ts)}</td>
      <td style="padding:8px 9px">${esc(r.supplier)}</td>
      <td style="padding:8px 9px">${esc(r.item)}</td>
      <td style="padding:8px 9px">${badge('info',r.category)}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${r.qty}</td>
      <td style="padding:8px 9px">${esc(r.unit)}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${r.kilos?Number(r.kilos).toFixed(1)+' kg':'—'}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${r.cost?peso(r.cost):'—'}</td>
      <td style="padding:8px 9px">${esc(r.receivedBy||'—')}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-size:11px;color:var(--text3)">${fmtTime(r.ts)}</td>
      <td style="padding:8px 9px"><button class="btn btn-d btn-sm" onclick="deleteRecord('receiving','${r.id}')">Delete</button></td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════════
//  FABRIC
// ═══════════════════════════════════════════════════════
function renderFabric(){
  var data=load('fabric'); var cutting=load('cutting');
  var fs=document.getElementById('f-fab-status')?.value;
  var withStatus=data.map(f=>{
    var used=cutting.filter(c=>c.fabricId===f.id).reduce((s,c)=>s+Number(c.kilos||0),0);
    var rem=Math.max(0,Number(f.totalKilos||0)-used);
    var pct=f.totalKilos>0?Math.min(100,Math.round(used/f.totalKilos*100)):0;
    var st=rem<=settings.lowstock?'Critical':rem<=settings.lowstock*2?'Watch':'OK';
    return {...f,used,rem,pct,st};
  });
  var filtered=withStatus.filter(f=>!fs||f.st===fs);
  setText('fk-types',data.length);
  setText('fk-critical',withStatus.filter(f=>f.st==='Critical').length);
  setText('fk-remaining',withStatus.reduce((s,f)=>s+f.rem,0).toFixed(1)+' kg');
  var tbody=document.getElementById('tbl-fabric');
  if(filtered.length===0){tbody.innerHTML='<tr><td colspan="9"><div class="empty">No fabric records found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(f=>{
    var bdg=f.st==='Critical'?badge('danger','Critical'):f.st==='Watch'?badge('warning','Watch'):badge('success','OK');
    var remCol=f.st==='Critical'?'var(--red-text)':f.st==='Watch'?'var(--amber-text)':'var(--green-text)';
    return `<tr>
      <td style="padding:8px 9px">${esc(f.type)}</td>
      <td style="padding:8px 9px">${esc(f.color)}</td>
      <td style="padding:8px 9px">${esc(f.supplier||'—')}</td>
      <td style="padding:8px 9px" class="mono">${fmtDate(f.ts)}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${Number(f.totalKilos).toFixed(1)}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${f.used.toFixed(1)}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700;color:${remCol}">${f.rem.toFixed(1)}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${f.pct}%</td>
      <td style="padding:8px 9px">${bdg}</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════
//  BATCHES / POs
// ═══════════════════════════════════════════════════════
function renderBatches(){
  var data=load('batches'); var payments=load('payments');
  var fs=document.getElementById('f-batch-status')?.value;
  // Auto-mark overdue
  var today=new Date(); var od=settings.overdue||7;
  data=data.map(b=>{
    if(b.status==='Pending'){
      var created=new Date(b.ts); var diff=(today-created)/(1000*60*60*24);
      if(diff>od) b.status='Overdue';
    }
    return b;
  });
  save('batches',data);
  var filtered=data.filter(b=>!fs||b.status===fs);
  var unpaid=data.filter(b=>b.status!=='Paid'&&b.status!=='Cancelled');
  setText('bk-total',data.length);
  setText('bk-paid',data.filter(b=>b.status==='Paid').length);
  setText('bk-pending',data.filter(b=>b.status==='Pending').length);
  setText('bk-outstanding',peso(unpaid.reduce((s,b)=>s+Number(b.amount||0),0)));
  var tbody=document.getElementById('tbl-batches');
  if(filtered.length===0){tbody.innerHTML='<tr><td colspan="8"><div class="empty">No POs found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(b=>{
    var st=b.status==='Paid'?badge('success','Paid'):b.status==='Overdue'?badge('danger','Overdue'):b.status==='Cancelled'?badge('gray','Cancelled'):badge('warning','Pending');
    var action=b.status!=='Paid'&&b.status!=='Cancelled'?`<button class="btn btn-g btn-sm" onclick="quickPayModal('${b.id}')">Mark paid</button>`:'';
    return `<tr>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:600;color:var(--blue-text)">${esc(b.code)}</td>
      <td style="padding:8px 9px" class="mono">${fmtDate(b.ts)}</td>
      <td style="padding:8px 9px">${esc(b.design)}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:600">${b.qty}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${peso(b.amount)}</td>
      <td style="padding:8px 9px">${st}</td>
      <td style="padding:8px 9px">${esc(b.generatedBy||'—')}</td>
      <td style="padding:8px 9px">${action}</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════
//  PAYMENTS
// ═══════════════════════════════════════════════════════
function renderPayments(){
  var data=load('payments'); var batches=load('batches');
  var fs=document.getElementById('f-pay-status')?.value;
  var filtered=fs?data.filter(p=>{var b=batches.find(b=>b.id===p.batchId); return b&&b.status===fs;}):data;
  var unpaid=batches.filter(b=>b.status!=='Paid'&&b.status!=='Cancelled');
  setText('payk-paid',peso(data.reduce((s,p)=>s+Number(p.amount||0),0)));
  setText('payk-outstanding',peso(unpaid.reduce((s,b)=>s+Number(b.amount||0),0)));
  setText('payk-count',data.length);
  var tbody=document.getElementById('tbl-payments');
  if(filtered.length===0){tbody.innerHTML='<tr><td colspan="7"><div class="empty">No payment records found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(p=>{
    var b=batches.find(b=>b.id===p.batchId);
    var st=b?badge(b.status==='Paid'?'success':b.status==='Overdue'?'danger':'warning',b.status||'—'):badge('gray','—');
    return `<tr>
      <td style="padding:8px 9px;font-family:var(--mono);color:var(--blue-text)">${esc(p.batchCode||'—')}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700;color:var(--green-text)">${peso(p.amount)}</td>
      <td style="padding:8px 9px">${esc(p.method)}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-size:11.5px">${esc(p.reference||'—')}</td>
      <td style="padding:8px 9px" class="mono">${fmtDate(p.ts)}</td>
      <td style="padding:8px 9px">${esc(p.recordedBy||'—')}</td>
      <td style="padding:8px 9px">${st}</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════
//  WORKERS
// ═══════════════════════════════════════════════════════
function renderWorkers(){
  var data=load('workers'); 
  var printing=load('printing'); var pressing=load('pressing'); var cutting=load('cutting');
  var presslog=load('presslog')||[];
  var fd=document.getElementById('f-wk-dept')?.value;
  
  // Normalize - handle records with missing name/dept
  data = data.map(function(w){ 
    return Object.assign({}, w, {
      name: w.name||w.workerName||null, 
      dept: w.dept||w.department||null
    }); 
  });
  
  var valid = data.filter(function(w){ return w.name && w.dept; });
  var broken = data.filter(function(w){ return !w.name || !w.dept; });
  var filtered = valid.filter(function(w){ return !fd || w.dept===fd; });
  
  var tbody=document.getElementById('tbl-workers');
  if(!tbody) return;
  
  var rows = '';
  if(broken.length > 0 && !fd){
    rows += '<tr><td colspan="5" style="padding:10px;background:#fef2f2;border-bottom:1px solid #fecaca">'+
      '<span style="color:#dc2626;font-size:12px;font-weight:600">⚠ '+broken.length+' corrupted records found.</span> '+
      '<button class="btn btn-d btn-sm" style="margin-left:8px" onclick="cleanBrokenWorkers()">Delete corrupted records</button>'+
    '</td></tr>';
  }
  
  if(filtered.length===0 && !rows){
    tbody.innerHTML='<tr><td colspan="5"><div class="empty">No workers found. Add your first worker.</div></td></tr>';
    return;
  }
  
  rows += filtered.map(function(w){
    var total=[...printing,...pressing,...cutting,...presslog].filter(function(r){ return r.workerId===w.id; }).reduce(function(s,r){ return s+Number(r.qty||0); },0);
    return '<tr>'+
      '<td style="padding:8px 9px"><div class="wc">'+avatar(w.name,w.dept)+'<span>'+esc(w.name)+'</span></div></td>'+
      '<td style="padding:8px 9px">'+badge('info',w.dept)+'</td>'+
      '<td style="padding:8px 9px;font-family:var(--mono);font-weight:600">'+total.toLocaleString()+'</td>'+
      '<td style="padding:8px 9px;color:var(--text3);font-size:11px">'+fmtDate(w.ts)+'</td>'+
      '<td style="padding:8px 9px"><button class="btn btn-d btn-sm" onclick="deleteRecord('workers',''+w.id+'')">Remove</button></td>'+
    '</tr>';
  }).join('');
  tbody.innerHTML = rows;
}

async function cleanBrokenWorkers(){
  if(!confirm('Delete all '+load('workers').filter(function(w){return !(w.name||w.workerName)||!(w.dept||w.department);}).length+' corrupted worker records? This cannot be undone.')) return;
  var data = load('workers');
  var broken = data.filter(function(w){ return !(w.name||w.workerName) || !(w.dept||w.department); });
  if(!broken.length){ showToast('No corrupted records found.'); return; }
  showLoading(true);
  showToast('Deleting '+broken.length+' records... please wait.');
  var sb = getSB();
  if(sb){
    // Delete all broken workers at once using IN clause via multiple requests
    var ids = broken.map(function(w){ return w.id; });
    // Supabase JS v2: use .in() filter
    try {
      var res = await sb.from('workers').delete().in('id', ids);
      if(res.error) throw res.error;
    } catch(e) {
      // Fallback: delete one by one
      for(var i=0; i<broken.length; i++){
        await sbDelete('workers', broken[i].id);
      }
    }
  }
  showLoading(false);
  await dbReload();
  renderWorkers();
  showToast('Deleted '+broken.length+' corrupted records ✓');
}

function renderAudit(){
  var data=load('audit');
  var fu=document.getElementById('f-audit-user')?.value;
  var fm=document.getElementById('f-audit-module')?.value;
  var fa=document.getElementById('f-audit-action')?.value;
  // populate user filter
  var userSel=document.getElementById('f-audit-user');
  var users=[...new Set(data.map(l=>l.user))];
  var curU=userSel?.value;
  if(userSel){ userSel.innerHTML='<option value="">All users</option>'+users.map(u=>`<option value="${esc(u)}"${u===curU?' selected':''}>${esc(u)}</option>`).join(''); }
  var filtered=data.filter(l=>{
    if(fu&&l.user!==fu)return false;
    if(fm&&l.module!==fm)return false;
    if(fa&&l.action!==fa)return false;
    return true;
  });
  var tbody=document.getElementById('tbl-audit');
  if(filtered.length===0){tbody.innerHTML='<tr><td colspan="5"><div class="empty">No audit entries found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(l=>`
    <tr>
      <td style="padding:8px 9px;font-family:var(--mono);font-size:11px;color:var(--text3)">${fmtDate(l.ts)} ${fmtTime(l.ts)}</td>
      <td style="padding:8px 9px">${esc(l.user)}</td>
      <td style="padding:8px 9px">${badge(l.action==='Created'?'info':l.action==='Deleted'?'danger':'warning',l.action)}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-size:11.5px">${esc(l.module)}</td>
      <td style="padding:8px 9px;color:var(--text2);max-width:320px;overflow:hidden;text-overflow:ellipsis">${esc(l.detail)}</td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════════
//  REPORTS
// ═══════════════════════════════════════════════════════
function renderReport(){
  var from=document.getElementById('rp-from').value;
  var to=document.getElementById('rp-to').value;
  var dept=document.getElementById('rp-dept').value;
  var printing=load('printing'); var pressing=load('pressing'); var cutting=load('cutting');
  var workers=load('workers');
  var allRecs=[
    ...printing.map(r=>({...r,type:'Printing'})),
    ...pressing.map(r=>({...r,type:'Pressing'})),
    ...cutting.map(r=>({...r,type:'Cutting'}))
  ].filter(r=>{
    if(from&&r.date<from)return false;
    if(to&&r.date>to)return false;
    if(dept&&r.type!==dept)return false;
    return true;
  });
  var workerMap={};
  allRecs.forEach(r=>{
    if(!workerMap[r.workerId]) workerMap[r.workerId]={name:r.workerName,dept:r.type,printing:0,pressing:0,cutting:0,total:0};
    if(r.type==='Printing')workerMap[r.workerId].printing+=Number(r.qty||0);
    if(r.type==='Pressing')workerMap[r.workerId].pressing+=Number(r.qty||0);
    if(r.type==='Cutting')workerMap[r.workerId].cutting+=Number(r.qty||0);
    workerMap[r.workerId].total+=Number(r.qty||0);
  });
  var rows=Object.values(workerMap).sort((a,b)=>b.total-a.total);
  var el=document.getElementById('report-output');
  if(rows.length===0){el.innerHTML='<div class="empty">No data found for selected range.</div>';return;}
  el.innerHTML=`<div class="tw"><table>
    <thead><tr><th>Worker</th><th>Dept</th><th>Printing</th><th>Pressing</th><th>Cutting</th><th>Total units</th></tr></thead>
    <tbody>${rows.map(w=>`<tr>
      <td style="padding:8px 9px">${esc(w.name||'Unknown')}</td>
      <td style="padding:8px 9px">${badge('info',w.dept)}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${w.printing}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${w.pressing}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${w.cutting}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700">${w.total}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
  // Inventory tab
  renderInvReport(); renderPOReport();
}

function renderInvReport(){
  var fabric=load('fabric'); var cutting=load('cutting');
  var el=document.getElementById('inv-report-content');
  if(fabric.length===0){el.innerHTML='<div class="empty">No fabric data.</div>';return;}
  el.innerHTML=`<table>
    <thead><tr><th>Fabric</th><th>Color</th><th>Total (kg)</th><th>Used (kg)</th><th>Remaining (kg)</th><th>Status</th></tr></thead>
    <tbody>${fabric.map(f=>{
      var used=cutting.filter(c=>c.fabricId===f.id).reduce((s,c)=>s+Number(c.kilos||0),0);
      var rem=Math.max(0,Number(f.totalKilos||0)-used);
      var st=rem<=settings.lowstock?badge('danger','Critical'):rem<=settings.lowstock*2?badge('warning','Watch'):badge('success','OK');
      return `<tr><td style="padding:8px 9px">${esc(f.type)}</td><td style="padding:8px 9px">${esc(f.color)}</td><td style="padding:8px 9px;font-family:var(--mono)">${Number(f.totalKilos).toFixed(1)}</td><td style="padding:8px 9px;font-family:var(--mono)">${used.toFixed(1)}</td><td style="padding:8px 9px;font-family:var(--mono);font-weight:700">${rem.toFixed(1)}</td><td style="padding:8px 9px">${st}</td></tr>`;
    }).join('')}</tbody></table>`;
}

function renderPOReport(){
  var batches=load('batches'); var payments=load('payments');
  var el=document.getElementById('po-report-content');
  if(batches.length===0){el.innerHTML='<div class="empty">No PO data.</div>';return;}
  el.innerHTML=`<table>
    <thead><tr><th>PO Code</th><th>Design</th><th>Qty</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
    <tbody>${batches.map(b=>{
      var st=b.status==='Paid'?badge('success','Paid'):b.status==='Overdue'?badge('danger','Overdue'):badge('warning',b.status);
      return `<tr><td style="padding:8px 9px;font-family:var(--mono);color:var(--blue-text)">${esc(b.code)}</td><td style="padding:8px 9px">${esc(b.design)}</td><td style="padding:8px 9px;font-family:var(--mono)">${b.qty}</td><td style="padding:8px 9px;font-family:var(--mono)">${peso(b.amount)}</td><td style="padding:8px 9px">${st}</td><td style="padding:8px 9px;font-family:var(--mono);font-size:11.5px">${fmtDate(b.ts)}</td></tr>`;
    }).join('')}</tbody></table>`;
}

function switchTab(el,id){
  document.querySelectorAll('#p-reports .tn').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  ['rt-prod','rt-inv','rt-po'].forEach(i=>{var e=document.getElementById(i);if(e)e.style.display='none';});
  var t=document.getElementById(id); if(t)t.style.display='block';
  if(id==='rt-inv')renderInvReport();
  if(id==='rt-po')renderPOReport();
}

// ═══════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════
function openModal(type){
  // Admin-only Add User modal. This must bypass normal record permissions.
  if(type==='newuser'){
    if(currentRole !== 'admin'){
      showToast('Only admin can add users.','err');
      return;
    }
    document.getElementById('mtitle').textContent='Add new user';
    document.getElementById('mbody').innerHTML=buildNewUserForm();
    document.getElementById('moverlay').classList.add('open');
    return;
  }

  if(!canAccess(type)){
    showToast('Access denied: your role cannot add records here.','err');
    return;
  }
  var titles={printing:'Add printing record',pressing:'Add pressing record',cutting:'Cutting record',receiving:'Receive materials',fabric:'Add fabric record',batches:'Generate production PO',payments:'Record payment',workers:'Add worker'};
  document.getElementById('mtitle').textContent=titles[type]||'Add record';
  document.getElementById('mbody').innerHTML=buildForm(type);
  document.getElementById('moverlay').classList.add('open');
}

function closeModal(){ document.getElementById('moverlay').classList.remove('open'); }

function buildForm(type){
  var workers=load('workers'); var fabric=load('fabric'); var batches=load('batches');
  var workerOpts=workers.map(w=>`<option value="${w.id}">${esc(w.name)} (${esc(w.dept)})</option>`).join('');
  var fabOpts=fabric.map(f=>{
    var used=load('cutting').filter(c=>c.fabricId===f.id).reduce((s,c)=>s+Number(c.kilos||0),0);
    var rem=Math.max(0,Number(f.totalKilos||0)-used);
    return `<option value="${f.id}">${esc(f.type)} — ${esc(f.color)} (${rem.toFixed(1)} kg left)</option>`;
  }).join('');
  var unpaidBatches=batches.filter(b=>b.status!=='Paid'&&b.status!=='Cancelled');
  var batchOpts=unpaidBatches.map(b=>`<option value="${b.id}">${esc(b.code)} — ${peso(b.amount)} (${b.status})</option>`).join('');

  var today=todayStr();
  if(type==='printing') return `
    <div class="fgrid">
      <div class="fg"><label>Date <span class="req">*</span></label><input class="fi" type="date" id="f-date" value="${today}"></div>
      <div class="fg"><label>Worker <span class="req">*</span></label><select class="fi" id="f-worker">${workerOpts||'<option value="">No workers — add workers first</option>'}</select></div>
      <div class="fg"><label>Design / item <span class="req">*</span></label><input class="fi" type="text" id="f-design" placeholder="e.g. Design A — T-shirt"></div>
      <div class="fg"><label>Quantity printed <span class="req">*</span></label><input class="fi" type="number" id="f-qty" placeholder="0" min="1"></div>
      <div class="fg full"><label>Remarks (optional)</label><textarea class="fi" id="f-remarks" placeholder="Notes..."></textarea></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="submitForm('printing')">Save record</button></div>`;

  if(type==='pressing') return `
    <div class="fgrid">
      <div class="fg"><label>Date <span class="req">*</span></label><input class="fi" type="date" id="f-date" value="${today}"></div>
      <div class="fg"><label>Worker <span class="req">*</span></label><select class="fi" id="f-worker">${workerOpts||'<option value="">No workers yet</option>'}</select></div>
      <div class="fg"><label>Design / item <span class="req">*</span></label><input class="fi" type="text" id="f-design" placeholder="e.g. Design B — Polo"></div>
      <div class="fg"><label>Quantity pressed <span class="req">*</span></label><input class="fi" type="number" id="f-qty" placeholder="0" min="1"></div>
      <div class="fg full"><label>Remarks (optional)</label><textarea class="fi" id="f-remarks" placeholder="Notes..."></textarea></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="submitForm('pressing')">Save record</button></div>`;

  if(type==='cutting') return `
    <div class="fgrid">
      <div class="fg"><label>Date <span class="req">*</span></label><input class="fi" type="date" id="f-date" value="${today}"></div>
      <div class="fg"><label>Worker <span class="req">*</span></label><select class="fi" id="f-worker">${workerOpts||'<option value="">No workers yet</option>'}</select></div>
      <div class="fg"><label>Fabric used <span class="req">*</span></label><select class="fi" id="f-fabric">${fabOpts||'<option value="">No fabric — add fabric first</option>'}</select></div>
      <div class="fg"><label>Quantity cut (units) <span class="req">*</span></label><input class="fi" type="number" id="f-qty" placeholder="0" min="1"></div>
      <div class="fg"><label>Fabric kilos used <span class="req">*</span></label><input class="fi" type="number" id="f-kilos" placeholder="0.0" step="0.1" min="0"></div>
      <div class="fg full"><label>Remarks</label><textarea class="fi" id="f-remarks" placeholder="Fabric balance auto-updates on save..."></textarea></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="submitForm('cutting')">Save &amp; update fabric</button></div>`;

  if(type==='receiving') return `
    <div class="fgrid">
      <div class="fg"><label>Date received <span class="req">*</span></label><input class="fi" type="date" id="f-date" value="${today}"></div>
      <div class="fg"><label>Supplier <span class="req">*</span></label><input class="fi" type="text" id="f-supplier" placeholder="Supplier name"></div>
      <div class="fg"><label>Item name <span class="req">*</span></label><input class="fi" type="text" id="f-item" placeholder="Item description"></div>
      <div class="fg"><label>Category <span class="req">*</span></label><select class="fi" id="f-category"><option>Fabric</option><option>Supplies</option><option>Materials</option><option>Other</option></select></div>
      <div class="fg"><label>Quantity <span class="req">*</span></label><input class="fi" type="number" id="f-qty" placeholder="0" min="1"></div>
      <div class="fg"><label>Unit <span class="req">*</span></label><select class="fi" id="f-unit"><option>pcs</option><option>rolls</option><option>boxes</option><option>kg</option><option>liters</option><option>meters</option></select></div>
      <div class="fg"><label>Kilos (if fabric)</label><input class="fi" type="number" id="f-kilos" placeholder="0.0" step="0.1"></div>
      <div class="fg"><label>Cost (₱)</label><input class="fi" type="number" id="f-cost" placeholder="0.00" step="0.01"></div>
      <div class="fg"><label>Received by</label><input class="fi" type="text" id="f-receivedby" placeholder="Staff name"></div>
      <div class="fg full"><label>Remarks</label><textarea class="fi" id="f-remarks" placeholder="Batch number, condition notes..."></textarea></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="submitForm('receiving')">Save entry</button></div>`;

  if(type==='fabric') return `
    <div class="fgrid">
      <div class="fg"><label>Fabric type <span class="req">*</span></label><input class="fi" type="text" id="f-type" placeholder="Cotton, Polyester, Spandex..."></div>
      <div class="fg"><label>Color / design <span class="req">*</span></label><input class="fi" type="text" id="f-color" placeholder="White, Blue, Black..."></div>
      <div class="fg"><label>Supplier</label><input class="fi" type="text" id="f-supplier" placeholder="Supplier name"></div>
      <div class="fg"><label>Date received</label><input class="fi" type="date" id="f-date" value="${today}"></div>
      <div class="fg"><label>Total kilos received <span class="req">*</span></label><input class="fi" type="number" id="f-kilos" placeholder="0.0" step="0.1" min="0"></div>
      <div class="fg"><label>Total rolls</label><input class="fi" type="number" id="f-rolls" placeholder="0" min="0"></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="submitForm('fabric')">Save fabric</button></div>`;

  if(type==='batches') return `
    <div class="fgrid">
      <div class="fg"><label>Date <span class="req">*</span></label><input class="fi" type="date" id="f-date" value="${today}"></div>
      <div class="fg"><label>Design / item <span class="req">*</span></label><input class="fi" type="text" id="f-design" placeholder="Design name or item"></div>
      <div class="fg"><label>Total quantity <span class="req">*</span></label><input class="fi" type="number" id="f-qty" placeholder="0" min="1"></div>
      <div class="fg"><label>Total amount (₱)</label><input class="fi" type="number" id="f-amount" placeholder="0.00" step="0.01"></div>
      <div class="fg full"><label>Remarks</label><textarea class="fi" id="f-remarks" placeholder="Notes about this batch..."></textarea></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-g" onclick="submitForm('batches')">Generate PO</button></div>`;

  if(type==='payments') return `
    <div class="fgrid">
      <div class="fg full"><label>PO to pay <span class="req">*</span></label><select class="fi" id="f-batch">${batchOpts||'<option value="">No pending POs</option>'}</select></div>
      <div class="fg"><label>Payment date <span class="req">*</span></label><input class="fi" type="date" id="f-date" value="${today}"></div>
      <div class="fg"><label>Amount paid (₱) <span class="req">*</span></label><input class="fi" type="number" id="f-amount" placeholder="0.00" step="0.01"></div>
      <div class="fg"><label>Payment method <span class="req">*</span></label><select class="fi" id="f-method"><option>GCash</option><option>Maya</option><option>Bank transfer — BDO</option><option>Bank transfer — BPI</option><option>Cash</option><option>Other</option></select></div>
      <div class="fg full"><label>Reference number</label><input class="fi" type="text" id="f-reference" placeholder="Transaction reference"></div>
      <div class="fg full"><label>Notes</label><textarea class="fi" id="f-notes" placeholder="Additional notes..."></textarea></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-g" onclick="submitForm('payments')">Record payment</button></div>`;

  if(type==='workers') return `
    <div class="fgrid">
      <div class="fg"><label>Full name <span class="req">*</span></label><input class="fi" type="text" id="f-name" placeholder="Worker full name" autocomplete="off"></div>
      <div class="fg"><label>Department <span class="req">*</span></label>
        <select class="fi" id="f-dept">
          <option value="">— Select department —</option>
          <option>Printing</option>
          <option>Press</option>
          <option>Pressing</option>
          <option>Cutting</option>
          <option>Inventory</option>
          <option>Encoding</option>
          <option>Admin</option>
        </select>
      </div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="submitForm('workers')">Save worker</button></div>`;

  return '<div class="empty">Form not available.</div>';
}

function gv(id){ var e=document.getElementById(id); return e?e.value.trim():''; }

async function submitForm(type){
  var workers=load('workers'); var fabric=load('fabric'); var batches=load('batches');
  if(type==='printing'){
    var workerId=gv('f-worker'); var design=gv('f-design'); var qty=gv('f-qty'); var date=gv('f-date');
    if(!workerId||!design||!qty||!date){showToast('Please fill in all required fields.','err');return;}
    var w=workers.find(w=>w.id===workerId);
    var rec={id:uid(),workerId:workerId,workerName:w?w.name:'Unknown',design:design,qty:Number(qty),remarks:gv('f-remarks'),date:date,encodedBy:settings.username||'Admin',ts:nowISO()};
    var ok=await sbInsert('printing_records',rec);
    if(ok){await addAudit('Created','printing','Printing — '+(w?w.name:'?')+' · '+qty+' units · '+design);await dbReload();refreshAll();}
    closeModal(); showToast('Printing record saved. ✓');
  }
  else if(type==='pressing'){
    var workerId=gv('f-worker'); var design=gv('f-design'); var qty=gv('f-qty'); var date=gv('f-date');
    if(!workerId||!design||!qty||!date){showToast('Please fill in all required fields.','err');return;}
    var w=workers.find(w=>w.id===workerId);
    var rec={id:uid(),workerId:workerId,workerName:w?w.name:'Unknown',design:design,qty:Number(qty),remarks:gv('f-remarks'),date:date,encodedBy:settings.username||'Admin',ts:nowISO()};
    var ok=await sbInsert('pressing_records',rec);
    if(ok){await addAudit('Created','pressing','Pressing — '+(w?w.name:'?')+' · '+qty+' units · '+design);await dbReload();refreshAll();}
    closeModal(); showToast('Pressing record saved. ✓');
  }
  else if(type==='cutting'){
    var workerId=gv('f-worker'); var fabricId=gv('f-fabric'); var qty=gv('f-qty'); var kilos=gv('f-kilos'); var date=gv('f-date');
    if(!workerId||!fabricId||!qty||!kilos||!date){showToast('Please fill in all required fields.','err');return;}
    var w=workers.find(w=>w.id===workerId); var f=fabric.find(f=>f.id===fabricId);
    var rec={id:uid(),workerId:workerId,workerName:w?w.name:'',fabricId:fabricId,fabricName:f?(f.type+' — '+f.color):'',qty:Number(qty),kilos:Number(kilos),remarks:gv('f-remarks'),date:date,encodedBy:settings.username||'Admin',ts:nowISO()};
    var ok=await sbInsert('cutting_records',rec);
    if(ok){await addAudit('Created','cutting','Cutting — '+(w?w.name:'?')+' · '+qty+' units · '+Number(kilos).toFixed(1)+' kg');await dbReload();refreshAll();}
    closeModal(); showToast('Cutting saved. Fabric balance updated. ✓');
  }
  else if(type==='receiving'){
    var supplier=gv('f-supplier'); var item=gv('f-item'); var qty=gv('f-qty'); var date=gv('f-date');
    if(!supplier||!item||!qty||!date){showToast('Please fill in required fields.','err');return;}
    var rec={id:uid(),supplier:supplier,item:item,category:gv('f-category')||'Fabric',qty:Number(qty),unit:gv('f-unit')||'pcs',kilos:gv('f-kilos')?Number(gv('f-kilos')):null,cost:gv('f-cost')?Number(gv('f-cost')):null,receivedBy:gv('f-receivedby'),remarks:gv('f-remarks'),date:date,encodedBy:settings.username||'Admin',ts:nowISO()};
    var ok=await sbInsert('received_materials',rec);
    if(ok){await addAudit('Created','receiving','Received — '+item+' · '+qty+' from '+supplier);await dbReload();refreshAll();}
    closeModal(); showToast('Materials received and logged. ✓');
  }
  else if(type==='fabric'){
    var ftype=gv('f-type'); var color=gv('f-color'); var kilos=gv('f-kilos');
    if(!ftype||!color||!kilos){showToast('Please fill in Fabric type, Color and Kilos.','err');return;}
    var rec={id:uid(),type:ftype,color:color,supplier:gv('f-supplier'),totalKilos:Number(kilos),rolls:gv('f-rolls')?Number(gv('f-rolls')):null,date:gv('f-date')||todayStr(),ts:nowISO()};
    var ok=await sbInsert('fabric_inventory',rec);
    if(ok){await addAudit('Created','fabric','Fabric added — '+ftype+' '+color+' · '+kilos+' kg');await dbReload();refreshAll();}
    closeModal(); showToast('Fabric added to inventory. ✓');
  }
  else if(type==='batches'){
    var design=gv('f-design'); var qty=gv('f-qty'); var date=gv('f-date');
    if(!design||!qty||!date){showToast('Please fill in required fields.','err');return;}
    var existing=load('batches');
    var num=String(existing.length+1).padStart(3,'0');
    var code='PO-'+date.replace(/-/g,'')+'-'+num;
    var rec={id:uid(),code:code,design:design,qty:Number(qty),amount:gv('f-amount')?Number(gv('f-amount')):0,remarks:gv('f-remarks'),status:'Pending',date:date,generatedBy:settings.username||'Admin',ts:nowISO()};
    var ok=await sbInsert('production_batches',rec);
    if(ok){await addAudit('Created','batches','PO generated — '+code+' · '+design+' · '+qty+' units');await dbReload();refreshAll();}
    closeModal(); showToast('PO '+code+' generated. ✓');
  }
  else if(type==='payments'){
    var batchId=gv('f-batch'); var amount=gv('f-amount'); var method=gv('f-method'); var date=gv('f-date');
    if(!batchId||!amount||!date){showToast('Please fill in required fields.','err');return;}
    var allBatches=load('batches'); var b=allBatches.find(function(b){return b.id===batchId;});
    var rec={id:uid(),batchId:batchId,batchCode:b?b.code:'',amount:Number(amount),method:method,reference:gv('f-reference'),notes:gv('f-notes'),date:date,recordedBy:settings.username||'Admin',ts:nowISO()};
    var ok=await sbInsert('payment_records',rec);
    if(ok){await sbUpdate('production_batches',batchId,{status:'Paid'});await addAudit('Created','payments','Payment — '+(b?b.code:'?')+' · '+peso(amount)+' via '+method);await dbReload();refreshAll();}
    closeModal(); showToast('Payment recorded. '+(b?b.code:'PO')+' marked Paid. ✓','success');
  }
  else if(type==='workers'){
    var name=gv('f-name'); var dept=gv('f-dept');
    if(!name||!dept){showToast('Please enter worker name and department.','err');return;}
    var rec={id:uid(),name:name,dept:dept,ts:nowISO()};
    var ok=await sbInsert('workers',rec);
    if(ok){await addAudit('Created','workers','Worker added — '+name+' ('+dept+')');await dbReload();refreshAll();}
    closeModal(); showToast('Worker "'+name+'" added. ✓');
  }
}

// Quick pay from batches table
function quickPayModal(batchId){
  var batches=load('batches'); var b=batches.find(b=>b.id===batchId);
  if(!b)return;
  document.getElementById('mtitle').textContent=`Mark ${b.code} as paid`;
  document.getElementById('mbody').innerHTML=`
    <div style="background:var(--bg);border-radius:var(--r);padding:10px 12px;margin-bottom:14px;font-size:12px;color:var(--text2)">
      <div>PO: <strong style="color:var(--blue-text);font-family:var(--mono)">${esc(b.code)}</strong></div>
      <div>Design: ${esc(b.design)} · ${b.qty} units</div>
      <div>Amount due: <strong style="color:var(--amber-text);font-family:var(--mono)">${peso(b.amount)}</strong></div>
    </div>
    <div class="fgrid">
      <div class="fg"><label>Amount paid (₱) <span class="req">*</span></label><input class="fi" type="number" id="qp-amount" value="${b.amount||''}" step="0.01"></div>
      <div class="fg"><label>Payment date <span class="req">*</span></label><input class="fi" type="date" id="qp-date" value="${todayStr()}"></div>
      <div class="fg"><label>Method <span class="req">*</span></label><select class="fi" id="qp-method"><option>GCash</option><option>Maya</option><option>Bank transfer — BDO</option><option>Bank transfer — BPI</option><option>Cash</option><option>Other</option></select></div>
      <div class="fg"><label>Reference #</label><input class="fi" type="text" id="qp-ref" placeholder="Transaction reference"></div>
    </div>
    <div class="fa">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-g" onclick="quickPaySubmit('${batchId}')">Confirm payment</button>
    </div>`;
  document.getElementById('moverlay').classList.add('open');
}

async function quickPaySubmit(batchId){
  var amount=document.getElementById('qp-amount')?.value;
  var date=document.getElementById('qp-date')?.value;
  var method=document.getElementById('qp-method')?.value;
  var ref=document.getElementById('qp-ref')?.value;
  if(!amount||!date){showToast('Please fill in amount and date.','err');return;}
  var allBatches=load('batches'); var b=allBatches.find(function(x){return x.id===batchId;});
  var rec={id:uid(),batchId:batchId,batchCode:b?b.code:'',amount:Number(amount),method:method,reference:ref,date:date,recordedBy:settings.username||'Admin',ts:nowISO()};
  var ok=await sbInsert('payment_records',rec);
  if(ok){await sbUpdate('production_batches',batchId,{status:'Paid'});await addAudit('Created','payments','Payment — '+(b?b.code:'?')+' · '+peso(amount)+' via '+method);await dbReload();refreshAll();}
  closeModal(); showToast((b?b.code:'PO')+' marked as Paid. ✓','success');
}

// ═══════════════════════════════════════════════════════
//  DELETE
// ═══════════════════════════════════════════════════════
async function deleteRecord(key, id){
  if(!confirm('Delete this record? This cannot be undone.'))return;
  var tableMap={printing:'printing_records',pressing:'pressing_records',cutting:'cutting_records',receiving:'received_materials',fabric:'fabric_inventory',batches:'production_batches',payments:'payment_records',workers:'workers'};
  var tbl=tableMap[key];
  if(tbl) await sbDelete(tbl,id);
  await addAudit('Deleted',key,'Record deleted — ID: '+id);
  await dbReload(); refreshAll(); showToast('Record deleted.','warn');
}

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════
function setText(id,val){ var e=document.getElementById(id); if(e)e.textContent=val; }
function esc(s){ if(!s)return''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showToast(msg,type){
  var t=document.getElementById('toast');
  var icon=document.getElementById('toast-icon');
  t.className='toast show';
  if(type==='err'){t.classList.add('err');icon.textContent='✕';icon.style.color='var(--red-text)';}
  else if(type==='warn'){t.classList.add('warn');icon.textContent='⚠';icon.style.color='var(--amber-text)';}
  else{icon.textContent='✓';icon.style.color='var(--green-text)';}
  document.getElementById('toast-msg').textContent=msg;
  setTimeout(()=>t.classList.remove('show'),3800);
}

function populateWorkerFilter(elId, workers, dept){
  var el=document.getElementById(elId); if(!el)return;
  var cur=el.value;
  var opts=workers.map(w=>`<option value="${w.id}"${w.id===cur?' selected':''}>${esc(w.name)}</option>`).join('');
  el.innerHTML='<option value="">All workers</option>'+opts;
}

function updateOverdueBadge(){
  var batches=load('batches');
  var overdue=batches.filter(b=>b.status==='Overdue').length;
  var navEl=document.getElementById('nav-payments');
  if(navEl){
    var existing=navEl.querySelector('.nbadge');
    if(existing)existing.remove();
    if(overdue>0){var span=document.createElement('span');span.className='nbadge';span.textContent=overdue;navEl.appendChild(span);}
  }
}

// ═══════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════
function saveSettings(){
  settings.bizname=document.getElementById('set-bizname')?.value||settings.bizname;
  settings.username=document.getElementById('set-username')?.value||settings.username;
  updateUserUI();
  settings.lowstock=Number(document.getElementById('set-lowstock')?.value)||10;
  settings.overdue=Number(document.getElementById('set-overdue')?.value)||7;
  saveSettingsToLS();
  document.getElementById('user-chip').textContent=settings.username||'Admin';
  document.querySelector('.brand-name').textContent=settings.bizname||'ProdOps';
  showToast('Settings saved. ✓');
}

function loadSettingsUI(){
  // Show last backup time
  var lb=localStorage.getItem('last_backup_time');
  var el=document.getElementById('last-backup-time');
  if(el&&lb) el.textContent='Last: '+fmtDate(lb);
  loadSettings();
  var e;
  if(e=document.getElementById('set-bizname'))e.value=settings.bizname;
  if(e=document.getElementById('set-username'))e.value=settings.username;
  if(e=document.getElementById('set-lowstock'))e.value=settings.lowstock;
  if(e=document.getElementById('set-overdue'))e.value=settings.overdue;
  if(e=document.getElementById('user-chip'))e.textContent=settings.username||'Admin';
  if(e=document.querySelector('.brand-name'))e.textContent=settings.bizname||'ProdOps';
}

// ═══════════════════════════════════════════════════════
//  DATA EXPORT / IMPORT
// ═══════════════════════════════════════════════════════
function exportAllDataCSV(){
  // Export each accounting table as CSV
  [
    {key:'cashin',name:'CashIn'},
    {key:'expenses',name:'Expenses'},
    {key:'supplierpay',name:'SupplierPayments'}
  ].forEach(function(t){
    var data=aload(t.key);
    if(!data.length) return;
    var keys=Object.keys(data[0]);
    var rows=[keys].concat(data.map(function(r){return keys.map(function(k){return r[k]||''});}));
    downloadCSV(rows,'ProdOps_'+t.name+'_'+todayStr()+'.csv');
  });
  showToast('All accounting data exported as CSV ✓');
}

function exportAllData(){
  localStorage.setItem('last_backup_time', new Date().toISOString());
  var el=document.getElementById('last-backup-time');
  if(el) el.textContent='Last: '+fmtDate(new Date().toISOString());
  var allData={};
  Object.keys(KEYS).forEach(k=>allData[k]=load(k));
  allData.exportedAt=nowISO();
  var blob=new Blob([JSON.stringify(allData,null,2)],{type:'application/json'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url; a.download='ProdOps_Backup_'+todayStr()+'.json'; a.click();
  URL.revokeObjectURL(url);
  showToast('Data exported successfully. ✓');
}

function importData(input){
  var file=input.files[0]; if(!file)return;
  var reader=new FileReader();
  reader.onload=function(e){
    try{
      var d=JSON.parse(e.target.result);
      if(confirm('This will replace all current data with the backup. Continue?')){
        Object.keys(KEYS).forEach(k=>{if(d[k])save(k,d[k]);});
        refreshAll(); 

// ═══════════════════════════════════════════════════════
//  USER MANAGEMENT
// ═══════════════════════════════════════════════════════
async function renderUserMgmt(){
  var sb=getSB(); if(!sb) return;
  var tbody=document.getElementById('tbl-users');
  if(!tbody) return;
  tbody.innerHTML='<tr><td colspan="6"><div class="empty">Loading...</div></td></tr>';
  try{
    var res=await sb.from('app_users').select('*').order('created_at',{ascending:false});
    if(res.error){tbody.innerHTML='<tr><td colspan="6"><div class="empty">Error: '+res.error.message+'</div></td></tr>';return;}
    var users=res.data||[];
    if(!users.length){tbody.innerHTML='<tr><td colspan="6"><div class="empty">No users yet. Add your first user.</div></td></tr>';return;}
    var roleColors={admin:'bd',supervisor:'bpur',printing_staff:'bi',pressing_staff:'bi',cutting_staff:'bi',inventory_staff:'bs',accounting:'bw',viewer:'bg2'};
    tbody.innerHTML=users.map(function(u){
      return '<tr>'+
        '<td style="padding:10px 12px;font-weight:600">'+esc(u.full_name||'—')+'</td>'+
        '<td style="padding:10px 12px;color:var(--text2)">'+esc(u.email)+'</td>'+
        '<td style="padding:10px 12px"><span class="b '+(roleColors[u.role]||'bg2')+'">'+esc(u.role||'viewer')+'</span></td>'+
        '<td style="padding:10px 12px">'+(u.is_active?'<span class="b bs">Active</span>':'<span class="b bg2">Inactive</span>')+'</td>'+
        '<td style="padding:10px 12px;color:var(--text3);font-size:11px">'+(u.last_login?fmtDate(u.last_login):'Never')+'</td>'+
        '<td style="padding:10px 12px;display:flex;gap:6px">'+
          '<button class="btn btn-sm" onclick="editUserRole(\''+u.id+'\',\''+u.role+'\',\''+esc(u.full_name||u.email).replace(/'/g,'&#39;')+'\')">Edit role</button>'+
          (u.email!==currentUser?.email?'<button class="btn btn-d btn-sm" onclick="deactivateUser(\''+u.id+'\','+u.is_active+')">'+( u.is_active?'Deactivate':'Activate')+'</button>':'<span style="color:var(--text3);font-size:11px">Current user</span>')+
        '</td>'+
      '</tr>';
    }).join('');
  }catch(e){tbody.innerHTML='<tr><td colspan="6"><div class="empty">Error loading users.</div></td></tr>';}
}

function editUserRole(id, currentRole, name){
  var roles=['admin','supervisor','printing_staff','pressing_staff','cutting_staff','inventory_staff','accounting','viewer'];
  var opts=roles.map(function(r){return '<option value="'+r+'"'+(r===currentRole?' selected':'')+'>'+r.replace(/_/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();})+'</option>';}).join('');
  var html='<div style="margin-bottom:16px"><label style="display:block;font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">User: '+esc(name)+'</label>'+
    '<label style="display:block;font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px;margin-top:12px">Role</label>'+
    '<select class="fi" id="edit-role-sel">'+opts+'</select></div>'+
    '<div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="saveUserRole(\''+id+'\')">Save role</button></div>';
  document.getElementById('mtitle').textContent='Edit user role';
  document.getElementById('mbody').innerHTML=html;
  document.getElementById('moverlay').classList.add('open');
}

async function saveUserRole(id){
  var role=document.getElementById('edit-role-sel')?.value;
  if(!role) return;
  var sb=getSB();
  var res=await sb.from('app_users').update({role:role}).eq('id',id);
  if(res.error){showToast('Error: '+res.error.message,'err');return;}
  closeModal();renderUserMgmt();showToast('User role updated to '+role+' ✓');
}

async function deactivateUser(id, currentStatus){
  var action=currentStatus?'deactivate':'activate';
  if(!confirm('Are you sure you want to '+action+' this user?')) return;
  var sb=getSB();
  var res=await sb.from('app_users').update({is_active:!currentStatus}).eq('id',id);
  if(res.error){showToast('Error: '+res.error.message,'err');return;}
  renderUserMgmt();showToast('User '+action+'d ✓');
}

function buildNewUserForm(){
  var roles=['admin','supervisor','printing_staff','pressing_staff','cutting_staff','inventory_staff','accounting','viewer'];
  var opts=roles.map(function(r){return '<option value="'+r+'"'+(r==='printing_staff'?' selected':'')+'>'+r.replace(/_/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();})+'</option>';}).join('');
  return '<div class="fgrid">'+
    '<div class="fg"><label>Full name <span class="req">*</span></label><input class="fi" type="text" id="f-fullname" placeholder="Juan dela Cruz"></div>'+
    '<div class="fg"><label>Email address <span class="req">*</span></label><input class="fi" type="email" id="f-email" placeholder="staff@yourbusiness.com"></div>'+
    '<div class="fg"><label>Temporary password <span class="req">*</span></label><input class="fi" type="text" id="f-temppass" placeholder="Min. 6 characters" value="ProdOps2026!"></div>'+
    '<div class="fg"><label>Role / Position <span class="req">*</span></label><select class="fi" id="f-role">'+opts+'</select></div>'+
  '</div>'+
  '<div class="alert-info" style="padding:10px;margin-bottom:12px;border-radius:8px;line-height:1.45">✅ Admin-only: this creates a login account and assigns the selected role. Share the temporary password with your staff. If Supabase email confirmation is ON, staff must confirm their email first before logging in.</div>'+
  '<div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" id="btn-create-user" onclick="createNewUser()">Create user</button></div>';
}

function getSignupClient(){
  // Separate temporary Supabase client so creating a staff account will NOT log out the admin.
  if(!window.supabase) return null;
  return window.supabase.createClient(SUPA_URL, SUPA_ANON, {
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:'prodops-staff-create-temp'},
    global:{headers:{'X-Client-Info':'prodops/user-admin'}}
  });
}

async function createNewUser(){
  if(currentRole !== 'admin'){showToast('Only admin can create users.','err');return;}
  var name=gv('f-fullname').trim(),email=gv('f-email').trim().toLowerCase(),pass=gv('f-temppass'),role=gv('f-role');
  if(!name||!email||!pass){showToast('Fill in all required fields.','err');return;}
  if(!/^\S+@\S+\.\S+$/.test(email)){showToast('Enter a valid email address.','err');return;}
  if(pass.length<6){showToast('Password must be at least 6 characters.','err');return;}
  var btn=document.getElementById('btn-create-user');
  if(btn){btn.disabled=true;btn.textContent='Creating...';}
  try{
    var adminSb=getSB();
    var signupSb=getSignupClient();
    if(!adminSb||!signupSb){showToast('Supabase is not ready. Refresh and try again.','err');return;}
    var res=await signupSb.auth.signUp({email:email,password:pass,options:{data:{full_name:name,role:role}}});
    if(res.error){
      var msg=res.error.message||'Unknown error';
      if(msg.toLowerCase().includes('already')) msg='This email already exists. Edit the role instead, or use another email.';
      showToast('Error creating login: '+msg,'err');return;
    }
    var newUserId=(res.data&&res.data.user&&res.data.user.id)?res.data.user.id:uid();
    var up=await adminSb.from('app_users').upsert([{id:newUserId,email:email,full_name:name,role:role,is_active:true,created_at:nowISO()}],{onConflict:'email'});
    if(up.error){showToast('Login created, but role save failed: '+up.error.message,'err');return;}
    closeModal(); await renderUserMgmt(); showToast('User created: '+name+' — '+role+' ✓');
  }catch(e){console.error(e);showToast('Error creating user. Check console or Supabase settings.','err');}
  finally{if(btn){btn.disabled=false;btn.textContent='Create user';}}
}

// Add to TITLES and nav handler
TITLES['usermgmt']='User Management';

// ═══════════════════════════════════════════════════════
//  MIGRATE LOCAL STORAGE DATA TO SUPABASE
// ═══════════════════════════════════════════════════════
async function migrateToSupabase(){
  var statusEl = document.getElementById('migrate-status');
  statusEl.innerHTML = '<div class="alert alert-info">Starting migration... please wait.</div>';

  var oldKeys = {
    printing:'po_printing', pressing:'po_pressing', cutting:'po_cutting',
    receiving:'po_receiving', fabric:'po_fabric', batches:'po_batches',
    payments:'po_payments', workers:'po_workers'
  };
  var accOldKeys = {cashin:'acc_cashin', expenses:'acc_expenses', supplierpay:'acc_supplierpay'};

  var tableMap = {
    printing:'printing_records', pressing:'pressing_records',
    cutting:'cutting_records', receiving:'received_materials',
    fabric:'fabric_inventory', batches:'production_batches',
    payments:'payment_records', workers:'workers'
  };
  var accTableMap = {cashin:'cash_in', expenses:'expenses', supplierpay:'supplier_payments'};

  var results = [];
  var totalMigrated = 0;

  // Migrate production tables
  for(var key in oldKeys){
    try{
      var raw = localStorage.getItem(oldKeys[key]);
      if(!raw) continue;
      var records = JSON.parse(raw);
      if(!records || !records.length) continue;
      statusEl.innerHTML = '<div class="alert alert-info">Migrating '+key+' ('+records.length+' records)...</div>';
      var n = await sbBulkInsert(tableMap[key], records);
      results.push({key:key, count:records.length, ok:n>0});
      if(n>0) totalMigrated += records.length;
    }catch(e){
      results.push({key:key, count:0, ok:false, err:e.message});
    }
  }

  // Migrate accounting tables
  for(var key in accOldKeys){
    try{
      var raw = localStorage.getItem(accOldKeys[key]);
      if(!raw) continue;
      var records = JSON.parse(raw);
      if(!records || !records.length) continue;
      statusEl.innerHTML = '<div class="alert alert-info">Migrating accounting: '+key+' ('+records.length+' records)...</div>';
      var n = await sbBulkInsert(accTableMap[key], records);
      results.push({key:'acc_'+key, count:records.length, ok:n>0});
      if(n>0) totalMigrated += records.length;
    }catch(e){
      results.push({key:'acc_'+key, count:0, ok:false, err:e.message});
    }
  }

  // Show results
  var html = '<div style="background:var(--green-bg);border:1px solid rgba(34,201,139,.2);border-radius:8px;padding:12px;margin-top:8px">';
  html += '<div style="font-weight:600;color:var(--green-text);margin-bottom:8px">✓ Migration complete — '+totalMigrated+' total records uploaded</div>';
  results.forEach(function(r){
    html += '<div style="font-size:11.5px;color:var(--text2);padding:2px 0">'+(r.ok?'✓':'✗')+' '+r.key+': '+r.count+' records'+(r.err?' ('+r.err+')':'')+'</div>';
  });
  html += '</div>';

  if(totalMigrated === 0){
    html = '<div class="alert alert-warn">No local data found to migrate. Either data is already in Supabase or this browser has no stored records.</div>';
  }

  statusEl.innerHTML = html;

  // Reload from Supabase and refresh
  await dbReload();
  refreshAll();
  showToast('Migration complete! '+totalMigrated+' records now in Supabase. ✓');
}

loadSettingsUI();
        showToast('Data restored from backup. ✓');
      }
    }catch(err){showToast('Invalid backup file.','err');}
  };
  reader.readAsText(file);
  input.value='';
}

function clearAllData(){
  if(!confirm('This will DELETE ALL data permanently. Are you absolutely sure?'))return;
  if(!confirm('Last chance — all records, workers, POs, payments will be gone. Confirm?'))return;
  Object.values(KEYS).forEach(k=>localStorage.removeItem(k));
  refreshAll(); showToast('All data cleared.','warn');
}

function exportReportCSV(){
  var printing=load('printing'); var pressing=load('pressing'); var cutting=load('cutting');
  var rows=[['Type','Date','Worker','Design/Item','Qty','Remarks','Encoded By','Timestamp']];
  [...printing.map(r=>['Printing',r.date,r.workerName,r.design,r.qty,r.remarks,r.encodedBy,r.ts]),
   ...pressing.map(r=>['Pressing',r.date,r.workerName,r.design,r.qty,r.remarks,r.encodedBy,r.ts]),
   ...cutting.map(r=>['Cutting',r.date,r.workerName,r.fabricName,r.qty,r.remarks,r.encodedBy,r.ts])
  ].forEach(r=>rows.push(r));
  downloadCSV(rows,'ProdOps_Productivity_'+todayStr()+'.csv');
}

function exportAuditCSV(){
  var data=load('audit');
  var rows=[['Timestamp','User','Action','Module','Detail']];
  data.forEach(l=>rows.push([l.ts,l.user,l.action,l.module,l.detail]));
  downloadCSV(rows,'ProdOps_AuditLog_'+todayStr()+'.csv');
}

function exportPOCSV(){
  var batches=load('batches'); var payments=load('payments');
  var rows=[['PO Code','Design','Qty','Amount','Status','Date','Generated By']];
  batches.forEach(b=>rows.push([b.code,b.design,b.qty,b.amount,b.status,b.date,b.generatedBy]));
  downloadCSV(rows,'ProdOps_POs_'+todayStr()+'.csv');
}

function downloadCSV(rows,filename){
  var csv=rows.map(r=>r.map(c=>'"'+(String(c||'').replace(/"/g,'""'))+'"').join(',')).join('\n');
  var blob=new Blob([csv],{type:'text/csv'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url; a.download=filename; a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported. ✓');
}

// ═══════════════════════════════════════════════════════
//  CLOCK
// ═══════════════════════════════════════════════════════
function updateClock(){
  var e=document.getElementById('clock');
  if(e) e.textContent=new Date().toLocaleString('en-PH',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

// ═══════════════════════════════════════════════════════
//  MODAL CLOSE
// ═══════════════════════════════════════════════════════
document.getElementById('moverlay').addEventListener('click',function(e){
  if(e.target===this)closeModal();
});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape')closeModal();
});

// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════
loadSettingsUI();
updateUserUI();

// ── AUTH CHECK ──────────────────────────────────────────
// Check if user is logged in before showing the app
async function checkAuth(){
  var sb = getSB();
  if(!sb){ setTimeout(checkAuth, 500); return false; }
  var res = await sb.auth.getSession();
  if(!res.data || !res.data.session){
    await new Promise(function(resolve){ setTimeout(resolve, 800); });
    res = await sb.auth.getSession();
  }
  if(!res.data || !res.data.session){
    window.location.replace('./login.html');
    return false;
  }
  // User is logged in
  currentUser = res.data.session.user;
  console.log('Logged in as:', currentUser.email);
  
  // Load user role from app_users table
  await loadUserRole(currentUser.email);
  
  // Update UI with user info
  var name = currentUser.user_metadata?.full_name || currentUser.email.split('@')[0];
  settings.username = name;
  var initials = name.split(' ').map(function(w){return w[0]||'';}).join('').toUpperCase().slice(0,2)||'AD';
  var av = document.getElementById('user-avatar');
  var chip = document.getElementById('user-chip');
  if(av) av.textContent = initials;
  if(chip) chip.textContent = name;
  
  // Update role badge in topbar
  var roleEl = document.getElementById('user-role-badge');
  if(roleEl){
    roleEl.textContent = currentRole.charAt(0).toUpperCase()+currentRole.slice(1);
    var colors = {admin:'#dc2626',supervisor:'#7c3aed',encoder:'#2563eb',staff:'#059669',accounting:'#d97706',viewer:'#6b7280'};
    roleEl.style.color = colors[currentRole]||'#6b7280';
  }
  
  // Apply role restrictions to sidebar
  applyRoleRestrictions();
}

async function loadUserRole(email){
  var sb = getSB();
  if(!sb) return;
  try{
    var res = await sb.from('app_users').select('role,full_name').eq('email', email).single();
    if(res.data){
      currentRole = res.data.role || 'viewer';
      if(res.data.full_name) settings.username = res.data.full_name;
      console.log('User role:', currentRole);
    } else {
      // Owner fallback: your main email stays admin even if app_users row is missing
      if(String(email).toLowerCase()==='edwwardcanete@gmail.com'){
        currentRole = 'admin';
        settings.username = 'Admin';
        try{ await sb.from('app_users').upsert([{id:currentUser?.id,email:email,full_name:'Admin',role:'admin',is_active:true,created_at:nowISO()}]); }catch(_e){}
      } else {
        // First time user — default to viewer, admin needs to assign role
        currentRole = 'viewer';
        console.log('No role found for', email, '— defaulting to viewer');
      }
    }
  }catch(e){
    console.error('Error loading user role:', e);
    currentRole = 'viewer';
  }
}

async function dbGetUserRole(email){
  return currentRole;
}

function applyRoleRestrictions(){
  // Reset then hide nav items user cannot access
  document.querySelectorAll('.nv').forEach(function(el){
    el.style.display = '';
    var onclick = el.getAttribute('onclick')||'';
    var match = onclick.match(/nav\(['"]([^'"]+)['"]/);
    if(match){
      var panel = match[1];
      if(!canAccess(panel)){
        el.style.display = 'none';
      }
    }
  });

  // Hide section headers when all items in that section are hidden
  document.querySelectorAll('.nav-sec').forEach(function(sec){
    var next = sec.nextElementSibling, hasVisible = false;
    while(next && !next.classList.contains('nav-sec')){
      if(next.classList && next.classList.contains('nv') && next.style.display !== 'none'){
        hasVisible = true;
        break;
      }
      next = next.nextElementSibling;
    }
    sec.style.display = hasVisible ? '' : 'none';
  });

  // Mobile nav restrictions
  var mnFinance=document.getElementById('mn-finance'); if(mnFinance) mnFinance.style.display = canAccess('accdashboard') ? '' : 'none';
  var mnReports=document.getElementById('mn-reports'); if(mnReports) mnReports.style.display = canAccess('reports') ? '' : 'none';
  var mnMore=document.getElementById('mn-more'); if(mnMore) mnMore.style.display = canAccess('settings') ? '' : 'none';
}

function doLogout(){
  var sb = getSB();
  if(sb){ sb.auth.signOut().then(function(){ window.location.href='./login.html'; }); }
  else { window.location.href='./login.html'; }
}

// Initialize Supabase - try multiple times to handle slow CDN loading
function tryInitSB(attempts){
  if(window.supabase){
    initSB();
    console.log('Supabase library loaded OK');
  } else if(attempts > 0){
    console.log('Waiting for Supabase CDN... attempts left:',attempts);
    setTimeout(function(){ tryInitSB(attempts-1); }, 500);
  } else {
    console.error('Supabase CDN failed to load after all retries');
    showToast('Database library failed to load. Try refreshing.','err');
  }
}
tryInitSB(10); // Try up to 10 times (5 seconds total)
// Initial load from Supabase
function renderAll(){
  renderDashboard();
  renderPrinting(); renderPressing(); renderCutting();
  renderReceiving(); renderFabric(); renderBatches();
  renderPayments(); renderWorkers(); renderAudit();
  updateOverdueBadge();
  renderAccDashboard();
  renderCashIn();
  renderExpenses();
  renderSupplierPay();
}

function startApp(){
  dbReload().then(function(){
    renderAll();
    // Auto-refresh every 15 seconds
    setInterval(function(){
      dbReload().then(function(){ renderAll(); });
    }, 15000);
  });
  return true;
}

// Wait for Supabase to be ready then start app
function waitAndStart(tries){
  if(getSB()){
    console.log('Starting app with Supabase ready');
    // Check auth first, then start app
    checkAuth().then(function(ok){
      if(ok) startApp();
    });
  } else if(tries > 0){
    setTimeout(function(){ waitAndStart(tries-1); }, 500);
  } else {
    console.error('Could not connect to Supabase after waiting');
    showToast('Cannot connect to database. Check internet connection.','err');
    // Still render UI even without data
    renderAll();
  }
}
waitAndStart(20); // Wait up to 10 seconds
updateClock();
setInterval(updateClock,60000);

// Mobile sidebar toggle
function toggleSidebar(){
  var s=document.querySelector('.sidebar');
  var o=document.getElementById('mob-overlay');
  if(s) s.classList.toggle('open');
  if(o) o.classList.toggle('show');
}
function closeSidebar(){
  var s=document.querySelector('.sidebar');
  var o=document.getElementById('mob-overlay');
  if(s) s.classList.remove('open');
  if(o) o.classList.remove('show');
}
function setMobileNav(id){
  document.querySelectorAll('.mn-item').forEach(function(b){b.classList.remove('on');});
  var el=document.getElementById(id);
  if(el) el.classList.add('on');
}
// Close sidebar on nav item click (mobile)
document.querySelectorAll('.nv').forEach(function(el){
  el.addEventListener('click',function(){
    if(window.innerWidth<=768) closeSidebar();
  });
});
// Update user avatar initials from settings
function updateUserUI(){
  var name=settings.username||'Admin';
  var initials=name.split(' ').map(function(w){return w[0]||'';}).join('').toUpperCase().slice(0,2)||'AD';
  var av=document.getElementById('user-avatar');
  var chip=document.getElementById('user-chip');
  var bn=document.getElementById('brand-name');
  if(av) av.textContent=initials;
  if(chip) chip.textContent=name;
  if(bn) bn.textContent=settings.bizname||'ProdOps';
}
setTimeout(function(){
  var sb=getSB();
  if(sb){
    // Test connection with a simple query
    sb.from('workers').select('count',{count:'exact',head:true}).then(function(res){
      if(res.error){
        showToast('Database connection error: '+res.error.message,'err');
        console.error('DB test failed:',res.error);
      } else {
        showToast('Connected to ProdOps database ✓');
        console.log('DB connection verified OK');
      }
    });
  } else {
    showToast('Supabase library not loaded. Check internet connection.','err');
  }
},2000);

// ═══════════════════════════════════════════════════════
//  ACCOUNTING — DATA KEYS
// ═══════════════════════════════════════════════════════
// ACCK removed - now using Supabase cache via _cache['acc_'+k]
// aload() and asave() are defined in the main data store section above

var EXP_SUBCATS={
  'Direct Cost':['Fabric','Ink','Subli Paper','Garter','Lace','Eyelet','Black Pouch','Sticker','Individual Plastic','Waybill','Packaging Tape','Shrinkage','Other Direct Cost'],
  'Indirect Cost':['Labor Sewer','Transportation','Waybill','Packaging Tape','Shrinkage','Other Indirect Cost'],
  'Opex':['Marketing Ads','Rent','Electricity','Internet','Water','Salary','Printer Maintenance','Transportation','Office Supplies','Repair & Maintenance','Admin & Compliance','Software & Apps','Loans','DDC Fee','Other Opex'],
  'Liabilities':['Loans','Tax','Admin & Compliance','Other Liabilities']
};
var BANKS=['Seabank','Go Tyme','Cash','G-Cash','UnionBank','GoTyme Edward','DDC Fee','Security Bank'];

// ═══════════════════════════════════════════════════════
//  ACCOUNTING DASHBOARD
// ═══════════════════════════════════════════════════════
function renderAccDashboard(){
  var month=document.getElementById('acc-dash-month')?.value||'';
  var ci=aload('cashin'); var exp=aload('expenses'); var sp=aload('supplierpay');
  if(month){ci=ci.filter(r=>r.date&&r.date.startsWith(month));exp=exp.filter(r=>r.date&&r.date.startsWith(month));}
  var totalCI=ci.reduce((s,r)=>s+parseFloat(r.amount||0),0);
  var totalExp=exp.reduce((s,r)=>s+parseFloat(r.amount||0),0);
  var netProfit=totalCI-totalExp;
  console.log('AccDashboard: ci rows=',ci.length,'totalCI=',totalCI,'exp rows=',exp.length);
  var pendingSP=sp.filter(r=>r.status!=='Paid').reduce((s,r)=>s+Number(r.amount||0),0);
  setText('acc-total-cashin',peso(totalCI));
  setText('acc-total-exp',peso(totalExp));
  var npEl=document.getElementById('acc-net-profit');
  if(npEl){npEl.textContent=peso(netProfit);npEl.style.color=netProfit>=0?'var(--green-text)':'var(--red-text)';}
  setText('acc-pending-pay',peso(pendingSP));
  // New KPIs
  var totalQty=ci.reduce(function(s,r){return s+Number(r.qty||0);},0);
  setText('acc-total-qty',totalQty);
  // Avg daily sales
  var uniqueDays=[...new Set(ci.map(function(r){return r.date;}))].length;
  var avgDaily=uniqueDays>0?totalCI/uniqueDays:0;
  setText('acc-avg-daily',peso(avgDaily));
  // Render daily line chart
  renderDailyChart(aload('cashin'), month);

  // Cash in breakdown
  var platforms=['TikTok','Shopee','Website','Walk-in'];
  var ciBreak=document.getElementById('acc-cashin-breakdown');
  var ciTotals=platforms.map(p=>({p,v:ci.filter(r=>r.platform===p).reduce((s,r)=>s+Number(r.amount||0),0)}));
  ciBreak.innerHTML=ciTotals.map(({p,v})=>`
    <div class="sr"><span style="color:var(--text2)">${p}</span><span style="font-family:var(--mono);font-weight:600;color:var(--green-text)">${peso(v)}</span></div>`).join('');
  drawDonut('chart-cashin',ciTotals.map(x=>x.p),ciTotals.map(x=>x.v),['#22c98b','#f0a832','#4f7cff','#a78bfa']);

  // Expenses breakdown by category
  var cats=['Direct Cost','Indirect Cost','Opex','Liabilities'];
  var expBreak=document.getElementById('acc-exp-breakdown');
  var expTotals=cats.map(c=>({c,v:exp.filter(r=>r.category===c).reduce((s,r)=>s+Number(r.amount||0),0)}));
  expBreak.innerHTML=expTotals.map(({c,v})=>`
    <div class="sr"><span style="color:var(--text2)">${c}</span><span style="font-family:var(--mono);font-weight:600;color:var(--red-text)">${peso(v)}</span></div>`).join('');
  drawDonut('chart-exp',expTotals.map(x=>x.c),expTotals.map(x=>x.v),['#f05252','#f0a832','#4f7cff','#a78bfa']);

  // Pending supplier POs
  var today=new Date();
  var pending=sp.map(p=>{
    var due=new Date(p.dueDate);
    var overdue=p.status!=='Paid'&&due<today;
    return{...p,overdue};
  }).filter(p=>p.status!=='Paid').sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate));
  var ptbl=document.getElementById('acc-pending-tbl');
  if(!pending.length){ptbl.innerHTML='<tr><td colspan="8"><div class="empty">No pending supplier payments.</div></td></tr>';return;}
  ptbl.innerHTML=pending.map(p=>`
    <tr>
      <td style="padding:8px 9px" class="mono">${fmtDate(p.dateReceived)}</td>
      <td style="padding:8px 9px;font-weight:600;color:var(--blue-text)">${esc(p.poNumber)}</td>
      <td style="padding:8px 9px">${fmtDate(p.dueDate)}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${p.totalQty}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700">${peso(p.amount)}</td>
      <td style="padding:8px 9px">${p.timeline}</td>
      <td style="padding:8px 9px">${p.overdue?badge('danger','Overdue'):badge('warning','Pending')}</td>
    </tr>`).join('');
}

function drawDonut(canvasId,labels,values,colors){
  var canvas=document.getElementById(canvasId);
  if(!canvas)return;
  var ctx=canvas.getContext('2d');
  var total=values.reduce((s,v)=>s+v,0);
  if(!total){ctx.clearRect(0,0,canvas.width,canvas.height);return;}
  var cx=canvas.width/2,cy=canvas.height/2,r=Math.min(cx,cy)-10,inner=r*0.55;
  var start=-Math.PI/2;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  values.forEach((v,i)=>{
    if(!v)return;
    var slice=(v/total)*2*Math.PI;
    ctx.beginPath();ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,start,start+slice);
    ctx.closePath();ctx.fillStyle=colors[i%colors.length];ctx.fill();
    start+=slice;
  });
  ctx.beginPath();ctx.arc(cx,cy,inner,0,2*Math.PI);
  ctx.fillStyle='#161b27';ctx.fill();
  ctx.fillStyle='#e8eaf0';ctx.font='bold 13px IBM Plex Sans';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(peso(total),cx,cy);
}

// ═══════════════════════════════════════════════════════
//  CASH IN
// ═══════════════════════════════════════════════════════
function renderCashIn(){
  var data=aload('cashin');
  console.log('renderCashIn: data length=',data.length, 'first row=',JSON.stringify(data[0]||{}));
  var fp=document.getElementById('f-ci-platform')?.value;
  var ff=document.getElementById('f-ci-from')?.value;
  var ft=document.getElementById('f-ci-to')?.value;
  // Only filter if actual date values are entered (not placeholder)
  var filtered=data.filter(r=>{
    if(fp&&r.platform!==fp)return false;
    if(ff&&ff.match(/\d{4}-\d{2}-\d{2}/)&&r.date&&r.date<ff)return false;
    if(ft&&ft.match(/\d{4}-\d{2}-\d{2}/)&&r.date&&r.date>ft)return false;
    return true;
  });
  console.log('renderCashIn filtered:',filtered.length,'of',data.length,'platform filter:',fp||'none');
  // Parse amounts safely - Supabase may return numeric as string
  filtered = filtered.map(function(r){
    return Object.assign({}, r, {
      amount: parseFloat(r.amount)||0,
      qty: parseFloat(r.qty)||0
    });
  });
  ['TikTok','Shopee','Website','Walk-in'].forEach(p=>{
    var id={'TikTok':'ci-tiktok','Shopee':'ci-shopee','Website':'ci-website','Walk-in':'ci-walkin'}[p];
    setText(id,peso(filtered.filter(r=>r.platform===p).reduce((s,r)=>s+r.amount,0)));
  });
  setText('ci-total',peso(filtered.reduce((s,r)=>s+r.amount,0)));
  setText('ci-qty',filtered.reduce((s,r)=>s+r.qty,0));
  var tbody=document.getElementById('tbl-cashin');
  if(!filtered.length){tbody.innerHTML='<tr><td colspan="10"><div class="empty">No cash in records found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(r=>`
    <tr>
      <td style="padding:8px 9px" class="mono">${r.date||fmtDate(r.ts)}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700;color:var(--green-text)">${peso(parseFloat(r.amount||0))}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${r.qty||'—'}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${r.holdingTax?peso(r.holdingTax):'—'}</td>
      <td style="padding:8px 9px">${badge('success',r.platform)}</td>
      <td style="padding:8px 9px">${esc(r.bank||'—')}</td>
      <td style="padding:8px 9px">${esc(r.processBy||'—')}</td>
      <td style="padding:8px 9px">${r.status?badge('success',r.status):badge('warning','Pending')}</td>
      <td style="padding:8px 9px;color:var(--text2)">${esc(r.notes||'—')}</td>
      <td style="padding:8px 9px"><button class="btn btn-d btn-sm" onclick="delAccRec('cashin','${r.id}')">Del</button></td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════════
//  EXPENSES
// ═══════════════════════════════════════════════════════
function renderExpenses(){
  var data=aload('expenses');
  var fc=document.getElementById('f-exp-cat')?.value;
  var fs=document.getElementById('f-exp-subcat')?.value;
  var ff=document.getElementById('f-exp-from')?.value;
  var ft=document.getElementById('f-exp-to')?.value;
  // Populate subcat filter
  var subcatSel=document.getElementById('f-exp-subcat');
  if(subcatSel&&fc&&EXP_SUBCATS[fc]){
    var cur=subcatSel.value;
    subcatSel.innerHTML='<option value="">All sub-categories</option>'+EXP_SUBCATS[fc].map(s=>`<option value="${s}"${s===cur?' selected':''}>${s}</option>`).join('');
  }
  var filtered=data.filter(r=>{
    if(fc&&r.category!==fc)return false;
    if(fs&&r.subCategory!==fs)return false;
    if(ff&&r.date<ff)return false;
    if(ft&&r.date>ft)return false;
    return true;
  });
  var cogs=data.filter(r=>r.category==='Direct Cost').reduce((s,r)=>s+Number(r.amount||0),0);
  var opex=data.filter(r=>r.category==='Opex').reduce((s,r)=>s+Number(r.amount||0),0);
  setText('exp-cogs',peso(cogs));
  setText('exp-opex',peso(opex));
  setText('exp-total',peso(data.reduce((s,r)=>s+Number(r.amount||0),0)));
  setText('exp-count',filtered.length);
  var tbody=document.getElementById('tbl-expenses');
  if(!filtered.length){tbody.innerHTML='<tr><td colspan="11"><div class="empty">No expense records found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(r=>`
    <tr>
      <td style="padding:8px 9px" class="mono">${fmtDate(r.ts)}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700;color:var(--red-text)">${peso(r.amount)}</td>
      <td style="padding:8px 9px">${badge('info',r.category)}</td>
      <td style="padding:8px 9px">${esc(r.subCategory||'—')}</td>
      <td style="padding:8px 9px">${esc(r.description||'—')}</td>
      <td style="padding:8px 9px">${esc(r.paidTo||'—')}</td>
      <td style="padding:8px 9px">${r.status?badge('success','Paid'):badge('warning','Pending')}</td>
      <td style="padding:8px 9px">${esc(r.processBy||'—')}</td>
      <td style="padding:8px 9px">${esc(r.bank||'—')}</td>
      <td style="padding:8px 9px;color:var(--text2)">${esc(r.notes||'—')}</td>
      <td style="padding:8px 9px"><button class="btn btn-d btn-sm" onclick="delAccRec('expenses','${r.id}')">Del</button></td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════════
//  SUPPLIER PAYMENTS
// ═══════════════════════════════════════════════════════
function renderSupplierPay(){
  var data=aload('supplierpay');
  var today=new Date();
  // Auto-update overdue
  data=data.map(p=>{if(p.status!=='Paid'&&new Date(p.dueDate)<today)p.status='Overdue';return p;});
  asave('supplierpay',data);
  var fs=document.getElementById('f-sp-status')?.value;
  var fsp=document.getElementById('f-sp-supplier')?.value;
  // Populate supplier filter
  var spSel=document.getElementById('f-sp-supplier');
  if(spSel){var suppliers=[...new Set(data.map(p=>p.supplier))];var cur=spSel.value;spSel.innerHTML='<option value="">All suppliers</option>'+suppliers.map(s=>`<option value="${esc(s)}"${s===cur?' selected':''}>${esc(s)}</option>`).join('');}
  var filtered=data.filter(p=>{if(fs&&p.status!==fs)return false;if(fsp&&p.supplier!==fsp)return false;return true;});
  var pending=data.filter(p=>p.status!=='Paid');
  var overdue=data.filter(p=>p.status==='Overdue');
  setText('sp-pending',peso(pending.reduce((s,p)=>s+Number(p.amount||0),0)));
  setText('sp-overdue',peso(overdue.reduce((s,p)=>s+Number(p.amount||0),0)));
  setText('sp-overdue-count',overdue.length+' POs');
  setText('sp-paid',peso(data.filter(p=>p.status==='Paid').reduce((s,p)=>s+Number(p.amount||0),0)));
  var tbody=document.getElementById('tbl-supplierpay');
  if(!filtered.length){tbody.innerHTML='<tr><td colspan="10"><div class="empty">No supplier POs found.</div></td></tr>';return;}
  tbody.innerHTML=filtered.map(p=>`
    <tr>
      <td style="padding:8px 9px" class="mono">${fmtDate(p.dateReceived)}</td>
      <td style="padding:8px 9px;font-weight:600;color:var(--blue-text)">${esc(p.poNumber)}</td>
      <td style="padding:8px 9px">${esc(p.supplier)}</td>
      <td style="padding:8px 9px;font-family:var(--mono)">${p.totalQty}</td>
      <td style="padding:8px 9px;font-family:var(--mono);font-weight:700">${peso(p.amount)}</td>
      <td style="padding:8px 9px">${esc(p.timeline)}</td>
      <td style="padding:8px 9px" class="mono">${fmtDate(p.dueDate)}</td>
      <td style="padding:8px 9px">${p.status==='Paid'?badge('success','Paid'):p.status==='Overdue'?badge('danger','Overdue'):badge('warning','Pending')}</td>
      <td style="padding:8px 9px;color:var(--text2)">${esc(p.notes||'—')}</td>
      <td style="padding:8px 9px;display:flex;gap:5px">
        ${p.status!=='Paid'?`<button class="btn btn-g btn-sm" onclick="markSupplierPaid('${p.id}')">Mark paid</button>`:''}
        <button class="btn btn-d btn-sm" onclick="delAccRec('supplierpay','${p.id}')">Del</button>
      </td>
    </tr>`).join('');
}

async function markSupplierPaid(id){
  await sbUpdate('supplier_payments',id,{status:'Paid'});
  await addAudit('Updated','supplierpay','Supplier PO marked paid — ID: '+id);
  await dbReload();renderSupplierPay();renderAccDashboard();
  showToast('Supplier PO marked as paid. ✓');
}

// ═══════════════════════════════════════════════════════
//  PROFIT & LOSS
// ═══════════════════════════════════════════════════════
function renderPandL(){
  var from=document.getElementById('pl-from')?.value;
  var to=document.getElementById('pl-to')?.value;
  if(!from||!to){showToast('Please select both From and To dates.','err');return;}
  var ci=aload('cashin').filter(r=>r.date>=from&&r.date<=to);
  var exp=aload('expenses').filter(r=>r.date>=from&&r.date<=to);
  var totalCI=ci.reduce((s,r)=>s+Number(r.amount||0),0);
  var cats=['Direct Cost','Indirect Cost','Opex','Liabilities'];
  var expByCat=cats.map(c=>({c,v:exp.filter(r=>r.category===c).reduce((s,r)=>s+Number(r.amount||0),0)}));
  var totalExp=exp.reduce((s,r)=>s+Number(r.amount||0),0);
  var grossProfit=totalCI-expByCat.find(x=>x.c==='Direct Cost').v;
  var netProfit=totalCI-totalExp;
  var el=document.getElementById('pl-output');
  el.innerHTML=`
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:600;color:var(--text2);margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em">
        Profit & Loss Report — ${fmtDate(from+'T00:00:00')} to ${fmtDate(to+'T00:00:00')}
      </div>
      <div class="sr"><span style="font-weight:600">REVENUE</span><span></span></div>
      ${['TikTok','Shopee','Website','Walk-in'].map(p=>{var v=ci.filter(r=>r.platform===p).reduce((s,r)=>s+Number(r.amount||0),0);return v?`<div class="sr"><span style="color:var(--text2);padding-left:16px">${p}</span><span style="font-family:var(--mono)">${peso(v)}</span></div>`:''}).join('')}
      <div class="sr" style="border-top:1px solid var(--border2);margin-top:4px"><span style="font-weight:600">Total Revenue</span><span style="font-family:var(--mono);font-weight:700;color:var(--green-text)">${peso(totalCI)}</span></div>
      <div style="height:12px"></div>
      <div class="sr"><span style="font-weight:600">COST OF GOODS SOLD</span><span></span></div>
      ${exp.filter(r=>r.category==='Direct Cost').map(r=>`<div class="sr"><span style="color:var(--text2);padding-left:16px">${esc(r.subCategory||r.description||'—')}</span><span style="font-family:var(--mono)">${peso(r.amount)}</span></div>`).join('')||'<div class="sr"><span style="color:var(--text3);padding-left:16px">No direct costs recorded</span><span>₱0.00</span></div>'}
      <div class="sr" style="border-top:1px solid var(--border2);margin-top:4px"><span style="font-weight:600">Gross Profit</span><span style="font-family:var(--mono);font-weight:700;color:${grossProfit>=0?'var(--green-text)':'var(--red-text)'}">${peso(grossProfit)}</span></div>
      <div style="height:12px"></div>
      <div class="sr"><span style="font-weight:600">OPERATING EXPENSES</span><span></span></div>
      ${expByCat.filter(x=>x.c!=='Direct Cost').map(({c,v})=>v?`<div class="sr"><span style="color:var(--text2);padding-left:16px">${c}</span><span style="font-family:var(--mono)">${peso(v)}</span></div>`:'').join('')}
      <div class="sr" style="border-top:1px solid var(--border2);margin-top:4px"><span style="font-weight:600">Total Expenses</span><span style="font-family:var(--mono);font-weight:700;color:var(--red-text)">${peso(totalExp)}</span></div>
      <div style="height:12px"></div>
      <div class="sr" style="background:${netProfit>=0?'var(--green-bg)':'var(--red-bg)'};padding:10px 12px;border-radius:var(--r);border:1px solid ${netProfit>=0?'rgba(34,201,139,.2)':'rgba(240,82,82,.2)'}">
        <span style="font-size:15px;font-weight:700">NET PROFIT</span>
        <span style="font-family:var(--mono);font-size:18px;font-weight:700;color:${netProfit>=0?'var(--green-text)':'var(--red-text)'}">${peso(netProfit)}</span>
      </div>
    </div>`;
}

function exportPLCSV(){
  var from=document.getElementById('pl-from')?.value;
  var to=document.getElementById('pl-to')?.value;
  if(!from||!to){showToast('Select date range first.','err');return;}
  var ci=aload('cashin').filter(r=>r.date>=from&&r.date<=to);
  var exp=aload('expenses').filter(r=>r.date>=from&&r.date<=to);
  var rows=[['P&L Report','From: '+from,'To: '+to],[],['REVENUE'],['Platform','Amount']];
  ['TikTok','Shopee','Website','Walk-in'].forEach(p=>{
    var v=ci.filter(r=>r.platform===p).reduce((s,r)=>s+Number(r.amount||0),0);
    rows.push([p,v]);
  });
  rows.push(['Total Revenue',ci.reduce((s,r)=>s+Number(r.amount||0),0)],[],['EXPENSES'],['Category','Sub Category','Amount']);
  exp.forEach(r=>rows.push([r.category,r.subCategory||'',r.amount]));
  rows.push(['Total Expenses',exp.reduce((s,r)=>s+Number(r.amount||0),0)]);
  downloadCSV(rows,'ProdOps_PL_'+todayStr()+'.csv');
}

// ═══════════════════════════════════════════════════════
//  ACCOUNTING FORMS
// ═══════════════════════════════════════════════════════
var origBuildForm=buildForm;
buildForm=function(type){
  if(type==='cashin') return buildCashInForm();
  if(type==='expense') return buildExpenseForm();
  if(type==='supplierpay') return buildSupplierPayForm();
  if(type==='newuser') return buildNewUserForm();
  return origBuildForm(type);
};

// Auto-init expense subcategory checkboxes when modal opens
var origOpenModal=openModal;
openModal=function(type){
  origOpenModal(type);
  if(type==='expense'){
    setTimeout(function(){
      updateSubcatOpts();
    },50);
  }
};

function buildCashInForm(){
  var today=todayStr();
  var bankOpts=BANKS.map(b=>`<option value="${b}">${b}</option>`).join('');
  return`
    <div class="fgrid">
      <div class="fg"><label>Date <span class="req">*</span></label><input class="fi" type="date" id="f-date" value="${today}"></div>
      <div class="fg"><label>Amount (₱) <span class="req">*</span></label><input class="fi" type="number" id="f-amount" placeholder="0.00" step="0.01"></div>
      <div class="fg"><label>Qty sold</label><input class="fi" type="number" id="f-qty" placeholder="0"></div>
      <div class="fg"><label>Holding tax (₱)</label><input class="fi" type="number" id="f-tax" placeholder="0.00" step="0.01"></div>
      <div class="fg"><label>Platform <span class="req">*</span></label><select class="fi" id="f-platform"><option>TikTok</option><option>Shopee</option><option>Website</option><option>Walk-in</option></select></div>
      <div class="fg"><label>Bank / payment method <span class="req">*</span></label><select class="fi" id="f-bank"><option value="">— Select bank —</option>${bankOpts}</select></div>
      <div class="fg"><label>Process by</label><input class="fi" type="text" id="f-processBy" placeholder="Staff name"></div>
      <div class="fg"><label>Status</label><select class="fi" id="f-status"><option value="1">Received</option><option value="">Pending</option></select></div>
      <div class="fg full"><label>Notes</label><textarea class="fi" id="f-notes" placeholder="Optional notes..."></textarea></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="submitAccForm('cashin')">Save cash in</button></div>`;
}

function buildExpenseForm(){
  var today=todayStr();
  var catOpts=['Direct Cost','Indirect Cost','Opex','Liabilities'].map(c=>`<option>${c}</option>`).join('');
  var bankOpts=BANKS.map(b=>`<option value="${b}">${b}</option>`).join('');
  return`
    <style>
    .subcat-list{display:grid;grid-template-columns:1fr 1fr;gap:4px;max-height:160px;overflow-y:auto;padding:8px;background:var(--bg);border:1px solid var(--border2);border-radius:var(--r);margin-top:2px}
    .subcat-list::-webkit-scrollbar{width:4px}.subcat-list::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
    .subcat-item{display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--text2);transition:background .1s}
    .subcat-item:hover{background:var(--bg3);color:var(--text)}
    .subcat-item input[type=checkbox]{width:15px;height:15px;accent-color:var(--accent);cursor:pointer;flex-shrink:0}
    .subcat-item.checked{background:rgba(79,124,255,.12);color:var(--blue-text);font-weight:500}
    </style>
    <div class="fgrid">
      <div class="fg"><label>Date <span class="req">*</span></label><input class="fi" type="date" id="f-date" value="${today}"></div>
      <div class="fg"><label>Amount (₱) <span class="req">*</span></label><input class="fi" type="number" id="f-amount" placeholder="0.00" step="0.01"></div>
      <div class="fg"><label>Category <span class="req">*</span></label><select class="fi" id="f-category" onchange="updateSubcatOpts()">${catOpts}</select></div>
      <div class="fg"><label>Description</label><input class="fi" type="text" id="f-description" placeholder="What is this expense for?"></div>
      <div class="fg full"><label>Sub category <span style="font-size:10px;color:var(--text3)">(tick all that apply)</span></label><div class="subcat-list" id="f-subcat-list"></div></div>
      <div class="fg"><label>Paid to</label><input class="fi" type="text" id="f-paidTo" placeholder="Supplier / vendor name"></div>
      <div class="fg"><label>Bank / payment method <span class="req">*</span></label><select class="fi" id="f-bank"><option value="">— Select bank —</option>${bankOpts}</select></div>
      <div class="fg"><label>Process by</label><input class="fi" type="text" id="f-processBy" placeholder="Staff name"></div>
      <div class="fg"><label>Status</label><select class="fi" id="f-status"><option value="1">Paid</option><option value="">Pending</option></select></div>
      <div class="fg full"><label>Notes</label><textarea class="fi" id="f-notes" placeholder="Optional notes..."></textarea></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="submitAccForm('expense')">Save expense</button></div>`;
}

function buildSupplierPayForm(){
  var today=todayStr();
  return`
    <div class="fgrid">
      <div class="fg"><label>Date received <span class="req">*</span></label><input class="fi" type="date" id="f-dateReceived" value="${today}"></div>
      <div class="fg"><label>PO number <span class="req">*</span></label><input class="fi" type="text" id="f-poNumber" placeholder="e.g. PO-001"></div>
      <div class="fg"><label>Supplier name <span class="req">*</span></label><input class="fi" type="text" id="f-supplier" placeholder="Supplier name"></div>
      <div class="fg"><label>Total qty <span class="req">*</span></label><input class="fi" type="number" id="f-qty" placeholder="0"></div>
      <div class="fg"><label>Total amount (₱) <span class="req">*</span></label><input class="fi" type="number" id="f-amount" placeholder="0.00" step="0.01"></div>
      <div class="fg"><label>Payment timeline <span class="req">*</span></label><select class="fi" id="f-timeline"><option>1 week</option><option>2 weeks</option><option>3 weeks</option><option>1 month</option><option>COD</option><option>Custom</option></select></div>
      <div class="fg full"><label>Notes</label><textarea class="fi" id="f-notes" placeholder="Terms, conditions, etc..."></textarea></div>
    </div>
    <div class="fa"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="submitAccForm('supplierpay')">Save supplier PO</button></div>`;
}

function updateSubcatOpts(){
  var cat=document.getElementById('f-category')?.value;
  var list=document.getElementById('f-subcat-list');
  if(!list)return;
  var opts=EXP_SUBCATS[cat]||[];
  list.innerHTML=opts.map(o=>`
    <label class="subcat-item" onclick="toggleSubcat(this)">
      <input type="checkbox" value="${o}" onclick="event.stopPropagation()"> ${o}
    </label>`).join('');
}
function toggleSubcat(el){
  var cb=el.querySelector('input[type=checkbox]');
  cb.checked=!cb.checked;
  el.classList.toggle('checked',cb.checked);
}
function getCheckedSubcats(){
  var list=document.getElementById('f-subcat-list');
  if(!list)return'';
  var checked=[...list.querySelectorAll('input[type=checkbox]:checked')].map(c=>c.value);
  return checked.join(', ');
}

async function submitAccForm(type){
  if(type==='cashin'){
    var date=gv('f-date'),amount=gv('f-amount'),platform=gv('f-platform');
    if(!date||!amount||!platform){showToast('Fill in required fields.','err');return;}
    var r={id:uid(),date,amount:Number(amount),qty:gv('f-qty')?Number(gv('f-qty')):null,holdingTax:gv('f-tax')?Number(gv('f-tax')):null,platform,bank:gv('f-bank'),processBy:gv('f-processBy')||settings.username,status:gv('f-status')?'Received':'Pending',notes:gv('f-notes'),ts:nowISO()};
    var ok=await sbInsert('cash_in',r);
    closeModal();
    if(ok){
      await addAudit('Created','cashin','Cash in — '+platform+' · '+peso(amount));
      await dbReload();
      renderCashIn();
      renderAccDashboard();
      showToast('Cash in saved: '+peso(amount)+' from '+platform+' ✓');
    }
  }
  else if(type==='expense'){
    var date=gv('f-date'),amount=gv('f-amount'),cat=gv('f-category'),bank=gv('f-bank');
    if(!date||!amount||!cat||!bank){showToast('Fill in Date, Amount, Category and Bank.','err');return;}
    var subcats=getCheckedSubcats();
    var r={id:uid(),date,amount:Number(amount),category:cat,subCategory:subcats||gv('f-subcat')||'',description:gv('f-description'),paidTo:gv('f-paidTo'),bank,processBy:gv('f-processBy')||settings.username,status:gv('f-status')?'Paid':'Pending',notes:gv('f-notes'),ts:nowISO()};
    var ok=await sbInsert('expenses',r);
    closeModal();
    if(ok){
      await addAudit('Created','expenses','Expense — '+cat+' · '+(subcats||'—')+' · '+peso(amount));
      await dbReload();
      renderExpenses();
      renderAccDashboard();
      showToast('Expense saved: '+peso(amount)+' ✓');
    }
  }
  else if(type==='supplierpay'){
    var dr=gv('f-dateReceived'),po=gv('f-poNumber'),sup=gv('f-supplier'),qty=gv('f-qty'),amt=gv('f-amount'),tl=gv('f-timeline');
    if(!dr||!po||!sup||!qty||!amt||!tl){showToast('Fill in all required fields.','err');return;}
    // Calculate due date from timeline
    var due=new Date(dr);
    if(tl==='1 week')due.setDate(due.getDate()+7);
    else if(tl==='2 weeks')due.setDate(due.getDate()+14);
    else if(tl==='3 weeks')due.setDate(due.getDate()+21);
    else if(tl==='1 month')due.setMonth(due.getMonth()+1);
    else due.setDate(due.getDate()+1);
    var r={id:uid(),dateReceived:dr,poNumber:po,supplier:sup,totalQty:Number(qty),amount:Number(amt),timeline:tl,dueDate:due.toISOString().slice(0,10),status:'Pending',notes:gv('f-notes'),ts:nowISO()};
    var ok=await sbInsert('supplier_payments',r);
    if(ok){await addAudit('Created','supplierpay','Supplier PO — '+po+' · '+sup+' · '+peso(amt)+' due '+fmtDate(r.dueDate));await dbReload();renderSupplierPay();renderAccDashboard();}
    closeModal();showToast('Supplier PO saved. Due: '+fmtDate(r.dueDate)+' ✓');
  }
}

async function delAccRec(key,id){
  if(!confirm('Delete this record?'))return;
  var accTbl={cashin:'cash_in',expenses:'expenses',supplierpay:'supplier_payments'};
  if(accTbl[key]) await sbDelete(accTbl[key],id);
  await addAudit('Deleted',key,'Record deleted — ID: '+id);
  await dbReload();
  if(key==='cashin')renderCashIn();
  if(key==='expenses')renderExpenses();
  if(key==='supplierpay')renderSupplierPay();
  renderAccDashboard();
  showToast('Record deleted.','warn');
}

// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  DAILY TRANSACTION LINE CHART ENGINE
// ═══════════════════════════════════════════════════════
var _chartView = 'day';

function setChartView(v){
  _chartView = v;
  ['day','week','month'].forEach(function(x){
    var b = document.getElementById('chart-view-'+x);
    if(!b) return;
    b.style.background = x===v ? 'var(--accent)' : 'transparent';
    b.style.borderColor = x===v ? 'var(--accent)' : 'rgba(255,255,255,.15)';
    b.style.color = x===v ? '#fff' : 'var(--text)';
  });
  renderAccDashboard();
}

function getGroupKey(dateStr, view){
  if(!dateStr) return '?';
  if(view==='day') return dateStr;
  if(view==='week'){
    var d=new Date(dateStr); var day=d.getDay();
    d.setDate(d.getDate()-day+(day===0?-6:1));
    return d.toISOString().slice(0,10);
  }
  if(view==='month') return dateStr.slice(0,7);
  return dateStr;
}

function renderDailyChart(ciData, month){
  var canvas=document.getElementById('chart-daily-tx');
  var emptyMsg=document.getElementById('chart-empty-msg');
  var xlabels=document.getElementById('chart-x-labels');
  if(!canvas) return;
  var filtered=month?ciData.filter(function(r){return r.date&&r.date.startsWith(month);}):ciData;
  if(!filtered.length){
    if(emptyMsg) emptyMsg.style.display='flex';
    var ctx2=canvas.getContext('2d'); ctx2.clearRect(0,0,canvas.width,canvas.height);
    if(xlabels) xlabels.innerHTML=''; return;
  }
  if(emptyMsg) emptyMsg.style.display='none';
  var grouped={};
  filtered.forEach(function(r){
    var key=getGroupKey(r.date,_chartView);
    if(!grouped[key]) grouped[key]={sales:0,qty:0};
    grouped[key].sales+=Number(r.amount||0);
    grouped[key].qty+=Number(r.qty||0);
  });
  var keys=Object.keys(grouped).sort();
  var sales=keys.map(function(k){return grouped[k].sales;});
  var qty=keys.map(function(k){return grouped[k].qty;});
  var validSales=sales.map(function(v){return Math.round(v*0.97);});
  drawLineChart(canvas,keys,sales,validSales,qty,xlabels);
}

function niceMax(v){ if(!v||v===0)return 1; var mag=Math.pow(10,Math.floor(Math.log10(v))); return Math.ceil(v/mag)*mag; }

function drawLineChart(canvas,labels,sales,validSales,qty,xlabelsEl){
  var dpr=window.devicePixelRatio||1;
  var rect=canvas.parentElement.getBoundingClientRect();
  var W=Math.max(rect.width||600,300); var H=260;
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  var ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);
  var padL=68,padR=40,padT=16,padB=10;
  var chartW=W-padL-padR; var chartH=H-padT-padB;
  var n=labels.length; if(n===0)return;
  var salesMax=niceMax(Math.max.apply(null,sales.concat(validSales))*1.15)||1;
  var qtyMax=niceMax(Math.max.apply(null,qty)*1.15)||1;
  // Grid
  var G=5;
  for(var i=0;i<=G;i++){
    var gy=padT+(chartH/G)*i;
    ctx.strokeStyle='rgba(255,255,255,0.055)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(padL,gy); ctx.lineTo(padL+chartW,gy); ctx.stroke();
    var sv=salesMax-(salesMax/G)*i;
    ctx.fillStyle='#555e75'; ctx.font='10px IBM Plex Mono'; ctx.textAlign='right';
    ctx.fillText(sv>=1000?(sv/1000).toFixed(sv>=100000?0:1)+'K':sv.toFixed(0),padL-5,gy+3);
    var qv=Math.round(qtyMax-(qtyMax/G)*i);
    ctx.fillStyle='#555e75'; ctx.textAlign='left';
    ctx.fillText(qv,padL+chartW+5,gy+3);
  }
  // Right axis label
  ctx.save(); ctx.fillStyle='#8b92a8'; ctx.font='10px IBM Plex Sans';
  ctx.textAlign='center'; ctx.translate(W-8,padT+chartH/2);
  ctx.rotate(-Math.PI/2); ctx.fillText('Qty',0,0); ctx.restore();

  function xP(i){return padL+(n===1?chartW/2:(chartW/(n-1))*i);}
  function yS(v){return padT+chartH-(v/salesMax)*chartH;}
  function yQ(v){return padT+chartH-(v/qtyMax)*chartH;}

  // Area fills
  function drawArea(data,yFn,c1,c2){
    ctx.beginPath(); ctx.moveTo(xP(0),yFn(data[0]));
    for(var i=1;i<n;i++) ctx.lineTo(xP(i),yFn(data[i]));
    ctx.lineTo(xP(n-1),padT+chartH); ctx.lineTo(xP(0),padT+chartH); ctx.closePath();
    var g=ctx.createLinearGradient(0,padT,0,padT+chartH);
    g.addColorStop(0,c1); g.addColorStop(1,c2); ctx.fillStyle=g; ctx.fill();
  }
  drawArea(sales,yS,'rgba(79,124,255,0.22)','rgba(79,124,255,0.01)');
  drawArea(validSales,yS,'rgba(34,201,139,0.14)','rgba(34,201,139,0.01)');

  // Lines
  function drawLine(data,yFn,color,dash){
    ctx.beginPath(); ctx.strokeStyle=color; ctx.lineWidth=2.2;
    ctx.lineJoin='round'; ctx.lineCap='round';
    if(dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
    data.forEach(function(v,i){ if(i===0) ctx.moveTo(xP(i),yFn(v)); else ctx.lineTo(xP(i),yFn(v)); });
    ctx.stroke(); ctx.setLineDash([]);
  }
  drawLine(sales,yS,'#4f7cff',null);
  drawLine(validSales,yS,'#22c98b',null);
  drawLine(qty,yQ,'#8b92a8',[4,3]);

  // Dots (only if <=35 points)
  if(n<=35){
    function drawDots(data,yFn,color){
      data.forEach(function(v,i){
        ctx.beginPath(); ctx.arc(xP(i),yFn(v),3,0,2*Math.PI);
        ctx.fillStyle=color; ctx.fill();
        ctx.strokeStyle='#0f1117'; ctx.lineWidth=1.5; ctx.stroke();
      });
    }
    drawDots(sales,yS,'#4f7cff');
    drawDots(validSales,yS,'#22c98b');
    drawDots(qty,yQ,'#8b92a8');
  }

  // Store chart data for tooltip
  canvas._cd={labels,sales,validSales,qty,padL,padT,chartW,chartH,n,salesMax,qtyMax,W,H,xP,yS,yQ};

  canvas.onmousemove=function(e){
    var r=canvas.getBoundingClientRect();
    var mx=e.clientX-r.left;
    var raw=(mx-padL)/(n===1?1:chartW/(n-1));
    var idx=Math.round(raw);
    if(idx<0||idx>=n) return;
    // Redraw
    drawLineChart(canvas,labels,sales,validSales,qty,null);
    drawTooltip(canvas.getContext('2d'),canvas._cd,idx);
  };
  canvas.onmouseleave=function(){ drawLineChart(canvas,labels,sales,validSales,qty,xlabelsEl); };

  // X labels
  if(xlabelsEl){
    var maxL=Math.min(n,14); var step=Math.max(1,Math.ceil(n/maxL));
    var html='<div style="display:flex;width:100%;position:relative;height:16px">';
    labels.forEach(function(l,i){
      if(i%step!==0&&i!==n-1) return;
      var pct=n===1?50:(i/(n-1))*100;
      var lbl=_chartView==='day'?l.slice(5):_chartView==='week'?'Wk '+l.slice(5,7):l.slice(0,7);
      html+='<div style="position:absolute;left:'+pct+'%;transform:translateX(-50%);font-size:10px;color:var(--text3);font-family:var(--mono);white-space:nowrap">'+lbl+'</div>';
    });
    html+='</div>';
    xlabelsEl.innerHTML=html;
  }
}

function drawTooltip(ctx,d,idx){
  var x=d.xP(idx);
  ctx.save();
  ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=1; ctx.setLineDash([4,3]);
  ctx.beginPath(); ctx.moveTo(x,d.padT); ctx.lineTo(x,d.padT+d.chartH); ctx.stroke();
  ctx.setLineDash([]);
  var tipW=188,tipH=90;
  var tipX=x+12; var tipY=d.padT+12;
  if(tipX+tipW>d.W-d.padL) tipX=x-tipW-12;
  ctx.fillStyle='rgba(16,20,32,0.97)'; ctx.strokeStyle='rgba(255,255,255,0.13)'; ctx.lineWidth=1;
  rrect(ctx,tipX,tipY,tipW,tipH,8); ctx.fill(); ctx.stroke();
  ctx.fillStyle='#e8eaf0'; ctx.font='500 11px IBM Plex Sans'; ctx.textAlign='left';
  ctx.fillText(d.labels[idx],tipX+10,tipY+18);
  var rows=[
    {lbl:'Total sales:',val:'₱'+Number(d.sales[idx]).toLocaleString('en-PH',{maximumFractionDigits:0}),color:'#4f7cff'},
    {lbl:'Valid sales:',val:'₱'+Number(d.validSales[idx]).toLocaleString('en-PH',{maximumFractionDigits:0}),color:'#22c98b'},
    {lbl:'Qty sold:',val:String(d.qty[idx]),color:'#8b92a8'}
  ];
  rows.forEach(function(r,i){
    var ty=tipY+36+i*18;
    ctx.fillStyle=r.color; ctx.font='11px IBM Plex Sans'; ctx.textAlign='left';
    ctx.fillText(r.lbl,tipX+10,ty);
    ctx.fillStyle='#e8eaf0'; ctx.font='500 11px IBM Plex Mono'; ctx.textAlign='right';
    ctx.fillText(r.val,tipX+tipW-10,ty);
  });
  ctx.restore();
}
function rrect(ctx,x,y,w,h,r){
  ctx.beginPath(); ctx.moveTo(x+r,y);
  ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
  ctx.closePath();
}

//  ACCOUNTING EXPORTS
// ═══════════════════════════════════════════════════════
function exportCashInCSV(){
  var data=aload('cashin');
  var rows=[['Date','Amount','Qty Sold','Holding Tax','Platform','Bank','Process By','Status','Notes','Timestamp']];
  data.forEach(r=>rows.push([r.date,r.amount,r.qty||'',r.holdingTax||'',r.platform,r.bank||'',r.processBy||'',r.status||'',r.notes||'',r.ts]));
  downloadCSV(rows,'ProdOps_CashIn_'+todayStr()+'.csv');
}
function exportExpCSV(){
  var data=aload('expenses');
  var rows=[['Date','Amount','Category','Sub Category','Description','Paid To','Status','Process By','Bank','Notes','Timestamp']];
  data.forEach(r=>rows.push([r.date,r.amount,r.category,r.subCategory||'',r.description||'',r.paidTo||'',r.status||'',r.processBy||'',r.bank||'',r.notes||'',r.ts]));
  downloadCSV(rows,'ProdOps_Expenses_'+todayStr()+'.csv');
}
function exportSupplierCSV(){
  var data=aload('supplierpay');
  var rows=[['Date Received','PO Number','Supplier','Total Qty','Amount','Timeline','Due Date','Status','Notes']];
  data.forEach(r=>rows.push([r.dateReceived,r.poNumber,r.supplier,r.totalQty,r.amount,r.timeline,r.dueDate,r.status,r.notes||'']));
  downloadCSV(rows,'ProdOps_SupplierPay_'+todayStr()+'.csv');
}

// Add accounting titles to nav titles map
TITLES['accdashboard']='Accounting Dashboard';
TITLES['usermgmt']='User Management';
TITLES['cashIN']='Cash In Monitoring';
TITLES['expenses']='Business Expenses';
TITLES['supplierpay']='Supplier Payments';
TITLES['pandl']='Profit & Loss';

// Accounting renders are now built into refreshAll directly - no hook needed

// ═══════════════════════════════════════════════════════
//  BULK UPLOAD ENGINE — Excel/CSV for Cash In & Expenses
// ═══════════════════════════════════════════════════════

// Load SheetJS (xlsx) library dynamically
function loadSheetJS(cb){
  if(window.XLSX){cb();return;}
  var s=document.createElement('script');
  s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  s.onload=cb;
  s.onerror=function(){showToast('Failed to load Excel library. Check internet connection.','err');};
  document.head.appendChild(s);
}

// ── TEMPLATE DOWNLOAD ──────────────────────────────────
function downloadTemplate(type){
  if(type==='cashin'){
    var rows=[
      ['CASH IN MONITORING — BULK UPLOAD TEMPLATE'],
      ['Instructions: Fill in rows below. Do NOT change column headers. Date format: YYYY-MM-DD. Platform must be: TikTok / Shopee / Website / Walk-in. Bank must be: Seabank / Go Tyme / Cash / G-Cash / UnionBank / GoTyme Edward / DDC Fee / Security Bank. Status: Received or Pending.'],
      [],
      ['Date','Amount','Qty Sold','Holding Tax','Platform','Bank','Process By','Status','Notes'],
      ['2026-04-01','15000','75','','TikTok','G-Cash','Admin','Received','April 1 remittance'],
      ['2026-04-02','8500','42','','Shopee','Seabank','Maria L.','Received',''],
      ['2026-04-03','3200','16','','Walk-in','Cash','Admin','Received','Walk-in sales'],
    ];
    downloadXLSXTemplate(rows,'CashIn_BulkUpload_Template.xlsx','Cash In Template');
  } else if(type==='expense'){
    var rows=[
      ['BUSINESS EXPENSES — BULK UPLOAD TEMPLATE'],
      ['Instructions: Fill in rows below. Do NOT change column headers. Date format: YYYY-MM-DD. Category must be: Direct Cost / Indirect Cost / Opex / Liabilities. Bank must be: Seabank / Go Tyme / Cash / G-Cash / UnionBank / GoTyme Edward / DDC Fee / Security Bank. Status: Paid or Pending.'],
      [],
      ['Date','Amount','Category','Sub Category','Description','Paid To','Bank','Process By','Status','Notes'],
      ['2026-04-01','218863','Direct Cost','Fabric','Fabric purchase April','Supplier PH','Seabank','Admin','Paid',''],
      ['2026-04-01','17544','Opex','Marketing Ads','TikTok Ads April','TikTok','G-Cash','Admin','Paid','Campaign boost'],
      ['2026-04-02','49735','Opex','Electricity','April electricity bill','Meralco','UnionBank','Admin','Paid',''],
      ['2026-04-03','22797','Opex','Salary','April salaries','Staff','Cash','Admin','Paid',''],
    ];
    downloadXLSXTemplate(rows,'Expenses_BulkUpload_Template.xlsx','Expenses Template');
  }
}

function downloadXLSXTemplate(rows, filename, sheetname){
  loadSheetJS(function(){
    var wb=XLSX.utils.book_new();
    var ws=XLSX.utils.aoa_to_sheet(rows);
    // Style header rows
    ws['!cols']=[{wch:12},{wch:12},{wch:14},{wch:18},{wch:25},{wch:20},{wch:16},{wch:14},{wch:10},{wch:25}];
    XLSX.utils.book_append_sheet(wb,ws,sheetname);
    XLSX.writeFile(wb,filename);
    showToast('Template downloaded. Fill it in and upload. ✓');
  });
}

// ── BULK UPLOAD HANDLER ────────────────────────────────
function bulkUpload(type, input){
  var file=input.files[0];
  if(!file){return;}
  input.value=''; // reset so same file can be re-uploaded
  loadSheetJS(function(){
    var reader=new FileReader();
    reader.onload=function(e){
      try{
        var data=new Uint8Array(e.target.result);
        var workbook=XLSX.read(data,{type:'array',cellDates:true});
        var sheetName=workbook.SheetNames[0];
        var sheet=workbook.Sheets[sheetName];
        var rows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:false,dateNF:'yyyy-mm-dd'});
        if(type==='cashin') processCashInUpload(rows);
        else if(type==='expense') processExpenseUpload(rows);
      }catch(err){
        showBulkError(['File could not be read: '+err.message+'. Make sure it is a valid Excel (.xlsx) or CSV file.']);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

// ── CASH IN PROCESSOR ─────────────────────────────────
var CI_REQUIRED=['Date','Amount','Platform'];
var CI_COLS=['Date','Amount','Qty Sold','Holding Tax','Platform','Bank','Process By','Status','Notes'];
var VALID_PLATFORMS=['TikTok','Shopee','Website','Walk-in'];
var VALID_BANKS_SET=['Seabank','Go Tyme','Cash','G-Cash','UnionBank','GoTyme Edward','DDC Fee','Security Bank'];
var VALID_STATUSES_CI=['Received','Pending',''];

function processCashInUpload(rows){
  // Find header row (skip instruction rows at top)
  var headerIdx=-1;
  for(var i=0;i<rows.length;i++){
    if(rows[i]&&rows[i][0]&&String(rows[i][0]).trim()==='Date'&&rows[i][1]&&String(rows[i][1]).trim()==='Amount'){
      headerIdx=i; break;
    }
  }
  if(headerIdx===-1){
    showBulkError(['Cannot find header row. Make sure row has columns: Date, Amount, Qty Sold, Holding Tax, Platform, Bank, Process By, Status, Notes']);
    return;
  }
  var headers=rows[headerIdx].map(h=>String(h||'').trim());
  var dataRows=rows.slice(headerIdx+1).filter(r=>r&&r.some(c=>c!==null&&c!==undefined&&String(c).trim()!==''));

  var errors=[]; var valid=[]; var skipped=0;
  dataRows.forEach(function(row,idx){
    var rn=idx+1; // row number for user
    var rec={};
    headers.forEach(function(h,i){rec[h]=row[i]!==undefined&&row[i]!==null?String(row[i]).trim():''});

    var rowErrs=[];
    // Date validation
    var date=normalizeDate(rec['Date']);
    if(!date) rowErrs.push('Invalid or missing Date (use YYYY-MM-DD format)');
    // Amount validation
    var amount=parseFloat(String(rec['Amount']).replace(/[₱,]/g,''));
    if(isNaN(amount)||amount<=0) rowErrs.push('Amount must be a number greater than 0');
    // Platform validation
    var platform=rec['Platform']||'';
    if(!VALID_PLATFORMS.includes(platform)) rowErrs.push('Platform must be: TikTok, Shopee, Website, or Walk-in (got: "'+platform+'")');
    // Bank validation (optional but if filled must be valid)
    var bank=rec['Bank']||'';
    if(bank&&!VALID_BANKS_SET.includes(bank)) rowErrs.push('Bank "'+bank+'" is not recognized. Valid banks: '+VALID_BANKS_SET.join(', '));
    // Status
    var status=rec['Status']||'Received';
    if(!['Received','Pending',''].includes(status)) rowErrs.push('Status must be Received or Pending');

    if(rowErrs.length){
      rowErrs.forEach(function(e){ errors.push('Row '+rn+': '+e); });
    } else {
      valid.push({
        id:uid(),
        date:date,
        amount:amount,
        qty:rec['Qty Sold']?Number(rec['Qty Sold'])||null:null,
        holdingTax:rec['Holding Tax']?Number(rec['Holding Tax'])||null:null,
        platform:platform,
        bank:bank||'',
        processBy:rec['Process By']||settings.username||'Admin',
        status:status||'Received',
        notes:rec['Notes']||'',
        ts:nowISO()
      });
    }
  });

  if(dataRows.length===0){skipped=0;}
  showBulkPreview('cashin', valid, errors, dataRows.length);
}

// ── EXPENSE PROCESSOR ─────────────────────────────────
var VALID_CATS=['Direct Cost','Indirect Cost','Opex','Liabilities'];
var ALL_SUBCATS=['Fabric','Ink','Subli Paper','Garter','Lace','Eyelet','Black Pouch','Sticker','Individual Plastic','Waybill','Packaging Tape','Shrinkage','Labor Sewer','Transportation','Marketing Ads','Rent','Electricity','Internet','Water','Salary','Printer Maintenance','Office Supplies','Repair & Maintenance','Admin & Compliance','Software & Apps','Loans','DDC Fee','Other Direct Cost','Other Indirect Cost','Other Opex','Other Liabilities'];

function processExpenseUpload(rows){
  var headerIdx=-1;
  for(var i=0;i<rows.length;i++){
    if(rows[i]&&rows[i][0]&&String(rows[i][0]).trim()==='Date'&&rows[i][1]&&String(rows[i][1]).trim()==='Amount'){
      headerIdx=i; break;
    }
  }
  if(headerIdx===-1){
    showBulkError(['Cannot find header row. Make sure row has: Date, Amount, Category, Sub Category, Description, Paid To, Bank, Process By, Status, Notes']);
    return;
  }
  var headers=rows[headerIdx].map(h=>String(h||'').trim());
  var dataRows=rows.slice(headerIdx+1).filter(r=>r&&r.some(c=>c!==null&&c!==undefined&&String(c).trim()!==''));

  var errors=[]; var valid=[];
  dataRows.forEach(function(row,idx){
    var rn=idx+1;
    var rec={};
    headers.forEach(function(h,i){rec[h]=row[i]!==undefined&&row[i]!==null?String(row[i]).trim():''});

    var rowErrs=[];
    var date=normalizeDate(rec['Date']);
    if(!date) rowErrs.push('Invalid or missing Date (use YYYY-MM-DD)');
    var amount=parseFloat(String(rec['Amount']).replace(/[₱,]/g,''));
    if(isNaN(amount)||amount<=0) rowErrs.push('Amount must be a number greater than 0');
    var cat=rec['Category']||'';
    if(!VALID_CATS.includes(cat)) rowErrs.push('Category must be: Direct Cost, Indirect Cost, Opex, or Liabilities (got: "'+cat+'")');
    var subcat=rec['Sub Category']||'';
    // Sub category is optional but warn if filled and not recognized
    var subcatWarning='';
    if(subcat&&!ALL_SUBCATS.includes(subcat)) subcatWarning='Note: Sub Category "'+subcat+'" is not in the standard list but will be saved as-is.';
    var bank=rec['Bank']||'';
    if(!bank) rowErrs.push('Bank / payment method is required');
    else if(!VALID_BANKS_SET.includes(bank)) rowErrs.push('Bank "'+bank+'" not recognized. Valid: '+VALID_BANKS_SET.join(', '));
    var status=rec['Status']||'Paid';
    if(!['Paid','Pending',''].includes(status)) rowErrs.push('Status must be Paid or Pending');

    if(rowErrs.length){
      rowErrs.forEach(function(e){ errors.push('Row '+rn+': '+e); });
    } else {
      valid.push({
        id:uid(),
        date:date,
        amount:amount,
        category:cat,
        subCategory:subcat,
        description:rec['Description']||'',
        paidTo:rec['Paid To']||'',
        bank:bank,
        processBy:rec['Process By']||settings.username||'Admin',
        status:status||'Paid',
        notes:rec['Notes']||'',
        ts:nowISO()
      });
      if(subcatWarning) errors.push('Row '+rn+' (warning): '+subcatWarning);
    }
  });

  showBulkPreview('expense', valid, errors, dataRows.length);
}

// ── DATE NORMALIZER ────────────────────────────────────
function normalizeDate(val){
  if(!val||String(val).trim()==='')return null;
  var s=String(val).trim();
  // Already YYYY-MM-DD
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)){
    var d=new Date(s);
    return isNaN(d.getTime())?null:s;
  }
  // M/D/YYYY or MM/DD/YYYY
  if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)){
    var parts=s.split('/');
    var d=new Date(parts[2],parts[0]-1,parts[1]);
    if(isNaN(d.getTime()))return null;
    return d.toISOString().slice(0,10);
  }
  // Try native Date parse
  var d=new Date(s);
  if(!isNaN(d.getTime()))return d.toISOString().slice(0,10);
  return null;
}

// ── PREVIEW MODAL ──────────────────────────────────────
function showBulkPreview(type, valid, errors, total){
  var hasErrors=errors.filter(e=>!e.includes('(warning)')).length>0;
  var warnings=errors.filter(e=>e.includes('(warning)'));
  var hardErrors=errors.filter(e=>!e.includes('(warning)'));
  var label=type==='cashin'?'Cash In':'Expense';

  var html=`
    <div style="margin-bottom:14px">
      <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
        <div style="background:var(--green-bg);border:1px solid rgba(34,201,139,.2);border-radius:8px;padding:10px 14px;flex:1;min-width:100px">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:3px">Valid records</div>
          <div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--green-text)">${valid.length}</div>
        </div>
        <div style="background:var(--red-bg);border:1px solid rgba(240,82,82,.2);border-radius:8px;padding:10px 14px;flex:1;min-width:100px">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:3px">Errors found</div>
          <div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--red-text)">${hardErrors.length}</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px 14px;flex:1;min-width:100px">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:3px">Total rows read</div>
          <div style="font-size:22px;font-weight:700;font-family:var(--mono)">${total}</div>
        </div>
      </div>`;

  // Show errors if any
  if(hardErrors.length>0){
    html+=`<div style="background:var(--red-bg);border:1px solid rgba(240,82,82,.25);border-radius:8px;padding:12px;margin-bottom:12px;max-height:180px;overflow-y:auto">
      <div style="font-size:11px;font-weight:600;color:var(--red-text);text-transform:uppercase;margin-bottom:8px">⚠ Errors — these rows will NOT be uploaded</div>
      ${hardErrors.map(e=>`<div style="font-size:12px;color:var(--red-text);padding:3px 0;border-bottom:1px solid rgba(240,82,82,.1);font-family:var(--mono)">${esc(e)}</div>`).join('')}
    </div>`;
  }

  // Show warnings if any
  if(warnings.length>0){
    html+=`<div style="background:var(--amber-bg);border:1px solid rgba(240,168,50,.25);border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:600;color:var(--amber-text);text-transform:uppercase;margin-bottom:8px">⚡ Warnings — rows will be uploaded but check these</div>
      ${warnings.map(e=>`<div style="font-size:12px;color:var(--amber-text);padding:3px 0;font-family:var(--mono)">${esc(e)}</div>`).join('')}
    </div>`;
  }

  // Preview table of valid records
  if(valid.length>0){
    html+=`<div style="font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;margin-bottom:6px">Preview — valid records to be uploaded</div>
    <div style="overflow-x:auto;max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
    <table style="width:100%;border-collapse:collapse;font-size:11.5px">
    <thead><tr>`;
    if(type==='cashin'){
      html+=`<th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border);white-space:nowrap">Date</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Amount</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Platform</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Bank</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Qty</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Status</th>`;
      html+=`</tr></thead><tbody>`;
      valid.slice(0,10).forEach(function(r){
        html+=`<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 8px;font-family:var(--mono)">${r.date}</td>
          <td style="padding:6px 8px;font-family:var(--mono);color:var(--green-text);font-weight:600">${peso(r.amount)}</td>
          <td style="padding:6px 8px">${r.platform}</td>
          <td style="padding:6px 8px">${r.bank||'—'}</td>
          <td style="padding:6px 8px;font-family:var(--mono)">${r.qty||'—'}</td>
          <td style="padding:6px 8px">${r.status}</td>
        </tr>`;
      });
    } else {
      html+=`<th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border);white-space:nowrap">Date</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Amount</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Category</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Sub Category</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Bank</th>
        <th style="padding:6px 8px;background:var(--bg);color:var(--text3);text-align:left;font-size:10px;border-bottom:1px solid var(--border)">Status</th>`;
      html+=`</tr></thead><tbody>`;
      valid.slice(0,10).forEach(function(r){
        html+=`<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 8px;font-family:var(--mono)">${r.date}</td>
          <td style="padding:6px 8px;font-family:var(--mono);color:var(--red-text);font-weight:600">${peso(r.amount)}</td>
          <td style="padding:6px 8px">${r.category}</td>
          <td style="padding:6px 8px;font-size:11px;color:var(--text2)">${r.subCategory||'—'}</td>
          <td style="padding:6px 8px">${r.bank}</td>
          <td style="padding:6px 8px">${r.status}</td>
        </tr>`;
      });
    }
    if(valid.length>10) html+=`<tr><td colspan="6" style="padding:8px;text-align:center;color:var(--text3);font-size:11px">... and ${valid.length-10} more records</td></tr>`;
    html+=`</tbody></table></div>`;
  }

  // Action buttons
  html+=`<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
    <button class="btn" onclick="closeBulkModal()">Cancel</button>`;
  if(valid.length>0){
    html+=`<button class="btn btn-p" id="bulk-confirm-btn">
      Upload ${valid.length} valid ${label} records
    </button>`;
  } else {
    html+=`<button class="btn" disabled style="opacity:.4">No valid records to upload</button>`;
  }
  html+=`</div></div>`;

  document.getElementById('bulk-modal-title').textContent=`Bulk Upload — ${label} (${valid.length} valid / ${hardErrors.length} errors)`;
  document.getElementById('bulk-modal-body').innerHTML=html;
  document.getElementById('bulk-modal').classList.add('open');
  document.getElementById('moverlay').classList.remove('open');

  // Store valid records in global variable and attach click handler AFTER HTML is rendered
  window._bulkPendingRecords=valid;
  window._bulkPendingType=type;
  var confirmBtn=document.getElementById('bulk-confirm-btn');
  if(confirmBtn){
    confirmBtn.addEventListener('click',function(){
      confirmBulkUpload(window._bulkPendingType, window._bulkPendingRecords);
    });
  }
}

function showBulkError(msgs){
  var html=`<div style="background:var(--red-bg);border:1px solid rgba(240,82,82,.25);border-radius:8px;padding:14px;margin-bottom:14px">
    <div style="font-size:13px;font-weight:600;color:var(--red-text);margin-bottom:10px">Upload failed</div>
    ${msgs.map(m=>`<div style="font-size:12.5px;color:var(--red-text);margin-bottom:6px">✕ ${esc(m)}</div>`).join('')}
  </div>
  <button class="btn" onclick="closeBulkModal()">Close</button>`;
  document.getElementById('bulk-modal-title').textContent='Upload Error';
  document.getElementById('bulk-modal-body').innerHTML=html;
  document.getElementById('bulk-modal').classList.add('open');
}

function closeBulkModal(){
  document.getElementById('bulk-modal').classList.remove('open');
}

// ── CONFIRM & SAVE ─────────────────────────────────────
async function confirmBulkUpload(type, records){
  var recs = records || window._bulkPendingRecords || [];
  var t = type || window._bulkPendingType || 'cashin';
  if(!recs.length){ showToast('No records to upload.','err'); return; }
  var tbl = t==='cashin' ? 'cash_in' : 'expenses';
  // Show uploading state
  var btn=document.getElementById('bulk-confirm-btn');
  if(btn){btn.disabled=true;btn.textContent='Uploading...';}
  showLoading(true);
  var inserted = await sbBulkInsert(tbl, recs);
  showLoading(false);
  if(inserted>0){
    await addAudit('Created', t, 'Bulk upload — ' + inserted + ' records imported');
  }
  window._bulkPendingRecords = null;
  window._bulkPendingType = null;
  closeBulkModal();
  if(inserted>0){
    await dbReload();
    if(t==='cashin'){ renderCashIn(); renderAccDashboard(); }
    else { renderExpenses(); renderAccDashboard(); }
    showToast('✓ ' + inserted + ' records uploaded to Supabase successfully!');
  } else {
    showToast('Upload failed. Check console for details.','err');
  }
}

// Close bulk modal on overlay click
document.getElementById('bulk-modal').addEventListener('click',function(e){
  if(e.target===this)closeBulkModal();
});


// Unregister ALL service workers - they were blocking Supabase API calls
if("serviceWorker"in navigator){
  navigator.serviceWorker.getRegistrations().then(function(regs){
    regs.forEach(function(r){
      r.unregister();
      console.log('Unregistered old service worker');
    });
  });
}


// ═══════════════════════════════════════════════════════
// FORCE-FIX: Add User modal opener (admin screen)
// This makes the + Add user button work even if earlier wrappers break openModal().
// ═══════════════════════════════════════════════════════
function forceOpenAddUserModal(){
  var mo=document.getElementById('moverlay');
  var title=document.getElementById('mtitle');
  var body=document.getElementById('mbody');
  if(!mo||!title||!body){
    alert('Modal container not found. Please refresh the page.');
    return;
  }
  var isAdmin = String(currentRole||'').toLowerCase()==='admin' || String(document.getElementById('user-role-badge')?.textContent||'').toLowerCase().includes('admin');
  if(!isAdmin){
    showToast('Only admin can add users.','err');
    return;
  }
  title.textContent='Add new user';
  body.innerHTML=buildNewUserForm();
  mo.classList.add('open');
  mo.style.display='flex';
}

(function bindAddUserButtonForce(){
  function bind(){
    var buttons=document.querySelectorAll('button');
    buttons.forEach(function(btn){
      if((btn.textContent||'').trim().toLowerCase().includes('add user')){
        btn.onclick=function(e){
          if(e){e.preventDefault();e.stopPropagation();}
          forceOpenAddUserModal();
          return false;
        };
      }
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',bind); else bind();
  setTimeout(bind,300);
  setTimeout(bind,1000);
})();
