(() => {
'use strict';

const $ = s => document.querySelector(s);
const E = {
  canvas: $('#game'),
  board: $('#board'),
  palette: $('#palette'),
  progress: $('#progressBar'),
  status: $('#status'),
  done: $('#done'),
  note: $('#note'),
  upload: $('#upload'),
  uploadBtn: $('#uploadBtn'),
  resetBtn: $('#resetBtn'),
  againBtn: $('#againBtn')
};

const ctx = E.canvas.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', {willReadFrequently:true});
const raster = document.createElement('canvas');
const rctx = raster.getContext('2d');

const S = {
  image:null,
  imageUrl:null,
  W:0,H:0,
  source:null,
  labels:null,
  regions:[],
  regionMap:null,
  palette:[],
  selected:0,
  filledCount:0,
  total:0,
  ready:false,
  fit:{x:0,y:0,w:1,h:1}
};

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const rgb=c=>`rgb(${c[0]},${c[1]},${c[2]})`;
const colorDist=(a,b)=>{
  const dr=a[0]-b[0],dg=a[1]-b[1],db=a[2]-b[2];
  return dr*dr*.8+dg*dg+db*db*.7;
};
const tick=()=>new Promise(r=>requestAnimationFrame(r));

function showStatus(text){
  E.status.textContent=text;
  E.status.classList.remove('hide');
}
function hideStatus(){E.status.classList.add('hide')}

function loadImage(src){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>resolve(img);
    img.onerror=reject;
    img.src=src;
  });
}

async function useSource(src){
  S.ready=false;
  showStatus('画像を読み込んでいます…');
  E.done.classList.remove('show');
  try{
    S.image=await loadImage(src);
    await buildPuzzle();
  }catch(err){
    console.error(err);
    showStatus('画像を読み込めませんでした');
  }
}

async function buildPuzzle(){
  showStatus('色を8色にまとめています…');
  await tick();

  const maxW=200,maxH=356;
  const ar=S.image.naturalWidth/S.image.naturalHeight;
  let W,H;
  if(ar>=maxW/maxH){W=maxW;H=Math.max(120,Math.round(W/ar))}
  else{H=maxH;W=Math.max(120,Math.round(H*ar))}
  S.W=W;S.H=H;

  work.width=W;work.height=H;
  wctx.clearRect(0,0,W,H);
  wctx.fillStyle='#fff';
  wctx.fillRect(0,0,W,H);
  wctx.drawImage(S.image,0,0,W,H);

  // 軽い平滑化。細かな色ムラを先に丸める。
  let img=wctx.getImageData(0,0,W,H);
  img=boxBlur(img,W,H,1);
  S.source=img.data;

  const samples=[];
  const N=W*H;
  const stride=Math.max(1,Math.floor(N/9000));
  for(let i=0;i<N;i+=stride){
    const p=i*4;
    samples.push([S.source[p],S.source[p+1],S.source[p+2]]);
  }

  let centers=seedCenters(samples,8);
  for(let i=0;i<10;i++) centers=kMeansStep(samples,centers);

  let labels=new Int16Array(N);
  for(let i=0;i<N;i++){
    const p=i*4;
    const c=[S.source[p],S.source[p+1],S.source[p+2]];
    let best=0,bd=Infinity;
    for(let k=0;k<centers.length;k++){
      const d=colorDist(c,centers[k]);
      if(d<bd){bd=d;best=k}
    }
    labels[i]=best;
  }

  // 量子化後の1pxノイズを多数決で消す。
  labels=majoritySmooth(labels,W,H,3);

  showStatus('小さな領域をまとめています…');
  await tick();

  // 小片は、接している領域のうち境界が長く、色も近い側へ統合。
  const minArea=Math.max(70,Math.round(N*0.0017));
  for(let pass=0;pass<6;pass++){
    const changed=mergeSmall(labels,centers,W,H,minArea);
    labels=majoritySmooth(labels,W,H,1);
    if(!changed)break;
  }

  S.labels=labels;
  S.palette=centers.map(c=>c.map(v=>Math.round(v)));

  showStatus('番号を置いています…');
  await tick();

  makeRegions();
  compactPalette();
  resetPuzzle();
  renderPalette();
  resize();
  S.ready=true;
  hideStatus();
}

function boxBlur(image,W,H,r){
  const src=image.data;
  const out=new ImageData(W,H);
  const dst=out.data;
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      let sr=0,sg=0,sb=0,n=0;
      for(let yy=Math.max(0,y-r);yy<=Math.min(H-1,y+r);yy++){
        for(let xx=Math.max(0,x-r);xx<=Math.min(W-1,x+r);xx++){
          const p=(yy*W+xx)*4;
          sr+=src[p];sg+=src[p+1];sb+=src[p+2];n++;
        }
      }
      const p=(y*W+x)*4;
      dst[p]=sr/n;dst[p+1]=sg/n;dst[p+2]=sb/n;dst[p+3]=255;
    }
  }
  return out;
}

function seedCenters(samples,k){
  const centers=[samples[Math.floor(samples.length*.37)].slice()];
  while(centers.length<k){
    let pick=samples[0],best=-1;
    const stride=Math.max(1,Math.floor(samples.length/2200));
    for(let i=0;i<samples.length;i+=stride){
      const s=samples[i];
      let nearest=Infinity;
      for(const c of centers)nearest=Math.min(nearest,colorDist(s,c));
      if(nearest>best){best=nearest;pick=s}
    }
    centers.push(pick.slice());
  }
  return centers;
}

function kMeansStep(samples,centers){
  const sums=centers.map(()=>[0,0,0,0]);
  for(const s of samples){
    let bi=0,bd=Infinity;
    for(let k=0;k<centers.length;k++){
      const d=colorDist(s,centers[k]);
      if(d<bd){bd=d;bi=k}
    }
    const z=sums[bi];
    z[0]+=s[0];z[1]+=s[1];z[2]+=s[2];z[3]++;
  }
  return centers.map((c,i)=>{
    const z=sums[i];
    return z[3]?[z[0]/z[3],z[1]/z[3],z[2]/z[3]]:c;
  });
}

function majoritySmooth(labels,W,H,passes){
  let cur=labels;
  for(let pass=0;pass<passes;pass++){
    const out=new Int16Array(cur);
    for(let y=1;y<H-1;y++){
      for(let x=1;x<W-1;x++){
        const i=y*W+x;
        const count=new Int16Array(8);
        for(let yy=-1;yy<=1;yy++){
          for(let xx=-1;xx<=1;xx++){
            count[cur[(y+yy)*W+x+xx]]++;
          }
        }
        let best=cur[i],n=count[best];
        for(let k=0;k<8;k++)if(count[k]>n){n=count[k];best=k}
        if(n>=5)out[i]=best;
      }
    }
    cur=out;
  }
  return cur;
}

function components(labels,W,H){
  const N=W*H;
  const map=new Int32Array(N);map.fill(-1);
  const queue=new Int32Array(N);
  const comps=[];
  let id=0;

  for(let start=0;start<N;start++){
    if(map[start]>=0)continue;
    const label=labels[start];
    let head=0,tail=0;
    queue[tail++]=start;
    map[start]=id;
    const pixels=[];

    while(head<tail){
      const i=queue[head++];
      pixels.push(i);
      const x=i%W;
      if(x>0)visit(i-1);
      if(x<W-1)visit(i+1);
      if(i>=W)visit(i-W);
      if(i<N-W)visit(i+W);

      function visit(n){
        if(map[n]<0&&labels[n]===label){
          map[n]=id;
          queue[tail++]=n;
        }
      }
    }
    comps.push({id,label,pixels,area:pixels.length});
    id++;
  }
  return {map,comps};
}

function mergeSmall(labels,centers,W,H,minArea){
  const {map,comps}=components(labels,W,H);
  const small=comps.filter(c=>c.area<minArea);
  if(!small.length)return false;

  const out=new Int16Array(labels);
  let changed=false;

  for(const c of small){
    const neighbors=new Map();

    for(const i of c.pixels){
      const x=i%W;
      const ns=[];
      if(x>0)ns.push(i-1);
      if(x<W-1)ns.push(i+1);
      if(i>=W)ns.push(i-W);
      if(i<W*H-W)ns.push(i+W);

      for(const n of ns){
        const cid=map[n];
        if(cid===c.id)continue;
        const other=comps[cid];
        if(!other)continue;
        const key=other.label;
        neighbors.set(key,(neighbors.get(key)||0)+1);
      }
    }

    let bestLabel=-1,bestScore=-Infinity;
    for(const [label,boundary] of neighbors){
      const dist=Math.sqrt(colorDist(centers[c.label],centers[label]));
      const score=boundary*8-dist*.08;
      if(score>bestScore){bestScore=score;bestLabel=label}
    }

    if(bestLabel>=0&&bestLabel!==c.label){
      for(const i of c.pixels)out[i]=bestLabel;
      changed=true;
    }
  }

  labels.set(out);
  return changed;
}

function makeRegions(){
  const W=S.W,H=S.H,N=W*H;
  const {map,comps}=components(S.labels,W,H);
  const regions=comps.map(c=>({
    id:c.id,color:c.label,pixels:c.pixels,area:c.area,filled:false,
    minX:W,minY:H,maxX:0,maxY:0,labelX:0,labelY:0
  }));

  for(const r of regions){
    for(const i of r.pixels){
      const x=i%W,y=(i/W)|0;
      if(x<r.minX)r.minX=x;if(x>r.maxX)r.maxX=x;
      if(y<r.minY)r.minY=y;if(y>r.maxY)r.maxY=y;
    }
  }

  // 全領域を同時に距離変換。境界から最も遠い点を番号位置にする。
  const dist=new Uint16Array(N);
  dist.fill(65535);
  const queue=new Int32Array(N);
  let head=0,tail=0;

  for(let i=0;i<N;i++){
    const rid=map[i],x=i%W;
    let boundary=x===0||x===W-1||i<W||i>=N-W;
    if(!boundary){
      boundary=map[i-1]!==rid||map[i+1]!==rid||map[i-W]!==rid||map[i+W]!==rid;
    }
    if(boundary){dist[i]=0;queue[tail++]=i}
  }

  while(head<tail){
    const i=queue[head++],rid=map[i],x=i%W,nd=dist[i]+1;
    if(x>0)spread(i-1);
    if(x<W-1)spread(i+1);
    if(i>=W)spread(i-W);
    if(i<N-W)spread(i+W);
    function spread(n){
      if(map[n]===rid&&dist[n]>nd){
        dist[n]=nd;queue[tail++]=n;
      }
    }
  }

  for(const r of regions){
    let best=r.pixels[0],bd=-1;
    for(const i of r.pixels){
      if(dist[i]>bd){bd=dist[i];best=i}
    }
    r.labelX=best%W;
    r.labelY=(best/W)|0;
    r.labelRadius=bd;
  }

  S.regionMap=map;
  S.regions=regions;
  S.total=regions.length;
  raster.width=W;raster.height=H;
}

function compactPalette(){
  const used=[...new Set(S.regions.map(r=>r.color))].sort((a,b)=>a-b);
  const remap=new Map(used.map((v,i)=>[v,i]));
  S.palette=used.map(i=>S.palette[i]);
  for(const r of S.regions)r.color=remap.get(r.color);
  // S.labelsは描画色には使わずregionMap経由なので、ここでの再番号だけでよい。
}

function resetPuzzle(){
  for(const r of S.regions)r.filled=false;
  S.filledCount=0;
  S.selected=0;
  E.done.classList.remove('show');
  updateProgress();
  draw();
}

function colorFinished(c){
  let found=false;
  for(const r of S.regions){
    if(r.color===c){found=true;if(!r.filled)return false}
  }
  return found;
}

function renderPalette(){
  E.palette.textContent='';
  S.palette.forEach((c,i)=>{
    const b=document.createElement('button');
    b.className='swatch';
    b.style.background=rgb(c);
    const lum=c[0]*.299+c[1]*.587+c[2]*.114;
    b.style.color=lum<135?'#fff':'#43383b';
    b.textContent=i+1;
    if(i===S.selected)b.classList.add('selected');
    if(colorFinished(i))b.classList.add('finished');
    b.onclick=()=>{
      if(colorFinished(i))return;
      S.selected=i;
      renderPalette();
    };
    E.palette.appendChild(b);
  });
}

function updateProgress(){
  E.progress.style.width=(S.total?S.filledCount/S.total*100:0)+'%';
}

function resize(){
  const b=E.board.getBoundingClientRect();
  const d=Math.min(2,devicePixelRatio||1);
  E.canvas.width=Math.max(1,Math.round(b.width*d));
  E.canvas.height=Math.max(1,Math.round(b.height*d));
  draw();
}

function fit(){
  const cw=E.canvas.width,ch=E.canvas.height,ar=S.W/S.H;
  let w=cw,h=w/ar;
  if(h>ch){h=ch;w=h*ar}
  S.fit={x:(cw-w)/2,y:(ch-h)/2,w,h};
  return S.fit;
}

function draw(){
  if(!S.regionMap||!S.regions.length)return;
  const W=S.W,H=S.H,N=W*H;
  const image=rctx.createImageData(W,H),d=image.data;

  for(let i=0;i<N;i++){
    const rid=S.regionMap[i],r=S.regions[rid],p=i*4;
    const c=S.palette[r.color];
    if(r.filled){
      d[p]=c[0];d[p+1]=c[1];d[p+2]=c[2];
    }else{
      d[p]=252;d[p+1]=250;d[p+2]=247;
    }
    d[p+3]=255;
  }

  // 量子化された領域どうしの境界を線画として描く。
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i=y*W+x,rid=S.regionMap[i];
      let edge=false;
      if(x<W-1&&S.regionMap[i+1]!==rid)edge=true;
      if(y<H-1&&S.regionMap[i+W]!==rid)edge=true;
      if(edge){
        const p=i*4;
        d[p]=92;d[p+1]=82;d[p+2]=85;
      }
    }
  }

  // 元画像の濃いエッジを薄く重ね、顔や髪などの線を少し残す。
  for(let y=1;y<H-1;y++){
    for(let x=1;x<W-1;x++){
      const i=y*W+x,p=i*4;
      const lum=(q)=>{
        const z=q*4;
        return S.source[z]*.299+S.source[z+1]*.587+S.source[z+2]*.114;
      };
      const L=lum(i);
      const grad=Math.max(
        Math.abs(L-lum(i-1)),Math.abs(L-lum(i+1)),
        Math.abs(L-lum(i-W)),Math.abs(L-lum(i+W))
      );
      if(L<118&&grad>24){
        d[p]=82;d[p+1]=74;d[p+2]=77;
      }
    }
  }

  rctx.putImageData(image,0,0);
  const f=fit();
  ctx.clearRect(0,0,E.canvas.width,E.canvas.height);
  ctx.fillStyle='#fff';
  ctx.fillRect(0,0,E.canvas.width,E.canvas.height);
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(raster,f.x,f.y,f.w,f.h);
  drawNumbers(f);
}

function drawNumbers(f){
  const sx=f.w/S.W,sy=f.h/S.H;
  ctx.textAlign='center';
  ctx.textBaseline='middle';

  for(const r of S.regions){
    if(r.filled)continue;
    // 数字が読めない小領域は統合済みだが、念のため狭すぎる場所には表示しない。
    const radius=r.labelRadius*Math.min(sx,sy);
    if(radius<7*(devicePixelRatio||1))continue;

    const fs=clamp(radius*.95,10*(devicePixelRatio||1),17*(devicePixelRatio||1));
    const x=f.x+(r.labelX+.5)*sx;
    const y=f.y+(r.labelY+.5)*sy;
    ctx.font=`900 ${fs}px system-ui,sans-serif`;
    ctx.lineWidth=Math.max(2,fs*.2);
    ctx.strokeStyle='rgba(255,255,255,.95)';
    ctx.fillStyle='#62565a';
    ctx.strokeText(r.color+1,x,y);
    ctx.fillText(r.color+1,x,y);
  }
}

function pickRegion(ev){
  const rect=E.canvas.getBoundingClientRect();
  const scale=E.canvas.width/rect.width;
  const cx=(ev.clientX-rect.left)*scale;
  const cy=(ev.clientY-rect.top)*scale;
  const f=S.fit;
  if(cx<f.x||cy<f.y||cx>=f.x+f.w||cy>=f.y+f.h)return -1;
  const x=clamp(Math.floor((cx-f.x)/f.w*S.W),0,S.W-1);
  const y=clamp(Math.floor((cy-f.y)/f.h*S.H),0,S.H-1);
  return S.regionMap[y*S.W+x];
}

function tap(ev){
  if(!S.ready)return;
  const rid=pickRegion(ev);
  if(rid<0)return;
  const r=S.regions[rid];
  if(r.filled||r.color!==S.selected)return;

  r.filled=true;
  S.filledCount++;
  updateProgress();
  draw();

  if(colorFinished(S.selected)){
    const start=S.selected;
    for(let n=1;n<=S.palette.length;n++){
      const c=(start+n)%S.palette.length;
      if(!colorFinished(c)){S.selected=c;break}
    }
  }
  renderPalette();

  if(S.filledCount===S.total){
    E.done.classList.add('show');
  }
}

E.canvas.addEventListener('pointerdown',tap);
E.uploadBtn.onclick=()=>E.upload.click();
E.upload.onchange=async()=>{
  const file=E.upload.files&&E.upload.files[0];
  if(!file)return;
  if(S.imageUrl)URL.revokeObjectURL(S.imageUrl);
  S.imageUrl=URL.createObjectURL(file);
  await useSource(S.imageUrl);
};
E.resetBtn.onclick=()=>{if(S.regions.length){resetPuzzle();renderPalette()}};
E.againBtn.onclick=()=>{resetPuzzle();renderPalette()};
new ResizeObserver(resize).observe(E.board);
window.addEventListener('orientationchange',()=>setTimeout(resize,120));

useSource('demo.svg');
})();