const F=window.__FOLK,D=window.__DRAG,S=window.__SKY,S2=window.__SKY2;const by={};
for(let ms=0;ms<F.LOOP_MS;ms+=60){const u=ms/F.LOOP_MS,c=F.camAt(ms),p=c.pos,t=F.KEYS[c.keyIdx].title;window.__SKYTICK(ms/1000*170600/F.LOOP_MS);
 const b=by[t]=by[t]||{n:0,dragon:99,wy:99,ship:99,bal:99,zep:99};
 for(let i=0;i<3;i++){const q=D.pos(i,u);b.dragon=Math.min(b.dragon,Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2]))}
 for(const m of S2.wy){const q=m.position;b.wy=Math.min(b.wy,Math.hypot(q.x-p[0],q.y-p[1],q.z-p[2]))}
 {const q=S2.sm.position;b.ship=Math.min(b.ship,Math.hypot(q.x-p[0],q.y-p[1],q.z-p[2]))}
 for(const f of S.fl){const q=f.m.position;b.bal=Math.min(b.bal,Math.hypot(q.x-p[0],q.y-p[1],q.z-p[2]))}
 {const q=S.zm.position;b.zep=Math.min(b.zep,Math.hypot(q.x-p[0],q.y-p[1],q.z-p[2]))}b.n++}
const r={};for(const k in by){const b=by[k];r[k]=['d'+Math.round(b.dragon),'w'+Math.round(b.wy),'s'+Math.round(b.ship),'b'+Math.round(b.bal),'z'+Math.round(b.zep)].join(' ')}return JSON.stringify(r)
