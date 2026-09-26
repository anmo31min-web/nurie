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
  noteText: $('#noteText'),
  upload: $('#upload'),
  uploadBtn: $('#uploadBtn'),
  resetBtn: $('#resetBtn'),
  againBtn: $('#againBtn'),
  detailToggle: $('#detailToggle'),
  zoomIn: $('#zoomIn'), zoomOut: $('#zoomOut'), zoomReset: $('#zoomReset')
};

const ctx = E.canvas.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', {willReadFrequently:true});
const raster = document.createElement('canvas');
const rctx = raster.getContext('2d');
// Bilateral filtering uses the same RGB-distance Gaussian as before, but the
// 256^3 possible squared distances are reduced to a small integer LUT. This
// keeps the hot loop free of Math.exp without changing its weighting.
const COLOR_WEIGHT_LUT = (() => {
  const lut = new Float32Array(195076);
  const inv = 1 / (2 * 25 * 25);
  for (let d = 0; d < lut.length; d++) lut[d] = Math.exp(-d * inv);
  return lut;
})();

const S = {
  image:null,
  imageUrl:null,
  W:0,H:0,
  filtered:null,
  detailCanvas:null,
  lab:null,
  labels:null,
  regionMap:null,
  regions:[],
  palette:[],
  paletteLab:[],
  selected:0,
  filledCount:0,
  total:0,
  hiddenLabels:0,
  loadSerial:0,
  ready:false,
  fit:{x:0,y:0,w:1,h:1},
  view:{zoom:1,panX:0,panY:0}
};

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const rgb=c=>'rgb('+c[0]+','+c[1]+','+c[2]+')';
const tick=()=>new Promise(r=>requestAnimationFrame(r));

function showStatus(text){
  E.status.classList.remove('error');
  E.status.textContent=text;
  E.status.classList.remove('hide');
}
function hideStatus(){ E.status.classList.add('hide'); }

function loadImage(src){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>resolve(img);
    img.onerror=reject;
    img.src=src;
  });
}

function snapshotPuzzle(){
  return {
    ...S,
    regions:S.regions.map(r=>({...r,pixels:r.pixels})),
    view:{...S.view},
    doneVisible:E.done.classList.contains('show'),
    noteText:E.noteText?.textContent||''
  };
}

function restorePuzzle(snapshot){
  const serial=S.loadSerial;
  Object.assign(S,snapshot,{view:{...snapshot.view},loadSerial:serial});
  setCompleted(!!snapshot.doneVisible);
  if(E.noteText)E.noteText.textContent=snapshot.noteText;
  if(S.W&&S.H){raster.width=S.W;raster.height=S.H;}
  if(S.regions.length){renderPalette();resize();draw();}
}

let lastGoodPuzzle=null;
async function useSource(src,ownedUrl=null){
  const serial=++S.loadSerial;
  if(S.ready)lastGoodPuzzle=snapshotPuzzle();
  const previous=lastGoodPuzzle;
  pointers.clear();
  S.ready=false;
  E.uploadBtn.disabled=true;
  E.upload.disabled=true;
  E.resetBtn.disabled=true;
  E.againBtn.disabled=true;
  if(E.detailToggle)E.detailToggle.disabled=true;
  [E.zoomIn,E.zoomOut,E.zoomReset].forEach(b=>{if(b)b.disabled=true;});
  setCompleted(false);
  showStatus('画像を読み込んでいます…');
  try{
    const image=await loadImage(src);
    if(serial!==S.loadSerial)return;
    S.image=image;
    await buildPuzzle(serial);
    if(serial!==S.loadSerial)return false;
    if(ownedUrl){
      if(S.imageUrl&&S.imageUrl!==ownedUrl)URL.revokeObjectURL(S.imageUrl);
      S.imageUrl=ownedUrl;
    }
    return true;
  }catch(err){
    console.error(err);
    if(serial===S.loadSerial){
      if(previous){
        restorePuzzle(previous);
        showStatus('読み込めませんでした。前のぬりえに戻りました');
        E.status.classList.add('error');
      }else{
        S.ready=false;
        showStatus('読み込めませんでした。「画像」から選び直してください');
      }
    }
    return false;
  } finally {
    if(serial===S.loadSerial){
      E.upload.disabled=false;
      E.uploadBtn.disabled=false;
      E.resetBtn.disabled=false;
      E.againBtn.disabled=false;
      if(E.detailToggle)E.detailToggle.disabled=false;
      [E.zoomIn,E.zoomOut,E.zoomReset].forEach(b=>{if(b)b.disabled=false;});
    }
  }
}

async function buildPuzzle(serial=S.loadSerial){
  if(serial!==S.loadSerial)return;
  const ar=S.image.naturalWidth/S.image.naturalHeight;
  const longSide=512;
  let W,H;
  if(ar>=1){
    W=Math.min(longSide,S.image.naturalWidth);
    H=Math.max(1,Math.round(W/ar));
  }else{
    H=Math.min(longSide,S.image.naturalHeight);
    W=Math.max(1,Math.round(H*ar));
  }
  if(Math.max(S.image.naturalWidth,S.image.naturalHeight)<longSide){
    W=S.image.naturalWidth;
    H=S.image.naturalHeight;
  }
  S.W=W; S.H=H;

  work.width=W; work.height=H;
  wctx.clearRect(0,0,W,H);
  wctx.fillStyle='#fff';
  wctx.fillRect(0,0,W,H);
  wctx.drawImage(S.image,0,0,W,H);

  showStatus('色ムラをならしています…');
  await tick();
  if(serial!==S.loadSerial)return;
  const original=wctx.getImageData(0,0,W,H);
  const filtered=await bilateralFilter(original,W,H,2,25);
  if(serial!==S.loadSerial)return;
  S.filtered=filtered.data;
  S.detailCanvas=buildDetailOverlay(original,W,H);

  showStatus('20色にまとめています…');
  await tick();
  if(serial!==S.loadSerial)return;
  S.lab=rgbDataToLab(S.filtered,W*H);

  const sampleIdx=randomSampleIndices(W*H,Math.min(10000,W*H),20260926);
  const samples=sampleIdx.map(i=>[
    S.lab[i*3],
    S.lab[i*3+1],
    S.lab[i*3+2]
  ]);

  let centers=kmeansPlusPlus(samples,20,20260926);
  centers=lloyd(samples,centers,20);
  if(!centers.length) throw new Error('palette generation failed');

  const labels=new Int16Array(W*H);
  const sums=centers.map(()=>[0,0,0,0]);
  for(let i=0;i<W*H;i++){
    const o=i*3;
    const lab=[S.lab[o],S.lab[o+1],S.lab[o+2]];
    const k=nearestCenter(lab,centers);
    labels[i]=k;
    const p=i*4,z=sums[k];
    z[0]+=S.filtered[p];
    z[1]+=S.filtered[p+1];
    z[2]+=S.filtered[p+2];
    z[3]++;
  }

  S.palette=sums.map((z,i)=>{
    if(!z[3]) return labToRgb(centers[i]);
    return [
      Math.round(z[0]/z[3]),
      Math.round(z[1]/z[3]),
      Math.round(z[2]/z[3])
    ];
  });
  S.paletteLab=centers.map(c=>c.slice());

  showStatus('小さな領域を整理しています…');
  await tick();
  if(serial!==S.loadSerial)return;

  S.labels=labels;
  for(let pass=0;pass<3;pass++){
    const merged=mergeSmallRegionsSequential(S.labels,S.lab,S.paletteLab,W,H);
    if(!merged)break;
    await tick();
    if(serial!==S.loadSerial)return;
  }

  showStatus('番号を置いています…');
  await tick();
  if(serial!==S.loadSerial)return;

  makeRegions();
  ensureLabelsFit();
  compactPalette();
  // Compaction may change a number's width; remeasure the final labels.
  S.hiddenLabels=0;
  for(const r of S.regions){r.labelVisible=findLabelPlacement(r);if(!r.labelVisible)S.hiddenLabels++;}
  S.view={zoom:1,panX:0,panY:0};
  S.ready=true;
  resetPuzzle();
  renderPalette();
  resize();
  hideStatus();
}

function buildDetailOverlay(image,W,H){
  return window.NurieDetail.build(image,W,H);
}

async function bilateralFilter(image,W,H,radius,sigmaColor){
  const src=image.data;
  const out=new ImageData(W,H);
  const dst=out.data;
  const sigmaSpace=2;
  const invSpace=1/(2*sigmaSpace*sigmaSpace);
  const weights=sigmaColor===25 ? COLOR_WEIGHT_LUT : Float32Array.from(COLOR_WEIGHT_LUT,(_,d)=>Math.exp(-d/(2*sigmaColor*sigmaColor)));
  const kernel=[];

  for(let dy=-radius;dy<=radius;dy++){
    for(let dx=-radius;dx<=radius;dx++){
      kernel.push({
        dx,dy,
        ws:Math.exp(-(dx*dx+dy*dy)*invSpace)
      });
    }
  }

  for(let y=0;y<H;y++){
    if((y&31)===0) await tick();
    for(let x=0;x<W;x++){
      const cp=(y*W+x)*4;
      const cr=src[cp],cg=src[cp+1],cb=src[cp+2];
      let sr=0,sg=0,sb=0,sw=0;

      for(const q of kernel){
        const xx=clamp(x+q.dx,0,W-1);
        const yy=clamp(y+q.dy,0,H-1);
        const p=(yy*W+xx)*4;
        const dr=src[p]-cr,dg=src[p+1]-cg,db=src[p+2]-cb;
        const wc=weights[dr*dr+dg*dg+db*db];
        const w=q.ws*wc;
        sr+=src[p]*w;
        sg+=src[p+1]*w;
        sb+=src[p+2]*w;
        sw+=w;
      }

      dst[cp]=sr/sw;
      dst[cp+1]=sg/sw;
      dst[cp+2]=sb/sw;
      dst[cp+3]=255;
    }
  }
  return out;
}

function srgbLinear(v){
  v/=255;
  return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4);
}

function rgbToLab(r,g,b){
  r=srgbLinear(r); g=srgbLinear(g); b=srgbLinear(b);
  const X=(r*.4124564+g*.3575761+b*.1804375)/.95047;
  const Y=(r*.2126729+g*.7151522+b*.0721750);
  const Z=(r*.0193339+g*.1191920+b*.9503041)/1.08883;
  const e=216/24389,k=24389/27;
  const f=t=>t>e?Math.cbrt(t):(k*t+16)/116;
  const fx=f(X),fy=f(Y),fz=f(Z);
  return [116*fy-16,500*(fx-fy),200*(fy-fz)];
}

function rgbDataToLab(data,N){
  const out=new Float32Array(N*3);
  for(let i=0;i<N;i++){
    const p=i*4,l=rgbToLab(data[p],data[p+1],data[p+2]),o=i*3;
    out[o]=l[0];out[o+1]=l[1];out[o+2]=l[2];
  }
  return out;
}

function labToRgb(lab){
  let fy=(lab[0]+16)/116;
  let fx=lab[1]/500+fy;
  let fz=fy-lab[2]/200;
  const e=216/24389,k=24389/27;
  const finv=t=>{
    const t3=t*t*t;
    return t3>e?t3:(116*t-16)/k;
  };
  let X=.95047*finv(fx),Y=finv(fy),Z=1.08883*finv(fz);
  let r= 3.2404542*X-1.5371385*Y-0.4985314*Z;
  let g=-0.9692660*X+1.8760108*Y+0.0415560*Z;
  let b= 0.0556434*X-0.2040259*Y+1.0572252*Z;
  const enc=v=>{
    v=v<=.0031308?12.92*v:1.055*Math.pow(v,1/2.4)-.055;
    return Math.round(clamp(v,0,1)*255);
  };
  return [enc(r),enc(g),enc(b)];
}

function deltaE2(a,b){
  const d0=a[0]-b[0],d1=a[1]-b[1],d2=a[2]-b[2];
  return d0*d0+d1*d1+d2*d2;
}

function nearestCenter(v,centers){
  let bi=0,bd=Infinity;
  for(let k=0;k<centers.length;k++){
    const d=deltaE2(v,centers[k]);
    if(d<bd){bd=d;bi=k}
  }
  return bi;
}

function makeRng(seed){
  let s=seed>>>0;
  return ()=>{
    s=(1664525*s+1013904223)>>>0;
    return s/4294967296;
  };
}

function randomSampleIndices(N,count,seed){
  if(count>=N) return Array.from({length:N},(_,i)=>i);
  const rng=makeRng(seed);
  const step=N/count;
  const out=[];
  for(let i=0;i<count;i++){
    const start=Math.floor(i*step);
    const end=Math.max(start+1,Math.floor((i+1)*step));
    out.push(Math.min(N-1,start+Math.floor(rng()*(end-start))));
  }
  return out;
}

function kmeansPlusPlus(samples,k,seed){
  if(!samples.length)return [];
  const rng=makeRng(seed);
  const centers=[samples[Math.floor(rng()*samples.length)].slice()];

  while(centers.length<k){
    const weights=new Float64Array(samples.length);
    let total=0;
    for(let i=0;i<samples.length;i++){
      let md=Infinity;
      for(const c of centers) md=Math.min(md,deltaE2(samples[i],c));
      weights[i]=md;
      total+=md;
    }
    if(total<=1e-9)break;
    let target=rng()*total,pick=samples.length-1;
    for(let i=0;i<weights.length;i++){
      target-=weights[i];
      if(target<=0){pick=i;break}
    }
    centers.push(samples[pick].slice());
  }
  return centers;
}

function lloyd(samples,centers,maxIter){
  let c=centers.map(x=>x.slice());
  for(let iter=0;iter<maxIter;iter++){
    const sums=c.map(()=>[0,0,0,0]);
    for(const s of samples){
      const k=nearestCenter(s,c),z=sums[k];
      z[0]+=s[0];z[1]+=s[1];z[2]+=s[2];z[3]++;
    }
    let move=0;
    for(let k=0;k<c.length;k++){
      const z=sums[k];
      if(!z[3])continue;
      const n=[z[0]/z[3],z[1]/z[3],z[2]/z[3]];
      move+=deltaE2(c[k],n);
      c[k]=n;
    }
    if(move/c.length<.02)break;
  }
  return c;
}

function components(labels,W,H,lab){
  const N=W*H;
  const map=new Int32Array(N); map.fill(-1);
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
    let sL=0,sA=0,sB=0;

    while(head<tail){
      const i=queue[head++];
      pixels.push(i);
      const o=i*3;
      if(lab){sL+=lab[o];sA+=lab[o+1];sB+=lab[o+2]}
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

    const area=pixels.length;
    comps.push({
      id,label,pixels,area,active:true,
      sumLab:[sL,sA,sB],
      meanLab:lab?[sL/area,sA/area,sB/area]:null,
      neighbors:new Map(),
      perimeter:0,
      rMax:0
    });
    id++;
  }

  return {map,comps};
}

function buildAdjacency(map,comps,W,H){
  const N=W*H;
  for(const c of comps){
    c.neighbors=new Map();
    c.perimeter=0;
  }

  function edge(a,b){
    comps[a].perimeter++;
    comps[b].perimeter++;
    comps[a].neighbors.set(b,(comps[a].neighbors.get(b)||0)+1);
    comps[b].neighbors.set(a,(comps[b].neighbors.get(a)||0)+1);
  }

  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i=y*W+x,a=map[i];
      if(x===0)comps[a].perimeter++;
      if(y===0)comps[a].perimeter++;
      if(x===W-1)comps[a].perimeter++;
      else{
        const b=map[i+1];
        if(a!==b)edge(a,b);
      }
      if(y===H-1)comps[a].perimeter++;
      else{
        const b=map[i+W];
        if(a!==b)edge(a,b);
      }
    }
  }
}

function chamferDistance(map,W,H){
  const N=W*H,INF=60000;
  const d=new Uint16Array(N);
  d.fill(INF);

  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i=y*W+x,r=map[i];
      if(x===0||y===0||x===W-1||y===H-1||
         map[i-1]!==r||map[i+1]!==r||map[i-W]!==r||map[i+W]!==r){
        d[i]=0;
      }
    }
  }

  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i=y*W+x,r=map[i];
      let v=d[i];
      if(x>0&&map[i-1]===r)v=Math.min(v,d[i-1]+10);
      if(y>0&&map[i-W]===r)v=Math.min(v,d[i-W]+10);
      if(x>0&&y>0&&map[i-W-1]===r)v=Math.min(v,d[i-W-1]+14);
      if(x<W-1&&y>0&&map[i-W+1]===r)v=Math.min(v,d[i-W+1]+14);
      d[i]=v;
    }
  }

  for(let y=H-1;y>=0;y--){
    for(let x=W-1;x>=0;x--){
      const i=y*W+x,r=map[i];
      let v=d[i];
      if(x<W-1&&map[i+1]===r)v=Math.min(v,d[i+1]+10);
      if(y<H-1&&map[i+W]===r)v=Math.min(v,d[i+W]+10);
      if(x<W-1&&y<H-1&&map[i+W+1]===r)v=Math.min(v,d[i+W+1]+14);
      if(x>0&&y<H-1&&map[i+W-1]===r)v=Math.min(v,d[i+W-1]+14);
      d[i]=v;
    }
  }
  return d;
}

function mergeSmallRegionsSequential(labels,lab,paletteLab,W,H){
  const built=components(labels,W,H,lab);
  const map=built.map, comps=built.comps;
  if(comps.length<=1)return false;

  buildAdjacency(map,comps,W,H);
  const dist=chamferDistance(map,W,H);

  for(let i=0;i<map.length;i++){
    const c=comps[map[i]];
    const r=dist[i]/10;
    if(r>c.rMax)c.rMax=r;
  }

  const scale=Math.max(W,H)/512;
  const minArea=Math.max(18,Math.round(64*scale*scale));
  const minRadius=Math.max(2.4,5*scale);
  const order=comps.slice().sort((a,b)=>a.area-b.area);
  // Keep the widest connected patch of every color: otherwise increasing
  // the palette can paradoxically erase more colors during cleanup.
  const representatives=new Map();
  for(const c of comps){
    if(!representatives.has(c.label)||representatives.get(c.label).rMax<c.rMax||(representatives.get(c.label).rMax===c.rMax&&representatives.get(c.label).area<c.area))representatives.set(c.label,c);
  }
  let mergedAny=false;

  for(const a of order){
    if(!a.active)continue;
    if(representatives.get(a.label)===a)continue;
    const tooSmall=a.area<minArea;
    const tooThin=a.rMax<minRadius;
    if(!tooSmall&&!tooThin)continue;

    let best=null,bestScore=Infinity;
    for(const [bid,shared] of a.neighbors){
      const b=comps[bid];
      if(!b||!b.active||b.id===a.id)continue;
      const de=Math.sqrt(deltaE2(a.meanLab,paletteLab[b.label]));
      const contact=shared/Math.max(1,a.perimeter);
      const score=de/20+(1-contact);
      if(score<bestScore){
        bestScore=score;
        best={b,shared};
      }
    }
    if(!best)continue;

    const b=best.b,shared=best.shared;
    for(const p of a.pixels){
      labels[p]=b.label;
      map[p]=b.id;
      b.pixels.push(p);
    }

    b.area+=a.area;
    b.sumLab[0]+=a.sumLab[0];
    b.sumLab[1]+=a.sumLab[1];
    b.sumLab[2]+=a.sumLab[2];
    b.meanLab=[
      b.sumLab[0]/b.area,
      b.sumLab[1]/b.area,
      b.sumLab[2]/b.area
    ];
    b.rMax=Math.max(b.rMax,a.rMax);
    b.perimeter=b.perimeter+a.perimeter-2*shared;

    for(const [cid,len] of a.neighbors){
      if(cid===b.id)continue;
      const c=comps[cid];
      if(!c||!c.active)continue;
      c.neighbors.delete(a.id);
      const oldBC=b.neighbors.get(cid)||0;
      b.neighbors.set(cid,oldBC+len);
      c.neighbors.set(b.id,(c.neighbors.get(b.id)||0)+len);
    }

    b.neighbors.delete(a.id);
    a.neighbors.clear();
    a.active=false;
    a.pixels=[];
    mergedAny=true;
  }

  return mergedAny;
}

function makeRegions(){
  const W=S.W,H=S.H;
  const built=components(S.labels,W,H,null);
  const map=built.map, comps=built.comps;
  const dist=chamferDistance(map,W,H);

  const regions=comps.map(c=>({
    id:c.id,
    color:c.label,
    pixels:c.pixels,
    area:c.area,
    filled:false,
    labelX:0,labelY:0,labelRadius:0
  }));

  for(let i=0;i<map.length;i++){
    const r=regions[map[i]];
    const radius=dist[i]/10;
    if(radius>r.labelRadius){
      r.labelRadius=radius;
      r.labelX=i%W;
      r.labelY=(i/W)|0;
    }
  }

  S.regionMap=map;
  S.regions=regions;
  S.total=regions.length;
  raster.width=W;
  raster.height=H;
}

// Label placement and drawing intentionally share this image-coordinate font
// recipe. The canvas is later scaled for CSS pixels/DPR, so testing in image
// coordinates makes the result stable across resize and retina displays.
const labelMeasureCtx=document.createElement('canvas').getContext('2d');
labelMeasureCtx.textAlign='center';
labelMeasureCtx.textBaseline='middle';
const labelSpecs=new Map();
function labelSpec(region){
  const fontSize=region.labelFontSize||9;
  const key=fontSize+':'+region.color;
  if(labelSpecs.has(key))return labelSpecs.get(key);
  const font=`900 ${fontSize}px system-ui,sans-serif`;
  labelMeasureCtx.font=font;
  const stroke=fontSize<9?1:Math.max(2,fontSize*.18),pad=fontSize<9?.25:1;
  let left=0,right=0,top=0,bottom=0;
  // Measure the actual one- or two-digit number, preserving narrow details.
  for(const digit of [region.color+1]){
    const m=labelMeasureCtx.measureText(String(digit));
    left=Math.max(left,m.actualBoundingBoxLeft);
    right=Math.max(right,m.actualBoundingBoxRight);
    top=Math.max(top,m.actualBoundingBoxAscent);
    bottom=Math.max(bottom,m.actualBoundingBoxDescent);
  }
  const spec={fontSize,font,stroke,left:left+stroke/2+pad,right:right+stroke/2+pad,
    top:top+stroke/2+pad,bottom:bottom+stroke/2+pad};
  labelSpecs.set(key,spec);
  return spec;
}

function regionLabelFitsAt(region,x,y,spec){
  const left=Math.floor(x+.5-spec.left),right=Math.ceil(x+.5+spec.right)-1;
  const top=Math.floor(y+.5-spec.top),bottom=Math.ceil(y+.5+spec.bottom)-1;
  if(left<0||top<0||right>=S.W||bottom>=S.H)return false;
  for(let yy=top;yy<=bottom;yy++)for(let xx=left;xx<=right;xx++){
    if(S.regionMap[yy*S.W+xx]!==region.id)return false;
  }
  return true;
}

function findLabelPlacement(region){
  region.labelFontSize=9;
  const spec=labelSpec(region);
  let found=regionLabelFitsAt(region,region.labelX,region.labelY,spec);
  if(!found){
    for(const p of region.pixels){
      const x=p%S.W,y=(p/S.W)|0;
      if(regionLabelFitsAt(region,x,y,spec)){
        region.labelX=x;region.labelY=y;found=true;break;
      }
    }
  }
  if(!found){
    // Preserve small details with compact numbers that can be read on zoom.
    for(let size=8;size>=4&&!found;size--){
      region.labelFontSize=size;
      const smallSpec=labelSpec(region);
      for(const p of region.pixels){
        const x=p%S.W,y=(p/S.W)|0;
        if(regionLabelFitsAt(region,x,y,smallSpec)){
          region.labelX=x;region.labelY=y;found=true;break;
        }
      }
    }
    return found;
  }
  // Grow only after the smallest label fits; this never forces extra merges.
  for(let size=10;size<=17;size++){
    region.labelFontSize=size;
    if(!regionLabelFitsAt(region,region.labelX,region.labelY,labelSpec(region))){
      region.labelFontSize=size-1;break;
    }
  }
  return true;
}

function mergeRegionForLabel(region, neighbor){
  for(const p of region.pixels) S.labels[p]=neighbor.label;
  // Rebuilding components after every merge avoids stale adjacency, radius,
  // and color connectivity state when several tiny regions touch.
}

function ensureLabelsFit(){
  const maxPasses=Math.max(1,S.W*S.H);
  for(let pass=0;pass<maxPasses;pass++){
    makeRegions();
    const counts=new Map();
    for(const r of S.regions)counts.set(r.color,(counts.get(r.color)||0)+1);
    const invalid=S.regions.find(r=>!findLabelPlacement(r)&&counts.get(r.color)>1);
    if(!invalid)break;
    const built=components(S.labels,S.W,S.H,S.lab);
    buildAdjacency(built.map,built.comps,S.W,S.H);
    const source=built.comps[invalid.id];
    let best=null,bestScore=Infinity;
    if(source){
      for(const [id,shared] of source.neighbors){
        const candidate=built.comps[id];
        if(!candidate)continue;
        const colorGap=Math.sqrt(deltaE2(source.meanLab,S.paletteLab[candidate.label]));
        const score=colorGap/18+(1-shared/Math.max(1,source.perimeter))*2;
        if(score<bestScore){bestScore=score;best=candidate;}
      }
    }
    if(!best){
      invalid.labelVisible=false;
      invalid.noNumberReason='領域が小さすぎるため番号なし';
      break;
    }
    const beforeCount=S.regions.length;
    mergeRegionForLabel(source,best);
    makeRegions();
    if(S.regions.length>=beforeCount){
      const stuck=S.regions.find(r=>r.id===invalid.id)||invalid;
      stuck.labelVisible=false;
      break;
    }
  }
  makeRegions();
  S.hiddenLabels=0;
  for(const region of S.regions){
    region.labelVisible=findLabelPlacement(region);
    if(!region.labelVisible){
      region.noNumberReason='領域が小さすぎるため番号なし';
      S.hiddenLabels++;
    }
  }
}

function compactPalette(){
  const used=[...new Set(S.regions.map(r=>r.color))].sort((a,b)=>a-b);
  const remap=new Map(used.map((v,i)=>[v,i]));
  for(let i=0;i<S.labels.length;i++)S.labels[i]=remap.get(S.labels[i]);
  S.palette=used.map(i=>S.palette[i]);
  S.paletteLab=used.map(i=>S.paletteLab[i]);
  for(const r of S.regions)r.color=remap.get(r.color);
}

function resetPuzzle(){
  for(const r of S.regions)r.filled=false;
  S.filledCount=0;
  S.selected=0;
  setCompleted(false);
  updateProgress();
  draw();
}

function colorFinished(c){
  let found=false;
  for(const r of S.regions){
    if(r.color===c){
      found=true;
      if(!r.filled)return false;
    }
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
      if(!S.ready)return;
      if(colorFinished(i))return;
      S.selected=i;
      draw();
      renderPalette();
    };
    E.palette.appendChild(b);
  });
  const active=E.palette.children[S.selected];
  if(active)E.palette.scrollLeft=active.offsetLeft-E.palette.offsetLeft-(E.palette.clientWidth-active.offsetWidth)/2;
  const noteText=S.hiddenLabels
    ? `同じ番号を塗り終えると元絵に。極細の${S.hiddenLabels}領域は2倍以上に拡大すると番号を表示`
    : '同じ番号をすべて塗ると、元絵の色と質感が戻ります';
  if(E.noteText)E.noteText.textContent=noteText;
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
  const z=clamp(S.view.zoom,1,6);
  w*=z;h*=z;
  S.view.panX=clamp(S.view.panX,-Math.max(0,(w-cw)/2),Math.max(0,(w-cw)/2));
  S.view.panY=clamp(S.view.panY,-Math.max(0,(h-ch)/2),Math.max(0,(h-ch)/2));
  S.fit={x:(cw-w)/2+S.view.panX,y:(ch-h)/2+S.view.panY,w,h};
  return S.fit;
}

function setZoom(next,cx=E.canvas.width/2,cy=E.canvas.height/2){
  if(!S.ready)return;
  hideStatus();
  const oldZoom=S.view.zoom;
  const before=fit();
  const ix=(cx-before.x)/before.w, iy=(cy-before.y)/before.h;
  S.view.zoom=clamp(next,1,6);
  const ratio=S.view.zoom/oldZoom;
  const w=before.w*ratio,h=before.h*ratio;
  S.view.panX=cx-ix*w-(E.canvas.width-w)/2;
  S.view.panY=cy-iy*h-(E.canvas.height-h)/2;
  draw();
}

function resetView(){S.view={zoom:1,panX:0,panY:0};draw();}

function setCompleted(completed){
  E.done.classList.toggle('show',completed);
  document.querySelector('.app').classList.toggle('completed',completed);
  E.done.querySelector('details').open=false;
}

function draw(){
  if(!S.ready||!S.regionMap||!S.regions.length)return;
  const W=S.W,H=S.H,N=W*H;
  const image=rctx.createImageData(W,H),d=image.data;
  const revealed=S.palette.map((_,color)=>colorFinished(color));

  for(let i=0;i<N;i++){
    const rid=S.regionMap[i],r=S.regions[rid],p=i*4;
    if(r.filled){
      // Completing a number reveals its original colors and texture together.
      if(revealed[r.color])continue;
      const c=S.palette[r.color];
      d[p]=c[0];d[p+1]=c[1];d[p+2]=c[2];
    }else{
      const active=r.color===S.selected;
      if(active){
        const c=S.palette[r.color],hatch=((i%W+Math.floor(i/W))%8)<2;
        const mix=hatch?.24:.14;
        d[p]=Math.round(253*(1-mix)+c[0]*mix);d[p+1]=Math.round(252*(1-mix)+c[1]*mix);d[p+2]=Math.round(249*(1-mix)+c[2]*mix);
        if(hatch){d[p]=Math.round(d[p]*.82+148*.18);d[p+1]=Math.round(d[p+1]*.82+114*.18);d[p+2]=Math.round(d[p+2]*.82+130*.18);}
      }else{
        d[p]=253;d[p+1]=252;d[p+2]=249;
      }
    }
    d[p+3]=255;
  }

  // Retain guides only while at least one side still needs painting.
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i=y*W+x,rid=S.regionMap[i];
      let edge=false;
      if(x<W-1&&S.regionMap[i+1]!==rid&&(!S.regions[rid].filled||!S.regions[S.regionMap[i+1]].filled))edge=true;
      if(y<H-1&&S.regionMap[i+W]!==rid&&(!S.regions[rid].filled||!S.regions[S.regionMap[i+W]].filled))edge=true;
      if(edge){
        const p=i*4;
        d[p]=92;d[p+1]=84;d[p+2]=86;
        d[p+3]=255;
      }
    }
  }

  rctx.putImageData(image,0,0);
  // Decorative guides belong to unpainted paper, not to the original art.
  if(E.detailToggle?.checked&&S.detailCanvas){
    rctx.globalCompositeOperation='source-atop';
    rctx.drawImage(S.detailCanvas,0,0);
    rctx.globalCompositeOperation='source-over';
  }
  const f=fit();
  ctx.clearRect(0,0,E.canvas.width,E.canvas.height);
  ctx.fillStyle='#fff';
  ctx.fillRect(0,0,E.canvas.width,E.canvas.height);
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(S.image,f.x,f.y,f.w,f.h);
  if(S.filledCount<S.total)ctx.drawImage(raster,f.x,f.y,f.w,f.h);
  drawNumbers(f);
}

function drawNumbers(f){
  const sx=f.w/S.W,sy=f.h/S.H;
  const scale=Math.min(sx,sy);
  ctx.textAlign='center';
  ctx.textBaseline='middle';

  for(const r of S.regions){
    if(r.filled||(r.labelVisible===false&&S.view.zoom<2))continue;
    // A zoom-only marker may cross a very thin region's edge; keeping it out
    // of the overview avoids covering the illustration with oversized labels.
    const spec=labelSpec(r.labelVisible===false?{...r,labelFontSize:6}:r);
    const fs=spec.fontSize*scale;
    const x=f.x+(r.labelX+.5)*sx;
    const y=f.y+(r.labelY+.5)*sy;
    ctx.font='900 '+fs+'px system-ui,sans-serif';
    ctx.lineWidth=spec.stroke*scale;
    ctx.strokeStyle='rgba(255,255,255,.98)';
    ctx.fillStyle='#5c5356';
    ctx.strokeText(String(r.color+1),x,y);
    ctx.fillText(String(r.color+1),x,y);
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
  hideStatus();
  const rid=pickRegion(ev);
  if(rid<0)return;
  const r=S.regions[rid];
  if(r.filled||r.color!==S.selected)return;

  r.filled=true;
  S.filledCount++;
  updateProgress();

  if(colorFinished(S.selected)){
    const start=S.selected;
    for(let n=1;n<=S.palette.length;n++){
      const c=(start+n)%S.palette.length;
      if(!colorFinished(c)){S.selected=c;break}
    }
  }
  renderPalette();
  draw();

  if(S.filledCount===S.total){setCompleted(true);resetView();}
}

const pointers=new Map();
let gesture={moved:false,pinch:false,startX:0,startY:0,startZoom:1,startDistance:0};
const canvasPoint=ev=>{const r=E.canvas.getBoundingClientRect();return {x:(ev.clientX-r.left)*(E.canvas.width/r.width),y:(ev.clientY-r.top)*(E.canvas.height/r.height)};};
const pointerDistance=()=>{const a=[...pointers.values()];return a.length<2?0:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y);};
E.canvas.addEventListener('pointerdown',ev=>{
  if(!S.ready)return;
  const p=canvasPoint(ev);pointers.set(ev.pointerId,p);E.canvas.setPointerCapture?.(ev.pointerId);
  if(pointers.size===1){gesture={moved:false,pinch:false,startX:p.x,startY:p.y,startZoom:S.view.zoom,startDistance:0};}
  else if(pointers.size===2){gesture.pinch=true;gesture.startDistance=pointerDistance();gesture.startZoom=S.view.zoom;}
});
E.canvas.addEventListener('pointermove',ev=>{
  if(!S.ready||!pointers.has(ev.pointerId))return;
  const p=canvasPoint(ev),old=pointers.get(ev.pointerId);pointers.set(ev.pointerId,p);
  if(pointers.size>=2){
    const d=pointerDistance();if(d&&gesture.startDistance){
      const a=[...pointers.values()];const cx=(a[0].x+a[1].x)/2,cy=(a[0].y+a[1].y)/2;
      setZoom(gesture.startZoom*d/gesture.startDistance,cx,cy);
    }
    gesture.moved=true;return;
  }
  const ratio=E.canvas.width/E.canvas.getBoundingClientRect().width;
  if(!gesture.moved&&Math.hypot(p.x-gesture.startX,p.y-gesture.startY)>5*ratio){
    gesture.moved=true;S.view.panX+=p.x-gesture.startX;S.view.panY+=p.y-gesture.startY;draw();
  }else if(gesture.moved){S.view.panX+=p.x-old.x;S.view.panY+=p.y-old.y;draw();}
});
const endPointer=ev=>{const wasTap=pointers.has(ev.pointerId)&&pointers.size===1&&!gesture.moved&&!gesture.pinch;pointers.delete(ev.pointerId);if(wasTap)tap(ev);if(!pointers.size)gesture={moved:false,pinch:false};};
E.canvas.addEventListener('pointerup',endPointer);
E.canvas.addEventListener('pointercancel',ev=>{pointers.delete(ev.pointerId);gesture.moved=true;if(!pointers.size)gesture={moved:false,pinch:false};});
E.canvas.addEventListener('wheel',ev=>{if(!S.ready)return;ev.preventDefault();const p=canvasPoint(ev);setZoom(S.view.zoom*(ev.deltaY<0?1.2:1/1.2),p.x,p.y);},{passive:false});
E.uploadBtn.onclick=()=>E.upload.click();
E.upload.onchange=async()=>{
  const file=E.upload.files&&E.upload.files[0];
  if(!file)return;
  const candidate=URL.createObjectURL(file);
  const ok=await useSource(candidate,candidate);
  if(!ok)URL.revokeObjectURL(candidate);
  E.upload.value='';
};
E.resetBtn.onclick=()=>{
  if(S.ready&&S.regions.length){resetPuzzle();renderPalette()}
};
E.againBtn.onclick=()=>{
  if(S.ready){resetPuzzle();renderPalette();}
};
$('#saveBtn').onclick=()=>{
  if(!S.ready||S.filledCount!==S.total)return;
  const output=document.createElement('canvas');
  output.width=S.image.naturalWidth;output.height=S.image.naturalHeight;
  const out=output.getContext('2d');
  out.fillStyle='#fff';out.fillRect(0,0,output.width,output.height);
  out.drawImage(S.image,0,0);
  output.toBlob(blob=>{
    if(!blob)return;
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='nurie-complete.png';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  },'image/png');
};
E.detailToggle?.addEventListener('change',draw);
E.zoomIn?.addEventListener('click',()=>{if(S.ready)setZoom(S.view.zoom*1.35);});
E.zoomOut?.addEventListener('click',()=>{if(S.ready)setZoom(S.view.zoom/1.35);});
E.zoomReset?.addEventListener('click',()=>{if(S.ready)resetView();});

new ResizeObserver(resize).observe(E.board);
window.addEventListener('orientationchange',()=>setTimeout(resize,120));

useSource('demo.png');
})();
