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
renderer.toneMappingExposure = 1.05;
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

// ---------------- sky dome (style C: teal twilight) ----------------
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uPhase: { value: 0 }, uTime: { value: 0 } },
  vertexShader: 'varying vec3 vDir;void main(){vDir=normalize(position);vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_Position=p.xyww;}',
  fragmentShader: `
precision highp float;uniform float uPhase;uniform float uTime;varying vec3 vDir;
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
void main(){
  vec3 d=normalize(vDir);
  float h=clamp(d.y,0.0,1.0);
  vec3 hD=vec3(1.0,0.62,0.37), mD=vec3(0.18,0.43,0.49), zD=vec3(0.06,0.09,0.20);
  vec3 hN=vec3(0.10,0.23,0.29), mN=vec3(0.05,0.12,0.19), zN=vec3(0.02,0.03,0.07);
  vec3 hd=mix(hD,hN,uPhase), md=mix(mD,mN,uPhase), zd=mix(zD,zN,uPhase);
  vec3 col=mix(hd,md,smoothstep(0.0,0.22,h));
  col=mix(col,zd,smoothstep(0.16,0.62,h));
  // moon
  vec3 mdv=normalize(vec3(0.45,0.52,-0.62));
  float dm=dot(d,mdv);
  float disc=smoothstep(0.99955,0.99985,dm);
  float glow=pow(max(dm,0.0),200.0)*0.9;
  vec3 mc=vec3(1.0,0.93,0.76);
  col+=(disc*1.6+glow)*mc*(0.35+0.65*uPhase);
  // faint teal aurora late
  float au=smoothstep(0.55,0.95,uPhase);
  if(au>0.001&&d.y>0.15){
    float band=smoothstep(0.15,0.4,d.y)*smoothstep(0.75,0.5,d.y);
    float w=0.5+0.5*sin(atan(d.z,d.x)*3.0+uTime*0.1+d.y*4.0);
    col+=vec3(0.1,0.7,0.6)*band*w*au*0.16;
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
  const N = 1100, p = new Float32Array(N * 3), c = new Float32Array(N * 3);
  let sd = 11; const rnd = () => (sd = (sd * 9301 + 49297) & 65535) / 65535;
  for (let i = 0; i < N; i++) {
    const az = rnd() * 6.283, el = Math.asin(rnd() * 0.94 + 0.05);
    const r = 4000;
    p[i * 3] = Math.cos(az) * Math.cos(el) * r;
    p[i * 3 + 1] = Math.sin(el) * r;
    p[i * 3 + 2] = Math.sin(az) * Math.cos(el) * r;
    const w = rnd(), b = 0.55 + rnd() * 0.45;
    c[i * 3] = b * (0.8 + w * 0.2); c[i * 3 + 1] = b * 0.88; c[i * 3 + 2] = b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  starMat = new THREE.PointsMaterial({ size: 2.1, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false });
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
  const m = new THREE.MeshBasicMaterial({ color: 0x101b2c });
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
  lampMat = new THREE.PointsMaterial({ size: 7, map: haloTex, color: 0xffc46e, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
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

// ---------------- crowd points ----------------
{
  const pts = manifest.crowd;
  const p = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    p[i * 3] = pts[i][0]; p[i * 3 + 1] = 1.1; p[i * 3 + 2] = pts[i][1];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.PointsMaterial({ size: 2.6, map: haloTex, color: 0xffdc9e, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
  m.toneMapped = false;
  scene.add(new THREE.Points(g, m));
}

// ---------------- dragons ----------------
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
  { // snout
    const g = new THREE.ConeGeometry(1.0, 3.3, 5); g.rotateX(Math.PI / 2); g.translate(0, 1.45, 10.5);
    body.push({ g, c: [base.r, base.g, base.b] });
  }
  for (const sx of [-0.72, 0.72]) { // horns
    const g = new THREE.ConeGeometry(0.6, 1.4, 4); g.translate(sx, 2.9, 8.1);
    body.push({ g, c: [fin.r, fin.g, fin.b] });
  }
  { // tail
    const g = new THREE.ConeGeometry(1.1, 7.2, 5); g.rotateX(-Math.PI / 2); g.translate(0, 0.3, -8.1);
    body.push({ g, c: [base.r, base.g, base.b] });
  }
  const bodyMesh = new THREE.Mesh(mergeGeos(body), new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color(colorHex), emissiveIntensity: 0.62 }));
  // glow: eyes + spine ridge
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
  // wings
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
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    pivot.add(m);
    return pivot;
  }
  const L = wing(1), R = wing(-1);
  const grp = new THREE.Group();
  grp.add(bodyMesh, glowMesh, L, R);
  grp.scale.setScalar(2.6);
  return { grp, L, R };
}
const dragons = manifest.dragons.map((d) => {
  const { grp, L, R } = makeDragon(d.col);
  scene.add(grp);
  return { ...d, grp, L, R };
});
function tickDragons(t) {
  for (const d of dragons) {
    const a = t * d.speed + d.ph;
    const x = d.cx + Math.cos(a) * d.r;
    const z = d.cz + Math.sin(a) * d.r * 0.8;
    const y = d.h + Math.sin(t * 0.5 + d.ph) * 18;
    d.grp.position.set(x, y, z);
    const na = a + 0.02 * Math.sign(d.speed);
    const nx = d.cx + Math.cos(na) * d.r, nz = d.cz + Math.sin(na) * d.r * 0.8;
    d.grp.lookAt(nx, y, nz);
    const f = Math.sin(t * 4.2 + d.ph) * 0.5;
    d.L.rotation.z = 0.2 + f; d.R.rotation.z = -0.2 - f;
  }
}

// ---------------- beats / camera ----------------
const KEYS = manifest.keys;
let total = 0;
const segs = [];
for (let i = 0; i < KEYS.length; i++) {
  const k = KEYS[i];
  segs.push({ kind: 'hold', i, dur: k.hold, start: total }); total += k.hold;
  if (i < KEYS.length - 1) { segs.push({ kind: 'fly', i, dur: KEYS[i + 1].fly, start: total }); total += KEYS[i + 1].fly; }
}
const smooth = (t) => t * t * (3 - 2 * t);
function camAt(ms) {
  const t = ms % total;
  let s = segs[segs.length - 1];
  for (const sg of segs) if (t >= sg.start && t < sg.start + sg.dur) { s = sg; break; }
  const a = KEYS[s.i], b = KEYS[Math.min(s.i + 1, KEYS.length - 1)];
  let f = s.kind === 'hold' ? 0 : smooth(Math.min(1, (t - s.start) / s.dur));
  const mix3 = (u, v) => [u[0] + (v[0] - u[0]) * f, u[1] + (v[1] - u[1]) * f, u[2] + (v[2] - u[2]) * f];
  return { pos: s.kind === 'hold' ? a.pos : mix3(a.pos, b.pos), look: s.kind === 'hold' ? a.look : mix3(a.look, b.look), keyIdx: s.i, segStart: s.start };
}

// title cards
let curKey = -1;
function cards(ms) {
  const { keyIdx } = camAt(ms);
  if (keyIdx !== curKey) {
    curKey = keyIdx;
    const k = KEYS[keyIdx];
    $('cardTitle').textContent = k.title;
    $('cardNote').textContent = k.note;
    $('card').classList.add('show');
    clearTimeout(cards._t);
    cards._t = setTimeout(() => $('card').classList.remove('show'), 3400);
  }
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
  const u = (ms % total) / total;

  const { pos, look } = camAt(ms);
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);

  const phase = THREE.MathUtils.smoothstep(u, 0.10, 0.95);
  skyMat.uniforms.uPhase.value = phase;
  skyMat.uniforms.uTime.value = t;
  starMat.opacity = THREE.MathUtils.smoothstep(phase, 0.12, 0.7);
  sky.position.copy(camera.position);

  scene.fog.color.copy(FOG_DUSK).lerp(FOG_NIGHT, phase);
  skyMat.uniformsNeedUpdate = true;
  waterUniforms.uTime.value = t;
  waterUniforms.uGlow.value = 0.25 + phase * 0.75;
  waterUniforms.fogColor.value.copy(scene.fog.color);
  farMat.uniforms.uNight.value = phase;
  farMat.uniforms.fogColor.value.copy(scene.fog.color);
  wallMat.emissiveIntensity = phase * 1.0;
  glowMat.color.setScalar(phase);
  lampMat.opacity = phase * 0.9;
  hemi.intensity = 1.18 - phase * 0.5;
  dir.intensity = 0.72 - phase * 0.5;

  tickLanterns(t, phase);
  tickDragons(t);
  for (const b of boats) {
    b.g.position.y = 0.5 + Math.sin(t * 0.9 + b.ph) * 0.22;
    b.g.rotation.y = b.ph + Math.sin(t * 0.14 + b.ph) * 0.5;
  }
  cards(ms);
  Score.nightfall(phase);

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
