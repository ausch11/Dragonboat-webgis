// Small dependency-free Web Mercator map. All application coordinates are WGS84.
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function world(lng, lat, zoom) {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
  return {x:(lng + 180) / 360 * size, y:(.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size};
}
function coordinate(x, y, zoom) {
  const size = 256 * 2 ** zoom;
  return {lng:x / size * 360 - 180, lat:Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI};
}

export class EventMap {
  constructor(element, onSelect) {
    this.element = element;
    this.onSelect = onSelect;
    this.zoom = 5;
    this.center = {lng:118, lat:30.5};
    this.events = [];
    this.tiles = new Map();
    this.online = false;
    this.selected = null;
    this.element.innerHTML = `<div class="map-canvas"><svg class="map-svg" aria-hidden="true"></svg><div class="map-tiles"></div><div class="map-marker-layer"></div></div><button class="map-online">在线底图</button><div class="map-controls"><button data-map="in" aria-label="地图放大">＋</button><button data-map="out" aria-label="地图缩小">−</button><button data-map="fit">全览</button></div><div class="map-coordinate"></div><div class="map-attribution"></div><div class="map-info" hidden></div>`;
    this.svg = element.querySelector('.map-svg');
    this.tileLayer = element.querySelector('.map-tiles');
    this.markers = element.querySelector('.map-marker-layer');
    this.info = element.querySelector('.map-info');
    element.querySelector('.map-online').addEventListener('click', () => {
      this.online = !this.online;
      element.querySelector('.map-online').textContent = this.online ? '离线示意底图' : '在线底图';
      this.render();
    });
    element.querySelectorAll('[data-map]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.map === 'fit') this.fit();
      else this.zoom = Math.max(3, Math.min(14, this.zoom + (b.dataset.map === 'in' ? 1 : -1)));
      this.render();
    }));
    element.addEventListener('pointerdown', e => {
      if (e.target.closest('button,a,.map-info')) return;
      this.drag = {x:e.clientX,y:e.clientY,center:world(this.center.lng,this.center.lat,this.zoom)};
      element.setPointerCapture(e.pointerId);
    });
    element.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const c = coordinate(this.drag.center.x - e.clientX + this.drag.x, this.drag.center.y - e.clientY + this.drag.y, this.zoom);
      this.center = {lng:Math.max(-179, Math.min(179, c.lng)), lat:Math.max(-80, Math.min(80, c.lat))};
      this.scheduleRender();
    });
    const finish = () => { this.drag = null; };
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    this.observer = new ResizeObserver(() => this.scheduleRender());
    this.observer.observe(element);
  }

  configure(config) { this.config = config; }
  scheduleRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {this.frame = null; this.render();});
  }
  setEvents(events, fit=true) { this.events = events; this.info.hidden = true; if (fit) this.fit(); this.render(); }
  fit() {
    if (!this.events.length) {this.center = {lng:118,lat:30.5};this.zoom=5;return;}
    const points = this.events.map(e => world(e.longitude,e.latitude,0));
    const minX=Math.min(...points.map(p=>p.x)), maxX=Math.max(...points.map(p=>p.x));
    const minY=Math.min(...points.map(p=>p.y)), maxY=Math.max(...points.map(p=>p.y));
    this.center = coordinate((minX+maxX)/2,(minY+maxY)/2,0);
    this.center = {lng:this.center.lng,lat:this.center.lat};
    const w=Math.max(250,this.element.clientWidth)-90,h=Math.max(300,this.element.clientHeight)-120;
    this.zoom = Math.max(3, Math.min(9, Math.floor(Math.log2(Math.min(w / Math.max(1,maxX-minX),h / Math.max(1,maxY-minY))))));
  }
  position(lng, lat) {
    const c=world(this.center.lng,this.center.lat,this.zoom), p=world(lng,lat,this.zoom);
    return {x:p.x-c.x+this.element.clientWidth/2,y:p.y-c.y+this.element.clientHeight/2};
  }
  path(points) {return points.map(([lng,lat],i)=>{const p=this.position(lng,lat);return `${i?'L':'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;}).join(' ');}
  select(id, openInfo=true) {
    this.selected = id;
    const event=this.events.find(e=>e.id===id);
    if(event && openInfo) this.showInfo(event);
    this.renderMarkers();
  }
  showInfo(event, members=null) {
    const atVenue=members||this.events.filter(e=>e.venue_id===event.venue_id);
    this.info.innerHTML=`<button class="close" aria-label="关闭地图信息">×</button><h4>${esc(members?'附近赛事':event.venue_name)}</h4><div class="muted">${esc(event.city)} · ${atVenue.length} 场赛事</div>${atVenue.slice(0,6).map(e=>`<div><button data-event-id="${e.id}">${esc(e.title)} →</button></div>`).join('')}`;
    this.info.hidden=false;
    this.info.querySelector('.close').onclick=()=>{this.info.hidden=true;};
    this.info.querySelectorAll('[data-event-id]').forEach(b=>b.onclick=()=>this.onSelect(Number(b.dataset.eventId)));
  }
  render() {
    if (!this.element.clientWidth || !this.element.clientHeight) return;
    const w=this.element.clientWidth,h=this.element.clientHeight;
    this.svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
    const coast=[[101,18],[109,18],[109.5,20],[110.8,21],[113,22.7],[116,23],[118,24.5],[119.7,26],[121.2,28],[121.8,30],[121.7,31.2],[120.5,32.6],[120.1,34],[119,35.5],[121.8,37],[122.8,39],[127,41.5],[127,50],[101,50]];
    const rivers=[[[103,31],[108,30],[111,30.4],[114.3,30.5],[116,29.7],[117.5,30.4],[118.8,32],[120,32],[121.8,31.5]],[[112,35],[115,36],[117,37],[119,37.5]]];
    const grid=[];
    for(let lng=-180;lng<=180;lng+=2){const p=this.position(lng,this.center.lat);if(p.x>=0&&p.x<=w)grid.push(`<path d="M${p.x},0V${h}"/><text x="${p.x+4}" y="${h-13}">${lng}°E</text>`);}
    for(let lat=-80;lat<=80;lat+=2){const p=this.position(this.center.lng,lat);if(p.y>=0&&p.y<=h)grid.push(`<path d="M0,${p.y}H${w}"/><text x="5" y="${p.y-5}">${lat}°N</text>`);}
    const labels=[['南京',118.792,32.023],['杭州',120.062,30.267],['上海',121.47,31.23],['武汉',114.396,30.552],['福州',119.302,26.048],['盐城',120.139,33.365]];
    this.svg.innerHTML=`<rect width="100%" height="100%" fill="#dde9e5"/><path d="${this.path(coast)}Z" fill="#eef1e4"/><g fill="none" stroke="#b7d4cd" stroke-width="${Math.max(3,this.zoom-1)}" stroke-linejoin="round">${rivers.map(r=>`<path d="${this.path(r)}"/>`).join('')}</g><g fill="#91a79a" stroke="#cedcd0" stroke-width=".6" font-size="8" font-family="sans-serif">${grid.join('')}</g><g fill="#89a18d" font-size="10" font-family="sans-serif">${labels.map(([name,lng,lat])=>{const p=this.position(lng,lat);return `<text x="${p.x+18}" y="${p.y-15}">${name}</text>`;}).join('')}</g><text x="${w-20}" y="${h-55}" text-anchor="end" fill="#abc0b8" font-size="25" font-family="serif" letter-spacing="5">江 湖 之 间</text>`;
    this.element.querySelector('.map-coordinate').textContent=`中心 ${this.center.lng.toFixed(3)}, ${this.center.lat.toFixed(3)} · 缩放 ${this.zoom}`;
    this.renderTiles();
    this.renderMarkers();
    const mode=document.querySelector('#map-mode');
    if(mode)mode.textContent=this.online?'在线底图 / 失败时显示示意底图':'离线示意底图';
  }
  renderTiles() {
    this.tileLayer.hidden=!this.online;
    const attribution=this.element.querySelector('.map-attribution');
    if(!this.online){attribution.textContent='自绘示意底图 · 非测绘底图';return;}
    attribution.innerHTML=`<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">${esc(this.config?.tile_attribution || '© OpenStreetMap contributors')}</a>`;
    const c=world(this.center.lng,this.center.lat,this.zoom),w=this.element.clientWidth,h=this.element.clientHeight;
    const left=c.x-w/2,top=c.y-h/2,n=2**this.zoom,visible=new Set();
    const template=this.config?.tile_url;
    if(!template){this.online=false;return;}
    for(let x=Math.floor(left/256);x<=Math.floor((left+w)/256);x++){
      for(let y=Math.floor(top/256);y<=Math.floor((top+h)/256);y++){
        if(y<0||y>=n)continue;
        const tx=((x%n)+n)%n,key=`${this.zoom}/${x}/${y}`;visible.add(key);
        let img=this.tiles.get(key);
        if(!img){img=document.createElement('img');img.alt='';img.draggable=false;img.src=template.replace('{z}',this.zoom).replace('{x}',tx).replace('{y}',y);img.onerror=()=>{img.style.visibility='hidden';};this.tiles.set(key,img);this.tileLayer.append(img);}
        img.style.left=`${x*256-left}px`;img.style.top=`${y*256-top}px`;
      }
    }
    for(const [key,img] of this.tiles){if(!visible.has(key)){img.remove();this.tiles.delete(key);}}
  }
  renderMarkers() {
    const venues=new Map(),groups=[];
    for(const e of this.events){if(!venues.has(e.venue_id))venues.set(e.venue_id,[]);venues.get(e.venue_id).push(e);}
    for(const members of venues.values()){
      const e=members[0],p=this.position(e.longitude,e.latitude);
      const cluster=groups.find(g=>Math.hypot(g.x-p.x,g.y-p.y)<30);
      if(cluster){cluster.events.push(...members);cluster.points.push(p);cluster.x=cluster.points.reduce((a,v)=>a+v.x,0)/cluster.points.length;cluster.y=cluster.points.reduce((a,v)=>a+v.y,0)/cluster.points.length;}
      else groups.push({events:[...members],points:[p],x:p.x,y:p.y});
    }
    this.markers.innerHTML=groups.map((group,i)=>{
      const events=group.events,e=events[0],active=events.some(ev=>ev.id===this.selected);
      const cities=[...new Set(events.map(ev=>ev.city))],label=cities.length>1?`${cities[0]}等${cities.length}城`:cities[0];
      return `<button class="map-marker ${active?'active':''}" data-cluster="${i}" style="left:${group.x}px;top:${group.y}px" aria-label="${esc(label)}，${events.length}场赛事">${events.length>1?events.length:'•'}</button><span class="map-marker-label" style="left:${group.x}px;top:${group.y}px">${esc(label)}</span>`;
    }).join('');
    this.markers.querySelectorAll('[data-cluster]').forEach(b=>b.addEventListener('click',()=>{
      const group=groups[Number(b.dataset.cluster)],e=group.events[0];
      if(group.points.length>1&&this.zoom<14){const c=world(this.center.lng,this.center.lat,this.zoom);this.center=coordinate(c.x+group.x-this.element.clientWidth/2,c.y+group.y-this.element.clientHeight/2,this.zoom);this.zoom=Math.min(14,this.zoom+2);this.info.hidden=true;this.render();}
      else{this.selected=e.id;this.showInfo(e,group.points.length>1?group.events:null);this.renderMarkers();this.onSelect(e.id,true);}
    }));
    const count=document.querySelector('#map-count');if(count)count.textContent=`${venues.size} 个地点`;
  }
}
