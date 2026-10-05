import {EventMap} from './map.js';
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={user:null,csrf:null,venues:[],rules:[],events:[],adminEvents:[],config:{},view:'explore',page:1,total:0,loadVersion:0,chatBusy:false};
const modal=$('#modal');
let toastTimer;
function toast(message,error=false){const element=$('#toast');element.textContent=message;element.classList.toggle('error',error);element.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>element.hidden=true,4500);}
async function api(path,options={}){
  const headers={'Content-Type':'application/json',...options.headers};if(state.csrf)headers['X-CSRF-Token']=state.csrf;
  const response=await fetch(path,{credentials:'same-origin',...options,headers,body:options.body?JSON.stringify(options.body):undefined});
  const result=await response.json();
  if(!response.ok){const error=new Error(result.error?.message||'请求失败');error.status=response.status;throw error;}
  return result;
}
function openModal(html){$('#modal-content').innerHTML=html;if(!modal.open)modal.showModal();}
$('.modal-close').onclick=()=>modal.close();
modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close();}});
function authUI(){
  $('#admin-nav').hidden=state.user?.role!=='admin';
  $('#auth-area').innerHTML=state.user?`<span class="user-avatar">${esc(state.user.display_name.slice(0,1))}</span><span class="user-label">${esc(state.user.display_name)}</span><button class="text-link" id="logout">退出</button>`:`<button class="button small" data-action="login">登录 / 注册</button>`;
  const logout=$('#logout');if(logout)logout.onclick=async()=>{try{await api('/api/auth/logout',{method:'POST',body:{}});state.user=null;state.csrf=null;authUI();if(state.view==='admin')location.hash='explore';else await loadEvents();toast('已退出登录');}catch(e){toast(e.message,true);}};
}
function loginDialog(register=false){
  openModal(`<div class="modal-content-inner"><span class="eyebrow">WELCOME ABOARD</span><h2>${register?'加入舟行':'欢迎，重新出发'}</h2><p class="muted">登录后收藏赛事；管理员可维护赛事、地点和知识资料。</p><form id="auth-form" class="auth-form"><label>用户名<input name="username" autocomplete="username" maxlength="32" required placeholder="${register?'字母、数字或下划线':'请输入用户名'}"></label>${register?'<label>昵称<input name="display_name" maxlength="40" minlength="2" required placeholder="大家怎么称呼你"></label>':''}<label>密码<input type="password" name="password" autocomplete="${register?'new-password':'current-password'}" minlength="${register?8:1}" maxlength="128" required placeholder="${register?'至少8个字符':'请输入密码'}"></label><p class="form-error" id="auth-error" role="alert"></p><button class="button" type="submit">${register?'创建普通用户账号':'登录'}</button></form>${register?'':`<div class="auth-demo">演示管理员：admin / Admin@12345<br>演示普通用户：demo / User@12345</div>`}<div class="auth-switch"><button class="text-link" id="auth-switch">${register?'已有账号？去登录':'还没有账号？创建账号'}</button></div></div>`);
  $('#auth-switch').onclick=()=>loginDialog(!register);
  $('#auth-form').onsubmit=async e=>{
    e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;$('#auth-error').textContent='';
    try{const result=await api(`/api/auth/${register?'register':'login'}`,{method:'POST',body:Object.fromEntries(new FormData(form))});state.user=result.user;state.csrf=result.csrf_token;authUI();modal.close();toast(`欢迎，${state.user.display_name}`);if(state.view==='admin')await loadAdmin();else if(['explore','map','favorites'].includes(state.view))await loadEvents();}
    catch(error){$('#auth-error').textContent=error.message;}finally{button.disabled=false;}
  };
}
document.addEventListener('click',e=>{if(e.target.closest('[data-action=login]'))loginDialog();});
function formLocation(){
  const form=$('#filters');const origin=form.elements.origin.value;
  if(!origin)return null;
  if(origin==='custom')return {longitude:form.elements.longitude.value,latitude:form.elements.latitude.value};
  const venue=state.venues.find(v=>String(v.id)===origin);return venue?{longitude:venue.longitude,latitude:venue.latitude}:null;
}
function filters(){
  const values=Object.fromEntries(new FormData($('#filters')));const result={};
  for(const key of ['q','city','start_date','end_date','sort'])if(values[key])result[key]=values[key];
  const origin=formLocation();if(origin){result.longitude=origin.longitude;result.latitude=origin.latitude;result.radius_km=values.radius_km;}
  if(state.view==='favorites')result.favorites='1';
  result.page=state.page;result.page_size=12;
  return result;
}
function renderFilterChoices(){
  const city=$('#city-select'),origin=$('#origin-select'),oldCity=city.value,oldOrigin=origin.value;
  city.innerHTML='<option value="">全部城市</option>'+[...new Set(state.venues.map(v=>v.city))].sort().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  origin.innerHTML='<option value="">不限制距离</option>'+state.venues.map(v=>`<option value="${v.id}">${esc(v.city)} · ${esc(v.name)}</option>`).join('')+'<option value="custom">输入经纬度</option>';
  city.value=oldCity;origin.value=oldOrigin;updateOrigin();
}
function updateOrigin(){const form=$('#filters'),custom=form.elements.origin.value==='custom';$('#coordinate-fields').hidden=!custom;form.elements.radius_km.disabled=!form.elements.origin.value;form.elements.longitude.required=custom;form.elements.latitude.required=custom;}
$('#origin-select').onchange=updateOrigin;
$('#filters').onsubmit=e=>{e.preventDefault();state.page=1;loadEvents();};
$('#reset-filters').onclick=()=>{$('#filters').reset();$('#filters').elements.start_date.value='';updateOrigin();state.page=1;loadEvents();};
function eventCard(e){
  const date=e.start_date===e.end_date?e.start_date:`${e.start_date} — ${e.end_date.slice(5)}`;
  return `<article class="event-card" data-card-id="${e.id}"><div class="card-image"><img src="${esc(e.cover_image)}" alt="${esc(e.title)}封面" loading="lazy"><span class="badge">${esc(e.city)}${e.is_demo?' · 示例':''}</span>${e.distance_km!==null?`<span class="distance">约 ${e.distance_km} km</span>`:''}</div><div class="card-body"><span class="card-date">${esc(date)}</span><h3>${esc(e.title)}</h3><div class="card-location">⌖ ${esc(e.venue_name)}</div><div class="card-footer"><button data-detail="${e.id}">查看赛事 <span>↗</span></button><button class="favorite-button ${e.is_favorite?'saved':''}" data-favorite="${e.id}" aria-label="${e.is_favorite?'取消收藏':'收藏'}${esc(e.title)}">${e.is_favorite?'♥ 已收藏':'♡ 收藏'}</button></div></div></article>`;
}
function imageFallback(root=document){root.querySelectorAll('img:not([data-fallback])').forEach(img=>{img.dataset.fallback='1';img.addEventListener('error',()=>{if(!img.src.endsWith('/assets/river.svg'))img.src='/assets/river.svg';},{once:true});});}
const map=new EventMap($('#event-map'),(id,onlyHighlight=false)=>{document.querySelectorAll('.event-card').forEach(card=>card.classList.toggle('selected',Number(card.dataset.cardId)===id));if(!onlyHighlight)detailDialog(id);});
async function loadEvents(){
  const version=++state.loadVersion;
  if(state.view==='favorites'&&!state.user){$('#event-list').innerHTML='<div class="empty-state"><h3>把喜欢的赛事，留在这里</h3><p>登录后即可收藏赛事，在不同页面之间同步查看。</p><button class="button" data-action="login">登录 / 注册</button></div>';$('#pagination').innerHTML='';$('#result-summary').textContent='登录后查看收藏';map.setEvents([]);return;}
  $('#event-list').innerHTML='<div class="skeleton"></div><div class="skeleton"></div>';
  try{
    const result=await api('/api/events?'+new URLSearchParams(filters()));if(version!==state.loadVersion)return;
    state.events=result.items;state.total=result.total;
    $('#event-list').innerHTML=result.items.length?result.items.map(eventCard).join(''):'<div class="empty-state"><h3>暂时没有符合条件的赛事</h3><p>试试其他城市、日期或更大的查询半径。</p><button class="button ghost" id="empty-reset">查看全部赛事</button></div>';
    $('#result-summary').textContent=`共 ${result.total} 场赛事 · 当前显示 ${result.items.length} 场`;
    const pages=Math.ceil(result.total/result.page_size);
    $('#pagination').innerHTML=pages>1?`<button class="button ghost small" id="previous-page" ${state.page===1?'disabled':''}>上一页</button><span>${state.page} / ${pages}</span><button class="button ghost small" id="next-page" ${state.page===pages?'disabled':''}>下一页</button>`:'';
    $('#previous-page')?.addEventListener('click',()=>{state.page--;loadEvents();});$('#next-page')?.addEventListener('click',()=>{state.page++;loadEvents();});
    $('#empty-reset')?.addEventListener('click',()=>$('#reset-filters').click());
    // Map shows the whole filtered result, not only this list page (max 100).
    const mapResult=pages>1?await api('/api/events?'+new URLSearchParams({...filters(),page:1,page_size:100})):result;
    if(version!==state.loadVersion)return;map.setEvents(mapResult.items);
    if(mapResult.total>100)$('#map-count').textContent+=' · 前100场';
    imageFallback();
  }catch(error){if(version!==state.loadVersion)return;state.events=[];map.setEvents([]);$('#event-list').innerHTML=`<div class="empty-state"><h3>查询未完成</h3><p>${esc(error.message)}</p></div>`;$('#result-summary').textContent='请调整筛选条件后重试';$('#pagination').innerHTML='';}
}
async function toggleFavorite(id){
  if(!state.user){loginDialog();return;}
  try{const event=state.events.find(e=>e.id===id)||await api(`/api/events/${id}`);await api(`/api/me/favorites/${id}`,{method:event.is_favorite?'DELETE':'POST',body:{}});toast(event.is_favorite?'已取消收藏':'已加入我的收藏');if(['explore','map','favorites'].includes(state.view))await loadEvents();if(modal.open&&$('#detail-favorite'))await detailDialog(id);}
  catch(error){toast(error.message,true);}
}
document.addEventListener('click',e=>{const detail=e.target.closest('[data-detail]'),fav=e.target.closest('[data-favorite]');if(detail)detailDialog(Number(detail.dataset.detail));if(fav)toggleFavorite(Number(fav.dataset.favorite));});
async function detailDialog(id){
  try{const e=await api(`/api/events/${id}`);openModal(`<img class="modal-image" src="${esc(e.cover_image)}" alt="${esc(e.title)}封面"><div class="modal-content-inner"><span class="eyebrow">${esc(e.city)} · RACE DETAILS</span><h2>${esc(e.title)}</h2><div class="detail-tags"><span class="badge">${esc(e.race_distances)}</span>${e.is_demo?'<span class="badge draft">虚构示例赛事</span>':''}</div><div class="detail-info"><div><span>赛事日期</span>${esc(e.start_date)} 至 ${esc(e.end_date)}</div><div><span>主办方</span>${esc(e.organizer)}</div><div><span>比赛地点</span>${esc(e.venue_name)}</div><div><span>地址</span>${esc(e.address)}</div></div><p class="detail-description">${esc(e.description)}</p><p class="caption muted">WGS84 坐标：${e.longitude}, ${e.latitude}</p><div class="hero-actions"><button class="button" id="detail-favorite" data-favorite="${e.id}">${e.is_favorite?'♥ 取消收藏':'♡ 收藏赛事'}</button><button class="button ghost" id="detail-map">在地图查看 ↗</button></div></div>`);imageFallback(modal);$('#detail-map').onclick=async()=>{modal.close();history.replaceState(null,'','#map');await route();if(!map.events.some(item=>item.id===e.id))map.setEvents([...map.events,e],false);map.center={lng:e.longitude,lat:e.latitude};map.zoom=9;map.select(e.id);map.render();$('#event-map').scrollIntoView({behavior:'smooth',block:'center'});};}
  catch(error){toast(error.message,true);}
}
function renderRules(){
  $('#rule-list').innerHTML=state.rules.map((r,i)=>`<article class="rule-card" id="rule-${r.id}"><span class="eyebrow">KNOWLEDGE ${String(i+1).padStart(2,'0')}</span><h3>${esc(r.title)}</h3><p>${esc(r.content)}</p><div class="rule-source">${r.is_demo?'示例资料 · ':''}${esc(r.source_label)}<br>更新于 ${esc(r.updated_at.slice(0,10))}</div></article>`).join('');
}
async function askQuestion(question){
  if(state.chatBusy)return;const input=$('#chat-input');question=question.trim();if(!question)return;
  state.chatBusy=true;input.value='';$('#chat-form button').disabled=true;
  const messages=$('#chat-messages');messages.insertAdjacentHTML('beforeend',`<div class="chat-message user"><p>${esc(question)}</p></div><div class="chat-message assistant" id="pending-answer"><span class="chat-label">舟行助手</span><p>正在检索资料与查询赛事…</p></div>`);messages.scrollTop=messages.scrollHeight;
  try{const result=await api('/api/assistant/query',{method:'POST',body:{question,location:formLocation()}});
    $('#pending-answer').innerHTML=`<span class="chat-label">舟行助手</span><p>${esc(result.answer)}</p>${result.sources.length?`<div class="chat-sources">${result.sources.map((s,i)=>`<a href="#rules/${s.id}">[${i+1}] ${esc(s.title)} ↗</a>`).join('')}</div>`:''}${result.events.length?`<div class="chat-events">${result.events.map(e=>`<button class="chat-event" data-detail="${e.id}"><strong>${esc(e.title)}</strong><span>${esc(e.city)} · ${esc(e.start_date)}${e.distance_km!==null?` · ${e.distance_km}km`:''}${e.is_demo?' · 示例':''}</span></button>`).join('')}</div>`:''}<div class="chat-meta">${esc(result.notice)} · ${result.elapsed_ms} ms</div>`;
    $('#pending-answer').removeAttribute('id');
  }catch(error){$('#pending-answer').innerHTML=`<span class="chat-label">舟行助手</span><p>${esc(error.message)}。请稍后重新发送。</p>`;$('#pending-answer').removeAttribute('id');}
  finally{state.chatBusy=false;$('#chat-form button').disabled=false;messages.scrollTop=messages.scrollHeight;}
}
$('#chat-form').onsubmit=e=>{e.preventDefault();askQuestion($('#chat-input').value);};
$('#chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();askQuestion(e.currentTarget.value);}});
document.querySelectorAll('[data-question]').forEach(b=>b.onclick=()=>askQuestion(b.dataset.question));
function venueOptions(selected){return state.venues.map(v=>`<option value="${v.id}" ${Number(selected)===v.id?'selected':''}>${esc(v.city)} · ${esc(v.name)}</option>`).join('');}
function editEvent(event=null){
  if(state.user?.role!=='admin')return loginDialog();
  const isEditing=Boolean(event?.id);
  const e=event||{title:'',venue_id:state.venues[0]?.id,start_date:state.config.today,end_date:state.config.today,organizer:'',race_distances:'200米 / 500米',description:'',cover_image:'/assets/river.svg',status:'published',is_demo:true};
  openModal(`<div class="modal-content-inner"><span class="eyebrow">CREATE A NEW JOURNEY</span><h2>${isEditing?'编辑赛事':'发布一场赛事'}</h2><p class="muted">先选择比赛地点，再填写日程。发布后即可在列表和地图看到。</p><form id="event-form" class="form-grid"><label class="full">赛事名称<input name="title" value="${esc(e.title)}" maxlength="120" required></label><label class="full">比赛地点<select name="venue_id" required>${venueOptions(e.venue_id)}</select><button class="text-link" type="button" id="venue-from-event">需要新地点？先新增地点 →</button></label><label>开始日期<input type="date" name="start_date" value="${esc(e.start_date)}" required></label><label>结束日期<input type="date" name="end_date" value="${esc(e.end_date)}" required></label><label>主办方<input name="organizer" value="${esc(e.organizer)}" maxlength="120" required></label><label>竞赛项目<input name="race_distances" value="${esc(e.race_distances)}" maxlength="100" required></label><label class="full">赛事介绍<textarea name="description" rows="4" maxlength="5000" required>${esc(e.description)}</textarea></label><label class="full">封面图片路径<input name="cover_image" value="${esc(e.cover_image)}" required maxlength="500" list="cover-options"><datalist id="cover-options">${['river','lake','wetland','city','sunset'].map(n=>`<option value="/assets/${n}.svg">`).join('')}</datalist></label><label>发布状态<select name="status"><option value="published" ${e.status==='published'?'selected':''}>已发布</option><option value="draft" ${e.status==='draft'?'selected':''}>草稿（仅管理员可见）</option></select></label><label class="checkbox-label"><input type="checkbox" name="is_demo" ${e.is_demo?'checked':''}>标记为虚构示例赛事</label><p class="form-error" id="event-error" role="alert"></p><div class="form-actions"><button type="button" class="button ghost" id="event-cancel">取消</button><button class="button" type="submit">${isEditing?'保存修改':'保存赛事'}</button></div></form></div>`);
  $('#event-cancel').onclick=()=>modal.close();
  $('#venue-from-event').onclick=()=>{const draft=Object.fromEntries(new FormData($('#event-form')));draft.is_demo=$('#event-form').elements.is_demo.checked;editVenue(null,()=>editEvent(event?{...event,...draft}:draft));};
  $('#event-form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,button=form.querySelector('[type=submit]'),p=Object.fromEntries(new FormData(form));p.is_demo=form.elements.is_demo.checked;button.disabled=true;$('#event-error').textContent='';try{await api('/api/admin/events'+(event?.id?`/${event.id}`:''),{method:event?.id?'PATCH':'POST',body:p});modal.close();toast('赛事已保存，发布状态已同步');await loadAdmin();}catch(error){$('#event-error').textContent=error.message;}finally{button.disabled=false;}};
}
function editVenue(venue=null,after=null){
  const v=venue||{name:'',city:'',address:'',longitude:118.792,latitude:32.023,description:''};
  openModal(`<div class="modal-content-inner"><span class="eyebrow">A PLACE TO BEGIN</span><h2>${venue?'编辑比赛地点':'新增比赛地点'}</h2><p class="muted">请填写 WGS84 经纬度，地图将按此坐标定位。</p><form id="venue-form" class="form-grid"><label class="full">地点名称<input name="name" value="${esc(v.name)}" required maxlength="100"></label><label>城市<input name="city" value="${esc(v.city)}" required maxlength="40"></label><label>地址<input name="address" value="${esc(v.address)}" required maxlength="200"></label><label>经度<input type="number" name="longitude" value="${v.longitude}" step="any" min="-180" max="180" required></label><label>纬度<input type="number" name="latitude" value="${v.latitude}" step="any" min="-85" max="85" required></label><label class="full">地点介绍<textarea name="description" rows="3" maxlength="1000">${esc(v.description)}</textarea></label><p id="venue-error" class="form-error" role="alert"></p><div class="form-actions"><button class="button" type="submit">保存地点</button></div></form></div>`);
  $('#venue-form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;try{const saved=await api('/api/admin/venues'+(venue?`/${venue.id}`:''),{method:venue?'PATCH':'POST',body:Object.fromEntries(new FormData(form))});state.venues=(await api('/api/venues')).items;renderFilterChoices();if(after){after();$('#event-form').elements.venue_id.value=saved.id;}else{modal.close();await loadAdmin();}toast('比赛地点已保存');}catch(error){$('#venue-error').textContent=error.message;}finally{button.disabled=false;}};
}
function editRule(rule=null){
  const r=rule||{title:'',content:'',tags:'',source_label:'管理员提供的资料',is_demo:true};
  openModal(`<div class="modal-content-inner"><span class="eyebrow">KNOWLEDGE WITH A SOURCE</span><h2>${rule?'编辑知识资料':'新增知识资料'}</h2><form id="rule-form" class="form-grid"><label class="full">资料标题<input name="title" value="${esc(r.title)}" required maxlength="150"></label><label class="full">正文<textarea name="content" rows="8" required maxlength="12000">${esc(r.content)}</textarea></label><label class="full">检索关键词（逗号分隔）<input name="tags" value="${esc(r.tags)}" required maxlength="300"></label><label class="full">来源 / 文件名称 / 章节<input name="source_label" value="${esc(r.source_label)}" required maxlength="200"></label><label class="checkbox-label full"><input name="is_demo" type="checkbox" ${r.is_demo?'checked':''}>示例资料（非正式竞赛文件）</label><p id="rule-error" class="form-error" role="alert"></p><div class="form-actions"><button class="button" type="submit">保存资料</button></div></form></div>`);
  $('#rule-form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,button=form.querySelector('[type=submit]'),p=Object.fromEntries(new FormData(form));p.is_demo=form.elements.is_demo.checked;button.disabled=true;try{await api('/api/admin/rules'+(rule?`/${rule.id}`:''),{method:rule?'PATCH':'POST',body:p});state.rules=(await api('/api/rules')).items;renderRules();modal.close();await loadAdmin();toast('资料已保存，可以向助手提问');}catch(error){$('#rule-error').textContent=error.message;}finally{button.disabled=false;}};
}
function confirmDelete(title,action){openModal(`<div class="modal-content-inner"><span class="eyebrow">CONFIRM ACTION</span><h2>删除${esc(title)}？</h2><p class="muted">删除赛事会同时清理其收藏记录。此操作会修改数据库。</p><div class="hero-actions"><button class="button danger" id="confirm-delete">确认删除</button><button class="button ghost" id="cancel-delete">取消</button></div></div>`);$('#cancel-delete').onclick=()=>modal.close();$('#confirm-delete').onclick=async()=>{try{await action();modal.close();await loadAdmin();toast('已删除');}catch(error){toast(error.message,true);}};}
async function loadAdmin(){
  const allowed=state.user?.role==='admin';$('#admin-content').hidden=!allowed;$('#new-event').hidden=!allowed;
  $('#admin-gate').innerHTML=allowed?'':`<div class="empty-state"><h3>管理工作台需要管理员登录</h3><p>演示管理员：admin / Admin@12345</p><button class="button" data-action="login">切换账号 / 登录</button></div>`;if(!allowed)return;
  try{const [overview,events,venues,rules]=await Promise.all([api('/api/admin/overview'),api('/api/admin/events?page_size=100&sort=newest'),api('/api/venues'),api('/api/rules')]);state.adminEvents=events.items;state.venues=venues.items;state.rules=rules.items;renderFilterChoices();renderRules();
    $('#admin-stats').innerHTML=[['赛事记录',overview.events],['比赛地点',overview.venues],['注册用户',overview.users],['助手查询',overview.questions]].map(([label,value])=>`<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join('');
    $('#admin-event-rows').innerHTML=events.items.length?events.items.map(e=>`<tr><td><strong>${esc(e.title)}</strong><small>${esc(e.city)} · ${esc(e.venue_name)}${e.is_demo?' · 示例':''}</small></td><td>${esc(e.start_date)}<small>至 ${esc(e.end_date)}</small></td><td><span class="badge ${e.status==='draft'?'draft':''}">${e.status==='published'?'已发布':'草稿'}</span></td><td><button class="text-link" data-edit-event="${e.id}">编辑</button><button class="text-link" data-delete-event="${e.id}">删除</button></td></tr>`).join(''):'<tr><td colspan="4">暂时没有赛事，点击右上角发布。</td></tr>';
    $('#admin-venue-list').innerHTML=state.venues.map(v=>`<article class="management-card"><span class="badge">${esc(v.city)}</span><h3>${esc(v.name)}</h3><p>${esc(v.address)}<br>${v.longitude}, ${v.latitude}</p><button class="text-link" data-edit-venue="${v.id}">编辑地点</button><button class="text-link" data-delete-venue="${v.id}">删除</button></article>`).join('');
    $('#admin-rule-list').innerHTML=state.rules.map(r=>`<article class="management-card"><span class="badge">${r.is_demo?'示例资料':'知识资料'}</span><h3>${esc(r.title)}</h3><p>${esc(r.source_label)}</p><button class="text-link" data-edit-rule="${r.id}">编辑资料 →</button></article>`).join('');
    $('#admin-activity-content').innerHTML=`<div class="activity-panel"><h3>最近的助手查询</h3><p class="muted">记录查询模式、耗时及结果数量，不保存问题正文。</p><ul>${overview.recent_queries.length?overview.recent_queries.map(q=>`<li>${q.engine==='local'?'本地查询':'大模型'} · ${q.elapsed_ms} ms · ${q.event_count}场赛事 · ${q.source_count}条资料${q.token_count?` · ${q.token_count} tokens`:''}<br><small>${esc(q.created_at)}</small></li>`).join(''):'<li>暂无查询记录</li>'}</ul></div><div class="activity-panel"><h3>用户反馈</h3><ul>${overview.feedback.length?overview.feedback.map(f=>`<li>${esc(f.content)}<br><small>${esc(f.display_name)} · ${esc(f.created_at)}</small></li>`).join(''):'<li>暂无反馈</li>'}</ul></div>`;
  }catch(error){toast(error.message,true);}
}
$('#new-event').onclick=()=>editEvent();$('#new-venue').onclick=()=>editVenue();$('#new-rule').onclick=()=>editRule();
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-edit-event],[data-delete-event],[data-edit-venue],[data-delete-venue],[data-edit-rule]');if(!b)return;
  if(b.dataset.editEvent)editEvent(state.adminEvents.find(ev=>ev.id===Number(b.dataset.editEvent)));
  if(b.dataset.deleteEvent)confirmDelete('这场赛事',()=>api(`/api/admin/events/${b.dataset.deleteEvent}`,{method:'DELETE'}));
  if(b.dataset.editVenue)editVenue(state.venues.find(v=>v.id===Number(b.dataset.editVenue)));
  if(b.dataset.deleteVenue)confirmDelete('这个地点',()=>api(`/api/admin/venues/${b.dataset.deleteVenue}`,{method:'DELETE'}));
  if(b.dataset.editRule)editRule(state.rules.find(r=>r.id===Number(b.dataset.editRule)));
});
document.querySelectorAll('[data-admin-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-admin-tab]').forEach(b=>b.classList.toggle('active',b===button));for(const tab of ['events','venues','rules','activity'])$(`#admin-${tab}`).hidden=tab!==button.dataset.adminTab;});
$('#feedback-button').onclick=()=>{if(!state.user)return loginDialog();openModal('<div class="modal-content-inner"><span class="eyebrow">YOUR VOICE MATTERS</span><h2>让舟行更好一点</h2><form id="feedback-form" class="auth-form"><label>反馈内容<textarea name="content" required minlength="5" maxlength="2000" rows="5" placeholder="告诉我们你的使用体验或改进建议"></textarea></label><p class="form-error" id="feedback-error"></p><button class="button" type="submit">提交反馈</button></form></div>');$('#feedback-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/feedback',{method:'POST',body:Object.fromEntries(new FormData(e.currentTarget))});modal.close();toast('反馈已保存，管理员可在工作台查看');}catch(error){$('#feedback-error').textContent=error.message;}};};
async function route(){
  const [raw,id]=location.hash.replace(/^#/,'').split('/');const view=['explore','map','favorites','assistant','rules','admin'].includes(raw)?raw:'explore';state.view=view;
  for(const name of ['explore','assistant','rules','admin'])$(`#${name}-view`).hidden=name!==(['map','favorites'].includes(view)?'explore':view);
  $('#hero').hidden=view!=='explore';$('#explore-layout').classList.toggle('map-view-layout',view==='map');
  document.querySelectorAll('[data-view]').forEach(a=>a.classList.toggle('active',a.dataset.view===view));
  $('#events-heading').textContent=view==='favorites'?'把喜欢的赛事，留在这里':view==='map'?'换一个视角，发现下一站':'从这里，找到你的下一站';
  if(['explore','map','favorites'].includes(view)){state.page=1;await loadEvents();map.scheduleRender();}
  if(view==='admin')await loadAdmin();
  if(view==='rules'){document.querySelectorAll('.rule-card').forEach(r=>r.classList.toggle('highlight',r.id===`rule-${id}`));if(id)setTimeout(()=>$(`#rule-${CSS.escape(id)}`)?.scrollIntoView({behavior:'smooth',block:'center'}),50);}
}
window.addEventListener('hashchange',route);
async function start(){
  try{const [config,auth,venues,rules]=await Promise.all([api('/api/config'),api('/api/auth/me'),api('/api/venues'),api('/api/rules')]);state.config=config;state.user=auth.user;state.csrf=auth.csrf_token;state.venues=venues.items;state.rules=rules.items;map.configure(config);authUI();renderFilterChoices();renderRules();$('#filters').elements.start_date.value=config.today;$('#engine-badge').textContent=config.assistant_mode==='llm'?'大模型 + 查询工具':'本地知识检索';$('#chat-caption').textContent=config.assistant_mode==='llm'?'已配置模型服务，回答依据知识资料与只读查询工具。':'当前使用本地知识检索与查询工具；可在 .env 中配置大模型。';await route();imageFallback();}
  catch(error){for(const name of ['hero','explore-view','assistant-view','rules-view','admin-view'])$(`#${name}`).hidden=true;$('#fatal-error').hidden=false;$('#fatal-error').innerHTML=`<h3>暂时无法连接服务</h3><p>${esc(error.message)}</p><p>请确认已经运行 python server.py，然后刷新页面。</p>`;}
}
start();
