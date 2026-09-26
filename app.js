(() => {
'use strict';
const $=s=>document.querySelector(s);
const E={c:$('#game'),stage:$('#stage'),pal:$('#palette'),prog:$('#progressBar'),hint:$('#hint'),combo:$('#comboText'),meter:$('#comboMeter'),meterFill:$('#comboFill'),cat:$('#cat'),menu:$('#menu'),loading:$('#loading'),finish:$('#finish'),home:$('#homeBtn'),reset:$('#resetBtn'),again:$('#againBtn'),upload:$('#upload'),uploadBtn:$('#uploadBtn'),closeMenu:$('#closeMenu')};
const ctx=E.c.getContext('2d'),pc=document.createElement('canvas'),px=pc.getContext('2d',{willReadFrequently:true}),paint=document.createElement('canvas'),pctx=paint.getContext('2d');
const D={easy:{area:1600,min:52,label:1.08},normal:{area:900,min:34,label:1},fine:{area:520,min:22,label:.92}};
const S={img:null,url:null,diff:'easy',colors:8,W:0,H:0,src:null,outline:null,labels:null,map:null,regions:[],palette:[],selected:0,filled:0,total:0,combo:0,comboEnd:0,catDone:false,spark:null,complete:0,fit:{x:0,y:0,w:1,h:1},raf:0,busy:false};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),mix=(a,b,t)=>Math.round(a+(b-a)*t),css=c=>`rgb(${c[0]},${c[1]},${c[2]})`,next=()=>new Promise(r=>requestAnimationFrame(r));
const d2=(a,b)=>{let r=a[0]-b[0],g=a[1]-b[1],x=a[2]-b[2];return r*r*.8+g*g+x*x*.65};
function hsl([r,g,b]){r/=255;g/=255;b/=255;let M=Math.max(r,g,b),m=Math.min(r,g,b),d=M-m,h=0,s=0,l=(M+m)/2;if(d){s=d/(1-Math.abs(2*l-1));if(M===r)h=((g-b)/d)%6;else if(M===g)h=(b-r)/d+2;else h=(r-g)/d+4;h=(h*60+360)%360}return[h,s,l]}
function loading(on,t){S.busy=on;E.loading.classList.toggle('off',!on);if(t)$('#loadingText').textContent=t}
function load(src){return new Promise((ok,no)=>{let i=new Image;i.onload=()=>{S.img=i;ok(i)};i.onerror=no;i.src=src})}
async function source(src){loading(true,'ぬりえをつくっています…');try{await load(src);await process()}catch(e){console.error(e);alert('画像を読み込めませんでした。別の画像で試してみてください。')}finally{loading(false)}}
async function process(){
 if(!S.img)return;loading(true,'色をわけています…');await next();
 const maxW=180,maxH=320,ar=S.img.naturalWidth/S.img.naturalHeight;let W,H;
 if(ar>=maxW/maxH){W=maxW;H=Math.max(120,Math.round(W/ar))}else{H=maxH;W=Math.max(120,Math.round(H*ar))}
 S.W=W;S.H=H;pc.width=W;pc.height=H;px.clearRect(0,0,W,H);px.drawImage(S.img,0,0,W,H);S.src=px.getImageData(0,0,W,H).data;
 const N=W*H,lum=new Uint8Array(N),alpha=new Uint8Array(N);
 for(let i=0,p=0;i<N;i++,p+=4){lum[i]=Math.round(S.src[p]*.299+S.src[p+1]*.587+S.src[p+2]*.114);alpha[i]=S.src[p+3]}
 const edge=new Uint8Array(N),out=new Uint8Array(N);
 for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){let i=y*W+x;if(alpha[i]<24||lum[i]>118)continue;let m=Math.max(lum[i-1],lum[i+1],lum[i-W],lum[i+W]);if(m-lum[i]>25)edge[i]=1}
 for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){let i=y*W+x;if(!edge[i])continue;out[i]=1;for(let n of[i-1,i+1,i-W,i+W])if(lum[n]<112)out[n]=1}S.outline=out;
 let samples=[],step=Math.max(1,Math.floor(N/6500));
 for(let i=0;i<N;i+=step){if(alpha[i]<24||out[i])continue;let p=i*4;samples.push([S.src[p],S.src[p+1],S.src[p+2]])}
 if(samples.length<S.colors)throw Error('not enough pixels');
 let centers=init(samples,S.colors);for(let z=0;z<8;z++)centers=kstep(samples,centers);
 let order=centers.map((c,i)=>({i,c,h:hsl(c)})).sort((a,b)=>{let ag=a.h[1]<.12,bg=b.h[1]<.12;if(ag!==bg)return ag?1:-1;return a.h[0]-b.h[0]||a.h[2]-b.h[2]});
 let remap=new Int16Array(centers.length);S.palette=order.map((o,n)=>(remap[o.i]=n,o.c.map(Math.round)));
 let labels=new Int16Array(N);labels.fill(-1);
 for(let i=0;i<N;i++){if(alpha[i]<24||out[i])continue;let p=i*4,v=[S.src[p],S.src[p+1],S.src[p+2]],best=0,bd=Infinity;for(let k=0;k<centers.length;k++){let q=d2(v,centers[k]);if(q<bd){bd=q;best=k}}labels[i]=remap[best]}
 labels=smooth(labels,out,W,H,2);let di=D[S.diff];for(let p=0;p<2;p++)labels=mergeTiny(labels,out,W,H,di.min);S.labels=labels;
 loading(true,'ぬる場所をわけています…');await next();regions(di);reset(false);palette();resize();E.hint.classList.remove('hide');setTimeout(()=>E.hint.classList.add('hide'),2200);loading(false)
}
function init(a,k){let c=[a[Math.floor(a.length*.43)].slice()];while(c.length<k){let best=a[0],bd=-1,stride=Math.max(1,Math.floor(a.length/1800));for(let i=0;i<a.length;i+=stride){let s=a[i],md=Infinity;for(let q of c)md=Math.min(md,d2(s,q));if(md>bd){bd=md;best=s}}c.push(best.slice())}return c}
function kstep(a,c){let sums=c.map(()=>[0,0,0,0]);for(let s of a){let b=0,bd=Infinity;for(let k=0;k<c.length;k++){let q=d2(s,c[k]);if(q<bd){bd=q;b=k}}let z=sums[b];z[0]+=s[0];z[1]+=s[1];z[2]+=s[2];z[3]++}return c.map((q,k)=>sums[k][3]?[sums[k][0]/sums[k][3],sums[k][1]/sums[k][3],sums[k][2]/sums[k][3]]:q)}
function smooth(a,out,W,H,n){for(let pass=0;pass<n;pass++){let b=new Int16Array(a);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){let i=y*W+x;if(out[i]||a[i]<0)continue;let m=new Map;for(let q of[i-1,i+1,i-W,i+W,i-W-1,i-W+1,i+W-1,i+W+1]){let v=a[q];if(v>=0)m.set(v,(m.get(v)||0)+1)}let bv=a[i],bc=0;for(let[v,c]of m)if(c>bc){bc=c;bv=v}if(bc>=5)b[i]=bv}a=b}return a}
function comps(labels,out,W,H){let N=W*H,map=new Int32Array(N);map.fill(-1);let cs=[],q=new Int32Array(N),id=0;for(let s=0;s<N;s++){if(out[s]||labels[s]<0||map[s]>=0)continue;let label=labels[s],p=[],h=0,t=0;q[t++]=s;map[s]=id;while(h<t){let i=q[h++];p.push(i);let x=i%W,ns=[];if(x)ns.push(i-1);if(x<W-1)ns.push(i+1);if(i>=W)ns.push(i-W);if(i<N-W)ns.push(i+W);for(let n of ns)if(!out[n]&&labels[n]===label&&map[n]<0){map[n]=id;q[t++]=n}}cs.push({id,label,p,area:p.length});id++}return{map,cs}}
function mergeTiny(labels,out,W,H,min){let{map,cs}=comps(labels,out,W,H),b=new Int16Array(labels),N=W*H;for(let c of cs){if(c.area>=min)continue;let votes=new Map;for(let i of c.p){let x=i%W,ns=[];if(x)ns.push(i-1);if(x<W-1)ns.push(i+1);if(i>=W)ns.push(i-W);if(i<N-W)ns.push(i+W);for(let n of ns){if(map[n]===c.id||labels[n]<0)continue;let v=labels[n];votes.set(v,(votes.get(v)||0)+1)}}let best=-1,bv=0;for(let[v,n]of votes)if(n>bv){bv=n;best=v}if(best>=0)for(let i of c.p)b[i]=best}return smooth(b,out,W,H,1)}
function seeds(p,n,W){if(n<=1)return[p[(p.length/2)|0]];let sx=0,sy=0;for(let i of p){sx+=i%W;sy+=(i/W)|0}let cx=sx/p.length,cy=sy/p.length,first=p[0],fd=Infinity;for(let i of p){let x=i%W,y=(i/W)|0,d=(x-cx)**2+(y-cy)**2;if(d<fd){fd=d;first=i}}let s=[first],stride=Math.max(1,Math.floor(p.length/2200));while(s.length<n){let best=p[0],bd=-1;for(let z=0;z<p.length;z+=stride){let i=p[z],x=i%W,y=(i/W)|0,md=Infinity;for(let q of s){let dx=x-q%W,dy=y-((q/W)|0);md=Math.min(md,dx*dx+dy*dy)}if(md>bd){bd=md;best=i}}if(s.includes(best))break;s.push(best)}return s}
function regions(di){
 let W=S.W,H=S.H,N=W*H,{map:cm,cs}=comps(S.labels,S.outline,W,H),rm=new Int32Array(N);rm.fill(-1);let rs=[],own=new Int16Array(N),q=new Int32Array(N);
 for(let c of cs){let want=clamp(Math.round(c.area/di.area),1,18),sd=seeds(c.p,want,W);own.fill(-1);let h=0,t=0;sd.forEach((p,j)=>(own[p]=j,q[t++]=p));while(h<t){let i=q[h++],o=own[i],x=i%W,ns=[];if(x)ns.push(i-1);if(x<W-1)ns.push(i+1);if(i>=W)ns.push(i-W);if(i<N-W)ns.push(i+W);for(let n of ns)if(cm[n]===c.id&&own[n]<0){own[n]=o;q[t++]=n}}
  let base=rs.length;for(let j=0;j<sd.length;j++)rs.push({id:base+j,color:c.label,p:[],area:0,sx:0,sy:0,minX:W,minY:H,maxX:0,maxY:0,filled:false,lx:0,ly:0});
  for(let p of c.p){let o=Math.max(0,own[p]),r=rs[base+o],x=p%W,y=(p/W)|0;rm[p]=r.id;r.p.push(p);r.area++;r.sx+=x;r.sy+=y;r.minX=Math.min(r.minX,x);r.maxX=Math.max(r.maxX,x);r.minY=Math.min(r.minY,y);r.maxY=Math.max(r.maxY,y)}
 }
 for(let r of rs){let cx=r.sx/r.area,cy=r.sy/r.area,b=r.p[0],bd=Infinity,stride=Math.max(1,Math.floor(r.p.length/900));for(let z=0;z<r.p.length;z+=stride){let p=r.p[z],x=p%W,y=(p/W)|0,d=(x-cx)**2+(y-cy)**2;if(d<bd){bd=d;b=p}}r.lx=b%W;r.ly=(b/W)|0}
 let used=[...new Set(rs.map(r=>r.color))].sort((a,b)=>a-b),cr=new Map(used.map((v,i)=>[v,i]));S.palette=used.map(i=>S.palette[i]);for(let r of rs)r.color=cr.get(r.color);S.map=rm;S.regions=rs;S.total=rs.length;paint.width=W;paint.height=H
}
function reset(repal=true){for(let r of S.regions)r.filled=false;S.filled=0;S.combo=0;S.comboEnd=0;S.catDone=false;S.spark=null;S.complete=0;E.finish.classList.remove('show');E.combo.classList.remove('on');E.meter.classList.remove('on');S.selected=first();progress();if(repal)palette();draw()}
function first(){for(let c=0;c<S.palette.length;c++)if(S.regions.some(r=>r.color===c&&!r.filled))return c;return 0}
function done(c){let has=false;for(let r of S.regions)if(r.color===c){has=true;if(!r.filled)return false}return has}
function maru(){let ns='http://www.w3.org/2000/svg',s=document.createElementNS(ns,'svg'),p=document.createElementNS(ns,'path'),d='';for(let i=0;i<=40;i++){let a=i/40*Math.PI*2,r=28+2.3*Math.sin(a*8)+1.3*Math.sin(a*3+.8),x=34+Math.cos(a)*r,y=34+Math.sin(a)*r;d+=(i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)}p.setAttribute('d',d);p.setAttribute('class','maruPath');s.setAttribute('viewBox','0 0 68 68');s.appendChild(p);return s}
function palette(){E.pal.textContent='';S.palette.forEach((c,i)=>{let b=document.createElement('button');b.className='swatch';b.dataset.color=i;b.style.background=css(c);let l=c[0]*.299+c[1]*.587+c[2]*.114;b.style.color=l<135?'#fff':'#4a373d';b.textContent=i+1;if(i===S.selected)b.classList.add('selected');if(done(i)){b.classList.add('done');b.appendChild(maru())}b.onclick=()=>{if(!done(i)){S.selected=i;palette()}};E.pal.appendChild(b)});let q=E.pal.querySelector(`[data-color="${S.selected}"]`);if(q)q.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'})}
function progress(){E.prog.style.width=(S.total?S.filled/S.total*100:0).toFixed(1)+'%'}
function resize(){let r=E.stage.getBoundingClientRect(),d=Math.min(2,devicePixelRatio||1);E.c.width=Math.max(1,Math.round(r.width*d));E.c.height=Math.max(1,Math.round(r.height*d));draw()}
function fit(){let cw=E.c.width,ch=E.c.height,ar=S.W/S.H,w=cw,h=w/ar;if(h>ch){h=ch;w=h*ar}return S.fit={x:(cw-w)/2,y:(ch-h)/2,w,h}}
function draw(){
 if(!S.map||!S.img)return;let W=S.W,H=S.H,N=W*H,o=pctx.createImageData(W,H),d=o.data;
 for(let i=0;i<N;i++){let p=i*4,rid=S.map[i];if(S.outline[i]){d[p]=S.src[p];d[p+1]=S.src[p+1];d[p+2]=S.src[p+2];d[p+3]=255;continue}if(rid<0){d[p]=255;d[p+1]=250;d[p+2]=246;d[p+3]=255;continue}let r=S.regions[rid],c=S.palette[r.color],t=r.filled?0:.86;d[p]=mix(c[0],255,t);d[p+1]=mix(c[1],252,t);d[p+2]=mix(c[2],249,t);d[p+3]=255}
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){let i=y*W+x,rid=S.map[i];if(rid<0||S.outline[i])continue;let r=S.regions[rid];if(r.filled)continue;let ed=false;if(x<W-1){let n=S.map[i+1];if(n>=0&&n!==rid)ed=true}if(y<H-1){let n=S.map[i+W];if(n>=0&&n!==rid&&!(r.filled&&S.regions[n].filled))ed=true}if(ed){let p=i*4,c=S.palette[r.color];d[p]=mix(c[0],110,.35);d[p+1]=mix(c[1],110,.35);d[p+2]=mix(c[2],110,.35)}}
 pctx.putImageData(o,0,0);let f=fit();ctx.clearRect(0,0,E.c.width,E.c.height);ctx.fillStyle='#fffaf5';ctx.fillRect(0,0,E.c.width,E.c.height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(paint,f.x,f.y,f.w,f.h);
 let blend=0;if(S.complete){blend=clamp((performance.now()-S.complete)/650,0,1);if(blend){ctx.globalAlpha=blend;ctx.drawImage(S.img,f.x,f.y,f.w,f.h);ctx.globalAlpha=1}}
 if(blend<.8)numbers(f);if(S.spark)spark(f)
}
function numbers(f){let sx=f.w/S.W,sy=f.h/S.H,di=D[S.diff];ctx.textAlign='center';ctx.textBaseline='middle';for(let r of S.regions){if(r.filled||r.area<16)continue;let box=Math.min((r.maxX-r.minX+1)*sx,(r.maxY-r.minY+1)*sy),fs=clamp(box*.28*di.label,10*(devicePixelRatio||1),18*(devicePixelRatio||1)),c=S.palette[r.color];ctx.font=`900 ${fs}px system-ui,sans-serif`;ctx.lineWidth=Math.max(2,fs*.18);ctx.strokeStyle='rgba(255,255,255,.9)';ctx.fillStyle=`rgba(${mix(c[0],70,.55)},${mix(c[1],70,.55)},${mix(c[2],70,.55)},.95)`;let x=f.x+(r.lx+.5)*sx,y=f.y+(r.ly+.5)*sy;ctx.strokeText(r.color+1,x,y);ctx.fillText(r.color+1,x,y)}}
function spark(f){let age=performance.now()-S.spark.t;if(age>330){S.spark=null;return}let q=age/330,x=f.x+S.spark.x/S.W*f.w,y=f.y+S.spark.y/S.H*f.h;ctx.save();ctx.globalAlpha=1-q;ctx.strokeStyle='#fff';ctx.lineWidth=3*(devicePixelRatio||1);ctx.beginPath();ctx.arc(x,y,(9+q*20)*(devicePixelRatio||1),0,Math.PI*2);ctx.stroke();ctx.restore()}
function pick(ev){let r=E.c.getBoundingClientRect(),d=E.c.width/r.width,cx=(ev.clientX-r.left)*d,cy=(ev.clientY-r.top)*d,f=S.fit;if(cx<f.x||cy<f.y||cx>f.x+f.w||cy>f.y+f.h)return-1;let x=clamp(Math.floor((cx-f.x)/f.w*S.W),0,S.W-1),y=clamp(Math.floor((cy-f.y)/f.h*S.H),0,S.H-1),rid=S.map[y*S.W+x];if(rid>=0)return rid;for(let rad=1;rad<=3;rad++)for(let yy=Math.max(0,y-rad);yy<=Math.min(S.H-1,y+rad);yy++)for(let xx=Math.max(0,x-rad);xx<=Math.min(S.W-1,x+rad);xx++){let q=S.map[yy*S.W+xx];if(q>=0&&S.regions[q].color===S.selected&&!S.regions[q].filled)return q}return-1}
function tap(ev){if(S.busy||S.complete)return;let rid=pick(ev);if(rid<0)return;let r=S.regions[rid];if(r.filled||r.color!==S.selected)return;r.filled=true;S.filled++;S.spark={x:r.lx+.5,y:r.ly+.5,t:performance.now()};progress();bump();draw();if(done(r.color)){palette();nextColor(r.color)}else palette();if(S.filled===S.total)finishGame();animate()}
function nextColor(from){for(let n=1;n<=S.palette.length;n++){let c=(from+n)%S.palette.length;if(!done(c)){S.selected=c;palette();return}}}
function bump(){S.combo++;S.comboEnd=performance.now()+2500;E.combo.textContent=S.combo+' combo!';E.combo.classList.add('on');E.meter.classList.add('on');if(S.combo===10&&!S.catDone){S.catDone=true;E.cat.classList.remove('show');void E.cat.offsetWidth;E.cat.classList.add('show')}}
function animate(){if(!S.raf)S.raf=requestAnimationFrame(tick)}
function tick(){S.raf=0;let n=performance.now(),again=false;if(S.combo>0){let left=S.comboEnd-n;if(left<=0){S.combo=0;S.catDone=false;E.combo.classList.remove('on');E.meter.classList.remove('on')}else{E.meterFill.style.transform=`scaleX(${clamp(left/2500,0,1)})`;again=true}}if(S.spark){again=true;draw()}if(S.complete&&n-S.complete<800){again=true;draw()}if(again)S.raf=requestAnimationFrame(tick)}
function finishGame(){S.combo=0;E.combo.classList.remove('on');E.meter.classList.remove('on');S.complete=performance.now();palette();animate();setTimeout(()=>E.finish.classList.add('show'),760)}
E.c.addEventListener('pointerdown',tap);E.reset.onclick=()=>reset();E.again.onclick=()=>reset();E.home.onclick=()=>E.menu.classList.remove('off');E.closeMenu.onclick=()=>E.menu.classList.add('off');E.uploadBtn.onclick=()=>E.upload.click();
E.upload.onchange=async()=>{let f=E.upload.files&&E.upload.files[0];if(!f)return;if(S.url)URL.revokeObjectURL(S.url);S.url=URL.createObjectURL(f);E.menu.classList.add('off');await source(S.url)};
document.querySelectorAll('[data-difficulty]').forEach(b=>b.onclick=async()=>{if(b.dataset.difficulty===S.diff)return;S.diff=b.dataset.difficulty;document.querySelectorAll('[data-difficulty]').forEach(x=>x.classList.toggle('active',x===b));await process()});
document.querySelectorAll('[data-colors]').forEach(b=>b.onclick=async()=>{let n=+b.dataset.colors;if(n===S.colors)return;S.colors=n;document.querySelectorAll('[data-colors]').forEach(x=>x.classList.toggle('active',x===b));E.menu.classList.add('off');await process()});
new ResizeObserver(resize).observe(E.stage);window.addEventListener('orientationchange',()=>setTimeout(resize,150));source('demo.svg');
})();