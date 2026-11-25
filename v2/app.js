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

const ASSET_V = 'v20e';
const manifest = await (await fetch('./manifest.json?' + ASSET_V)).json();
bar.style.width = '6%';
const binBuf = await fetchWithProgress('./scene.bin?' + ASSET_V, (f) => { bar.style.width = (6 + f * 84) + '%'; });
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
const FOG_DUSK = new THREE.Color('#5a4550'), FOG_NIGHT = new THREE.Color('#0E1A2A');
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
  uniforms: { uPhase: { value: 0 }, uTime: { value: 0 }, fogColor: { value: new THREE.Color() } },
  vertexShader: 'varying vec3 vDir;void main(){vDir=normalize(position);vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_Position=p.xyww;}',
  fragmentShader: `
precision highp float;uniform float uPhase;uniform float uTime;uniform vec3 fogColor;varying vec3 vDir;
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
  // blend the lowest sky band into the scene fog color so distant geometry meets the sky seamlessly
  float hf=1.0-smoothstep(-0.045,0.075,d.y);
  col=mix(col,fogColor,hf*0.94);
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
let groundMatRef = null;
{
  const g = new THREE.CircleGeometry(3400, 48);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({ color: 0x182840 });
  groundMatRef = m;
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = -0.05;
  scene.add(mesh);
}

// ---------------- water shader ----------------
const waterUniforms = { uTime: { value: 0 }, uGlow: { value: 0.25 }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0.00105 } };
{
  const g = geoFromSections('water');
  var WATER_VERT = `
varying vec3 vW;varying float vFogZ;
void main(){vec4 w=modelMatrix*vec4(position,1.0);vW=w.xyz;
vec4 mv=viewMatrix*w;vFogZ=-mv.z;gl_Position=projectionMatrix*mv;}`;
  var WATER_FRAG = `
precision highp float;uniform float uTime;uniform float uGlow;uniform vec3 fogColor;uniform float fogDensity;
varying vec3 vW;varying float vFogZ;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
  vec3 deep=vec3(0.02,0.13,0.17), teal=vec3(0.05,0.35,0.42), cy=vec3(0.13,0.83,0.93);
  float b1=sin(vW.x*0.045+uTime*0.7)*sin(vW.z*0.06-uTime*0.9);
  float b2=sin(vW.x*0.11-uTime*1.7+vW.z*0.07);
  float band=0.5+0.25*b1+0.25*b2;
  vec3 col=mix(deep,teal,band);
  float sh1=smoothstep(0.72,0.98,sin(vW.x*0.22+uTime*1.4+vW.z*0.09)*0.5+0.5);
  float sh2=smoothstep(0.80,1.00,sin(vW.z*0.18-uTime*1.9-vW.x*0.05)*0.5+0.5);
  float shimmer=(sh1+sh2)*0.5*band;
  col+=vec3(0.35,0.75,0.85)*shimmer*uGlow*0.4;
  col+=vec3(1.0,0.6,0.25)*shimmer*uGlow*0.35;
  col+=cy*band*uGlow*0.22;
  vec2 cell=floor(vW.xz*0.9);
  float sp=hash(cell);
  if(sp>0.986){float tw=0.5+0.5*sin(uTime*2.5+sp*90.0);col+=cy*tw*uGlow*0.9;}
  float f=1.0-exp(-fogDensity*fogDensity*vFogZ*vFogZ);
  col=mix(col,fogColor,clamp(f,0.0,1.0));
  gl_FragColor=vec4(col,1.0);
}`;
  const m = new THREE.ShaderMaterial({ uniforms: waterUniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG });
  scene.add(new THREE.Mesh(g, m));
}

// ---------------- far buildings (instanced boxes) ----------------
{
  const far = sec('far');
  const n = far.length / 8;
  // house geometry: wall box (y 0..0.75) + gable roof prism (y 0.75..1.0, eave overhang), non-indexed
  const HQ = [];
  const quad = (a, b, c, d, n, col) => { HQ.push([a, b, c, n, col], [a, c, d, n, col]); };
  const W = [1, 1, 1], RS = [0.50, 0.46, 0.62], GB = [0.80, 0.76, 0.90];
  quad([-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0.58, 0.5], [-0.5, 0.58, 0.5], [0, 0, 1], W);      // +z wall
  quad([0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 0.58, -0.5], [0.5, 0.58, -0.5], [0, 0, -1], W);   // -z wall
  quad([0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 0.58, -0.5], [0.5, 0.58, 0.5], [1, 0, 0], W);        // +x wall
  quad([-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 0.58, 0.5], [-0.5, 0.58, -0.5], [-1, 0, 0], W);   // -x wall
  const SN1 = [0, 0.8, 0.6], SN2 = [0, 0.8, -0.6];
  quad([-0.58, 0.58, 0.58], [0.58, 0.58, 0.58], [0.58, 1.0, 0], [-0.58, 1.0, 0], SN1, RS);       // south slope
  quad([0.58, 0.58, -0.58], [-0.58, 0.58, -0.58], [-0.58, 1.0, 0], [0.58, 1.0, 0], SN2, RS);     // north slope
  HQ.push([[0.58, 0.58, 0.58], [0.58, 0.58, -0.58], [0.58, 1.0, 0], [1, 0, 0], GB]);             // +x gable
  HQ.push([[-0.58, 0.58, -0.58], [-0.58, 0.58, 0.58], [-0.58, 1.0, 0], [-1, 0, 0], GB]);         // -x gable
  const hp = [], hn = [], hc = [];
  for (const [a, b, c, n, col] of HQ) for (const v of [a, b, c]) { hp.push(...v); hn.push(...n); hc.push(...col); }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(hp), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(hn), 3));
  g.setAttribute('acol', new THREE.BufferAttribute(new Float32Array(hc), 3));
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
attribute vec3 ioff;attribute vec3 iscl;attribute vec3 icol;attribute vec3 acol;
varying vec3 vC;varying float vFogZ;varying vec3 vN;
void main(){vC=icol*acol;vN=normal;
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
  col=mix(col,fogColor,clamp(f*0.72,0.0,1.0));
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
  const pm = new THREE.PointsMaterial({ size: 20, map: haloTex, color: 0xff9e3c, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending });
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
  lanternPts.material.opacity = 0.16 + night * 0.3;
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
  const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a2438, emissiveIntensity: 1.0 });
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
const _lmLamberts = [];
function lmLambert() { const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x332d47, emissiveIntensity: 1.0 }); _lmLamberts.push(m); return m; }
function lmHaloAt(x, y, z, size, hex, opacity) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x, y, z]), 3));
  const m = new THREE.PointsMaterial({ size, map: haloTex, color: hex, transparent: true, opacity: opacity || 0.75, depthWrite: false, blending: THREE.AdditiveBlending });
  m.toneMapped = false;
  scene.add(new THREE.Points(g, m));
  return m;
}
// hero crystal cluster for Crystal Awakening (v20e)
{
  const CX = -88, CZ = -66;
  const shards = [];
  const defs = [[0, 0, 58, 9, 0.3], [-12, 4, 38, 6, 1.4], [11, -6, 44, 7, 2.5], [7, 9, 30, 5, 3.6], [-7, -11, 26, 4.5, 5.0]];
  for (const [x, z, h, r, ry] of defs) {
    const o = new THREE.OctahedronGeometry(r, 0);
    o.scale(1, h / (r * 2), 1); o.rotateY(ry); o.translate(x, h * 0.5, z);
    shards.push({ g: o, c: [0.45, 0.85, 1.0] });
  }
  const cm = new THREE.MeshBasicMaterial({ vertexColors: true });
  cm.toneMapped = false;
  const hero = new THREE.Mesh(mergeGeos(shards), cm);
  hero.position.set(CX, 140, CZ);
  scene.add(hero);
  lmHaloAt(CX, 172, CZ, 90, 0x7fd8ff, 0.55);
  lmHaloAt(CX, 148, CZ, 50, 0xb48aff, 0.4);
  lmTickers.push((t, phase) => {
    hero.rotation.y = t * 0.12;
    cm.color.setScalar(0.75 + 0.25 * Math.sin(t * 1.7) + phase * 0.3);
  });
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
// 1b) the Twin Spires: an identical matched pair straddling the dive line at (0,-45) and (44,-75)
function lmTwinSpire(PX, PZ) {
  const mat = lmLambert();
  const parts = [], glow = [];
  const body = [0.24, 0.22, 0.42], trim = [1.0, 0.72, 0.30];
  const drum = new THREE.CylinderGeometry(7, 8.5, 12, 8); drum.translate(PX, 6, PZ);
  parts.push({ g: drum, c: [0.30, 0.34, 0.44] });
  let y = 12, w = 10;
  for (let i = 0; i < 4; i++) {
    const segH = 13 * (1 - i * 0.07);
    const b = new THREE.BoxGeometry(w, segH, w); b.translate(PX, y + segH / 2, PZ);
    parts.push({ g: b, c: body });
    const band = new THREE.BoxGeometry(w * 1.03, 1.3, w * 1.03); band.translate(PX, y + segH * 0.72, PZ);
    glow.push({ g: band, c: trim });
    y += segH;
    for (const r of lmEaveRoof(w * 0.95, segH * 0.42, 0.05)) { r.g.translate(PX, y + segH * 0.16, PZ); parts.push(r); }
    y += segH * 0.34;
    w *= 0.78;
  }
  const cap = new THREE.ConeGeometry(3.1, 16, 6); cap.translate(PX, y + 8, PZ);
  glow.push({ g: cap, c: trim });
  const fin = new THREE.OctahedronGeometry(1.6, 0); fin.scale(1, 2.2, 1); fin.translate(PX, y + 17.5, PZ);
  glow.push({ g: fin, c: [0.55, 0.9, 1.0] });
  scene.add(new THREE.Mesh(mergeGeos(parts), mat));
  const gm = lmBasic(0xffc46a);
  scene.add(new THREE.Mesh(mergeGeos(glow), gm));
  const h = lmHaloAt(PX, y + 17.5, PZ, 26, 0xffc46a, 0.8);
  lmTickers.push((t, phase) => { h.opacity = 0.5 + 0.3 * phase + Math.sin(t * 2.4 + PX) * 0.08; });
  return y + 18;
}
lmTwinSpire(0, -45);
lmTwinSpire(44, -75);

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
// 3) grand pendopo palace hall, west of temple (-250, 60) — v20d rebuilt tall
{
  const mat = lmLambert();
  const HX = -250, HZ = 60;
  const parts = [];
  const plat = new THREE.BoxGeometry(72, 5, 50); plat.translate(HX, 2.5, HZ);
  parts.push({ g: plat, c: [0.3, 0.24, 0.2] });
  const step = new THREE.BoxGeometry(80, 2, 58); step.translate(HX, 1, HZ);
  parts.push({ g: step, c: [0.26, 0.2, 0.17] });
  const col = [0.55, 0.32, 0.15];
  for (let i = -3; i <= 3; i++) {
    for (const zz of [-16, 16]) {
      const c1 = new THREE.CylinderGeometry(1.3, 1.5, 22, 6); c1.translate(HX + i * 8.4, 16, HZ + zz);
      parts.push({ g: c1, c: col });
    }
  }
  for (let i = -1; i <= 1; i++) {
    const c2 = new THREE.CylinderGeometry(1.5, 1.7, 34, 6); c2.translate(HX + i * 12, 22, HZ);
    parts.push({ g: c2, c: [0.6, 0.36, 0.17] });
  }
  const t1 = lmEaveRoof(46, 15, 0.12); for (const p of t1) { p.g.translate(HX, 27 + 7.5, HZ); parts.push(p); }
  const t2 = lmEaveRoof(30, 12, 0.14); for (const p of t2) { p.g.translate(HX, 41 + 6, HZ); parts.push(p); }
  const fin = new THREE.ConeGeometry(3.2, 9, 6); fin.translate(HX, 53 + 4.5, HZ);
  parts.push({ g: fin, c: [0.85, 0.6, 0.2] });
  scene.add(new THREE.Mesh(mergeGeos(parts), mat));
  const door = new THREE.BoxGeometry(10, 13, 1); door.translate(HX, 11.5, HZ + 17.2);
  scene.add(new THREE.Mesh(mergeGeos([{ g: door, c: [1.0, 0.7, 0.3] }]), lmBasic(0xffffff)));
  lmHaloAt(HX, 13, HZ + 19, 26, 0xffb75e, 0.75);
  lmHaloAt(HX, 48, HZ, 40, 0xffd98a, 0.5);
}
// drifting mist banks around the palace (v20d)
{
  const mists = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.PlaneGeometry(150 + i * 26, 15 + (i % 2) * 8);
    const m = new THREE.MeshBasicMaterial({ map: haloTex, color: 0x8fa8cf, transparent: true, opacity: 0.09 + (i % 3) * 0.025, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    m.toneMapped = false;
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(-320 + i * 36, 8 + (i % 3) * 11, 26 + (i % 4) * 24);
    mesh.rotation.y = (i * 0.5) % 1.2 - 0.6;
    scene.add(mesh);
    mists.push({ mesh, x0: mesh.position.x, sp: 0.05 + i * 0.017, ph: i * 1.9 });
  }
  lmTickers.push((t) => {
    for (const mi of mists) mi.mesh.position.x = mi.x0 + Math.sin(t * mi.sp + mi.ph) * 16;
  });
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
  const beamGeo = new THREE.ConeGeometry(7, 150, 10, 1, true);
  beamGeo.translate(0, -75, 0);
  beamGeo.rotateX(-Math.PI / 2);
  const beamMatB = new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
  beamMatB.toneMapped = false;
  const beamMesh = new THREE.Mesh(beamGeo, beamMatB);
  beamMesh.position.set(LX, y + 3, LZ);
  scene.add(beamMesh);
  const beamMesh2 = new THREE.Mesh(beamGeo, beamMatB);
  beamMesh2.position.set(LX, y + 3, LZ);
  beamMesh2.rotation.y = Math.PI;
  scene.add(beamMesh2);
  const lampHalo = lmHaloAt(LX, y + 3, LZ, 40, 0xffe9b0, 0.9);
  lmTickers.push((t, phase) => {
    beamMesh.rotation.y = t * 0.7;
    beamMesh2.rotation.y = Math.PI + t * 0.7;
    beamMesh.material.opacity = 0.16 + phase * 0.2;
    lampHalo.opacity = 0.5 + 0.4 * phase + Math.sin(t * 3.1) * 0.1;
  });
}
// harbor bay water (v19w) — a real glowing basin where the harbor beats look
const BAY = { x: 800, z: 470, r: 250 };
{
  const g = new THREE.CircleGeometry(BAY.r, 40); g.rotateX(-Math.PI / 2); g.translate(BAY.x, 0.4, BAY.z);
  scene.add(new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: waterUniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG })));
}
// lantern-lit boats drifting on the bay (v19w)
{
  const boatMat = lmLambert();
  const boats = [];
  const radii = [45, 78, 150, 195];
  for (let i = 0; i < 4; i++) {
    const parts = [];
    const hull = new THREE.CylinderGeometry(1.6, 2.6, 10, 6); hull.rotateZ(Math.PI / 2); hull.scale(1, 0.55, 0.62); hull.translate(0, 1.0, 0);
    parts.push({ g: hull, c: [0.24, 0.14, 0.08] });
    const mast = new THREE.CylinderGeometry(0.18, 0.22, 9, 5); mast.translate(0.6, 6.0, 0);
    parts.push({ g: mast, c: [0.3, 0.2, 0.12] });
    const sail = new THREE.PlaneGeometry(4.6, 5.6); sail.rotateY(Math.PI / 2); sail.translate(0.6, 6.4, 0);
    parts.push({ g: sail, c: [0.75, 0.62, 0.4] });
    const cabin = new THREE.BoxGeometry(2.6, 1.6, 2.0); cabin.translate(-1.6, 2.0, 0);
    parts.push({ g: cabin, c: [0.2, 0.12, 0.07] });
    const mesh = new THREE.Mesh(mergeGeos(parts), boatMat);
    scene.add(mesh);
    const lampGeo = new THREE.BufferGeometry();
    lampGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 3.4, 0]), 3));
    const lampMatB = new THREE.PointsMaterial({ size: 14, map: haloTex, color: 0xffc46e, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    lampMatB.toneMapped = false;
    mesh.add(new THREE.Points(lampGeo, lampMatB));
    boats.push({ mesh, a0: i * 1.7, r: radii[i], sp: 0.021 + i * 0.006 });
  }
  lmTickers.push((t) => {
    for (const b of boats) {
      const a = b.a0 + t * b.sp;
      b.mesh.position.set(BAY.x + Math.cos(a) * b.r, 0.4, BAY.z + Math.sin(a) * b.r * 0.72);
      b.mesh.rotation.y = -a - Math.PI / 2;
    }
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


// ============================================================
// ---------------- FANTASY SKY LAYER (v4) ----------------
// Floating islands with buildings, glowing trees, twisting towers,
// crystal spires, rope bridges, waterfalls. All motion is a pure
// function of loop phase u, so the loop stays seamless.
// ============================================================
const FY = {
  rock: [0.34, 0.30, 0.42], rockD: [0.24, 0.21, 0.33], moss: [0.22, 0.46, 0.35],
  wood: [0.30, 0.20, 0.13], stone: [0.36, 0.40, 0.50],
  glowT: [0.20, 0.95, 0.72], glowM: [1.00, 0.62, 0.25], glowC: [0.45, 0.85, 1.00],
  water: [0.30, 0.85, 0.95], bridge: [0.42, 0.30, 0.16],
};
const _fh = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// [x, z, topY, radius, rockHeight, kind]  kind: 0 pagoda, 1 mushroom grove, 2 crystal, 3 twist tower
// anchored near landmarks but clear of the dragon orbits
const F_ISLES = [
  [330, 40, 70, 26, 18, 1],      // east of the market
  [390, 110, 105, 22, 16, 0],
  [285, 105, 150, 18, 14, 2],
  [128, -214, 190, 24, 20, 2],   // crystal crown above the paifang
  [-60, 200, 95, 30, 22, 1],     // beside the temple plaza
  [-120, 120, 160, 20, 18, 3],   // twisting tower over the plaza edge
  [-250, 60, 200, 34, 26, 1],    // great grove above the hall
  [720, 300, 140, 28, 20, 0],    // harbor watch isle
  [700, 430, 175, 24, 18, 3],    // twisting beacon isle
];

function _isleRock(cx, cz, topY, rad, h, i) {
  const parts = [];
  const top = new THREE.CylinderGeometry(rad, rad * 1.08, 4.5, 9, 1);
  top.translate(cx, topY - 2.2, cz);
  parts.push({ g: top, c: FY.rock });
  const skirt = new THREE.TorusGeometry(rad * 1.02, 1.1, 4, 10);
  skirt.rotateX(Math.PI / 2); skirt.translate(cx, topY - 4.6, cz);
  parts.push({ g: skirt, c: FY.moss });
  const under = new THREE.ConeGeometry(rad * 0.92, h, 8, 1);
  under.rotateX(Math.PI);
  under.translate(cx, topY - 4.5 - h / 2, cz);
  parts.push({ g: under, c: FY.rockD });
  for (const [ax, az] of [[-0.5, 0.5], [0.6, -0.4]]) {
    const l = new THREE.IcosahedronGeometry(rad * 0.34, 0);
    l.scale(1, 0.7, 1);
    l.translate(cx + ax * rad, topY - 4.5 - h * 0.55, cz + az * rad);
    parts.push({ g: l, c: FY.rockD });
  }
  return parts;
}

function _isleBuilding(cx, cz, topY, kind, i) {
  const parts = [];
  const bw = 9 + _fh(i) * 6, bh = 10 + _fh(i * 3) * 8;
  const bx = cx + (_fh(i * 7) - 0.5) * 8, bz = cz + (_fh(i * 11) - 0.5) * 8;
  const body = new THREE.BoxGeometry(bw, bh, bw);
  body.translate(bx, topY + bh / 2 - 0.5, bz);
  parts.push({ g: body, c: kind === 1 ? FY.wood : FY.stone });
  if (kind === 0) {
    const r1 = new THREE.ConeGeometry(bw * 0.95, 4, 4); r1.translate(bx, topY + bh + 1.5, bz);
    const r2 = new THREE.ConeGeometry(bw * 0.6, 3, 4); r2.translate(bx, topY + bh + 4.2, bz);
    parts.push({ g: r1, c: FY.rock }, { g: r2, c: FY.rockD });
  } else {
    const roof = new THREE.ConeGeometry(bw * 1.05, 5, 4); roof.translate(bx, topY + bh + 2, bz);
    parts.push({ g: roof, c: FY.rock });
  }
  return { parts, x: bx, y: topY + bh, z: bz };
}

function _glowTree(cx, cz, topY, i) {
  const parts = [];
  const sc = 0.8 + _fh(i * 13) * 0.7;
  const stemH = 16 * sc, capR = (6 + _fh(i * 5) * 4) * sc;
  const sx = cx + (_fh(i * 17) - 0.5) * 14, sz = cz + (_fh(i * 19) - 0.5) * 14;
  const stem = new THREE.CylinderGeometry(0.9 * sc, 1.4 * sc, stemH, 5);
  stem.translate(sx, topY + stemH / 2 - 0.5, sz);
  parts.push({ g: stem, c: FY.wood });
  if (i % 3 === 0) {
    const cap = new THREE.SphereGeometry(capR, 7, 5, 0, Math.PI * 2, 0, Math.PI * 0.5);
    cap.translate(sx, topY + stemH - 0.5, sz);
    parts.push({ g: cap, c: FY.moss });
  } else {
    const c1 = new THREE.ConeGeometry(capR, 7 * sc, 6); c1.translate(sx, topY + stemH + 2 * sc, sz);
    const c2 = new THREE.ConeGeometry(capR * 0.6, 5 * sc, 6); c2.translate(sx, topY + stemH + 6 * sc, sz);
    parts.push({ g: c1, c: FY.moss }, { g: c2, c: FY.moss });
  }
  return { parts, x: sx, y: topY + stemH + 3 * sc, z: sz, glow: FY.glowT };
}

function _twistTower(cx, cz, topY, i) {
  const parts = [];
  const segs = 7;
  let w = 11 + _fh(i * 23) * 4, y = topY - 0.5;
  const rot0 = _fh(i * 31) * 6.28;
  for (let k = 0; k < segs; k++) {
    const segH = 9 - k * 0.5;
    const off = (k % 2 === 0 ? 1 : -1) * (1.2 + _fh(i * 100 + k) * 1.5);
    const b = new THREE.BoxGeometry(w, segH, w);
    b.rotateY(rot0 + k * 0.45);
    b.translate(cx + off * (k / segs), y + segH / 2, cz + off * (k / segs) * 0.6);
    parts.push({ g: b, c: FY.stone });
    y += segH * 0.94; w *= 0.9;
  }
  const tip = new THREE.OctahedronGeometry(2.4, 0); tip.scale(1, 1.6, 1); tip.translate(cx, y + 4, cz);
  parts.push({ g: tip, c: FY.glowC });
  return { parts, x: cx, y: y + 4, z: cz, glow: FY.glowC };
}

function _crystalSpires(cx, cz, topY, i) {
  const parts = [];
  const n = 4 + Math.floor(_fh(i * 37) * 3);
  for (let k = 0; k < n; k++) {
    const h = 10 + _fh(i * 40 + k) * 16, r = 2 + _fh(i * 43 + k) * 2.5;
    const o = new THREE.OctahedronGeometry(r, 0);
    o.scale(1, h / (r * 2), 1);
    const ang = _fh(i * 47 + k) * 6.28, rad = _fh(i * 53 + k) * 9;
    o.rotateY(_fh(i * 59 + k) * 6.28);
    o.translate(cx + Math.cos(ang) * rad, topY + h * 0.5 - 0.5, cz + Math.sin(ang) * rad);
    parts.push({ g: o, c: FY.glowC });
  }
  const base = new THREE.IcosahedronGeometry(6, 0); base.scale(1.4, 0.5, 1.2); base.translate(cx, topY - 0.5, cz);
  parts.push({ g: base, c: FY.rockD });
  return parts;
}

function _ropeBridge(x0, y0, z0, x1, y1, z1) {
  const parts = [];
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz), sag = len * 0.06, N = 10;
  for (let k = 0; k <= N; k += 2) {
    const f = k / N;
    const plank = new THREE.BoxGeometry(2.2, 0.4, 2.2);
    plank.translate(x0 + dx * f, y0 + dy * f - Math.sin(f * Math.PI) * sag, z0 + dz * f);
    parts.push({ g: plank, c: FY.bridge });
  }
  for (const side of [-1.1, 1.1]) {
    const cable = new THREE.CylinderGeometry(0.18, 0.18, len * 1.05, 4);
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    cable.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2 - sag * 0.7, (z0 + z1) / 2), quat, new THREE.Vector3(1, 1, 1)));
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(side);
    cable.translate(perp.x, 0, perp.z);
    parts.push({ g: cable, c: FY.bridge });
  }
  return parts;
}

// ---- assemble ----
const _fRockParts = [], _fBldParts = [], _fCrysParts = [];
const _fLanterns = [], _fFalls = [], _fTreeGlows = [];
for (let i = 0; i < F_ISLES.length; i++) {
  const [cx, cz, topY, rad, h, kind] = F_ISLES[i];
  _fRockParts.push(..._isleRock(cx, cz, topY, rad, h, i));
  if (kind === 2) {
    _fCrysParts.push(..._crystalSpires(cx, cz, topY, i));
  } else {
    const b = _isleBuilding(cx, cz, topY, kind === 1 ? 1 : 0, i);
    _fBldParts.push(...b.parts);
    _fLanterns.push({ x: b.x, y: b.y + 0.5, z: b.z, col: FY.glowM });
    const tr = _glowTree(cx, cz, topY, i);
    _fBldParts.push(...tr.parts);
    _fTreeGlows.push({ x: tr.x, y: tr.y, z: tr.z, col: tr.glow });
  }
  if (kind === 3) {
    const tw = _twistTower(cx, cz, topY, i);
    _fBldParts.push(...tw.parts);
    _fTreeGlows.push({ x: tw.x, y: tw.y, z: tw.z, col: tw.glow });
  }
  for (let k = 0; k < 2 + (i % 3); k++) {
    const a = _fh(i * 71 + k) * 6.28, rr = _fh(i * 73 + k) * rad * 0.7;
    _fLanterns.push({ x: cx + Math.cos(a) * rr, y: topY + 1.2, z: cz + Math.sin(a) * rr, col: FY.glowM });
  }
  // waterfalls only where they read as falling to water/open ground,
  // not over the market/roof corridors the camera flies through
  if (topY > 85 && !(cx > 100 && cx < 450 && cz > -50 && cz < 200)) {
    const a = _fh(i * 83) * 6.28;
    _fFalls.push({ x: cx + Math.cos(a) * rad * 0.9, z: cz + Math.sin(a) * rad * 0.9, topY: topY - 5, len: Math.min(60, Math.max(30, topY - 8)) });
  }
}
// rope bridges to the nearest neighbour island
{
  const done = new Set();
  for (let i = 0; i < F_ISLES.length; i++) {
    let best = -1, bd = 1e9;
    for (let j = 0; j < F_ISLES.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(F_ISLES[j][0] - F_ISLES[i][0], F_ISLES[j][1] - F_ISLES[i][1]);
      if (d > 40 && d < 160 && d < bd) { bd = d; best = j; }
    }
    if (best > 0 && !done.has(i + '-' + best) && !done.has(best + '-' + i)) {
      done.add(i + '-' + best);
      const A = F_ISLES[i], B = F_ISLES[best];
      _fRockParts.push(..._ropeBridge(A[0], A[2] - 2, A[1], B[0], B[2] - 2, B[1]));
      _fLanterns.push({ x: (A[0] + B[0]) / 2, y: (A[2] + B[2]) / 2 - 3, z: (A[1] + B[1]) / 2, col: FY.glowM });
    }
  }
}

const _fRockMesh = new THREE.Mesh(mergeGeos(_fRockParts), lmLambert());
scene.add(_fRockMesh);
const _fBldMesh = new THREE.Mesh(mergeGeos(_fBldParts), lmLambert());
scene.add(_fBldMesh);
let _fCrysMat = null;
if (_fCrysParts.length) {
  _fCrysMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  _fCrysMat.toneMapped = false;
  scene.add(new THREE.Mesh(mergeGeos(_fCrysParts), _fCrysMat));
}

// island lanterns + tree glows: one Points system
const _fGlows = [..._fLanterns, ..._fTreeGlows];
const _fGlowMat = (() => {
  const n = _fGlows.length;
  const p = new Float32Array(n * 3), c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = _fGlows[i];
    p[i * 3] = g.x; p[i * 3 + 1] = g.y; p[i * 3 + 2] = g.z;
    c[i * 3] = g.col[0]; c[i * 3 + 1] = g.col[1]; c[i * 3 + 2] = g.col[2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const m = new THREE.PointsMaterial({ size: 12, map: haloTex, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  m.toneMapped = false;
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  scene.add(pts);
  return m;
})();

// waterfalls: one Points system, scroll is a pure function of u
const WF_PER = 14;
const _fWfPts = (() => {
  const total = _fFalls.length * WF_PER;
  const p = new Float32Array(total * 3), c = new Float32Array(total * 3);
  for (let k = 0; k < total; k++) {
    const w = _fFalls[(k / WF_PER) | 0], f = (k % WF_PER) / WF_PER;
    p[k * 3] = w.x; p[k * 3 + 1] = w.topY - f * w.len; p[k * 3 + 2] = w.z;
    c[k * 3] = FY.water[0]; c[k * 3 + 1] = FY.water[1]; c[k * 3 + 2] = FY.water[2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const m = new THREE.PointsMaterial({ size: 3.5, map: haloTex, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
  m.toneMapped = false;
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  scene.add(pts);
  return pts;
})();

function tickFantasy(u, phase) {
  _fGlowMat.opacity = 0.46 + phase * 0.5;
  _fGlowMat.size = 10 + Math.sin(u * 6.283) * 1.5 + phase * 6;
  if (_fCrysMat) _fCrysMat.opacity = 0.30 + phase * 0.55 + Math.sin(u * 12.566) * 0.08 * phase;
  const bob = Math.sin(u * 6.283) * 0.8;
  _fRockMesh.position.y = bob;
  _fBldMesh.position.y = bob;
  const pa = _fWfPts.geometry.attributes.position;
  for (let wi = 0; wi < _fFalls.length; wi++) {
    const w = _fFalls[wi];
    for (let j = 0; j < WF_PER; j++) {
      const f = (j / WF_PER + u * 3) % 1;
      pa.array[(wi * WF_PER + j) * 3 + 1] = w.topY - f * w.len;
    }
  }
  pa.needsUpdate = true;
}

// ---------- lantern launches (phase-windowed, seamless at wrap) ----------
const _launch = (() => {
  const PADS = [
    { x: 128, z: -214, n: 12, col: [1.0, 0.62, 0.24] },   // gate
    { x: 177, z: -132, n: 20, col: [1.0, 0.55, 0.18] },   // market
    { x: -166, z: 143, n: 10, col: [0.9, 0.55, 0.7] },    // temple
  ];
  const TOTAL = PADS.reduce((a, b) => a + b.n, 0);
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.05, 1.35, 1.05),
    (() => { const m = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }); m.toneMapped = false; return m; })(),
    TOTAL);
  inst.frustumCulled = false;
  const hp = new Float32Array(TOTAL * 3);
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
  const hm = new THREE.PointsMaterial({ size: 20, map: haloTex, color: 0xffb060, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  hm.toneMapped = false;
  const halo = new THREE.Points(hg, hm);
  halo.frustumCulled = false;
  const data = [];
  let idx = 0;
  const cc = new THREE.Color();
  for (const p of PADS) {
    for (let j = 0; j < p.n; j++) {
      const r1 = _fh(idx * 3 + 1), r2 = _fh(idx * 3 + 2), r3 = _fh(idx * 3 + 3);
      data.push({ pad: p, offX: (r1 - 0.5) * 14, offZ: (r2 - 0.5) * 14, lag: r3 * 0.25, wob: r1 * 6.28 });
      cc.setRGB(p.col[0], p.col[1], p.col[2]);
      inst.setColorAt(idx, cc);
      idx++;
    }
  }
  inst.instanceColor.needsUpdate = true;
  scene.add(inst, halo);
  return { inst, hm, hp, hg, data, TOTAL };
})();
const _lm4 = new THREE.Matrix4();
function tickLaunch(u, t) {
  // launch window u in [0.50, 0.95]: lanterns rise, then fade before the wrap
  const w = Math.min(Math.max((u - 0.50) / 0.45, 0), 1);
  const rise = w * 110;
  const fadeIn = Math.min(w / 0.06, 1);
  const fadeOut = 1 - THREE.MathUtils.smoothstep(w, 0.78, 1.0);
  const alpha = fadeIn * fadeOut;
  for (let i = 0; i < _launch.TOTAL; i++) {
    const d = _launch.data[i];
    const lagged = Math.min(Math.max((u - 0.50 - d.lag * 0.45) / 0.45, 0), 1);
    const y = 1.5 + lagged * 110;
    const x = d.pad.x + d.offX + Math.sin(t * 0.9 + d.wob) * (1 + lagged * 3);
    const z = d.pad.z + d.offZ + Math.cos(t * 0.7 + d.wob * 1.3) * (1 + lagged * 2);
    const sc = 0.55 + lagged * 0.5;
    _lm4.makeScale(sc, sc, sc);
    _lm4.setPosition(x, y, z);
    _launch.inst.setMatrixAt(i, _lm4);
    _launch.hp[i * 3] = x; _launch.hp[i * 3 + 1] = y; _launch.hp[i * 3 + 2] = z;
  }
  _launch.inst.instanceMatrix.needsUpdate = true;
  _launch.hg.attributes.position.needsUpdate = true;
  _launch.inst.material.opacity = alpha * 0.95;
  _launch.hm.opacity = alpha * 0.5;
}

// ---------- fireworks over the harbor (pure function of u) ----------
const _fw = (() => {
  const BURSTS = 9, PER = 55;
  const N = BURSTS * PER;
  const p = new Float32Array(N * 3), c = new Float32Array(N * 3);
  const meta = []; // per particle: burst origin, velocity, hue
  for (let b = 0; b < BURSTS; b++) {
    const ang = (b * 137.5) * Math.PI / 180;
    const r = 30 + (b % 4) * 22;
    const bx = 700 + Math.cos(ang) * r, by = 90 + (b % 3) * 28, bz = 430 + Math.sin(ang) * r * 0.7;
    const bu = 0.72 + (b / BURSTS) * 0.16; // window u in [0.72, 0.88]
    const hue = [[1, 0.45, 0.2], [0.5, 0.8, 1], [1, 0.75, 0.3]][b % 3];
    for (let k = 0; k < PER; k++) {
      const r1 = _fh(b * 100 + k), r2 = _fh(b * 100 + k + 50), r3 = _fh(b * 100 + k + 900);
      const th = r1 * 6.283, ph2 = r2 * 3.14;
      const spd = 14 + r3 * 16;
      meta.push({ bx, by, bz, bu, vx: Math.sin(ph2) * Math.cos(th) * spd, vy: Math.cos(ph2) * spd, vz: Math.sin(ph2) * Math.sin(th) * spd, hue });
      const i = b * PER + k;
      c[i * 3] = hue[0]; c[i * 3 + 1] = hue[1]; c[i * 3 + 2] = hue[2];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const m = new THREE.PointsMaterial({ size: 4.5, map: haloTex, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  m.toneMapped = false;
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  scene.add(pts);
  return { pts, meta, N, LIFE: 2.4 };
})();
function tickFireworks(u) {
  const pa = _fw.pts.geometry.attributes.position.array;
  const secPerU = LOOP_MS / 1000;
  let anyVisible = false;
  for (let i = 0; i < _fw.N; i++) {
    const m = _fw.meta[i];
    const dt = (u - m.bu) * secPerU;
    if (dt > 0 && dt < _fw.LIFE) {
      anyVisible = true;
      pa[i * 3] = m.bx + m.vx * dt;
      pa[i * 3 + 1] = m.by + m.vy * dt - 6 * dt * dt;
      pa[i * 3 + 2] = m.bz + m.vz * dt;
    } else {
      pa[i * 3 + 1] = -500; // park below the world
    }
  }
  _fw.pts.geometry.attributes.position.needsUpdate = true;
  _fw.pts.material.opacity = (u > 0.70 && u < 0.92) ? 0.9 : 0;
  _fw.pts.visible = anyVisible;
}

window.__FY = { rock: _fRockMesh, bld: _fBldMesh, wf: _fWfPts, launchInst: _launch.inst, launchHalo: _launch.hm, fw: _fw.pts, glow: _fGlowMat };

// ---------------- dragons (hero scale, close passes) ----------------
// Serpentine dragons: one tube body deformed along a traveling-wave spine,
// proper head (snout, jaw, horns, whiskers, glowing eyes), bat wings.
// Runtime-generated scale texture (canvas): scalloped scales on the back,
// broad plates on the belly band. No download cost.
let _scaleTex = null;
function scaleTexture() {
  if (_scaleTex) return _scaleTex;
  const S = 128, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#8a8a8a'; ctx.fillRect(0, 0, S, S);
  // belly band: x in [S/2, S] -> horizontal plates (maps to the lower half of the tube)
  ctx.fillStyle = '#b8b8b8'; ctx.fillRect(S / 2, 0, S / 2, S);
  ctx.strokeStyle = 'rgba(70,70,70,0.9)'; ctx.lineWidth = 2;
  for (let y = 0; y <= S; y += 16) { ctx.beginPath(); ctx.moveTo(S / 2, y); ctx.lineTo(S, y); ctx.stroke(); }
  // scalloped scales on the back half (x in [0, S/2)), two horizontal repeats
  const rw = 32, rh = 26;
  for (let ry = 0; ry < S / rh + 1; ry++) {
    const off = (ry % 2) * rw / 2;
    for (let rx = -1; rx < S / 2 / rw + 1; rx++) {
      const x = rx * rw + off, y = ry * rh;
      const g = ctx.createRadialGradient(x + rw / 2, y + rh * 0.3, 1, x + rw / 2, y + rh * 0.3, rw * 0.62);
      g.addColorStop(0, 'rgba(245,245,245,1)');
      g.addColorStop(0.55, 'rgba(150,150,150,0.95)');
      g.addColorStop(0.9, 'rgba(45,45,45,1)');
      g.addColorStop(1, 'rgba(20,20,20,1)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + rw / 2, y + rh * 0.35, rw * 0.62, 0, Math.PI);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
function makeDragon(colorHex, ph0) {
  const base = new THREE.Color(colorHex);
  const belly = base.clone().lerp(new THREE.Color(0xfff0cf), 0.65);
  const fin = base.clone().multiplyScalar(0.5);
  const RINGS = 36, RAD = 8, LEN = 26;
  const radiusAt = t => {
    // tail tip -> chest -> neck
    const prof = [[0, 0.28], [0.12, 0.85], [0.35, 1.55], [0.55, 1.95], [0.68, 1.75], [0.82, 1.2], [0.93, 0.95], [1, 0.7]];
    for (let i = 1; i < prof.length; i++) {
      if (t <= prof[i][0]) {
        const [t0, r0] = prof[i - 1], [t1, r1] = prof[i];
        return r0 + (r1 - r0) * (t - t0) / (t1 - t0);
      }
    }
    return 0.7;
  };
  // base spine: gentle S, tail at -z, neck at +z
  const basePts = [];
  for (let i = 0; i < RINGS; i++) {
    const t = i / (RINGS - 1);
    basePts.push(new THREE.Vector3(Math.sin(t * Math.PI * 1.5) * 1.4, Math.sin(t * Math.PI) * 0.9 + 0.2, (t - 0.5) * LEN));
  }
  // per-vertex records: ring index, offsets along frame (N,B,T), normal components
  const vRing = [], vOff = [], vNrm = [], vCol = [], vUv = [];
  const idx = [];
  for (let i = 0; i < RINGS; i++) {
    const t = i / (RINGS - 1), r = radiusAt(t);
    for (let j = 0; j < RAD; j++) {
      const th = j / RAD * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      vRing.push(i); vOff.push(r * c, r * s, 0); vNrm.push(c, s, 0);
      const k = Math.min(1, Math.max(0, (-s - 0.15) * 1.8)); // belly on lower half
      const col = base.clone().lerp(belly, k);
      vCol.push(col.r, col.g, col.b);
      vUv.push(j / RAD * 2, t * 8);
    }
  }
  for (let i = 0; i < RINGS - 1; i++) for (let j = 0; j < RAD; j++) {
    const a = i * RAD + j, b = i * RAD + (j + 1) % RAD, c2 = (i + 1) * RAD + j, d = (i + 1) * RAD + (j + 1) % RAD;
    idx.push(a, c2, b, b, c2, d);
  }
  // dorsal spikes: small cones riding the spine, leaning back
  const spikeAt = [0.16, 0.28, 0.40, 0.52, 0.63, 0.74, 0.84, 0.92];
  for (const t of spikeAt) {
    const i = Math.round(t * (RINGS - 1)), r = radiusAt(t);
    const h = 1.15 * (1 - Math.abs(t - 0.55) * 0.9), w = 0.34;
    const ringOf = Math.max(0, i - 1);
    // 4 base verts + tip, as two triangles (front/back) + sides
    const baseV = [[-w, 0, w * 0.6], [w, 0, w * 0.6], [w, 0, -w * 0.6], [-w, 0, -w * 0.6]];
    const start = vRing.length;
    for (const bv of baseV) {
      vRing.push(ringOf); vOff.push(bv[0], r + 0.05, bv[2]); vNrm.push(0, 0.8, -0.6);
      vCol.push(fin.r, fin.g, fin.b); vUv.push(0.12, 0.05);
    }
    vRing.push(ringOf); vOff.push(0, r + 0.05 + h, -h * 0.55); vNrm.push(0, 0.8, -0.6);
    vCol.push(fin.r, fin.g, fin.b); vUv.push(0.2, 0.12);
    idx.push(start, start + 1, start + 4, start + 1, start + 2, start + 4, start + 2, start + 3, start + 4, start + 3, start + 0, start + 4);
  }
  const nv = vRing.length;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vCol), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vUv), 2));
  g.setIndex(idx);
  const stex = scaleTexture();
  const bodyMesh = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ vertexColors: true, map: stex, bumpMap: stex, bumpScale: 0.7, shininess: 28, specular: new THREE.Color(0x554422), emissive: new THREE.Color(colorHex), emissiveIntensity: 0.14 }));

  // ---- head (static geometry, follows the neck frame) ----
  const headParts = [];
  const addH = (geo, c) => headParts.push({ g: geo, c: [c.r, c.g, c.b] });
  {
    const s = new THREE.SphereGeometry(1.5, 8, 6); s.scale(0.95, 0.85, 1.25); s.translate(0, 0.25, 0.8); addH(s, base);
    const snout = new THREE.BoxGeometry(1.5, 0.9, 3.0); snout.translate(0, 0.12, 2.6); addH(snout, base);
    const nose = new THREE.BoxGeometry(1.05, 0.6, 0.9); nose.translate(0, 0.3, 4.25); addH(nose, base);
    const jaw = new THREE.BoxGeometry(1.25, 0.38, 2.7); jaw.rotateX(0.10); jaw.translate(0, -0.62, 2.4); addH(jaw, belly);
    for (const sx of [-0.85, 0.85]) { // swept-back horns
      const h = new THREE.ConeGeometry(0.34, 3.0, 5); h.rotateX(-2.05); h.rotateZ(sx * 0.28); h.translate(sx, 1.35, -0.5); addH(h, fin);
    }
    for (const sx of [-0.95, 0.95]) { // cheek spikes
      const h = new THREE.ConeGeometry(0.22, 1.3, 4); h.rotateZ(sx * 1.9); h.translate(sx * 1.15, 0.1, 0.9); addH(h, fin);
    }
    for (const sx of [-0.5, 0.5]) { // whiskers flowing back
      const h = new THREE.ConeGeometry(0.07, 5.0, 3); h.rotateX(Math.PI / 2 + 0.35); h.rotateY(sx * 0.5); h.translate(sx * 1.6, -0.1, 2.2); addH(h, belly);
    }
  }
  const headMesh = new THREE.Mesh(mergeGeos(headParts), bodyMesh.material);
  const eyeGlows = [];
  for (const sx of [-0.82, 0.82]) {
    const e = new THREE.SphereGeometry(0.28, 6, 5); e.translate(sx, 0.66, 1.5);
    eyeGlows.push({ g: e, c: [1.0, 0.78, 0.25] });
  }
  const eyeMesh = new THREE.Mesh(mergeGeos(eyeGlows), new THREE.MeshBasicMaterial({ vertexColors: true }));
  eyeMesh.material.toneMapped = false;
  const headG = new THREE.Group();
  headG.add(headMesh, eyeMesh);
  headG.scale.setScalar(0.8);

  // ---- bat wings: scalloped membrane + finger bones ----
  function wing(sign) {
    const pivot = new THREE.Group();
    pivot.position.set(0.9 * sign, 1.4, 3.2);
    const A = [0, 0, 0], B = [2.8 * sign, 1.9, -0.7], C = [5.8 * sign, 2.8, -2.6],
      D = [4.2 * sign, 0.5, -4.6], E = [2.1 * sign, -0.5, -4.8], F = [0.5 * sign, -1.0, -2.8];
    const tris = [[A, B, F], [B, E, F], [B, D, E], [B, C, D]];
    const v = [], col = [];
    const membrane = fin.clone().lerp(base, 0.45);
    const shadeOf = p => { const d = Math.min(1, (Math.abs(p[0]) + Math.abs(p[2])) / 8); return 1.05 - d * 0.55; };
    for (const t of tris) for (const p of t) { v.push(p[0], p[1], p[2]); const sh = shadeOf(p); col.push(membrane.r * sh, membrane.g * sh, membrane.b * sh); }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
    wg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    wg.computeVertexNormals();
    const parts = [{ g: wg, c: [membrane.r, membrane.g, membrane.b] }];
    for (const tip of [C, D, E]) { // finger bones
      const from = new THREE.Vector3(...A).lerp(new THREE.Vector3(...B), 0.5);
      const to = new THREE.Vector3(...tip);
      const len = from.distanceTo(to);
      const bg = new THREE.CylinderGeometry(0.09, 0.16, len, 4);
      bg.translate(0, len / 2, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
      bg.applyQuaternion(q); bg.translate(from.x, from.y, from.z);
      parts.push({ g: bg, c: [fin.r, fin.g, fin.b] });
    }
    const merged = mergeGeos(parts);
    const m = new THREE.Mesh(merged, new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, shininess: 18, specular: new THREE.Color(0x332a18), emissive: new THREE.Color(colorHex), emissiveIntensity: 0.2 }));
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
  grp.add(bodyMesh, L, R, halo, headG);
  grp.scale.setScalar(5.2);

  // ---- per-frame spine update ----
  const waved = basePts.map(p => p.clone());
  const up = new THREE.Vector3(0, 1, 0);
  const Tv = new THREE.Vector3(), Nv = new THREE.Vector3(), Bv = new THREE.Vector3(), zero = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const frames = basePts.map(() => ({ N: new THREE.Vector3(1, 0, 0), B: new THREE.Vector3(0, 1, 0), T: new THREE.Vector3(0, 0, 1) }));
  function upd(time) {
    for (let i = 0; i < RINGS; i++) {
      const t = i / (RINGS - 1);
      const sway = Math.sin(t * 7.2 - time * 3.1 + ph0) * 1.15 * (0.25 + t * 0.95);
      const bob = Math.cos(t * 5.1 - time * 3.1 + ph0) * 0.42 * (0.3 + t * 0.55);
      waved[i].set(basePts[i].x + sway, basePts[i].y + bob, basePts[i].z);
    }
    for (let i = 0; i < RINGS; i++) {
      const a = waved[Math.max(0, i - 1)], b = waved[Math.min(RINGS - 1, i + 1)];
      Tv.subVectors(b, a).normalize();
      Nv.crossVectors(up, Tv);
      if (Nv.lengthSq() < 1e-6) Nv.set(1, 0, 0); else Nv.normalize();
      Bv.crossVectors(Tv, Nv).normalize();
      frames[i].N.copy(Nv); frames[i].B.copy(Bv); frames[i].T.copy(Tv);
    }
    for (let k = 0; k < nv; k++) {
      const f = frames[vRing[k]], p = waved[vRing[k]];
      const on = vOff[k * 3], ob = vOff[k * 3 + 1], ot = vOff[k * 3 + 2];
      pos[k * 3] = p.x + f.N.x * on + f.B.x * ob + f.T.x * ot;
      pos[k * 3 + 1] = p.y + f.N.y * on + f.B.y * ob + f.T.y * ot;
      pos[k * 3 + 2] = p.z + f.N.z * on + f.B.z * ob + f.T.z * ot;
      const nn = vNrm[k * 3], nb = vNrm[k * 3 + 1], nt = vNrm[k * 3 + 2];
      nrm[k * 3] = f.N.x * nn + f.B.x * nb + f.T.x * nt;
      nrm[k * 3 + 1] = f.N.y * nn + f.B.y * nb + f.T.y * nt;
      nrm[k * 3 + 2] = f.N.z * nn + f.B.z * nb + f.T.z * nt;
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    const fe = frames[RINGS - 1];
    headG.position.copy(waved[RINGS - 1]);
    m4.lookAt(zero, fe.T.clone().negate(), fe.B);
    headG.quaternion.setFromRotationMatrix(m4);
  }
  upd(0);
  return { grp, L, R, upd };
}
const DRAG_PATHS = [
  { cx: 177, cz: -132, r: 150, h: 120, amp: 18, speed: 0.16, ph: 0.0 },
  { cx: -250, cz: 210, r: 140, h: 100, amp: 16, speed: -0.12, ph: 2.1 },
  { cx: 560, cz: 350, r: 130, h: 105, amp: 25, speed: 0.10, ph: 4.2 },
];
const dragons = manifest.dragons.map((d, i) => {
  const { grp, L, R, upd } = makeDragon(d.col, DRAG_PATHS[i % DRAG_PATHS.length].ph);
  scene.add(grp);
  const p = DRAG_PATHS[i % DRAG_PATHS.length];
  return { grp, L, R, upd, ...p };
});
function tickDragons(t, u) {
  // chase window: mid-loop the pack closes on the lead dragon's orbit,
  // speed and flapping pick up, bellies glow brighter. Pure function of u.
  const cw = Math.min(Math.max((u - 0.55) / 0.13, 0), 1);
  const chase = cw > 0 && cw < 1 ? Math.sin(cw * Math.PI) ** 2 : 0;
  const cw2 = Math.min(Math.max((u - 0.70) / 0.09, 0), 1);
  const gather = cw2 > 0 && cw2 < 1 ? Math.sin(cw2 * Math.PI) ** 2 : 0;
  for (const d of dragons) {
    const isLead = d.ph === 0.0;
    const spd = d.speed * (1 + chase * (isLead ? 0.8 : 0.45));
    const a = t * spd + d.ph * (1 - gather * 0.88); // gather collapses phases into a trailing lane
    // non-leaders pull toward the lead orbit center during the chase
    const pull = chase * (isLead ? 0 : 0.55);
    const pull2 = gather * 0.8;
    const gx = d.cx + (560 - d.cx) * pull2, gz = d.cz + (350 - d.cz) * pull2;
    const cx = gx + (177 - gx) * pull, cz = gz + (-132 - gz) * pull;
    const rr = d.r * (1 - chase * (isLead ? 0 : 0.3));
    const x = cx + Math.cos(a) * rr;
    const z = cz + Math.sin(a) * rr * 0.8;
    const y = d.h + Math.sin(t * 0.5 + d.ph) * d.amp * (1 - chase * 0.3);
    d.grp.position.set(x, y, z);
    // never let a dragon fill or block the camera lens (Irvan 9:41 PM)
    const cdx = x - camera.position.x, cdy = y - camera.position.y, cdz = z - camera.position.z;
    const cd2 = cdx * cdx + cdy * cdy + cdz * cdz;
    if (cd2 < 16900) {
      const s = 130 / (Math.sqrt(cd2) || 1);
      d.grp.position.set(camera.position.x + cdx * s, camera.position.y + cdy * s, camera.position.z + cdz * s);
    }
    const na = a + 0.02 * Math.sign(d.speed);
    const nx = cx + Math.cos(na) * rr, nz = cz + Math.sin(na) * rr * 0.8;
    d.grp.lookAt(nx, y, nz);
    d.upd(t * (1 + chase * 0.5));
    const f = Math.sin(t * (4.2 + chase * 2.6) + d.ph) * (0.6 + chase * 0.3);
    d.L.rotation.z = 0.2 + f; d.R.rotation.z = -0.2 - f;
    d.L.rotation.y = -0.15 + f * 0.25; d.R.rotation.y = 0.15 - f * 0.25;
    const m = d.grp.children[0].material;
    m.emissiveIntensity = 0.14 + chase * 0.4;
  }
}

// ---------------- festival dressing ----------------
// lantern strings between far-building rooftops (anchors from baked far data)
let fxStringMat, fxHaloMat;
{
  const far = sec('far');
  const tops = [];
  {
    // v20a: far section emptied by the full-city bake — anchor strings to baked rooftops
    const rp = sec('roofs_pos');
    const cells = {};
    for (let i = 0; i < rp.length; i += 3) {
      const x = rp[i], y = rp[i + 1], z = rp[i + 2];
      if (y < 24 || y > 120 || Math.abs(x) > 700 || Math.abs(z) > 700) continue;
      const k = Math.round(x / 30) + ':' + Math.round(z / 30);
      if (!cells[k] || cells[k][1] < y) cells[k] = [x, y, z];
    }
    for (const k in cells) tops.push(cells[k]);
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
    const w = 4.5 + rnd() * 3.5, d = 3 + rnd() * 2, ry = rnd() * Math.PI;
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
  const atRayMesh = new THREE.Mesh(mergeGeos(rays), atRayMat);
  atRayMesh.visible = false; // disabled: cone walls read as dark banding when the camera flies through them
  scene.add(atRayMesh);
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
  crowdMat = new THREE.PointsMaterial({ size: 1.55, map: haloTex, color: 0xffdc9e, transparent: true, opacity: 0.72, depthWrite: false, blending: THREE.AdditiveBlending });
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
  { pos: [-40, 60, 160], look: [22, 45, -60], hold: 1400, fly: 5000, title: "Twin Spire Dive", note: "Diving straight between the matched towers of light" },
  { pos: [84, 34, -272], look: [177, 20, -132], hold: 2200, fly: 4800, title: "Gate of Lanterns", note: "Under the great gate, into the festival" },
  { pos: [128, 66, -62], look: [185, 22, -140], hold: 2000, fly: 5000, title: "Star Market Life", note: "Vendors weave through drifting sky lanterns" },
  { pos: [-40, 68, -40], look: [-166, 46, 143], hold: 1600, fly: 5000, title: "Pagoda Orbit", note: "Curling around the tiered temple roof" },
  { pos: [-330, 100, -20], look: [-250, 30, 60], hold: 1600, fly: 5200, title: "Palace Mist", note: "Silhouettes of the hall pierce the low fog" },
  { pos: [-160, 130, 260], look: [740, 14, 450], hold: 1500, fly: 5400, title: "Water Reveal", note: "Rising over the glowing canals for the reveal" },
  { pos: [370, 85, 300], look: [740, 15, 460], hold: 1600, fly: 5200, title: "Magic Harbor", note: "The beacon sweeps across shimmering water" },
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
      // title belongs to what the camera actually shows: keep the current
      // scene's key until the fly is ~70% done, then name the destination
      const raw = (t - fs) / k.fly;
      return { pos: _mix3(k.pos, nx.pos, f), look: _mix3(k.look, nx.look, f), keyIdx: raw < 0.7 ? i : (i + 1) % N };
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
  const down = _smooth((u - 0.982) / 0.018); // hold night through the Grand Astral Night beat; fade only in the last ~1.5s for a seamless wrap to dusk
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

const PIN_U = (() => { const p = new URLSearchParams(location.search).get('u'); return p === null ? -1 : parseFloat(p); })();
let start = null;
let firstFrame = true;
const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const t = clock.getElapsedTime();
  if (start === null) start = t;
  const ms = (PIN_U >= 0 ? PIN_U * LOOP_MS : (t - start) * 1000 + 400);
  const u = (ms % LOOP_MS) / LOOP_MS;
  window.__U = u;

  const { pos, look } = camAt(ms);
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);

  const phase = phaseAt(u);
  skyMat.uniforms.uPhase.value = phase;
  skyMat.uniforms.uTime.value = t;
  starMat.opacity = THREE.MathUtils.smoothstep(phase, 0.10, 0.6);
  sky.position.copy(camera.position);

  scene.fog.color.copy(FOG_DUSK).lerp(FOG_NIGHT, phase);
  skyMat.uniforms.fogColor.value.copy(scene.fog.color);
  for (const m of _lmLamberts) m.emissive.copy(scene.fog.color).multiplyScalar(0.72);
  if (groundMatRef) groundMatRef.color.copy(scene.fog.color).multiplyScalar(0.62);
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
  tickDragons(t, u);
  tickFestival(t, phase);
  tickAtmosphere(t, phase);
  tickLandmarks(t, phase);
  tickCrowd(t);
  tickFantasy(u, phase);
  tickLaunch(u, t);
  tickFireworks(u);
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
