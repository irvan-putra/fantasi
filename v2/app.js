import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const bar = document.querySelector('#bar i');

// ---------------- loading ----------------
async function fetchWithProgress(url, onp) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + url + ' ' + r.status);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total) { const b = await r.arrayBuffer(); onp && onp(1); return b; }
  const reader = r.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onp && onp(got / total);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

const stallTimer = setTimeout(() => $('stall').classList.add('show'), 12000);

const manifest = await (await fetch('./manifest.json')).json();
bar.style.width = '6%';
const binBuf = await fetchWithProgress('./scene.bin', (f) => { bar.style.width = (6 + f * 84) + '%'; });
bar.style.width = '92%';

// ---------------- decode sections ----------------
const SEC = manifest.sections;
function sec(name) {
  const s = SEC[name];
  const off = s.offset, len = s.length;
  if (s.dtype === 'f32') return new Float32Array(binBuf, off, len / 4);
  if (s.dtype === 'u32') return new Uint32Array(binBuf, off, len / 4);
  return new Uint8Array(binBuf, off, len);
}
function geoFromSections(prefix, { uv = false } = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(sec(prefix + '_pos'), 3));
  const col = sec(prefix + '_col');
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(col.buffer, col.byteOffset, col.length), 3, true));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(sec(prefix + '_uv'), 2));
  g.setIndex(new THREE.BufferAttribute(sec(prefix + '_idx'), 1));
  g.computeVertexNormals();
  return g;
}

// ---------------- renderer / scene ----------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
$('scene').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const FOG_DUSK = new THREE.Color('#274B5C'), FOG_NIGHT = new THREE.Color('#0E1A2A');
scene.fog = new THREE.FogExp2(FOG_DUSK.getHex(), 0.00105);
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.5, 6000);

const hemi = new THREE.HemisphereLight(0x3d7a8c, 0x18101f, 1.18);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffd9a0, 0.72);
dir.position.set(-0.4, 0.8, 0.35);
scene.add(dir);

// ---------------- sky dome (v3: sun disc, bands, clouds, moon) ----------------
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uPhase: { value: 0 }, uTime: { value: 0 } },
  vertexShader: 'varying vec3 vDir;void main(){vDir=normalize(position);vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_Position=p.xyww;}',
  fragmentShader: `
precision highp float;uniform float uPhase;uniform float uTime;varying vec3 vDir;
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  float a=hash12(i),b=hash12(i+vec2(1.,0.)),c=hash12(i+vec2(0.,1.)),d=hash12(i+vec2(1.,1.));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
void main(){
  vec3 d=normalize(vDir);
  float h=clamp(d.y,0.0,1.0);
  // dusk palette: hot amber horizon -> magenta band -> cyan -> deep teal zenith
  vec3 hD=vec3(1.05,0.55,0.22), bD=vec3(0.85,0.28,0.42), mD=vec3(0.13,0.52,0.58), zD=vec3(0.03,0.12,0.24);
  // night palette: ember horizon -> indigo -> deep blue zenith
  vec3 hN=vec3(0.30,0.13,0.22), bN=vec3(0.10,0.16,0.34), mN=vec3(0.04,0.11,0.22), zN=vec3(0.012,0.03,0.09);
  vec3 hd=mix(hD,hN,uPhase), bd=mix(bD,bN,uPhase), md=mix(mD,mN,uPhase), zd=mix(zD,zN,uPhase);
  vec3 col=mix(hd,bd,smoothstep(0.0,0.10,h));
  col=mix(col,md,smoothstep(0.07,0.30,h));
  col=mix(col,zd,smoothstep(0.24,0.66,h));
  // low sun disc + halo, strong at dusk, gone by mid-loop
  vec3 sdv=normalize(vec3(-0.62,0.055,-0.42));
  float dsd=dot(d,sdv);
  float sunVis=1.0-smoothstep(0.15,0.5,uPhase);
  float disc=smoothstep(0.99965,0.99993,dsd);
  float halo=pow(max(dsd,0.0),90.0)*0.8+pow(max(dsd,0.0),18.0)*0.30;
  col+=(disc*2.4+halo)*vec3(1.0,0.72,0.38)*sunVis;
  // horizon glow around sun azimuth
  float az=pow(max(dot(normalize(vec3(d.x,0.0,d.z)),normalize(vec3(-0.62,0.0,-0.42))),0.0),3.0);
  col+=vec3(1.0,0.5,0.2)*az*(1.0-smoothstep(0.0,0.28,h))*sunVis*0.35;
  // drifting clouds: two fbm bands, amber-lit at dusk, silver at night
  float cl=0.0;
  if(d.y>0.03){
    vec2 cuv=d.xz/(0.25+d.y)*1.6;
    float n=vnoise(cuv*1.3+vec2(uTime*0.008,0.0))*0.6+vnoise(cuv*3.1+vec2(uTime*0.016,3.7))*0.4;
    float band=smoothstep(0.05,0.16,d.y)*smoothstep(0.62,0.30,d.y);
    cl=smoothstep(0.52,0.78,n)*band;
  }
  vec3 cloudC=mix(vec3(1.0,0.58,0.34),vec3(0.45,0.62,0.78),uPhase);
  col=mix(col,cloudC,cl*(0.35+0.25*(1.0-uPhase)));
  // moon, rising with night
  vec3 mdv=normalize(vec3(0.45,0.52,-0.62));
  float dm=dot(d,mdv);
  float mdisc=smoothstep(0.99955,0.99985,dm);
  float mglow=pow(max(dm,0.0),200.0)*0.9+pow(max(dm,0.0),24.0)*0.12;
  vec3 mc=vec3(1.0,0.93,0.76);
  col+=(mdisc*1.8+mglow)*mc*(0.30+0.70*uPhase);
  // faint teal aurora late
  float au=smoothstep(0.55,0.95,uPhase)*(1.0-smoothstep(0.92,1.0,uPhase)*0.6);
  if(au>0.001&&d.y>0.15){
    float band2=smoothstep(0.15,0.4,d.y)*smoothstep(0.75,0.5,d.y);
    float w=0.5+0.5*sin(atan(d.z,d.x)*3.0+uTime*0.1+d.y*4.0);
    col+=vec3(0.1,0.7,0.6)*band2*w*au*0.16;
  }
  gl_FragColor=vec4(col,1.0);
}`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(4200, 32, 20), skyMat);
sky.frustumCulled = false;
scene.add(sky);
// starfield: real points on the dome
let starMat;
{
  const N = 1600, p = new Float32Array(N * 3), c = new Float32Array(N * 3);
  let sd = 11; const rnd = () => (sd = (sd * 9301 + 49297) & 65535) / 65535;
  for (let i = 0; i < N; i++) {
    const az = rnd() * 6.283, el = Math.asin(rnd() * 0.94 + 0.05);
    const r = 4000;
    p[i * 3] = Math.cos(az) * Math.cos(el) * r;
    p[i * 3 + 1] = Math.sin(el) * r;
    p[i * 3 + 2] = Math.sin(az) * Math.cos(el) * r;
    const w = rnd(), b = 0.55 + rnd() * 0.45;
    const warm = rnd() < 0.18;
    c[i * 3] = b * (warm ? 1.0 : 0.8 + w * 0.2);
    c[i * 3 + 1] = b * (warm ? 0.85 : 0.88);
    c[i * 3 + 2] = b * (warm ? 0.7 : 1.0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  starMat = new THREE.PointsMaterial({ size: 2.6, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false });
  starMat.toneMapped = false;
  const pts = new THREE.Points(g, starMat);
  pts.frustumCulled = false;
  sky.add(pts);
}

// ---------------- window textures ----------------
function windowTextures() {
  const W = 256, H = 256;
  const alb = document.createElement('canvas'); alb.width = W; alb.height = H;
  const emi = document.createElement('canvas'); emi.width = W; emi.height = H;
  const a = alb.getContext('2d'), e = emi.getContext('2d');
  a.fillStyle = '#c9c2bb'; a.fillRect(0, 0, W, H);
  e.fillStyle = '#000'; e.fillRect(0, 0, W, H);
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) & 65535) / 65535;
  const cols = 8, rows = 8, cw = W / cols, ch = H / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = c * cw, y = r * ch;
    a.fillStyle = 'rgba(60,52,60,0.55)'; a.fillRect(x + 5, y + 7, cw - 10, ch - 12);
    if (rnd() < 0.3) {
      const warm = rnd() < 0.82;
      const g = e.createLinearGradient(0, y, 0, y + ch);
      const col = warm ? '255,196,110' : '140,225,255';
      g.addColorStop(0, `rgba(${col},${0.75 + rnd() * 0.25})`);
      g.addColorStop(1, `rgba(${col},${0.4 + rnd() * 0.3})`);
      e.fillStyle = g; e.fillRect(x + 6, y + 8, cw - 12, ch - 14);
    }
  }
  const ta = new THREE.CanvasTexture(alb), te = new THREE.CanvasTexture(emi);
  for (const t of [ta, te]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; }
  return { alb: ta, emi: te };
}
const wtex = windowTextures();

// ---------------- static geometry ----------------
const wallMat = new THREE.MeshLambertMaterial({
  vertexColors: true, map: wtex.alb, emissive: 0xffffff, emissiveMap: wtex.emi,
  emissiveIntensity: 0.0, side: THREE.DoubleSide,
});
scene.add(new THREE.Mesh(geoFromSections('walls', { uv: true }), wallMat));

const roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
scene.add(new THREE.Mesh(geoFromSections('roofs'), roofMat));

const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide });
glowMat.color.setScalar(0.0);
scene.add(new THREE.Mesh(geoFromSections('glow'), glowMat));

const greenMat = new THREE.MeshLambertMaterial({ vertexColors: true });
scene.add(new THREE.Mesh(geoFromSections('green'), greenMat));

const roadMat = new THREE.MeshBasicMaterial({ vertexColors: true });
scene.add(new THREE.Mesh(geoFromSections('roads'), roadMat));

// ground disc
{
  const g = new THREE.CircleGeometry(3400, 48);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({ color: 0x182840 });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = -0.05;
  scene.add(mesh);
}

// ---------------- water shader ----------------
const waterUniforms = { uTime: { value: 0 }, uGlow: { value: 0.25 }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0.00105 } };
{
  const g = geoFromSections('water');
  const m = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: `
varying vec3 vW;varying float vFogZ;
void main(){vec4 w=modelMatrix*vec4(position,1.0);vW=w.xyz;
vec4 mv=viewMatrix*w;vFogZ=-mv.z;gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `
precision highp float;uniform float uTime;uniform float uGlow;uniform vec3 fogColor;uniform float fogDensity;
varying vec3 vW;varying float vFogZ;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
  vec3 deep=vec3(0.02,0.13,0.17), teal=vec3(0.05,0.35,0.42), cy=vec3(0.13,0.83,0.93);
  float b1=sin(vW.x*0.045+uTime*0.7)*sin(vW.z*0.06-uTime*0.9);
  float b2=sin(vW.x*0.11-uTime*1.7+vW.z*0.07);
  float band=0.5+0.25*b1+0.25*b2;
  vec3 col=mix(deep,teal,band);
  col+=cy*band*uGlow*0.5;
  vec2 cell=floor(vW.xz*0.9);
  float sp=hash(cell);
  if(sp>0.986){float tw=0.5+0.5*sin(uTime*2.5+sp*90.0);col+=cy*tw*uGlow*0.9;}
  float f=1.0-exp(-fogDensity*fogDensity*vFogZ*vFogZ);
  col=mix(col,fogColor,clamp(f,0.0,1.0));
  gl_FragColor=vec4(col,1.0);
}`,
  });
  scene.add(new THREE.Mesh(g, m));
}

// ---------------- far buildings (instanced boxes) ----------------
{
  const far = sec('far');
  const n = far.length / 8;
  const base = new THREE.BoxGeometry(1, 1, 1);
  base.translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.normal = base.attributes.normal;
  g.instanceCount = n;
  const off = new Float32Array(n * 3), scl = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    off[i * 3] = far[i * 8]; off[i * 3 + 1] = 0; off[i * 3 + 2] = far[i * 8 + 1];
    scl[i * 3] = far[i * 8 + 2]; scl[i * 3 + 1] = far[i * 8 + 3]; scl[i * 3 + 2] = far[i * 8 + 4];
    col[i * 3] = far[i * 8 + 5] / 255; col[i * 3 + 1] = far[i * 8 + 6] / 255; col[i * 3 + 2] = far[i * 8 + 7] / 255;
  }
  g.setAttribute('ioff', new THREE.InstancedBufferAttribute(off, 3));
  g.setAttribute('iscl', new THREE.InstancedBufferAttribute(scl, 3));
  g.setAttribute('icol', new THREE.InstancedBufferAttribute(col, 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { uNight: { value: 0 }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0.00105 } },
    vertexShader: `
attribute vec3 ioff;attribute vec3 iscl;attribute vec3 icol;
varying vec3 vC;varying float vFogZ;varying vec3 vN;
void main(){vC=icol;vN=normal;
vec3 p=position*iscl+ioff;
vec4 mv=viewMatrix*vec4(p,1.0);vFogZ=-mv.z;gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `
precision highp float;uniform float uNight;uniform vec3 fogColor;uniform float fogDensity;
varying vec3 vC;varying float vFogZ;varying vec3 vN;
void main(){
  vec3 L=normalize(vec3(-0.4,0.8,0.35));
  float d=max(dot(normalize(vN),L),0.0);
  vec3 col=vC*(0.44+0.45*d);
  col+=vC*vec3(1.0,0.8,0.5)*uNight*0.5;
  float f=1.0-exp(-fogDensity*fogDensity*vFogZ*vFogZ);
  col=mix(col,fogColor,clamp(f,0.0,1.0));
  gl_FragColor=vec4(col,1.0);
}`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  scene.add(mesh);
  var farMat = m;
}

// ---------------- trees (instanced) ----------------
function treeGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.35, 0.55, 3.2, 5);
  trunk.translate(0, 1.6, 0);
  const c1 = new THREE.ConeGeometry(2.6, 4.4, 6); c1.translate(0, 5.4, 0);
  const c2 = new THREE.ConeGeometry(1.9, 3.4, 6); c2.translate(0, 7.6, 0);
  const c3 = new THREE.ConeGeometry(1.2, 2.4, 5); c3.translate(0, 9.5, 0);
  return mergeGeos([
    { g: trunk, c: [0.36, 0.23, 0.14] },
    { g: c1, c: [0.10, 0.32, 0.24] }, { g: c2, c: [0.13, 0.42, 0.28] }, { g: c3, c: [0.16, 0.5, 0.3] },
  ]);
}
function mergeGeos(items) {
  let pos = [], nrm = [], col = [];
  for (const it of items) {
    const g = it.g.index ? it.g.toNonIndexed() : it.g;
    const p = g.attributes.position.array, nn = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]);
      nrm.push(nn[i], nn[i + 1], nn[i + 2]);
      col.push(it.c[0], it.c[1], it.c[2]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  return g;
}
{
  const pts = manifest.trees;
  const inst = new THREE.InstancedMesh(treeGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), pts.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < pts.length; i++) {
    const s = 0.8 + ((i * 37) % 100) / 140;
    Q.setFromAxisAngle(up, (i * 2.399) % 6.28);
    S.setScalar(s); P.set(pts[i][0], 0.4, pts[i][1]);
    M.compose(P, Q, S);
    inst.setMatrixAt(i, M);
  }
  scene.add(inst);
}

// ---------------- sprite texture (halos) ----------------
function haloTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); return t;
}
const haloTex = haloTexture();

// ---------------- street lamps ----------------
let lampMat;
{
  const pts = manifest.lamps;
  const p = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) { p[i * 3] = pts[i][0]; p[i * 3 + 1] = 5.5; p[i * 3 + 2] = pts[i][1]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  lampMat = new THREE.PointsMaterial({ size: 9, map: haloTex, color: 0xffc46e, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  lampMat.toneMapped = false;
  scene.add(new THREE.Points(g, lampMat));
}

// ---------------- floating lanterns ----------------
const LANT = manifest.lanterns;
let lanternInst, lanternPts;
{
  const g = new THREE.BoxGeometry(1.05, 1.35, 1.05);
  const m = new THREE.MeshBasicMaterial({ color: 0xffc46e });
  m.toneMapped = false;
  lanternInst = new THREE.InstancedMesh(g, m, LANT.length);
  scene.add(lanternInst);
  const p = new Float32Array(LANT.length * 3);
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const pm = new THREE.PointsMaterial({ size: 36, map: haloTex, color: 0xff9e3c, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  pm.toneMapped = false;
  lanternPts = new THREE.Points(pg, pm);
  scene.add(lanternPts);
}
const _lm = new THREE.Matrix4();
function tickLanterns(t, night) {
  const pa = lanternPts.geometry.attributes.position;
  for (let i = 0; i < LANT.length; i++) {
    const L = LANT[i];
    const y = L[1] + Math.sin(t * 0.5 + L[4]) * 3 + night * 10;
    const x = L[0] + Math.sin(t * 0.11 + L[4] * 2.0) * 6;
    _lm.makeScale(L[3], L[3], L[3]);
    _lm.setPosition(x, y, L[2]);
    lanternInst.setMatrixAt(i, _lm);
    pa.array[i * 3] = x; pa.array[i * 3 + 1] = y; pa.array[i * 3 + 2] = L[2];
  }
  lanternInst.instanceMatrix.needsUpdate = true;
  pa.needsUpdate = true;
  lanternPts.material.opacity = 0.25 + night * 0.45;
}

// ---------------- boats ----------------
const boats = [];
function makeBoat() {
  const wood = [0.48, 0.29, 0.14], woodD = [0.35, 0.2, 0.09];
  const hull = new THREE.ConeGeometry(1.6, 7.5, 4, 1);
  hull.rotateX(Math.PI / 2); hull.scale(1, 0.55, 1); hull.translate(0, 0.8, 0);
  const deck = new THREE.BoxGeometry(2.2, 0.25, 5.5); deck.translate(0, 1.15, 0);
  const mast = new THREE.CylinderGeometry(0.08, 0.08, 3.4, 4); mast.translate(0, 3, -0.4);
  const bodyG = mergeGeos([{ g: hull, c: wood }, { g: deck, c: woodD }, { g: mast, c: woodD }]);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(bodyG, new THREE.MeshLambertMaterial({ vertexColors: true })));
  const lampG = new THREE.SphereGeometry(0.35, 6, 5); lampG.translate(0, 4.9, -0.4);
  const lm = new THREE.Mesh(lampG, new THREE.MeshBasicMaterial({ color: 0xffc46e }));
  lm.material.toneMapped = false;
  g.add(lm);
  return g;
}
for (const b of manifest.boats) {
  const g = makeBoat();
  g.position.set(b[0], 0.5, b[1]);
  g.rotation.y = b[2];
  scene.add(g);
  boats.push({ g, ph: b[2], x: b[0], z: b[1] });
}

// ---------------- crystals ----------------
{
  const items = [];
  const rock = new THREE.IcosahedronGeometry(3, 0); rock.scale(1.2, 0.6, 1.1); rock.translate(0, 1, 0);
  items.push({ g: rock, c: [0.16, 0.14, 0.24] });
  const shardDefs = [[0, 0, 7, 1.6, 0.3], [-2.2, 0.7, 4.5, 1.2, 1.1], [2, -0.8, 5, 1.3, 2.2], [0.8, 2, 3.2, 0.9, 4.0], [-1, -2, 3.4, 0.95, 5.2]];
  const crysGeo = [];
  for (const [x, z, h, r, ry] of shardDefs) {
    const o = new THREE.OctahedronGeometry(r, 0);
    o.scale(1, h / (r * 2), 1); o.rotateY(ry); o.translate(x, 1 + h * 0.5, z);
    crysGeo.push(o);
  }
  const rockG = mergeGeos(items);
  const crysG = mergeGeos(crysGeo.map((o) => ({ g: o, c: [0.35, 0.85, 1.0] })));
  const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const crysMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  crysMat.toneMapped = false;
  for (const c of manifest.crystals) {
    const grp = new THREE.Group();
    grp.add(new THREE.Mesh(rockG, rockMat));
    grp.add(new THREE.Mesh(crysG, crysMat));
    grp.position.set(c[0], 0, c[1]);
    grp.scale.setScalar(c[2]);
    grp.rotation.y = c[2] * 3.1;
    scene.add(grp);
  }
  var crystalMat = crysMat;
}

// ---------------- hero landmarks (real silhouettes) ----------------
const lmTickers = [];
function tickLandmarks(t, phase) { for (const f of lmTickers) f(t, phase); }
function lmBasic(hex) { const m = new THREE.MeshBasicMaterial({ color: hex }); m.toneMapped = false; return m; }
function lmLambert() { return new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); }
function lmHaloAt(x, y, z, size, hex, opacity) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x, y, z]), 3));
  const m = new THREE.PointsMaterial({ size, map: haloTex, color: hex, transparent: true, opacity: opacity || 0.75, depthWrite: false, blending: THREE.AdditiveBlending });
  m.toneMapped = false;
  scene.add(new THREE.Points(g, m));
  return m;
}
// upturned-eave roof: squashed cone + rim ring
function lmEaveRoof(w, h, rim) {
  const cone = new THREE.ConeGeometry(w, h, 4, 1);
  cone.rotateY(Math.PI / 4);
  const ring = new THREE.TorusGeometry(w * 0.72, w * rim, 4, 4);
  ring.rotateY(Math.PI / 4); ring.rotateX(Math.PI / 2); ring.scale(1, 0.28, 1);
  ring.translate(0, -h * 0.5 + w * rim * 0.8, 0);
  return [
    { g: cone, c: [0.10, 0.22, 0.26] },
    { g: ring, c: [0.16, 0.34, 0.36] },
  ];
}
// 1) grand paifang gate at the market approach (axis 44,-320 -> 177,-132)
{
  const mat = lmLambert();
  const GX = 128, GZ = -214, SPAN = 34;
  const parts = [];
  const stone = [0.30, 0.36, 0.44], beam = [0.62, 0.36, 0.16];
  for (const sx of [-SPAN, SPAN]) {
    const p = new THREE.CylinderGeometry(2.6, 3.1, 46, 8); p.translate(GX + sx, 23, GZ);
    parts.push({ g: p, c: stone });
    const cap = new THREE.BoxGeometry(7.5, 2.6, 7.5); cap.translate(GX + sx, 46.5, GZ);
    parts.push({ g: cap, c: stone });
  }
  const b1 = new THREE.BoxGeometry(SPAN * 2 + 16, 3.4, 5.5); b1.translate(GX, 36, GZ);
  const b2 = new THREE.BoxGeometry(SPAN * 2 + 10, 2.8, 5.0); b2.translate(GX, 43, GZ);
  parts.push({ g: b1, c: beam }, { g: b2, c: beam });
  for (const r of lmEaveRoof(30, 8, 0.05)) { r.g.translate(GX, 52, GZ); parts.push(r); }
  for (const sx of [-SPAN, SPAN]) for (const r of lmEaveRoof(13, 5, 0.06)) { r.g.translate(GX + sx, 41, GZ); parts.push(r); }
  const fin = new THREE.OctahedronGeometry(2.2, 0); fin.scale(1, 1.8, 1); fin.translate(GX, 59.5, GZ);
  parts.push({ g: fin, c: [0.2, 0.9, 0.75] });
  scene.add(new THREE.Mesh(mergeGeos(parts), mat));
  lmHaloAt(GX, 60, GZ, 30, 0x54ffc8, 0.7);
  // hanging lantern row under the beams
  const lm = [];
  for (let i = -3; i <= 3; i++) {
    const s = new THREE.SphereGeometry(1.15, 8, 6); s.scale(1, 1.3, 1); s.translate(GX + i * 8.5, 33.2, GZ);
    lm.push({ g: s, c: [1.0, 0.55, 0.18] });
  }
  scene.add(new THREE.Mesh(mergeGeos(lm), lmBasic(0xffffff)));
  const hg = new Float32Array(7 * 3);
  for (let i = -3; i <= 3; i++) { hg[(i + 3) * 3] = GX + i * 8.5; hg[(i + 3) * 3 + 1] = 33.2; hg[(i + 3) * 3 + 2] = GZ; }
  const hgeo = new THREE.BufferGeometry();
  hgeo.setAttribute('position', new THREE.BufferAttribute(hg, 3));
  const hmat = new THREE.PointsMaterial({ size: 16, map: haloTex, color: 0xffa24a, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
  hmat.toneMapped = false;
  scene.add(new THREE.Points(hgeo, hmat));
  lmTickers.push((t, phase) => { hmat.opacity = 0.55 + 0.3 * phase + Math.sin(t * 2.1) * 0.08; });
}
// 2) tiered pagoda at the temple plaza (-166, 143)
function lmPagoda(PX, PZ, tiers, baseW, baseH) {
  const mat = lmLambert();
  const parts = [];
  let y = 0, w = baseW;
  const body = [0.32, 0.24, 0.38];
  for (let i = 0; i < tiers; i++) {
    const segH = baseH * (1 - i * 0.08);
    const b = new THREE.BoxGeometry(w, segH, w); b.translate(PX, y + segH / 2, PZ);
    parts.push({ g: b, c: body });
    y += segH;
    for (const r of lmEaveRoof(w * 0.95, segH * 0.42, 0.05)) { r.g.translate(PX, y + segH * 0.18, PZ); parts.push(r); }
    y += segH * 0.34;
    w *= 0.82;
  }
  const fin = new THREE.ConeGeometry(1.6, 9, 6); fin.translate(PX, y + 5, PZ);
  parts.push({ g: fin, c: [1.0, 0.75, 0.3] });
  scene.add(new THREE.Mesh(mergeGeos(parts), mat));
  // glowing window band per tier
  const wins = [];
  let wy = 0, ww = baseW;
  for (let i = 0; i < tiers; i++) {
    const segH = baseH * (1 - i * 0.08);
    const band = new THREE.BoxGeometry(ww * 0.72, segH * 0.3, ww * 0.72);
    band.translate(PX, wy + segH * 0.55, PZ);
    wins.push({ g: band, c: [1.0, 0.72, 0.3] });
    wy += segH * 1.34; ww *= 0.82;
  }
  const wm = lmBasic(0xffffff);
  scene.add(new THREE.Mesh(mergeGeos(wins), wm));
  lmHaloAt(PX, wy + 6, PZ, 26, 0xffc46e, 0.65);
  lmTickers.push((t, phase) => { wm.color.setScalar(0.25 + phase * 0.75); });
  return { top: wy };
}
lmPagoda(-166, 143, 6, 26, 9);
lmPagoda(250, 60, 5, 20, 8);
lmPagoda(-320, -260, 5, 22, 8.5);
// 3) great hall with sweeping roof, west of temple (-250, 60)
{
  const mat = lmLambert();
  const HX = -250, HZ = 60;
  const parts = [];
  const base = new THREE.BoxGeometry(52, 16, 34); base.translate(HX, 8, HZ);
  parts.push({ g: base, c: [0.36, 0.2, 0.2] });
  const col = [0.52, 0.3, 0.14];
  for (let i = -3; i <= 3; i++) {
    const c1 = new THREE.CylinderGeometry(1.1, 1.1, 16, 6); c1.translate(HX + i * 7.4, 8, HZ + 17.5);
    parts.push({ g: c1, c: col });
  }
  const prof = [];
  for (let i = 0; i <= 12; i++) {
    const x = -30 + i * 5;
    const y = 22 - Math.pow(Math.abs(x) / 30, 2.6) * -1 * 0 - Math.abs(Math.pow(Math.abs(x) / 30, 2.2)) * 2 + Math.sin((i / 12) * Math.PI) * 8;
    prof.push(new THREE.Vector2(x, 16 + Math.sin((i / 12) * Math.PI) * 9 + Math.pow(Math.abs(x) / 30, 3) * 6));
  }
  const roof = new THREE.LatheGeometry(prof.map(v => new THREE.Vector2(Math.abs(v.x) < 0.1 ? 0.1 : Math.abs(v.x), v.y)), 4, 0, Math.PI * 2);
  roof.scale(1, 1, 0.62); roof.rotateY(Math.PI / 4);
  roof.translate(HX, 0, HZ);
  parts.push({ g: roof, c: [0.09, 0.2, 0.25] });
  scene.add(new THREE.Mesh(mergeGeos(parts), mat));
  const door = new THREE.BoxGeometry(9, 11, 1); door.translate(HX, 5.5, HZ + 17.2);
  scene.add(new THREE.Mesh(mergeGeos([{ g: door, c: [1.0, 0.7, 0.3] }]), lmBasic(0xffffff)));
  lmHaloAt(HX, 9, HZ + 19, 22, 0xffb75e, 0.7);
}
// 4) lighthouse-minaret by the harbor (700, 430)
{
  const mat = lmLambert();
  const LX = 700, LZ = 430;
  const parts = [];
  let y = 0;
  const body = [0.24, 0.34, 0.42];
  for (let i = 0; i < 5; i++) {
    const r = 10 - i * 1.5, h = 18 - i * 1.6;
    const c = new THREE.CylinderGeometry(r - 1.2, r, h, 10); c.translate(LX, y + h / 2, LZ);
    parts.push({ g: c, c: body });
    y += h;
    const bal = new THREE.TorusGeometry(r + 0.6, 0.9, 5, 12); bal.rotateX(Math.PI / 2); bal.translate(LX, y, LZ);
    parts.push({ g: bal, c: [0.55, 0.38, 0.18] });
    y += 2.2;
  }
  const top = new THREE.ConeGeometry(6, 12, 8); top.translate(LX, y + 6, LZ);
  parts.push({ g: top, c: [0.12, 0.26, 0.3] });
  scene.add(new THREE.Mesh(mergeGeos(parts), mat));
  const beamMat = lmBasic(0xffe9b0);
  const beam = new THREE.CylinderGeometry(0.7, 3.2, 60, 6, 1, true);
  beam.rotateZ(Math.PI / 2);
  const beamMesh = new THREE.Mesh(beam, new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
  beamMesh.material.toneMapped = false;
  beamMesh.position.set(LX, y + 3, LZ);
  scene.add(beamMesh);
  const lampHalo = lmHaloAt(LX, y + 3, LZ, 40, 0xffe9b0, 0.9);
  lmTickers.push((t, phase) => {
    beamMesh.rotation.y = t * 0.7;
    beamMesh.material.opacity = 0.16 + phase * 0.2;
    lampHalo.opacity = 0.5 + 0.4 * phase + Math.sin(t * 3.1) * 0.1;
  });
}
// 5) arched lantern bridge near the harbor (620, 380) — arc over water edge
{
  const mat = lmLambert();
  const BX = 620, BZ = 380, SP = 46, H = 14;
  const parts = [];
  const deckPts = [];
  for (let i = 0; i <= 16; i++) {
    const f = i / 16, x = BX + (f - 0.5) * SP * 2;
    const yy = 2 + Math.sin(f * Math.PI) * H;
    deckPts.push([x, yy]);
  }
  for (let i = 0; i < 16; i++) {
    const [x0, y0] = deckPts[i], [x1, y1] = deckPts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const seg = new THREE.BoxGeometry(len + 0.4, 1.2, 6);
    seg.translate((x0 + x1) / 2, (y0 + y1) / 2, BZ);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const rot = new THREE.Matrix4().makeRotationZ(ang);
    seg.applyMatrix4(new THREE.Matrix4().makeTranslation(-(x0 + x1) / 2, -(y0 + y1) / 2, -BZ));
    seg.applyMatrix4(rot);
    seg.applyMatrix4(new THREE.Matrix4().makeTranslation((x0 + x1) / 2, (y0 + y1) / 2, BZ));
    parts.push({ g: seg, c: [0.5, 0.3, 0.14] });
  }
  for (const sx of [-SP, 0, SP]) {
    const post = new THREE.CylinderGeometry(1.2, 1.5, 22, 6); post.translate(BX + sx, 6, BZ);
    parts.push({ g: post, c: [0.28, 0.3, 0.36] });
  }
  scene.add(new THREE.Mesh(mergeGeos(parts), mat));
  // lanterns along the arc
  const n = 17, lp = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    lp[i * 3] = BX + (f - 0.5) * SP * 2;
    lp[i * 3 + 1] = 2 + Math.sin(f * Math.PI) * H + 3.4;
    lp[i * 3 + 2] = BZ;
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  const lmat = new THREE.PointsMaterial({ size: 12, map: haloTex, color: 0xff9e3c, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
  lmat.toneMapped = false;
  scene.add(new THREE.Points(lg, lmat));
  lmTickers.push((t, phase) => { lmat.opacity = 0.5 + 0.35 * phase + Math.sin(t * 1.7 + 1) * 0.07; });
}

// ---------------- dragons (hero scale, close passes) ----------------
function makeDragon(colorHex) {
  const base = new THREE.Color(colorHex);
  const belly = base.clone().lerp(new THREE.Color(0xfff0cf), 0.65);
  const fin = base.clone().multiplyScalar(0.5);
  const body = [];
  const addS = (r, x, y, z, sx, sy, sz, c) => {
    const g = new THREE.SphereGeometry(r, 6, 4); g.scale(sx, sy, sz); g.translate(x, y, z);
    body.push({ g, c: [c.r, c.g, c.b] });
  };
  const segs = [[0, 0, -3.6, 2.5, 1.0], [0, 0, -0.7, 2.4, 1.05], [0, 0.12, 1.9, 2.0, 1.0], [0, 0.36, 4.2, 1.55, 1.0], [0, 0.6, 6.1, 1.1, 1.0]];
  for (const s of segs) addS(s[3], s[0], s[1], s[2], 1.15, 1, s[4] * 1.4, base);
  addS(2.4, 0, -1.0, -0.6, 1.1, 0.8, 1.9, belly);
  addS(1.8, 0, 1.7, 8.1, 0.95, 1, 1.1, base);
  {
    const g = new THREE.ConeGeometry(1.0, 3.3, 5); g.rotateX(Math.PI / 2); g.translate(0, 1.45, 10.5);
    body.push({ g, c: [base.r, base.g, base.b] });
  }
  for (const sx of [-0.72, 0.72]) {
    const g = new THREE.ConeGeometry(0.6, 1.4, 4); g.translate(sx, 2.9, 8.1);
    body.push({ g, c: [fin.r, fin.g, fin.b] });
  }
  {
    const g = new THREE.ConeGeometry(1.1, 7.2, 5); g.rotateX(-Math.PI / 2); g.translate(0, 0.3, -8.1);
    body.push({ g, c: [base.r, base.g, base.b] });
  }
  const bodyMesh = new THREE.Mesh(mergeGeos(body), new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color(colorHex), emissiveIntensity: 0.32 }));
  const glows = [];
  for (const sx of [-0.75, 0.75]) {
    const g = new THREE.SphereGeometry(0.3, 5, 4); g.translate(sx, 2.1, 9.3);
    glows.push({ g, c: [1.0, 0.82, 0.3] });
  }
  for (let i = 0; i < 7; i++) {
    const g = new THREE.ConeGeometry(0.35, 1.2, 4); g.translate(0, 2.2 - i * 0.12, 5.5 - i * 1.7);
    glows.push({ g, c: [0.55, 0.9, 1.0] });
  }
  const glowMesh = new THREE.Mesh(mergeGeos(glows), new THREE.MeshBasicMaterial({ vertexColors: true }));
  glowMesh.material.toneMapped = false;
  function wing(sign) {
    const pivot = new THREE.Group();
    pivot.position.set(0.8 * sign, 1.8, 0.9);
    const P = [[0, 0, 0], [3.3 * sign, -1.5, 0], [0.7 * sign, 3.3, 0], [5.1 * sign, 3.7, 0]];
    const g = new THREE.BufferGeometry();
    const v = [];
    const idx = [0, 1, 2, 2, 1, 3];
    for (const k of idx) v.push(P[k][0], P[k][1], P[k][2]);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
    g.computeVertexNormals();
    const col = [];
    for (let i = 0; i < 6; i++) col.push(fin.r, fin.g, fin.b);
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: new THREE.Color(colorHex), emissiveIntensity: 0.12 }));
    pivot.add(m);
    return pivot;
  }
  const L = wing(1), R = wing(-1);
  // halo so the dragon reads at distance
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 1, 1]), 3));
  const hm = new THREE.PointsMaterial({ size: 22, map: haloTex, color: colorHex, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending });
  hm.toneMapped = false;
  const halo = new THREE.Points(hg, hm);
  const grp = new THREE.Group();
  grp.add(bodyMesh, glowMesh, L, R, halo);
  grp.scale.setScalar(5.2);
  return { grp, L, R };
}
const DRAG_PATHS = [
  { cx: 177, cz: -132, r: 150, h: 85, amp: 30, speed: 0.16, ph: 0.0 },
  { cx: -166, cz: 143, r: 120, h: 70, amp: 22, speed: -0.12, ph: 2.1 },
  { cx: 560, cz: 350, r: 130, h: 100, amp: 35, speed: 0.10, ph: 4.2 },
];
const dragons = manifest.dragons.map((d, i) => {
  const { grp, L, R } = makeDragon(d.col);
  scene.add(grp);
  const p = DRAG_PATHS[i % DRAG_PATHS.length];
  return { grp, L, R, ...p };
});
function tickDragons(t) {
  for (const d of dragons) {
    const a = t * d.speed + d.ph;
    const x = d.cx + Math.cos(a) * d.r;
    const z = d.cz + Math.sin(a) * d.r * 0.8;
    const y = d.h + Math.sin(t * 0.5 + d.ph) * d.amp;
    d.grp.position.set(x, y, z);
    const na = a + 0.02 * Math.sign(d.speed);
    const nx = d.cx + Math.cos(na) * d.r, nz = d.cz + Math.sin(na) * d.r * 0.8;
    d.grp.lookAt(nx, y, nz);
    const f = Math.sin(t * 4.2 + d.ph) * 0.6;
    d.L.rotation.z = 0.2 + f; d.R.rotation.z = -0.2 - f;
  }
}

// ---------------- festival dressing ----------------
// lantern strings between far-building rooftops (anchors from baked far data)
let fxStringMat, fxHaloMat;
{
  const far = sec('far');
  const n = far.length / 8;
  const tops = [];
  for (let i = 0; i < n; i++) {
    const x = far[i * 8], z = far[i * 8 + 1], h = far[i * 8 + 3];
    if (Math.abs(x) < 430 && Math.abs(z) < 430 && h > 16 && h < 110) tops.push([x, h, z]);
  }
  // pair each rooftop with a neighbour 30-95m away (one direction only)
  const strings = [];
  for (let i = 0; i < tops.length && strings.length < 210; i++) {
    const [x0, h0, z0] = tops[i];
    let best = null, bd = 1e9;
    for (let j = 0; j < tops.length; j++) {
      if (i === j) continue;
      const [x1, h1, z1] = tops[j];
      if (x1 <= x0) continue;
      const dd = Math.hypot(x1 - x0, z1 - z0);
      if (dd > 30 && dd < 95 && dd < bd) { bd = dd; best = [x1, Math.min(h1, h0), z1]; }
    }
    if (best) strings.push([x0, h0, z0, best[0], best[1], best[2]]);
  }
  const PAL = [0xffc46e, 0xff9e3c, 0xff5e4a, 0xff8fb3, 0xffe08a];
  const per = 7;
  const count = strings.length * per;
  const geo = new THREE.SphereGeometry(0.9, 6, 5);
  geo.scale(1, 1.35, 1);
  fxStringMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  fxStringMat.toneMapped = false;
  const inst = new THREE.InstancedMesh(geo, fxStringMat, count);
  const M = new THREE.Matrix4();
  const col = new THREE.Color();
  const haloPts = [];
  let k = 0;
  for (const [x0, h0, z0, x1, h1, z1] of strings) {
    const y0 = h0 + 1.5, y1 = h1 + 1.5;
    const sag = Math.hypot(x1 - x0, z1 - z0) * 0.16;
    for (let j = 0; j < per; j++) {
      const f = (j + 0.5) / per;
      const x = x0 + (x1 - x0) * f;
      const z = z0 + (z1 - z0) * f;
      const y = y0 + (y1 - y0) * f - Math.sin(f * Math.PI) * sag;
      M.makeScale(1, 1, 1);
      M.setPosition(x, y, z);
      inst.setMatrixAt(k, M);
      inst.setColorAt(k, col.setHex(PAL[(k * 7) % PAL.length]));
      k++;
      if (j % 2 === 0) haloPts.push(x, y, z);
    }
  }
  inst.count = k;
  scene.add(inst);
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(haloPts), 3));
  fxHaloMat = new THREE.PointsMaterial({ size: 11, map: haloTex, color: 0xffb066, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending });
  fxHaloMat.toneMapped = false;
  scene.add(new THREE.Points(hg, fxHaloMat));
  // market awnings: striped tilted planes over the square (177, -132)
  const stripeC = document.createElement('canvas'); stripeC.width = 64; stripeC.height = 8;
  const sx2 = stripeC.getContext('2d');
  sx2.fillStyle = '#fff'; sx2.fillRect(0, 0, 64, 8);
  sx2.fillStyle = '#c33'; sx2.fillRect(0, 0, 8, 8); sx2.fillRect(16, 0, 8, 8); sx2.fillRect(32, 0, 8, 8); sx2.fillRect(48, 0, 8, 8);
  const stripeTex = new THREE.CanvasTexture(stripeC);
  stripeTex.wrapS = THREE.RepeatWrapping;
  const awn = [];
  const APAL = [[0.9, 0.3, 0.25], [0.95, 0.7, 0.2], [0.25, 0.7, 0.55], [0.75, 0.35, 0.7], [0.3, 0.55, 0.85]];
  let sd = 7; const rnd = () => (sd = (sd * 9301 + 49297) & 65535) / 65535;
  for (let i = 0; i < 22; i++) {
    const ax = 177 + (rnd() - 0.5) * 110, az = -132 + (rnd() - 0.5) * 100;
    const w = 6 + rnd() * 5, d = 4 + rnd() * 3, ry = rnd() * Math.PI;
    const p = new THREE.PlaneGeometry(w, d);
    p.rotateX(-Math.PI / 2 + 0.32); p.rotateY(ry);
    p.translate(ax, 4.2 + rnd() * 1.5, az);
    awn.push({ g: p, c: APAL[i % APAL.length] });
  }
  const awnMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, map: stripeTex, emissive: 0x664422, emissiveIntensity: 0.4 });
  scene.add(new THREE.Mesh(mergeGeos(awn), awnMat));
  lmTickers.push((t, phase) => { awnMat.emissiveIntensity = 0.25 + phase * 0.5; });
}
function tickFestival(t, phase) {
  fxHaloMat.opacity = 0.4 + 0.4 * phase + Math.sin(t * 2.3) * 0.08;
}

// ---------------- atmosphere: god rays, ground mist, stall smoke ----------------
let atRayMat, atMistPts, atMistMat, atSmokePts, atSmokeMat, atSmokeData;
{
  // god rays: merged leaning cones over market / temple / harbor / gate
  const rays = [];
  const spots = [[177, -132, 130], [-166, 143, 110], [700, 430, 150], [128, -214, 120], [22, 33, 160], [560, 350, 130]];
  for (const [x, z, h] of spots) {
    const c = new THREE.CylinderGeometry(h * 0.16, h * 0.55, h * 3.2, 7, 1, true);
    c.translate(0, h * 1.1, 0);
    const rot = new THREE.Matrix4().makeRotationZ(0.22).multiply(new THREE.Matrix4().makeRotationY(x * 0.01));
    c.applyMatrix4(rot);
    c.translate(x, 0, z);
    rays.push({ g: c, c: [1, 1, 1] });
  }
  atRayMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.02, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, fog: false });
  atRayMat.toneMapped = false;
  scene.add(new THREE.Mesh(mergeGeos(rays), atRayMat));
  // ground mist: big soft points drifting as a slow carousel
  const MN = 42, mp = new Float32Array(MN * 3);
  let sd = 3; const rnd = () => (sd = (sd * 9301 + 49297) & 65535) / 65535;
  for (let i = 0; i < MN; i++) {
    const a = rnd() * 6.283, r = 60 + rnd() * 480;
    mp[i * 3] = 22 + Math.cos(a) * r;
    mp[i * 3 + 1] = 3 + rnd() * 7;
    mp[i * 3 + 2] = 33 + Math.sin(a) * r;
  }
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
  atMistMat = new THREE.PointsMaterial({ size: 300, map: haloTex, color: 0x6fa8b8, transparent: true, opacity: 0.055, depthWrite: false });
  atMistMat.toneMapped = false;
  atMistPts = new THREE.Points(mg, atMistMat);
  atMistPts.position.set(22, 0, 33);
  for (let i = 0; i < MN; i++) { mp[i * 3] -= 22; mp[i * 3 + 2] -= 33; }
  scene.add(atMistPts);
  // stall smoke at the market
  const SN = 10, SPC = 6, sp = new Float32Array(SN * SPC * 3);
  atSmokeData = [];
  for (let i = 0; i < SN; i++) {
    const x = 177 + (rnd() - 0.5) * 100, z = -132 + (rnd() - 0.5) * 90;
    atSmokeData.push({ x, z, ph: rnd() * 6.28 });
    for (let j = 0; j < SPC; j++) {
      sp[(i * SPC + j) * 3] = x; sp[(i * SPC + j) * 3 + 1] = 6 + j * 3; sp[(i * SPC + j) * 3 + 2] = z;
    }
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  atSmokeMat = new THREE.PointsMaterial({ size: 26, map: haloTex, color: 0x9fb4bc, transparent: true, opacity: 0.16, depthWrite: false });
  atSmokeMat.toneMapped = false;
  atSmokePts = new THREE.Points(sg, atSmokeMat);
  scene.add(atSmokePts);
}
function tickAtmosphere(t, phase) {
  atRayMat.opacity = 0.010 + (1 - phase) * 0.018 + Math.sin(t * 0.5) * 0.004;
  atRayMat.color.setHex(phase < 0.5 ? 0xffd9a0 : 0x9fd6ec);
  atMistPts.rotation.y = t * 0.006;
  atMistMat.opacity = 0.04 + phase * 0.05;
  const pa = atSmokePts.geometry.attributes.position;
  const SPC = 6;
  for (let i = 0; i < atSmokeData.length; i++) {
    const d = atSmokeData[i];
    for (let j = 0; j < SPC; j++) {
      const yy = (6 + j * 3 + t * 1.6 + d.ph * 3) % 22;
      pa.array[(i * SPC + j) * 3] = d.x + Math.sin(t * 0.7 + d.ph + j) * 1.5;
      pa.array[(i * SPC + j) * 3 + 1] = 5 + yy;
      pa.array[(i * SPC + j) * 3 + 2] = d.z + Math.cos(t * 0.5 + d.ph + j * 2) * 1.2;
    }
  }
  pa.needsUpdate = true;
}

// ---------------- crowd (dense, warm, bobbing) ----------------
let crowdMat, crowdPts, crowdBase;
{
  const pts = manifest.crowd;
  const N = pts.length * 4;
  const p = new Float32Array(N * 3);
  crowdBase = new Float32Array(N * 2);
  let sd = 5; const rnd = () => (sd = (sd * 9301 + 49297) & 65535) / 65535;
  let k = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = 0; j < 4; j++) {
      const x = pts[i][0] + (rnd() - 0.5) * 6, z = pts[i][1] + (rnd() - 0.5) * 6;
      p[k * 3] = x; p[k * 3 + 1] = 1.1; p[k * 3 + 2] = z;
      crowdBase[k * 2] = x; crowdBase[k * 2 + 1] = z;
      k++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  crowdMat = new THREE.PointsMaterial({ size: 2.8, map: haloTex, color: 0xffdc9e, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  crowdMat.toneMapped = false;
  crowdPts = new THREE.Points(g, crowdMat);
  scene.add(crowdPts);
}
function tickCrowd(t) {
  const pa = crowdPts.geometry.attributes.position;
  const n = pa.array.length / 3;
  for (let i = 0; i < n; i += 7) {
    pa.array[i * 3 + 1] = 1.1 + Math.sin(t * 2.2 + i) * 0.35;
  }
  pa.needsUpdate = true;
}

// ---------------- beats / camera (closed seamless loop) ----------------
const KEYS = [
  { pos: [-1305.9, 520, -1459.1], look: [22.13, 60, 33.16], hold: 2600, fly: 5000, title: "Dusk Horizon", note: "Amber light dissolves into the first twilight shadows" },
  { pos: [-520, 130, -820], look: [22, 50, 33], hold: 1500, fly: 5200, title: "The High Descent", note: "Sliding down toward the glowing realm" },
  { pos: [-260, 64, -430], look: [22, 40, -60], hold: 1400, fly: 5000, title: "Twin Spire Dive", note: "The tallest towers frame a canyon of light" },
  { pos: [90, 26, -260], look: [177, 18, -132], hold: 2200, fly: 4800, title: "Gate of Lanterns", note: "Under the great gate, into the festival" },
  { pos: [152, 24, -95], look: [177, 14, -132], hold: 2000, fly: 5000, title: "Star Market Life", note: "Vendors weave through drifting sky lanterns" },
  { pos: [-40, 42, -40], look: [-166, 40, 143], hold: 1600, fly: 5000, title: "Pagoda Orbit", note: "Curling around the tiered temple roof" },
  { pos: [-300, 48, 20], look: [-250, 26, 60], hold: 1600, fly: 5200, title: "Palace Mist", note: "Silhouettes of the hall pierce the low fog" },
  { pos: [-160, 130, 260], look: [700, 30, 430], hold: 1500, fly: 5400, title: "Water Reveal", note: "Rising over the glowing canals for the reveal" },
  { pos: [380, 60, 320], look: [700, 25, 430], hold: 1600, fly: 5200, title: "Magic Harbor", note: "The beacon sweeps across shimmering water" },
  { pos: [480, 100, 240], look: [560, 95, 350], hold: 1500, fly: 5000, title: "Dragon Lanes", note: "A dragon's wake stirs the festival lights" },
  { pos: [60, 190, -160], look: [-88, 150, -66], hold: 1600, fly: 5200, title: "Crystal Awakening", note: "Facets ignite in cascades of electric light" },
  { pos: [-820, 330, -760], look: [22, 90, 33], hold: 2000, fly: 6000, title: "Grand Astral Night", note: "The city breathes under a canopy of stars" },
];
const LOOP_MS = KEYS.reduce((a, k) => a + k.fly + k.hold, 0);
const _smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const _loopT = (x) => { x %= LOOP_MS; if (x < 0) x += LOOP_MS; return x; };
const _mix3 = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const _flyStarts = (() => { const a = []; let acc = 0; for (const k of KEYS) { a.push(acc); acc += k.fly + k.hold; } return a; })();
function camAt(ms) {
  const t = _loopT(ms), N = KEYS.length;
  for (let i = 0; i < N; i++) {
    const fs = _flyStarts[i], k = KEYS[i], nx = KEYS[(i + 1) % N];
    if (t >= fs && t < fs + k.fly) {
      const f = _smooth((t - fs) / k.fly);
      return { pos: _mix3(k.pos, nx.pos, f), look: _mix3(k.look, nx.look, f), keyIdx: (i + 1) % N };
    }
    if (t >= fs + k.fly && t < fs + k.fly + k.hold) {
      return { pos: nx.pos.slice(), look: nx.look.slice(), keyIdx: (i + 1) % N };
    }
  }
  return { pos: KEYS[0].pos.slice(), look: KEYS[0].look.slice(), keyIdx: 0 };
}
function phaseAt(u) {
  u = ((u % 1) + 1) % 1;
  const up = _smooth((u - 0.10) / 0.72);
  const down = _smooth((u - 0.86) / 0.14);
  return Math.min(1, up * (1 - down));
}
let _curCard = -1;
function cardsAt(ms) {
  const u = _loopT(ms) / LOOP_MS;
  const nearWrap = u < 1000 / LOOP_MS || u > 1 - 4200 / LOOP_MS;
  if (nearWrap) { _curCard = -1; $('card').classList.remove('show'); return; }
  const idx = camAt(ms).keyIdx;
  if (idx !== _curCard) {
    _curCard = idx;
    const k = KEYS[idx];
    $('cardTitle').textContent = k.title;
    $('cardNote').textContent = k.note;
    $('card').classList.add('show');
    clearTimeout(cardsAt._t);
    cardsAt._t = setTimeout(() => $('card').classList.remove('show'), 3200);
  }
}
function scoreFadeAt(u) {
  u = ((u % 1) + 1) % 1;
  const dip = 0.85 * Math.exp(-Math.pow(Math.min(u, 1 - u) / 0.055, 2));
  return Math.min(1, Math.max(0, 1 - dip));
}

// ---------------- score (ported from v1) ----------------
const Score = (() => {
  let ctx = null, master = null, running = false, chimeTimer = null, brightness = 0;
  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.0; master.connect(ctx.destination);
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 320; filt.Q.value = 0.4; filt.connect(master);
    for (const [f, g] of [[110, 0.05], [130.81, 0.035], [164.81, 0.03]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      o.detune.value = (Math.random() * 8) - 4;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og); og.connect(filt); o.start();
    }
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
    const lg = ctx.createGain(); lg.gain.value = 90; lfo.connect(lg); lg.connect(filt.frequency); lfo.start();
    Score._filt = filt;
    return true;
  }
  const SCALE = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33];
  function chime() {
    if (!running || !ctx) return;
    const f = SCALE[Math.floor(Math.random() * SCALE.length)] * (Math.random() < 0.3 ? 2 : 1);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.05 + brightness * 0.03, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 2.4);
    chimeTimer = setTimeout(chime, 2200 + Math.random() * 2200 - brightness * 700);
  }
  return {
    _filt: null,
    start() {
      if (running) return;
      if (!ensure()) return;
      if (ctx.state === 'suspended') ctx.resume();
      running = true;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 2.5);
      chime();
      document.getElementById('sound').textContent = '\u{1F50A}';
    },
    stop() {
      if (!running) return;
      running = false;
      master.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 0.6);
      if (chimeTimer) clearTimeout(chimeTimer);
      document.getElementById('sound').textContent = '\u{1F507}';
    },
    nightfall(frac) {
      brightness = Math.max(0, Math.min(1, frac));
      if (this._filt) this._filt.frequency.setTargetAtTime(320 + brightness * 900, ctx ? ctx.currentTime : 0, 1.5);
    },
    duck(f) {
      if (!running || !ctx || !master) return;
      master.gain.setTargetAtTime(0.5 * Math.max(0, Math.min(1, f)), ctx.currentTime, 0.35);
    },
    get running() { return running; },
  };
})();
let soundWanted = true;
$('sound').addEventListener('click', (e) => {
  e.stopPropagation();
  soundWanted = !soundWanted;
  if (soundWanted) Score.start(); else Score.stop();
});
const unlock = () => { if (soundWanted && !Score.running) Score.start(); };
addEventListener('pointerdown', unlock, { once: true });
addEventListener('keydown', unlock, { once: true });

// ---------------- stats chip ----------------
{
  const c = manifest.counts;
  $('stats').textContent = `${c.near.toLocaleString('en-US')} enchanted buildings · ${c.lanterns} sky lanterns · 3 dragons · invented, over real streets`;
}

// ---------------- run ----------------
bar.style.width = '100%';
clearTimeout(stallTimer);

let start = null;
let firstFrame = true;
const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const t = clock.getElapsedTime();
  if (start === null) start = t;
  const ms = (t - start) * 1000 + 400;
  const u = (ms % LOOP_MS) / LOOP_MS;

  const { pos, look } = camAt(ms);
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);

  const phase = phaseAt(u);
  skyMat.uniforms.uPhase.value = phase;
  skyMat.uniforms.uTime.value = t;
  starMat.opacity = THREE.MathUtils.smoothstep(phase, 0.10, 0.6);
  sky.position.copy(camera.position);

  scene.fog.color.copy(FOG_DUSK).lerp(FOG_NIGHT, phase);
  waterUniforms.uTime.value = t;
  waterUniforms.uGlow.value = 0.35 + phase * 0.95;
  waterUniforms.fogColor.value.copy(scene.fog.color);
  farMat.uniforms.uNight.value = phase;
  farMat.uniforms.fogColor.value.copy(scene.fog.color);
  wallMat.emissiveIntensity = phase * 1.3;
  glowMat.color.setScalar(phase);
  lampMat.opacity = phase * 0.95;
  hemi.intensity = 1.32 - phase * 0.55;
  dir.intensity = 0.72 - phase * 0.5;

  tickLanterns(t, phase);
  tickDragons(t);
  tickFestival(t, phase);
  tickAtmosphere(t, phase);
  tickLandmarks(t, phase);
  tickCrowd(t);
  for (const b of boats) {
    b.g.position.y = 0.5 + Math.sin(t * 0.9 + b.ph) * 0.22;
    b.g.rotation.y = b.ph + Math.sin(t * 0.14 + b.ph) * 0.5;
  }
  cardsAt(ms);
  Score.nightfall(phase);
  Score.duck(scoreFadeAt(u));

  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    $('poster').classList.add('gone');
    $('loader').classList.add('gone');
    setTimeout(() => { $('poster').remove(); $('loader').remove(); }, 1000);
    window.__READY = true; window.__R = renderer; window.__S = scene; window.__C = camera;
  }
}
frame();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
