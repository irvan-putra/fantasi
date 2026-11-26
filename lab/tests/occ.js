const F=window.__FOLK; const by={}; 
for(let ms=0;ms<F.LOOP_MS;ms+=40){const c=F.camAt(ms),p=c.pos,l=c.look; const t=F.KEYS[c.keyIdx].title; const b=by[t]=by[t]||{n:0,occ:0,close:0};
 b.n++; const dx=l[0]-p[0],dy=l[1]-p[1],dz=l[2]-p[2],D=Math.hypot(dx,dy,dz); let occ=false,close=false;
 for(let d=3;d<Math.min(D-5,90);d+=2){const f=d/D,x=p[0]+dx*f,y=p[1]+dy*f,z=p[2]+dz*f,r=F.roofAt(x,z); if(r>=0){ if(r>y-0.3){occ=true;break;} if(d<35&&y-r<3.5)close=true; }}
 for(let a=0;a<8&&!close;a++)for(const rad of [3,7]){const r=F.roofAt(p[0]+Math.cos(a*0.785)*rad,p[2]+Math.sin(a*0.785)*rad); if(r>=0&&p[1]-r<5&&p[1]>r-1){close=true;break;}}
 if(occ)b.occ++; if(close)b.close++;}
return JSON.stringify(by);
