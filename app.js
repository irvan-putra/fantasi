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

const ASSET_V = 'v22';
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
const _gl = new THREE.PointLight(0xffc27a, 60, 45, 1.6); _gl.position.set(196, 7, 192); scene.add(_gl); // v23z: lantern glow so the giant beat is not black
const _bl = new THREE.PointLight(0xffc27a, 40, 40, 1.6); _bl.position.set(-62, 12, 62); scene.add(_bl);

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

// v23as: flat caps over buildings whose wall rings had no roof (seen from above they looked like hollow shells). caps.bin is built from the wall top rings.
try {
  const cb = await (await fetch('./caps.bin?' + ASSET_V)).arrayBuffer(); const dv = new DataView(cb); let o = 0; const nCap = dv.getUint32(o, true); o += 4;
  const P = [], C = [], I = []; let vb = 0;
  for (let c = 0; c < nCap; c++) {
    const top = dv.getFloat32(o, true), cr = dv.getUint8(o + 4), cg = dv.getUint8(o + 5), cbl = dv.getUint8(o + 6), nl = dv.getUint8(o + 7); o += 8;
    const loops = [];
    for (let l = 0; l < nl; l++) { const n = dv.getUint16(o, true); o += 2; const L = []; for (let k = 0; k < n; k++) { L.push(new THREE.Vector2(dv.getFloat32(o, true), dv.getFloat32(o + 4, true))); o += 8; } loops.push(L); }
    const contour = loops[0], holes = loops.slice(1); let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { continue; }
    const all = contour.concat(...holes);
    for (const v of all) { P.push(v.x, top + 0.04, v.y); C.push(cr / 255, cg / 255, cbl / 255); }
    for (const t of tris) I.push(vb + t[0], vb + t[1], vb + t[2]);
    vb += all.length;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  const nrm = new Float32Array(P.length); for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1; g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3)); g.setIndex(I);
  const capMesh = new THREE.Mesh(g, roofMat); capMesh.frustumCulled = false; scene.add(capMesh); window.__CAPS = { n: nCap, tris: I.length / 3 };
} catch (e) { console.warn('caps failed', e); }

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
  float wx=vW.x*0.62+vW.z*0.78, wz=vW.z*0.66-vW.x*0.75;
  float sh1=smoothstep(0.55,0.98,sin(wx*0.16+uTime*1.4+wz*0.07)*0.5+0.5);
  float sh2=smoothstep(0.62,1.00,sin(wz*0.13-uTime*1.9-wx*0.04)*0.5+0.5);
  float shimmer=(sh1+sh2)*0.5*band;
  col+=vec3(0.35,0.75,0.85)*shimmer*uGlow*0.55;
  col+=vec3(1.0,0.6,0.25)*shimmer*uGlow*0.42;
  col+=cy*band*uGlow*0.4;
  vec2 cell=floor(vW.xz*0.9);
  float sp=hash(cell);
  if(sp>0.986){float tw=0.5+0.5*sin(uTime*2.5+sp*90.0);col+=cy*tw*uGlow*0.9;}
  float f=1.0-exp(-fogDensity*fogDensity*vFogZ*vFogZ);
  f=max(f,smoothstep(900.0,2200.0,vFogZ)); // v20u: melt the far water rim into fog - kills the thin horizon seam
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
  // v23t: keep trees off the street-level camera lanes
  const _lane = [[145, -150, 215, -150], [148, -184, 148, -114], [210.6, 196.7, 198.6, 196.7], [-47.5, 66, -78, 56.4]];
  const _nearLane = (x, z) => _lane.some(([ax, az, bx, bz]) => { const dx = bx - ax, dz = bz - az; const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz))); return Math.hypot(x - ax - dx * u, z - az - dz * u) < 7; });
  const inst = new THREE.InstancedMesh(treeGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), pts.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < pts.length; i++) {
    const s = 0.8 + ((i * 37) % 100) / 140;
    Q.setFromAxisAngle(up, (i * 2.399) % 6.28);
    S.setScalar(_nearLane(pts[i][0], pts[i][1]) ? 0.0001 : s); P.set(pts[i][0], 0.4, pts[i][1]);
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
// hero crystal cluster for Crystal Awakening (v20n: ignition cascade, orbiting shards, sparkles, light pillar)
{
  const CX = -88, CZ = -66, CY = 140;
  let csd = 5; const crnd = () => (csd = (csd * 9301 + 49297) & 65535) / 65535;
  const defs = [[0, 0, 58, 9, 0.3], [-12, 4, 38, 6, 1.4], [11, -6, 44, 7, 2.5], [7, 9, 30, 5, 3.6], [-7, -11, 26, 4.5, 5.0]];
  const chues = [0.52, 0.66, 0.58, 0.45, 0.72];
  const heroGrp = new THREE.Group();
  heroGrp.position.set(CX, CY, CZ);
  const shardMats = [];
  for (let di = 0; di < defs.length; di++) {
    const [x, z, h, r, ry] = defs[di];
    const o = new THREE.OctahedronGeometry(r, 0);
    o.scale(1, h / (r * 2), 1); o.rotateY(ry); o.translate(x, h * 0.5, z);
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
    m.toneMapped = false;
    shardMats.push(m);
    heroGrp.add(new THREE.Mesh(o, m));
  }
  scene.add(heroGrp);
  const ringGrp = new THREE.Group();
  ringGrp.position.set(CX, CY + 26, CZ);
  const ringMats = [];
  for (let i = 0; i < 9; i++) {
    const o = new THREE.OctahedronGeometry(1.1 + (i % 3) * 0.5, 0); o.scale(1, 2.2, 1);
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    m.toneMapped = false; ringMats.push(m);
    const mm = new THREE.Mesh(o, m);
    const an = i * 0.698, rad = 24 + (i % 3) * 7;
    mm.position.set(Math.cos(an) * rad, Math.sin(i * 2.1) * 14, Math.sin(an) * rad);
    mm.rotation.y = an * 2.3;
    ringGrp.add(mm);
  }
  scene.add(ringGrp);
  const spN = 90, spPos = new Float32Array(spN * 3);
  for (let i = 0; i < spN; i++) {
    const an = crnd() * 6.283, rad = 12 + crnd() * 38;
    spPos[i * 3] = CX + Math.cos(an) * rad;
    spPos[i * 3 + 1] = CY - 6 + crnd() * 70;
    spPos[i * 3 + 2] = CZ + Math.sin(an) * rad;
  }
  const spGeo = new THREE.BufferGeometry();
  spGeo.setAttribute('position', new THREE.BufferAttribute(spPos, 3));
  const spMat = new THREE.PointsMaterial({ size: 5, map: haloTex, color: 0xaee8ff, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending });
  spMat.toneMapped = false;
  const sparks = new THREE.Points(spGeo, spMat);
  scene.add(sparks);
  const pcv = document.createElement('canvas'); pcv.width = 2; pcv.height = 64;
  const pcx = pcv.getContext('2d');
  const pgr = pcx.createLinearGradient(0, 0, 0, 64);
  pgr.addColorStop(0, 'rgba(255,255,255,0)'); pgr.addColorStop(0.55, 'rgba(255,255,255,0.05)'); pgr.addColorStop(0.8, 'rgba(255,255,255,0.45)'); pgr.addColorStop(1, 'rgba(255,255,255,1)');
  pcx.fillStyle = pgr; pcx.fillRect(0, 0, 2, 64);
  const pilFadeTex = new THREE.CanvasTexture(pcv);
  const pilGeo = new THREE.CylinderGeometry(0.25, 16, 340, 12, 1, true); // v20v: aggressive taper, wide base to hairline top
  const pilMat = new THREE.MeshBasicMaterial({ color: 0x9fe4ff, map: pilFadeTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  pilMat.toneMapped = false;
  const pillar = new THREE.Mesh(pilGeo, pilMat);
  pillar.position.set(CX, CY + 120, CZ);
  scene.add(pillar);
  const haloA = lmHaloAt(CX, CY + 32, CZ, 110, 0x7fd8ff, 0.55);
  const haloB = lmHaloAt(CX, CY + 8, CZ, 60, 0xb48aff, 0.4);
  lmTickers.push((t, phase) => {
    const u = (window.__U !== undefined) ? window.__U : 0;
    // ignition window: facets ignite in cascade as the camera settles into the beat (pure function of u)
    const r0 = Math.min(Math.max((u - 0.795) / 0.02, 0), 1);
    const r1 = Math.min(Math.max((0.865 - u) / 0.02, 0), 1);
    const sm = (v) => v * v * (3 - 2 * v);
    const ignite = sm(r0) * sm(r1);
    heroGrp.rotation.y = t * 0.12;
    for (let i = 0; i < shardMats.length; i++) {
      const cas = Math.min(Math.max(ignite * 1.8 - i * 0.22, 0), 1);
      const lum = 0.28 + cas * 0.5 + 0.07 * Math.sin(t * 2.1 + i * 1.7);
      shardMats[i].color.setHSL((chues[i] + 0.05 * Math.sin(t * 0.6 + i) + 1) % 1, 0.85, Math.min(lum, 0.85));
    }
    ringGrp.rotation.y = -t * 0.21;
    ringGrp.position.y = CY + 26 + Math.sin(t * 0.5) * 4;
    for (let i = 0; i < ringMats.length; i++) {
      ringMats[i].opacity = 0.3 + ignite * 0.6;
      ringMats[i].color.setHSL((chues[i % chues.length] + 0.06 * Math.sin(t * 0.8 + i * 2.0) + 1) % 1, 0.9, 0.5 + ignite * 0.28);
    }
    spMat.opacity = 0.10 + ignite * 0.5 + 0.06 * Math.sin(t * 3.1);
    sparks.rotation.y = t * 0.05;
    pilMat.opacity = ignite * (0.20 + 0.06 * Math.sin(t * 2.3));
    haloA.opacity = 0.28 + ignite * 0.45;
    haloB.opacity = 0.20 + ignite * 0.38;
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
    const rr = lmEaveRoof(w * 1.32, segH * 0.6, 0.06);
    rr[0].c = [0.09, 0.24, 0.28]; rr[1].c = [0.15, 0.38, 0.40];
    for (const r of rr) { r.g.translate(PX, y + segH * 0.22, PZ); parts.push(r); }
    y += segH * 0.42;
    w *= 0.82;
  }
  const fin = new THREE.ConeGeometry(1.8, 13, 6); fin.translate(PX, y + 7, PZ);
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
    wy += segH * 1.42; ww *= 0.82;
  }
  const wm = lmBasic(0xffffff);
  scene.add(new THREE.Mesh(mergeGeos(wins), wm));
  lmHaloAt(PX, wy + 10, PZ, 30, 0xffc46e, 0.65);
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
  const t1 = lmEaveRoof(50, 22, 0.10); for (const p of t1) { p.c = [0.10, 0.28, 0.32]; p.g.translate(HX, 27 + 11, HZ); parts.push(p); }
  const t2 = lmEaveRoof(33, 16, 0.12); for (const p of t2) { p.c = [0.13, 0.34, 0.38]; p.g.translate(HX, 42 + 8, HZ); parts.push(p); }
  const t3 = lmEaveRoof(17, 10, 0.14); for (const p of t3) { p.c = [0.16, 0.4, 0.44]; p.g.translate(HX, 53 + 5, HZ); parts.push(p); }
  lmHaloAt(HX, 24, HZ, 34, 0xffc46e, 0.4);
  const fin = new THREE.ConeGeometry(3.2, 9, 6); fin.translate(HX, 63 + 4.5, HZ);
  parts.push({ g: fin, c: [0.85, 0.6, 0.2] });
  scene.add(new THREE.Mesh(mergeGeos(parts), mat));
  const door = new THREE.BoxGeometry(10, 13, 1); door.translate(HX, 11.5, HZ + 17.2);
  scene.add(new THREE.Mesh(mergeGeos([{ g: door, c: [1.0, 0.7, 0.3] }]), lmBasic(0xffffff)));
  lmHaloAt(HX, 13, HZ + 19, 26, 0xffb75e, 0.75);
  lmHaloAt(HX, 56, HZ, 44, 0xffd98a, 0.5);
}
// drifting mist banks around the palace (v20d)
{
  const mists = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.PlaneGeometry(150 + i * 26, 15 + (i % 2) * 8);
    const m = new THREE.MeshBasicMaterial({ map: haloTex, color: 0x8fa8cf, transparent: true, opacity: 0.2 + (i % 3) * 0.04, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
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
// aurora ribbons over the palace (v20o, Irvan 8:47 AM: "need more like aurora")
{
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
  const cx2 = cv.getContext('2d');
  for (let x = 0; x < 256; x++) {
    const hue = 150 + 90 * Math.sin(x * 0.05) + 40 * Math.sin(x * 0.013 + 2);
    const a = 0.8 * Math.pow(Math.max(0, Math.sin(x * 0.23 + 1)), 2.0) * (0.6 + 0.4 * Math.sin(x * 0.061 + 4)); // v20u: crisp streaks
    const gr = cx2.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, 'hsla(' + hue.toFixed(0) + ',100%,65%,0)');
    gr.addColorStop(0.45, 'hsla(' + hue.toFixed(0) + ',100%,62%,' + a.toFixed(3) + ')');
    gr.addColorStop(1, 'hsla(' + hue.toFixed(0) + ',100%,55%,0)');
    cx2.fillStyle = gr;
    cx2.fillRect(x, 0, 1, 128);
  }
  const aurTex = new THREE.CanvasTexture(cv);
  aurTex.wrapS = THREE.RepeatWrapping;
  const auroras = [];
  const adefs = [ // v20u: six narrow curtains, varied hue/tilt - reads as ribbons, not wash
    [0x77ffd9, -310, 138, 40, 110, 120, 0.55, 0.5],
    [0x9a6bff, -225, 158, 95, 90, 110, 0.5, -0.35],
    [0x64ff9a, -280, 128, -15, 130, 130, 0.45, 0.95],
    [0x5fe8ff, -195, 148, 30, 80, 100, 0.42, 0.15],
    [0xb48aff, -255, 118, 70, 95, 90, 0.4, -0.7],
    [0x64ff9a, -330, 168, 90, 100, 110, 0.38, 0.8],
  ];
  for (const [col, x, y, z, w, h, op, ry] of adefs) {
    const m = new THREE.MeshBasicMaterial({ map: aurTex, color: col, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    m.toneMapped = false;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    scene.add(mesh);
    auroras.push({ m, mesh, y0: y, op, ph: x * 0.01 });
  }
  lmTickers.push((t, phase) => {
    aurTex.offset.x = (t * 0.02) % 1;
    const dim = 0.25 + 0.75 * phase;
    for (const a of auroras) {
      a.m.opacity = a.op * dim * (0.55 + 0.45 * Math.sin(t * 0.4 + a.ph * 6));
      a.mesh.position.y = a.y0 + Math.sin(t * 0.23 + a.ph * 9) * 8;
    }
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
  // v20q: long soft tapered beams - narrow 24-seg cones + length-fade gradient (Irvan: beams were short white cones / giant blade)
  const bcv = document.createElement('canvas'); bcv.width = 2; bcv.height = 64;
  const bcx = bcv.getContext('2d');
  const bgr = bcx.createLinearGradient(0, 0, 0, 64);
  bgr.addColorStop(0, 'rgba(255,255,255,1)'); bgr.addColorStop(0.35, 'rgba(255,255,255,0.5)'); bgr.addColorStop(1, 'rgba(255,255,255,0)');
  bcx.fillStyle = bgr; bcx.fillRect(0, 0, 2, 64);
  const beamFadeTex = new THREE.CanvasTexture(bcv);
  const beamGeoI = new THREE.ConeGeometry(4, 280, 24, 1, true);
  beamGeoI.translate(0, -140, 0); beamGeoI.rotateX(-Math.PI / 2); beamGeoI.rotateX(-0.12);
  const beamGeoO = new THREE.ConeGeometry(10, 280, 24, 1, true);
  beamGeoO.translate(0, -140, 0); beamGeoO.rotateX(-Math.PI / 2); beamGeoO.rotateX(-0.12);
  const beamMatB = new THREE.MeshBasicMaterial({ color: 0xffe9b0, map: beamFadeTex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, side: THREE.FrontSide, depthWrite: false });
  beamMatB.toneMapped = false;
  const beamMatO = new THREE.MeshBasicMaterial({ color: 0xffe9b0, map: beamFadeTex, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, side: THREE.FrontSide, depthWrite: false });
  beamMatO.toneMapped = false;
  const beamMesh = new THREE.Mesh(beamGeoI, beamMatB);
  beamMesh.position.set(LX, y + 3, LZ);
  scene.add(beamMesh);
  const beamMeshO = new THREE.Mesh(beamGeoO, beamMatO);
  beamMeshO.position.set(LX, y + 3, LZ);
  scene.add(beamMeshO);
  const beamMesh2 = new THREE.Mesh(beamGeoI, beamMatB);
  beamMesh2.position.set(LX, y + 3, LZ);
  beamMesh2.rotation.y = Math.PI;
  scene.add(beamMesh2);
  const beamMesh2O = new THREE.Mesh(beamGeoO, beamMatO);
  beamMesh2O.position.set(LX, y + 3, LZ);
  beamMesh2O.rotation.y = Math.PI;
  scene.add(beamMesh2O);
  const lampHalo = lmHaloAt(LX, y + 3, LZ, 40, 0xffe9b0, 0.9);
  lmTickers.push((t, phase) => {
    beamMesh.rotation.y = t * 0.7;
    beamMeshO.rotation.y = t * 0.7;
    beamMesh2.rotation.y = Math.PI + t * 0.7;
    beamMesh2O.rotation.y = Math.PI + t * 0.7;
    beamMesh.material.opacity = 0.30 + phase * 0.25;
    lampHalo.opacity = 0.5 + 0.4 * phase + Math.sin(t * 3.1) * 0.1;
  });
}
// harbor bay water (v19w) — a real glowing basin where the harbor beats look
const BAY = { x: 800, z: 470, r: 250 };
{
  const g = new THREE.CircleGeometry(BAY.r, 40); g.rotateX(-Math.PI / 2); g.translate(BAY.x, 0.4, BAY.z);
  scene.add(new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: waterUniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG })));
  lmHaloAt(BAY.x, 5, BAY.z, 470, 0x35e0d0, 0.3);
  lmHaloAt(740, 5, 450, 200, 0x7ff0e0, 0.28);
}
// lantern-lit boats drifting on the bay (v19w)
{
  const boatMat = lmLambert();
  const boats = [];
  const radii = [45, 78, 150, 195];
  for (let i = 0; i < 4; i++) {
    const parts = [];
    const hull = new THREE.CylinderGeometry(3.4, 5.4, 22, 6); hull.rotateZ(Math.PI / 2); hull.scale(1, 0.55, 0.62); hull.translate(0, 2.2, 0);
    parts.push({ g: hull, c: [0.24, 0.14, 0.08] });
    const mast = new THREE.CylinderGeometry(0.4, 0.5, 19, 5); mast.translate(1.3, 12.6, 0);
    parts.push({ g: mast, c: [0.3, 0.2, 0.12] });
    const sail = new THREE.PlaneGeometry(10, 12); sail.rotateY(Math.PI / 2); sail.translate(1.3, 13.4, 0);
    parts.push({ g: sail, c: [0.78, 0.64, 0.42] });
    const cabin = new THREE.BoxGeometry(5.6, 3.4, 4.2); cabin.translate(-3.4, 4.4, 0);
    parts.push({ g: cabin, c: [0.2, 0.12, 0.07] });
    const mesh = new THREE.Mesh(mergeGeos(parts), boatMat);
    scene.add(mesh);
    const lampGeo = new THREE.BufferGeometry();
    lampGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-3.4, 8.0, 0]), 3));
    const lampMatB = new THREE.PointsMaterial({ size: 34, map: haloTex, color: 0xffc46e, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
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
// Chinese dragons: one long thin tube body deformed along a traveling-wave spine,
// head with snout, jaw, branched antlers, long whiskers, mane fan, glowing eyes. No wings -
// they ride the sky. (v20x, Irvan 09:54: "maybe a Chinese dragon instead?")
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
  const belly = base.clone().lerp(new THREE.Color(0xfff0cf), 0.8);
  const fin = base.clone().multiplyScalar(0.5);
  const mane = base.clone().lerp(new THREE.Color(0xffd98a), 0.55); // gold-tinged mane/antler color
  const RINGS = 60, RAD = 8, LEN = 44;
  const radiusAt = t => {
    // tail tip -> chest -> neck
    const prof = [[0, 0.54], [0.12, 1.62], [0.35, 2.84], [0.55, 3.51], [0.68, 3.17], [0.82, 2.43], [0.93, 2.03], [1, 1.62]]; // v22h: body 1.35x thicker (Irvan: bolder dragons)
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
  const spikeAt = [0.10, 0.16, 0.22, 0.28, 0.34, 0.40, 0.46, 0.52, 0.58, 0.63, 0.68, 0.74, 0.79, 0.84, 0.88, 0.92, 0.95];
  for (const t of spikeAt) {
    const i = Math.round(t * (RINGS - 1)), r = radiusAt(t);
    const h = 1.5 * (1 - Math.abs(t - 0.55) * 0.7), w = 0.3;
    const ringOf = Math.max(0, i - 1);
    // 4 base verts + tip, as two triangles (front/back) + sides
    const baseV = [[-w, 0, w * 0.6], [w, 0, w * 0.6], [w, 0, -w * 0.6], [-w, 0, -w * 0.6]];
    const start = vRing.length;
    for (const bv of baseV) {
      vRing.push(ringOf); vOff.push(bv[0], r + 0.05, bv[2]); vNrm.push(0, 0.8, -0.6);
      vCol.push(mane.r, mane.g, mane.b); vUv.push(0.12, 0.05);
    }
    vRing.push(ringOf); vOff.push(0, r + 0.05 + h, -h * 0.55); vNrm.push(0, 0.8, -0.6);
    vCol.push(mane.r, mane.g, mane.b); vUv.push(0.2, 0.12);
    idx.push(start, start + 1, start + 4, start + 1, start + 2, start + 4, start + 2, start + 3, start + 4, start + 3, start + 0, start + 4);
  }
  // tail fin fan (v21a): flat gold triangles fanning behind the tail tip
  for (const [fn, fl] of [[-0.9, 1.5], [0, 2.2], [0.9, 1.5]]) {
    const r0 = radiusAt(0.02);
    const start = vRing.length;
    const pts = [[-0.15, 0, 0.3], [0.15, 0, 0.3], [fn, 0.35, -fl]];
    for (const pv of pts) { vRing.push(1); vOff.push(pv[0], pv[1] + r0 * 0.2, pv[2]); vNrm.push(0, 1, 0); vCol.push(mane.r, mane.g, mane.b); vUv.push(0.12, 0.05); }
    idx.push(start, start + 1, start + 2, start, start + 2, start + 1);
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
  const bodyMesh = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ vertexColors: true, map: stex, bumpMap: stex, bumpScale: 0.7, shininess: 28, specular: new THREE.Color(0x554422), emissive: new THREE.Color(colorHex), emissiveIntensity: 0.35 }));

  // ---- head (static geometry, follows the neck frame) ----
  const headParts = [];
  const addH = (geo, c) => headParts.push({ g: geo, c: [c.r, c.g, c.b] });
  {
    const s = new THREE.SphereGeometry(1.5, 8, 6); s.scale(0.95, 0.85, 1.25); s.translate(0, 0.25, 0.8); addH(s, base);
    const snout = new THREE.BoxGeometry(1.5, 0.9, 3.0); snout.translate(0, 0.12, 2.6); addH(snout, base);
    const nose = new THREE.BoxGeometry(1.05, 0.6, 0.9); nose.translate(0, 0.3, 4.25); addH(nose, base);
    const jaw = new THREE.BoxGeometry(1.25, 0.38, 2.7); jaw.rotateX(0.10); jaw.translate(0, -0.62, 2.4); addH(jaw, belly);
    for (const sx of [-0.8, 0.8]) { // branched antlers, swept up and back
      const beam = new THREE.CylinderGeometry(0.10, 0.16, 2.6, 5); beam.rotateX(-1.9); beam.rotateZ(sx * 0.35); beam.translate(sx, 1.7, -0.7); addH(beam, mane);
      const t1 = new THREE.ConeGeometry(0.08, 1.1, 4); t1.rotateX(-1.2); t1.rotateZ(sx * 0.9); t1.translate(sx * 1.45, 2.3, -1.0); addH(t1, mane);
      const t2 = new THREE.ConeGeometry(0.07, 0.9, 4); t2.rotateX(-2.3); t2.rotateZ(sx * 0.2); t2.translate(sx * 1.1, 2.6, -1.6); addH(t2, mane);
    }
    for (let mi = -3; mi <= 3; mi++) { // mane fan behind the head
      const mgeo = new THREE.ConeGeometry(0.26, 1.7, 4);
      mgeo.rotateX(-0.9); mgeo.rotateZ(mi * 0.3);
      mgeo.translate(mi * 0.45, 1.15 - Math.abs(mi) * 0.05, -0.6);
      addH(mgeo, mane);
    }
    for (const sx of [-0.95, 0.95]) { // cheek spikes
      const h = new THREE.ConeGeometry(0.22, 1.3, 4); h.rotateZ(sx * 1.9); h.translate(sx * 1.15, 0.1, 0.9); addH(h, fin);
    }
    for (const sx of [-0.5, 0.5]) { // whiskers flowing back
      const h = new THREE.ConeGeometry(0.06, 7.5, 3); h.rotateX(Math.PI / 2 + 0.35); h.rotateY(sx * 0.5); h.translate(sx * 1.6, -0.1, 2.2); addH(h, belly);
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
  // pearl of wisdom floating before the head (v20y)
  const pearl = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe9a8 }));
  pearl.material.toneMapped = false;
  pearl.position.set(0, 0.35, 5.4);
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0.35, 5.4]), 3));
  const pmat = new THREE.PointsMaterial({ size: 22, map: haloTex, color: 0xffd98a, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
  pmat.toneMapped = false;
  const pearlHalo = new THREE.Points(pg, pmat);
  const headG = new THREE.Group();
  headG.add(headMesh, eyeMesh, pearl, pearlHalo);
  headG.scale.setScalar(1.9);

  // v20x: no wings - Chinese dragons ride the sky by virtue, not wings
  const L = new THREE.Group(), R = new THREE.Group();
  // halo so the dragon reads at distance
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 1, 1]), 3));
  const hm = new THREE.PointsMaterial({ size: 56, map: haloTex, color: colorHex, transparent: true, opacity: 0.34, depthWrite: false, blending: THREE.AdditiveBlending });
  hm.toneMapped = false;
  const halo = new THREE.Points(hg, hm);
  const grp = new THREE.Group();
  grp.add(bodyMesh, halo, headG);
  grp.scale.setScalar(6.8);

  // ---- per-frame spine update ----
  const waved = basePts.map(p => p.clone());
  const up = new THREE.Vector3(0, 1, 0);
  const Tv = new THREE.Vector3(), Nv = new THREE.Vector3(), Bv = new THREE.Vector3(), zero = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const frames = basePts.map(() => ({ N: new THREE.Vector3(1, 0, 0), B: new THREE.Vector3(0, 1, 0), T: new THREE.Vector3(0, 0, 1) }));
  function upd(time) {
    for (let i = 0; i < RINGS; i++) {
      const t = i / (RINGS - 1);
      const sway = Math.sin(t * 9.0 - time * 3.1 + ph0) * 4.0 * (0.25 + t * 0.95);
      const bob = Math.cos(t * 9.0 - time * 3.1 + ph0) * 2.6 * (0.3 + t * 0.55); // v21b: corkscrew pair with sway
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
const DRAG_PATHS = [ // v21a: long lanes sweeping across the city sky, not distant loops
  { cx: 0, cz: 0, r: 330, h: 185, amp: 48, loops: 1, ph: 0.0 },
  { cx: -60, cz: 40, r: 400, h: 215, amp: 58, loops: 1, ph: 2.1 },
  { cx: 80, cz: -40, r: 460, h: 160, amp: 40, loops: 1, ph: 4.2 },
];
const dragons = manifest.dragons.map((d, i) => {
  const { grp, L, R, upd } = makeDragon(d.col, DRAG_PATHS[i % DRAG_PATHS.length].ph);
  scene.add(grp);
  const p = DRAG_PATHS[i % DRAG_PATHS.length];
  return { grp, L, R, upd, ...p };
});
const _fwd = new THREE.Vector3();

let _DW = null;
function _dragonWorld() {
  if (_DW) return _DW;
  const ti = (name) => KEYS.findIndex((k) => k.title === name);
  const tAt = (idx) => { let t = 0; for (let j = 0; j < idx; j++) t += KEYS[j].fly + KEYS[j].hold; return t; };
  const uH = (tAt(ti('Magic Harbor')) + 800) / LOOP_MS, dU = 7500 / LOOP_MS;
  const slot = [[-80, 185, -30], [0, 225, 20], [80, 205, 60]]; // lateral (screen right), height, depth along the Dragon Lanes view
  const VIEW = [0.724, 0.690], RIGHT = [-0.690, 0.724], BASE = [567, 357];
  const ring = [[330, 290], [60, 200], [-120, 20], [-90, -150], [180, -230], [520, -120], [700, 100], [760, 300]];
  const rh = [200, 215, 230, 240, 235, 220, 205, 195];
  const lanes = [];
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * 55;
    const pts = [[720 + off * 0.4, 190 + i * 15, 440 - off * 0.6]]; // above the harbor
    pts.push([BASE[0] + RIGHT[0] * slot[i][0] + VIEW[0] * slot[i][2], slot[i][1], BASE[1] + RIGHT[1] * slot[i][0] + VIEW[1] * slot[i][2]]);
    ring.forEach((r, k) => pts.push([r[0] + (i - 1) * 60 * (k % 2 ? 1 : -1), rh[k] + i * 12, r[1] + (i - 1) * 50]));
    // times: harbor -> slot fixed, rest by arc length across the remaining loop
    const ts = [uH, uH + dU]; const rest = pts.slice(1); let tot = 0; const segs = [];
    for (let k = 0; k < rest.length; k++) { const q = rest[(k + 1) % rest.length === 0 ? 0 : k + 1] || pts[0]; const A = rest[k], B = k + 1 < rest.length ? rest[k + 1] : pts[0]; const dl = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]); segs.push(dl); tot += dl; }
    let acc = 0; for (let k = 0; k < segs.length - 1; k++) { acc += segs[k]; ts.push(uH + dU + (1 - dU) * acc / tot); }
    lanes.push({ pts, ts });
  }
  const crpos = (L, u) => { const n = L.pts.length, t0 = L.ts[0]; let x = ((u - t0) % 1 + 1) % 1 + t0; let k = n - 1; for (let j = 0; j < n; j++) { const te = j + 1 < n ? L.ts[j + 1] : t0 + 1; if (x < te) { k = j; break; } }
    const te = k + 1 < n ? L.ts[k + 1] : t0 + 1, s = (x - L.ts[k]) / (te - L.ts[k]);
    const P = (j) => L.pts[((j % n) + n) % n], p0 = P(k - 1), p1 = P(k), p2 = P(k + 1), p3 = P(k + 2), s2 = s * s, s3 = s2 * s; const o = [0, 0, 0];
    for (let c = 0; c < 3; c++) o[c] = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * s + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * s2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * s3);
    return o; };
  const ribbonUniform = { value: 0 };
  // glowing ribbon rivers in the sky along each lane
  const rmat = (hex) => new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, uniforms: { uT: ribbonUniform, uC: { value: new THREE.Color(hex) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'uniform float uT; uniform vec3 uC; varying vec2 vUv; void main(){ float e=1.0-abs(vUv.y*2.0-1.0); float a=pow(e,1.6); float f=0.88+0.12*sin(vUv.x*180.0-uT*1.4); gl_FragColor=vec4(uC*(0.5+1.4*a)*f, a*0.85);}' });
  const N = 260, HW = 15;
  lanes.forEach((L, i) => { const pos = [], uv = [], idx = [];
    for (let k = 0; k <= N; k++) { const uu = L.ts[0] + k / N, a = crpos(L, uu), b = crpos(L, uu + 0.002); let tx = b[0] - a[0], tz = b[2] - a[2]; const ln = Math.hypot(tx, tz) || 1; tx /= ln; tz /= ln; const nx = -tz * HW, nz = tx * HW;
      pos.push(a[0] + nx, a[1] - 6, a[2] + nz, a[0] - nx, a[1] - 6, a[2] - nz); uv.push(k / N * 12, 0, k / N * 12, 1);
      if (k < N) { const q = k * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    const m = new THREE.Mesh(g, rmat(manifest.dragons[i % manifest.dragons.length].col)); m.frustumCulled = false; m.renderOrder = 5; scene.add(m); });
  _DW = { pos: (i, u) => crpos(lanes[i % 3], u), lanes, uH, dU, ribbonUniform };
  window.__DRAG = _DW;
  return _DW;
}
function tickDragons(t, u) {
  // chase window: mid-loop the pack closes on the lead dragon's orbit,
  // speed and flapping pick up, bellies glow brighter. Pure function of u.
  const cw = Math.min(Math.max((u - 0.55) / 0.13, 0), 1);
  const chase = cw > 0 && cw < 1 ? Math.sin(cw * Math.PI) ** 2 : 0;
  const cw2 = Math.min(Math.max((u - 0.70) / 0.04, 0), 1);
  const cw3 = Math.min(Math.max((0.825 - u) / 0.04, 0), 1);
  const gather = Math.sin(cw2 * Math.PI / 2) ** 2 * Math.sin(cw3 * Math.PI / 2) ** 2; // rise 0.70-0.74, full through Dragon Lanes hold (0.744-0.762), release by 0.825
  const TAU = Math.PI * 2;
  // v22: escort band (Irvan 12:39-12:40 PM: the flypast "looks like just one dragon",
  // the water beat "i don't see any dragons"). Each dragon rides the upper sky RELATIVE
  // TO THE BEAT CAMERA, a pure function of loop phase u, so routes stay identical every
  // loop. Band: 16-26 deg off the view axis, >=12.5 deg above the horizon, 400-470u out:
  // inside the relaxed camera rule, never central, in frame at portrait FOV.
  // v23aq: dragons fly fixed WORLD paths (closed Catmull-Rom loops), a pure function of loop phase u, independent of the camera and of the beats.
  const W = _dragonWorld();
  let di = 0;
  for (const d of dragons) {
    const i = di++;
    const p = W.pos(i, u), p2 = W.pos(i, u + 0.002);
    d.grp.position.set(p[0], p[1], p[2]);
    d.grp.lookAt(p2[0], p2[1], p2[2]);
    d.grp.rotateZ(Math.sin(TAU * 3 * u + d.ph) * 0.25);
    d.upd(TAU * 13 * u + chase * 4);
    d.grp.scale.setScalar(1.9);
    d.grp.children[0].material.emissiveIntensity = 0.55 + chase * 0.3;
    W.ribbonUniform.value = t;
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
  crowdPts.visible = false; // v23f: the glow dots read as spheres on a phone; real folk replace them
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
// v23q street-level beats: descend through a clear air column, walk a verified-clear lane, climb out again
const _beat = (title, note, a0, b0, look0, look1, walk, H = 62, lift = 0, back = 0) => {
  // v23az: columns look slightly down the lane (never top-down); figure beats pull back for breathing room
  const sh = (p, l) => { if (!back) return p; const dx = p[0] - l[0], dz = p[2] - l[2], L = Math.hypot(dx, dz) || 1; return [p[0] + dx / L * back, p[1] + back * 0.3, p[2] + dz / L * back]; };
  const a = sh(a0, look0), b = sh(b0, look1);
  const hl = (l, p, y) => [l[0], Math.max(l[1], y - 6), l[2]];
  return [
    { pos: [a[0], H, a[2]], look: hl(look0, a, H), hold: 0, fly: 2800, title, note },
    { pos: a, look: look0, hold: 0, fly: walk, title, note },
    { pos: b, look: look1, hold: 0, fly: 2800, title, note },
    { pos: [b[0], H, b[2]], look: hl(look1, b, H), hold: 0, fly: 4600, lift, title, note },
  ];
};
const KEYS = [
  { pos: [-1305.9, 520, -1459.1], look: [22.13, 60, 33.16], hold: 2600, fly: 5000, title: "Dusk Horizon", note: "Amber light dissolves into the first twilight shadows" },
  { pos: [-520, 130, -820], look: [22, 50, 33], hold: 1500, fly: 5200, title: "The High Descent", note: "Sliding down toward the glowing realm" },
  { pos: [-40, 60, 160], look: [22, 45, -60], hold: 1400, fly: 5000, lift: 55, title: "Twin Spire Dive", note: "Diving straight between the matched towers of light" },
  { pos: [30, 30, -350], look: [128, 30, -214], hold: 2200, fly: 4800, title: "Gate of Lanterns", note: "Under the great gate, into the festival" },
  { pos: [128, 66, -62], look: [185, 22, -140], hold: 2000, fly: 5000, lift: 42, title: "Star Market Life", note: "Vendors weave through drifting sky lanterns" },
  ..._beat("Market Street Walk", "Low and slow, people on both sides", [145, 2.3, -150], [215, 2.3, -150], [175, 4, -150], [245, 4, -150], 9000),
  ..._beat("Lantern Lane", "Stalls, vendors and lanterns along the lane", [148, 2.3, -184], [148, 2.3, -114], [148, 4, -150], [148, 4, -84], 8000, 62, 45),
  { pos: [-85, 42, 15], look: [-166, 45, 143], hold: 1600, fly: 5000, title: "Pagoda Orbit", note: "Curling around the tiered temple roof" },
  { pos: [-410, 50, -50], look: [-250, 40, 60], hold: 1600, fly: 5200, title: "Palace Mist", note: "Silhouettes of the hall pierce the low fog" },
  ..._beat("Giant of the Lanes", "A giant looms over the lane", [166, 17, 184], [166, 17, 210], [188.6, 10.8, 196.7], [188.6, 10.8, 196.7], 6500, 34, 0, 0),
  { pos: [214, 30, 70], look: [200, 12, -30], hold: 0, fly: 3200, title: "Festival Hall", note: "Through the open front into the hall, folk at tables and on their feet" },
  { pos: [158, 15, -75], look: [200, 6, -75], hold: 0, fly: 3500, title: "Festival Hall", note: "Through the open front into the hall, folk at tables and on their feet" },
  { pos: [190, 8, -79.5], look: [216, 5, -79.5], hold: 0, fly: 3500, title: "Festival Hall", note: "Through the open front into the hall, folk at tables and on their feet" },
  { pos: [201.8, 9.2, -79.5], look: [213, 1.5, -74], hold: 600, fly: 4500, title: "Festival Hall", note: "Through the open front into the hall, folk at tables and on their feet" },
  { pos: [201.8, 9.2, -70.5], look: [213, 1.5, -76], hold: 600, fly: 3000, title: "Festival Hall", note: "Through the open front into the hall, folk at tables and on their feet" },
  { pos: [190, 8, -70.5], look: [216, 5, -70.5], hold: 0, fly: 3000, title: "Festival Hall", note: "Through the open front into the hall, folk at tables and on their feet" },
  { pos: [160, 16, -75], look: [200, 6, -75], hold: 0, fly: 3200, lift: 0, title: "Festival Hall", note: "Through the open front into the hall, folk at tables and on their feet" },
  { pos: [150, 55, -60], look: [40, 40, 60], hold: 0, fly: 4000, title: "Festival Hall", note: "Up and over the rooftops" },
  { pos: [-160, 130, 260], look: [740, 14, 450], hold: 1500, fly: 5400, title: "Water Reveal", note: "Rising over the glowing canals for the reveal" },
  { pos: [370, 85, 300], look: [740, 15, 460], hold: 1600, fly: 5200, title: "Magic Harbor", note: "The beacon sweeps across shimmering water" },
  { pos: [350, 120, 150], look: [567, 150, 357], hold: 1500, fly: 5000, title: "Dragon Lanes", note: "A dragon's wake stirs the festival lights" },
  { pos: [100, 120, -190], look: [-88, 155, -66], hold: 1600, fly: 5200, title: "Crystal Awakening", note: "Facets ignite in cascades of electric light" },
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
      return { pos: (() => { const p = _mix3(k.pos, nx.pos, f); p[1] += (k.lift || 0) * Math.sin(Math.PI * f); return p; })(), look: _mix3(k.look, nx.look, f), keyIdx: raw < 0.7 ? i : (i + 1) % N };
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
    const k = KEYS[idx]; if (k.title === cardsAt._lt) return; cardsAt._lt = k.title;
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
  let ctx = null, master = null, running = false, chimeTimer = null, brightness = 0, legacyMode = false, trackSrc = null, trackBuf = null, trackLoading = false, trackFilt = null;
  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.0; master.connect(ctx.destination);
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 700; filt.Q.value = 0.4; filt.connect(master);
    Score._filt = filt;
    Score._legacy = () => {
    // v22m: phone speakers cannot reproduce 110-165 Hz, so the old pad was inaudible on a Galaxy A24;
      // add a 220-440 Hz layer and lift the pad gains (Irvan 2:05 PM: "i can't hear the sounds")
      for (const [f, g] of [[110, 0.08], [130.81, 0.06], [164.81, 0.05], [220, 0.07], [329.63, 0.05], [440, 0.03]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        o.detune.value = (Math.random() * 8) - 4;
        const og = ctx.createGain(); og.gain.value = g;
        o.connect(og); og.connect(filt); o.start();
      }
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
      const lg = ctx.createGain(); lg.gain.value = 90; lfo.connect(lg); lg.connect(filt.frequency); lfo.start();
    };
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
    g.gain.linearRampToValueAtTime(0.16 + brightness * 0.06, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 2.4);
    if (legacyMode) chimeTimer = setTimeout(chime, 2200 + Math.random() * 2200 - brightness * 700);
  }
  // v23c: composed loop (music-src/compose.py, original, AI-written) replaces the drone pad + random chimes.
  async function playTrack() {
    if (trackSrc || trackLoading || legacyMode) return;
    trackLoading = true;
    try {
      if (!trackBuf) {
        const a = document.createElement('audio');
        const url = (a.canPlayType('audio/ogg; codecs="vorbis"') ? './score.ogg' : './score.m4a') + '?v23c';
        const r = await fetch(url); if (!r.ok) throw new Error('score fetch ' + r.status);
        trackBuf = await ctx.decodeAudioData(await r.arrayBuffer());
      }
      if (!running) { trackLoading = false; return; }
      trackFilt = ctx.createBiquadFilter(); trackFilt.type = 'lowpass'; trackFilt.frequency.value = 3200 + brightness * 2800; trackFilt.Q.value = 0.3;
      const tg = ctx.createGain(); tg.gain.value = 1.0;
      trackSrc = ctx.createBufferSource(); trackSrc.buffer = trackBuf; trackSrc.loop = true;
      trackSrc.connect(trackFilt); trackFilt.connect(tg); tg.connect(master); trackSrc.start();
    } catch (err) {
      console.warn('score track failed, falling back to synth pad', err);
      legacyMode = true; if (Score._legacy) Score._legacy(); chime();
    }
    trackLoading = false;
  }
  return {
    _filt: null,
    start() {
      if (running) return;
      if (!ensure()) return;
      if (ctx.state === 'suspended') ctx.resume();
      running = true; Score.t0 = performance.now();
      playTrack();
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 2.0);
      document.getElementById('sound').textContent = '\u{1F50A}';
    },
    stop() {
      if (!running) return;
      running = false;
      master.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 0.6);
      if (chimeTimer) clearTimeout(chimeTimer);
      if (trackSrc) { try { trackSrc.stop(ctx.currentTime + 0.7); } catch (e) {} trackSrc = null; }
      document.getElementById('sound').textContent = '\u{1F507}';
    },
    nightfall(frac) {
      brightness = Math.max(0, Math.min(1, frac));
      if (this._filt) this._filt.frequency.setTargetAtTime(700 + brightness * 900, ctx ? ctx.currentTime : 0, 1.5);
      if (trackFilt && ctx) trackFilt.frequency.setTargetAtTime(3200 + brightness * 2800, ctx.currentTime, 1.5);
    },
    duck(f) {
      if (!running || !ctx || !master) return;
      master.gain.setTargetAtTime(0.9 * Math.max(0, Math.min(1, f)), ctx.currentTime, 0.35);
    },
    get running() { return running; },
    // v22m: Chrome on Android only counts pointerup/touchend/click as an audio-unlocking gesture
    // (pointerdown with touch does not), so the context stayed suspended while the icon said on.
    wake() { if (ctx && ctx.state !== 'running') ctx.resume(); },
    debug() { return { state: ctx ? ctx.state : 'none', track: trackSrc ? 'playing' : trackBuf ? 'loaded' : trackLoading ? 'loading' : 'none', legacy: legacyMode, running, gain: master ? +master.gain.value.toFixed(3) : null, t: ctx ? +ctx.currentTime.toFixed(2) : null }; },
  };
})();
let soundWanted = true;
$('sound').addEventListener('click', (e) => {
  e.stopPropagation();
  if (soundWanted && Score.running && (Score.debug().state !== 'running' || performance.now() - (Score.t0 || 0) < 1500)) { Score.wake(); return; } // v22m: a tap while the context is still suspended unlocks audio, it does not mute
  soundWanted = !soundWanted;
  if (soundWanted) { Score.start(); Score.wake(); } else Score.stop();
});
const unlock = () => { if (soundWanted && !Score.running) Score.start(); };
addEventListener('pointerdown', unlock, { once: true });
addEventListener('keydown', unlock, { once: true });
// v22m: every real gesture re-tries resume(); the first pointerdown on touch cannot unlock audio
for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) {
  addEventListener(ev, () => { if (soundWanted) { if (!Score.running) Score.start(); Score.wake(); } }, { passive: true });
}
window.__SCORE = Score;

// ---------------- stats chip ----------------
{
  const c = manifest.counts;
  $('stats').textContent = `${c.near.toLocaleString('en-US')} enchanted buildings · ${c.lanterns} sky lanterns · 3 dragons · 8 hot air balloons · 1 zeppelin · 1 flying ship · 3 wyvern riders · fireworks · carts, drum circles, picnics, a blacksmith, mule train, procession, lantern kids · invented, over real streets`;
}

// ---------------- folk (v23a): humans, elves, dwarves, giants on streets, balconies, rooftops ----------------
// Instanced, capped, original silhouettes. Kept clear of the camera path.
let folkTick = null;
const FOLK_COUNT = { human: 0, elf: 0, dwarf: 0, giant: 0 };
{
  const rs = (seed) => { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };
  const rnd = rs(2301);
  const col = (hex) => new THREE.Color(hex);
  // part builders return non-indexed geometry with vertex colors baked in
  const part = (geo, hex, x = 0, y = 0, z = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    let g = geo.index ? geo.toNonIndexed() : geo;
    g.scale(sx, sy, sz); g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z);
    const c = col(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const merge = (gs) => {
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'color']) {
      let len = 0; for (const g of gs) len += g.attributes[name].array.length;
      const arr = new Float32Array(len); let o = 0;
      for (const g of gs) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
      out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
    }
    { const pa = []; for (const g of gs) { const n = g.attributes.position.count, id = g.userData.pid || 0; for (let i = 0; i < n; i++) pa.push(id); } out.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(pa), 1)); }
    out.computeVertexNormals();
    return out;
  };
  const T = (id, g) => { g.userData.pid = id; return g; }; // part ids: 0 body, 1 left leg, 2 right leg, 3 left arm, 4 right arm (and held props), 5 head (and hair, ears, helmet)
  const cone = (r, h, s = 6) => new THREE.ConeGeometry(r, h, s);
  const cyl = (rt, rb, h, s = 6) => new THREE.CylinderGeometry(rt, rb, h, s);
  const ball = (r) => new THREE.SphereGeometry(r, 5, 3);
  const SKIN = [0xffd9b8, 0xf0bf8c, 0xd8a070, 0xb88058];
  // units: 1 = about 1.8 m human; the whole thing is scaled up so figures read at festival distances
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  // v23f: real humanoids: two legs, torso, two arms, head, per-race extras. 1 unit = ~1.8 m human.
  // v23ap: friendly lego face: big white eyes with pupils, curved smile. Gain >1 on vertex colour keeps eyes bright at night (pseudo-unlit).
  const glow = (g, k) => { const a = g.attributes.color.array; for (let i = 0; i < a.length; i++) a[i] *= k; return g; };
  const FACE = () => [
    T(5, glow(part(box(0.095, 0.1, 0.05), 0xffffff, -0.075, 1.71, 0.19), 2.6)), T(5, glow(part(box(0.095, 0.1, 0.05), 0xffffff, 0.075, 1.71, 0.19), 2.6)),
    T(5, part(box(0.04, 0.05, 0.06), 0x0a0806, -0.075, 1.7, 0.207)), T(5, part(box(0.04, 0.05, 0.06), 0x0a0806, 0.075, 1.7, 0.207)),
    T(5, glow(part(box(0.11, 0.026, 0.05), 0xd04848, 0, 1.59, 0.195), 2.2)), T(5, glow(part(box(0.032, 0.032, 0.05), 0xd04848, -0.075, 1.612, 0.195), 2.2)), T(5, glow(part(box(0.032, 0.032, 0.05), 0xd04848, 0.075, 1.612, 0.195), 2.2)),
    T(5, glow(part(box(0.03, 0.03, 0.05), 0xd04848, -0.1, 1.636, 0.19), 2.2)), T(5, glow(part(box(0.03, 0.03, 0.05), 0xd04848, 0.1, 1.636, 0.19), 2.2))];
  const man = (o, extra) => {
    const gs = [
      T(1, part(box(0.17, 0.82, 0.18), o.pants, -0.11, 0.41, 0)), T(2, part(box(0.17, 0.82, 0.18), o.pants, 0.11, 0.41, 0)),
      part(box(0.52, 0.66, 0.28), o.cloth, 0, 1.15, 0),
      T(3, part(box(0.13, 0.66, 0.15), o.cloth, -0.34, 1.12, 0, 0, 0.14)), T(4, part(box(0.13, 0.66, 0.15), o.cloth, 0.34, 1.12, 0, 0, -0.14)),
      T(5, part(ball(0.19), o.skin, 0, 1.68)),
      ...FACE(),
      ...(extra || [])];
    const g = merge(gs);
    if (o.sx !== 1 || o.sy !== 1) { g.scale(o.sx, o.sy, o.sx); g.computeVertexNormals(); }
    return g;
  };
  // v23af: per-variant costume parts so humans, elves and dwarves do not all read as blocky bodies
  const EXTRA = {
    human(v) { const k = v % 5, ex = [part(box(0.54, 0.07, 0.3), 0x2a1c14, 0, 0.88, 0), T(1, part(box(0.19, 0.14, 0.22), 0x2a1c14, -0.11, 0.07, 0.03)), T(2, part(box(0.19, 0.14, 0.22), 0x2a1c14, 0.11, 0.07, 0.03))];
      if (k === 0) ex.push(T(5, part(cyl(0.36, 0.36, 0.03, 8), 0xe0c070, 0, 1.82)), T(5, part(cyl(0.16, 0.18, 0.12, 8), 0xe0c070, 0, 1.9)), part(box(0.1, 0.62, 0.3), 0xf0d060, 0.12, 1.15, 0.01, 0, 0.5));
      if (k === 1) ex.push(T(5, part(box(0.42, 0.08, 0.42), 0xd03060, 0, 1.8, 0)), T(5, part(box(0.1, 0.3, 0.06), 0xd03060, 0, 1.62, -0.22)), part(box(0.56, 0.1, 0.3), 0xf0c040, 0, 0.92, 0));
      if (k === 2) ex.push(part(box(0.46, 0.5, 0.04), 0xf4f0e0, 0, 0.82, 0.16), T(5, part(box(0.4, 0.07, 0.42), 0x2f4a6a, 0, 1.8, 0)), T(5, part(box(0.4, 0.04, 0.22), 0x2f4a6a, 0, 1.78, 0.24)));
      if (k === 3) ex.push(part(box(0.58, 0.62, 0.05), 0x8e5cc4, 0, 1.1, -0.18), T(5, part(cone(0.26, 0.34, 5), 0xe0b030, 0, 1.92, 0)), T(5, part(cyl(0.3, 0.3, 0.03, 6), 0xe0b030, 0, 1.78, 0)));
      if (k === 4) ex.push(part(box(0.36, 0.42, 0.16), 0x8a5a2e, 0, 1.15, -0.22), T(4, part(box(0.04, 0.5, 0.04), 0x5a3a20, 0.4, 0.85, 0.12)), T(4, part(box(0.16, 0.2, 0.16), 0xffd070, 0.4, 0.55, 0.12)));
      return ex; },
    elf(v) { const k = v % 4, ex = [part(box(0.44, 0.08, 0.3), 0xf0d060, 0, 1.45, 0.02), T(1, part(box(0.18, 0.2, 0.2), 0x4a3a28, -0.11, 0.1, 0.02)), T(2, part(box(0.18, 0.2, 0.2), 0x4a3a28, 0.11, 0.1, 0.02))];
      if (k === 0) ex.push(part(box(0.62, 0.9, 0.05), 0x2f9e5a, 0, 0.95, -0.2), T(5, part(cone(0.22, 0.35, 5), 0x2f9e5a, 0, 1.92, -0.05)));
      if (k === 1) ex.push(T(4, part(box(0.05, 0.7, 0.05), 0xc08a3a, 0.4, 1.0, 0.18)), T(4, part(box(0.26, 0.3, 0.1), 0xe0a050, 0.4, 0.62, 0.18)));
      if (k === 2) ex.push(T(5, part(box(0.4, 0.04, 0.3), 0xf0f0ff, 0, 1.78, 0.02)), T(5, part(box(0.07, 0.07, 0.05), 0x70d0ff, 0, 1.8, 0.2)), part(box(0.1, 0.8, 0.04), 0x9b7fe0, 0.18, 0.55, 0.16));
      if (k === 3) ex.push(T(5, part(box(0.03, 0.3, 0.12), 0xe04040, 0.18, 1.95, -0.05, 0, 0.5)), part(box(0.06, 0.9, 0.06), 0x6a4a2a, -0.2, 1.1, -0.22, 0, 0.3));
      return ex; },
    dwarf(v) { const k = v % 5, ex = [part(box(0.5, 0.5, 0.05), 0x4a3426, 0, 0.9, 0.17), T(1, part(box(0.2, 0.15, 0.24), 0x2a2018, -0.11, 0.07, 0.03)), T(2, part(box(0.2, 0.15, 0.24), 0x2a2018, 0.11, 0.07, 0.03))];
      if (k === 0) ex.push(part(box(0.07, 0.5, 0.07), 0xc06a2a, -0.12, 1.1, 0.2), part(box(0.07, 0.5, 0.07), 0xc06a2a, 0.12, 1.1, 0.2));
      if (k === 1) ex.push(T(4, part(box(0.14, 0.16, 0.14), 0xe8d070, 0.42, 0.68, 0.12)), T(4, part(box(0.04, 0.06, 0.04), 0xf8f4e0, 0.42, 0.78, 0.12)));
      if (k === 2) ex.push(T(5, part(cyl(0.03, 0.03, 0.2, 5), 0x6a4a2a, 0.08, 1.58, 0.2, 1.4)), part(box(0.34, 0.4, 0.18), 0x7a5a32, 0, 1.2, -0.2), part(box(0.38, 0.1, 0.2), 0xc04a3a, 0, 1.48, -0.2));
      if (k === 3) ex.push(T(5, part(cone(0.1, 0.3, 5), 0xd8c8a0, -0.2, 1.9, 0, 0, 0.5)), T(5, part(cone(0.1, 0.3, 5), 0xd8c8a0, 0.2, 1.9, 0, 0, -0.5)));
      if (k === 4) ex.push(T(4, part(box(0.06, 0.6, 0.06), 0x6a4a2a, -0.4, 0.8, 0.1)), T(4, part(box(0.3, 0.22, 0.14), 0x8a8a96, -0.4, 1.12, 0.1)), part(box(0.5, 0.06, 0.3), 0xd8b040, 0, 1.3, 0));
      return ex; },
  };
  const BUILD = {
    human(v) {
      const cloth = [0xd9534f, 0x3a86c8, 0x5aa469, 0xe0a030, 0x8e5cc4][v % 5], pants = [0x3a3f58, 0x5a4a3a, 0x2f4a3a][v % 3], skin = SKIN[v % 4], hair = [0x2a1c14, 0x5a3a20, 0xc8a050, 0x1a1a1a][v % 4];
      return man({ cloth, pants, skin, sx: 1, sy: 1 }, [T(5, part(new THREE.SphereGeometry(0.2, 5, 2, 0, Math.PI * 2, 0, Math.PI / 2), hair, 0, 1.72)), ...EXTRA.human(v)]);
    },
    elf(v) {
      const cloth = [0x2f9e8f, 0x7fc86a, 0xc8d6ff, 0x9b7fe0, 0xe8e0a0][v % 5], skin = [0xf3ddc4, 0xe6c8a8, 0xd8b896][v % 3], hair = [0xf4ecc0, 0xc8c8d8, 0x6b4a2a, 0xf0a0c0][v % 4];
      return man({ cloth, pants: 0x4a5a48, skin, boots: 0x6a5a3a, sx: 0.78, sy: 1.22 }, [
        T(5, part(cone(0.07, 0.5, 4), skin, -0.3, 1.82, 0, 0, 1.25)), T(5, part(cone(0.07, 0.5, 4), skin, 0.3, 1.82, 0, 0, -1.25)), // long pointed ears
        part(box(0.42, 0.5, 0.06), cloth, 0, 0.78, -0.17), // long coat tail
        T(5, part(new THREE.SphereGeometry(0.2, 5, 2, 0, Math.PI * 2, 0, Math.PI / 2), hair, 0, 1.72)), T(5, part(box(0.1, 0.55, 0.08), hair, 0, 1.45, -0.2)), ...EXTRA.elf(v)]);
    },
    dwarf(v) {
      const cloth = [0x8a4b2a, 0x5a6b7a, 0xa85a2a, 0x6a3a3a][v % 4], beard = [0xc06a2a, 0x8a8a8a, 0x3a2a1a, 0xd8b060][v % 4];
      return man({ cloth, pants: 0x4a3a2a, skin: SKIN[(v + 1) % 4], boots: 0x2a2018, sx: 1.55, sy: 0.62 }, [
        part(box(0.34, 0.36, 0.1), beard, 0, 1.3, 0.16), // beard on the chest, below the smile
        T(5, part(new THREE.SphereGeometry(0.24, 5, 2, 0, Math.PI * 2, 0, Math.PI / 2), 0x7a7f88, 0, 1.72)), // helmet
        part(box(0.56, 0.08, 0.3), 0x2a2018, 0, 0.88, 0), // belt
        T(4, part(box(0.07, 0.8, 0.07), 0x6a4a2a, 0.5, 0.95, 0.1)), T(4, part(box(0.3, 0.2, 0.06), 0x9a9aa4, 0.5, 1.45, 0.1)), ...EXTRA.dwarf(v)]); // axe
    },
    giant(v) {
      // v23ad: three distinct giants: fur-cloaked redbeard, horned stone-blue brute, ochre drummer with topknot
      const k = v % 3;
      const skin = [0xc89a78, 0x7f95b8, 0xd8a050][k], cloth = [0xb03a3a, 0x2f7f86, 0xe0b030][k], pants = [0x3a4a6a, 0x4a3a58, 0x6a3a2a][k], hair = [0xd0561e, 0xe8e8f0, 0x1a1a1a][k], trim = [0xf0c040, 0xd8f0ff, 0xd04040][k];
      const fur = [0x5a4030, 0x8a8a96, 0x6a4a28][k];
      const ex = [
        part(box(0.6, 0.12, 0.34), 0x2a1c14, 0, 0.9, 0), part(box(0.14, 0.14, 0.04), trim, 0, 0.9, 0.18), // belt + bright buckle
        part(box(0.56, 0.2, 0.3), trim, 0, 1.36, 0), // bright chest band
        part(box(0.5, 0.34, 0.06), cloth, 0, 0.66, 0.15), part(box(0.5, 0.34, 0.06), cloth, 0, 0.66, -0.15), // tabard flaps
        T(3, part(ball(0.17), fur, -0.38, 1.46, 0)), T(4, part(ball(0.17), fur, 0.38, 1.46, 0)), // fur pauldrons
        T(3, part(box(0.16, 0.1, 0.18), trim, -0.34, 0.9, 0)), T(4, part(box(0.16, 0.1, 0.18), trim, 0.34, 0.9, 0)), // arm bands
                        T(5, part(box(0.26, 0.12, 0.1), hair, 0, 1.46, 0.1)), // short chin beard below the smile
        part(box(0.6, 0.26, 0.1), fur, 0, 1.3, -0.2) // back cloak
      ];
      if (k === 0) { ex.push(T(5, part(new THREE.SphereGeometry(0.23, 5, 2, 0, Math.PI * 2, 0, Math.PI / 2), hair, 0, 1.72)), T(4, part(box(0.14, 2.0, 0.14), 0x5a3f28, 0.62, 1.3, 0.15)), T(4, part(box(0.34, 0.5, 0.34), 0x5a3f28, 0.62, 2.35, 0.15)), T(4, part(cone(0.08, 0.25, 4), 0xc0c0c8, 0.62, 2.7, 0.15))); }
      if (k === 1) { ex.push(T(5, part(new THREE.SphereGeometry(0.23, 5, 2, 0, Math.PI * 2, 0, Math.PI / 2), 0x8a8a96, 0, 1.72)), T(5, part(cone(0.07, 0.4, 4), 0xf0e8d0, -0.24, 1.9, 0, 0, 0.9)), T(5, part(cone(0.07, 0.4, 4), 0xf0e8d0, 0.24, 1.9, 0, 0, -0.9)), T(4, part(box(0.05, 0.5, 0.05), 0x4a3a2a, 0.62, 0.9, 0.15)), T(4, part(box(0.26, 0.3, 0.26), 0xffd070, 0.62, 0.55, 0.15)), T(4, part(box(0.12, 2.6, 0.12), 0x4a4038, -0.6, 1.4, 0.15))); }
      if (k === 2) { ex.push(T(5, part(ball(0.1), hair, 0, 1.95)), T(5, part(box(0.3, 0.1, 0.3), hair, 0, 1.82)), T(4, part(box(0.4, 0.3, 0.4), 0xa04a28, 0.55, 0.78, 0.2)), T(4, part(box(0.44, 0.06, 0.44), 0xf0d8a0, 0.55, 0.95, 0.2))); }
      return man({ cloth, pants, skin, boots: 0x2a2018, sx: 1.25, sy: 1 }, ex);
    },
  };
  const SC = { human: 2.6, elf: 2.6, dwarf: 2.6, giant: 6.0 }; // world scale per unit (giants ~ 2.7x humans' height with bulk)
  const meshes = {}; const lamb = [];
  const folkU = { uTime: { value: 0 } };
  const PIV = { human: [0.82, 1.43, 0.34, 1.68, 1, 1], elf: [0.82, 1.43, 0.34, 1.68, 0.78, 1.22], dwarf: [0.82, 1.43, 0.34, 1.68, 1.55, 0.62], giant: [0.82, 1.43, 0.34, 1.68, 1.25, 1] };
  // v23o: skeletal-ish animation in the vertex shader: leg/arm swing about hip/shoulder, head turn, lean, back-and-forth walk. Per-instance phase and mode in aAct.
  const animate = (mat, race) => { const p = PIV[race], piv = new THREE.Vector4(p[0] * p[5], p[1] * p[5], p[2] * p[4], p[3] * p[5]);
    mat.onBeforeCompile = (sh) => { sh.uniforms.uTime = folkU.uTime; sh.uniforms.uPiv = { value: piv };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aPart; attribute vec2 aAct; uniform float uTime; uniform vec4 uPiv;\nvec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }')
        .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
  { float md = aAct.y, ph = aAct.x, tm = uTime; float sitDrop = 0.0; float legA = 0.0, armL = 0.0, armR = 0.0, hy = 0.0, lean = 0.0, walk = 0.0;
    if (md < 0.5) { armL = 0.07 * sin(tm * 1.3 + ph); armR = -armL; hy = 0.6 * sin(tm * 0.45 + ph * 2.0); lean = 0.02 * sin(tm * 1.1 + ph); }
    else if (md < 1.5) { float s = sin(tm * 2.4 + ph * 3.0); legA = 0.65 * s; armL = -0.55 * s; armR = 0.55 * s; hy = 0.12 * sin(tm * 0.9 + ph); walk = 1.0; }
    else if (md < 2.5) { armR = -1.15 + 0.5 * sin(tm * 4.0 + ph); armL = 0.12 * sin(tm * 1.5 + ph); hy = 0.4 * sin(tm * 1.1 + ph); lean = 0.05 * sin(tm * 2.0 + ph); }
    else if (md < 3.5) { armL = -0.9 + 0.35 * sin(tm * 3.0 + ph); armR = -0.9 + 0.35 * sin(tm * 3.0 + ph + 1.6); lean = 0.16 + 0.04 * sin(tm * 1.5 + ph); hy = 0.45 * sin(tm * 0.8 + ph); }
    else if (md < 4.5) { armR = -2.6 + 0.35 * sin(tm * 6.0 + ph); armL = 0.05; hy = 0.85 * sin(tm * 0.6 + ph); }
    else if (md < 5.5) { lean = 0.38; armL = -0.75 + 0.1 * sin(tm + ph); armR = -0.75 + 0.1 * sin(tm * 1.2 + ph); hy = 0.9 * sin(tm * 0.45 + ph); }
    else { legA = (md < 6.5) ? -1.5 : -0.2; armL = -0.45 + 0.1 * sin(tm * 0.8 + ph); armR = (ph > 4.6) ? (-2.5 + 0.4 * sin(tm * 5.0 + ph)) : (-0.55 + 0.45 * sin(tm * 1.7 + ph * 2.0)); hy = 0.3 * sin(tm * 0.5 + ph); lean = 0.04 * sin(tm + ph); sitDrop = (md < 6.5) ? 0.93 : 0.5; }
    float legB = (md < 5.5) ? -legA : legA;
    vec2 hp = vec2(uPiv.x, 0.0), sp = vec2(uPiv.y, 0.0);
    if (aPart > 0.5 && aPart < 2.5 && md > 6.5) transformed.y = uPiv.x + (transformed.y - uPiv.x) * 0.5;
    if (aPart > 0.5 && aPart < 1.5) transformed.yz = hp + rot2(transformed.yz - hp, legA);
    else if (aPart > 1.5 && aPart < 2.5) transformed.yz = hp + rot2(transformed.yz - hp, legB);
    else if (aPart > 2.5 && aPart < 3.5) transformed.yz = sp + rot2(transformed.yz - sp, armL);
    else if (aPart > 3.5 && aPart < 4.5) transformed.yz = sp + rot2(transformed.yz - sp, armR);
    else if (aPart > 4.5) { vec2 xz = transformed.zx; xz = rot2(xz - vec2(0.0), hy); transformed.zx = xz; }
    if (aPart < 0.5 || aPart > 2.5) transformed.yz = hp + rot2(transformed.yz - hp, lean);
    transformed.y -= uPiv.x * sitDrop;
    if (walk > 0.5) { float cv = cos(tm * 0.5 + ph); float sg = clamp(cv * 6.0, -1.0, 1.0); float yw = (1.0 - sg) * 1.5708; transformed.xz = rot2(transformed.xz, yw); transformed.z += 0.85 * sin(tm * 0.5 + ph); }
  }`); };
    return mat; };
  const caps = { human: [0, 0], elf: [0, 0], dwarf: [0, 0], giant: [0, 0] };
  // ---- spots (v23i): real surfaces only. Ground off walls and not under roofs, roofs flat with measured height, ledges flush to a wall.
  const camPts = []; { for (let i = 0; i < 160; i++) camPts.push(camAt(i * LOOP_MS / 160).pos); }
  const nearCam = (x, y, z, r) => { for (const p of camPts) { const dx = p[0] - x, dy = p[1] - y, dz = p[2] - z; if (dx * dx + dy * dy + dz * dz < r * r) return true; } return false; };
  const LIM = 820, CELL = 12;
  const ck = (x, z) => (Math.floor(x / CELL) + 300) * 1000 + (Math.floor(z / CELL) + 300);
  const wp = sec('walls_pos'), wi = sec('walls_idx'), rf = sec('roofs_pos'), ri = sec('roofs_idx');
  const segs = [], segCell = new Map();
  { const nt = wi.length / 3;
    for (let t = 0; t < nt; t++) {
      const v = [wi[t * 3] * 3, wi[t * 3 + 1] * 3, wi[t * 3 + 2] * 3];
      const cx = (wp[v[0]] + wp[v[1]] + wp[v[2]]) / 3, cz = (wp[v[0] + 2] + wp[v[1] + 2] + wp[v[2] + 2]) / 3;
      if (Math.abs(cx) > LIM || Math.abs(cz) > LIM) continue;
      let bi = 0, bj = 1, bd = -1;
      for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) { const d = Math.hypot(wp[v[i]] - wp[v[j]], wp[v[i] + 2] - wp[v[j] + 2]); if (d > bd) { bd = d; bi = i; bj = j; } }
      if (bd < 0.5) continue;
      const s = segs.length; segs.push([wp[v[bi]], wp[v[bi] + 2], wp[v[bj]], wp[v[bj] + 2]]);
      const n = Math.max(1, Math.ceil(bd / (CELL / 2))), seen = new Set();
      for (let k = 0; k <= n; k++) { const x = segs[s][0] + (segs[s][2] - segs[s][0]) * k / n, z = segs[s][1] + (segs[s][3] - segs[s][1]) * k / n; const key = ck(x, z); if (seen.has(key)) continue; seen.add(key); let a = segCell.get(key); if (!a) { a = []; segCell.set(key, a); } a.push(s); }
    } }
  const rtris = [], rtCell = new Map();
  { const nt = ri.length / 3;
    for (let t = 0; t < nt; t++) {
      const v = [ri[t * 3] * 3, ri[t * 3 + 1] * 3, ri[t * 3 + 2] * 3];
      const cx = (rf[v[0]] + rf[v[1]] + rf[v[2]]) / 3, cz = (rf[v[0] + 2] + rf[v[1] + 2] + rf[v[2] + 2]) / 3;
      if (Math.abs(cx) > LIM || Math.abs(cz) > LIM) continue;
      const tri = [rf[v[0]], rf[v[0] + 1], rf[v[0] + 2], rf[v[1]], rf[v[1] + 1], rf[v[1] + 2], rf[v[2]], rf[v[2] + 1], rf[v[2] + 2]];
      const id = rtris.length; rtris.push(tri);
      const x0 = Math.min(tri[0], tri[3], tri[6]), x1 = Math.max(tri[0], tri[3], tri[6]), z0 = Math.min(tri[2], tri[5], tri[8]), z1 = Math.max(tri[2], tri[5], tri[8]);
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) { const key = (gx + 300) * 1000 + (gz + 300); let a = rtCell.get(key); if (!a) { a = []; rtCell.set(key, a); } a.push(id); }
    } }
  // highest roof surface above (x,z), or -1; interpolates sloped roofs
  const roofAt = (x, z) => {
    const a = rtCell.get(ck(x, z)); if (!a) return -1; let best = -1;
    for (const id of a) { const T = rtris[id];
      const d = (T[5] - T[8]) * (T[0] - T[6]) + (T[6] - T[3]) * (T[2] - T[8]); if (Math.abs(d) < 1e-6) continue;
      const l1 = ((T[5] - T[8]) * (x - T[6]) + (T[6] - T[3]) * (z - T[8])) / d, l2 = ((T[8] - T[2]) * (x - T[6]) + (T[0] - T[6]) * (z - T[8])) / d, l3 = 1 - l1 - l2;
      if (l1 < -0.001 || l2 < -0.001 || l3 < -0.001) continue;
      const y = l1 * T[1] + l2 * T[4] + l3 * T[7]; if (y > best) best = y; }
    return best;
  };
  // nearest wall segment: distance and direction
  const wallNear = (x, z) => {
    let bd = 1e9, bx = 1, bz = 0; const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const a = segCell.get((gx + i + 300) * 1000 + (gz + j + 300)); if (!a) continue;
      for (const s of a) { const S = segs[s], dx = S[2] - S[0], dz = S[3] - S[1], l2 = dx * dx + dz * dz; let u = l2 > 0 ? ((x - S[0]) * dx + (z - S[1]) * dz) / l2 : 0; u = Math.max(0, Math.min(1, u));
        const d = Math.hypot(x - S[0] - dx * u, z - S[1] - dz * u); if (d < bd) { bd = d; const l = Math.sqrt(l2) || 1; bx = dx / l; bz = dz / l; } } }
    return [bd, bx, bz];
  };
  const ground = [], roofs = [], balc = [];
  { const rp = sec('roads_pos'); const n = rp.length / 3;
    for (let k = 0; k < 16000 && ground.length < 2600; k++) { const i = (rnd() * n) | 0; const x = rp[i * 3] + (rnd() - 0.5) * 5, z = rp[i * 3 + 2] + (rnd() - 0.5) * 5; if (Math.abs(x) > LIM || Math.abs(z) > LIM) continue;
      if (roofAt(x, z) >= 0) continue; const w = wallNear(x, z); if (w[0] < 2.4) continue;
      ground.push([x, 0.5, z, Math.atan2(w[1], w[2]) + (rnd() < 0.5 ? 0 : Math.PI), w[0]]); } }
  // rooftop terraces: a small flat slab sunk into a (mostly pitched) roof; the figure stands on the slab top, so nothing sinks or pokes
  const cornerMax = (x, z, h) => { let mx = -1, mn = 1e9; for (const [a, b] of [[-h, -h], [h, -h], [-h, h], [h, h], [0, 0]]) { const r = roofAt(x + a, z + b); if (r < 0) return null; if (r > mx) mx = r; if (r < mn) mn = r; } return [mx, mn]; };
  { for (const T of rtris) {
      const ux = T[3] - T[0], uy = T[4] - T[1], uz = T[5] - T[2], vx = T[6] - T[0], vy = T[7] - T[1], vz = T[8] - T[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, ln = Math.hypot(nx, ny, nz); if (ln < 1e-3 || Math.abs(ny) / ln < 0.93) continue;
      if (Math.max(T[1], T[4], T[7]) < 7 || Math.max(T[1], T[4], T[7]) > 95) continue;
      if (rnd() > 0.95) continue;
      const bs = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.25, 0.25], [0.25, 0.5, 0.25], [0.25, 0.25, 0.5]];
      const [b0, b1, b2] = bs[(rnd() * 4) | 0]; const x = b0 * T[0] + b1 * T[3] + b2 * T[6], z = b0 * T[2] + b1 * T[5] + b2 * T[8];
      if (wallNear(x, z)[0] < 3.0) continue;
      const cm = cornerMax(x, z, 1.9); const c2 = cm && cornerMax(x, z, 1.7); if (!cm || !c2) continue; cm[0] = Math.max(cm[0], c2[0]); cm[1] = Math.min(cm[1], c2[1]); if (cm[0] - cm[1] > 1.0) continue;
      if (roofs.some((q) => Math.hypot(q[0] - x, q[2] - z) < 6)) continue;
      const dd = cm[0] - cm[1]; roofs.push([x, cm[0] + (dd > 0.3 ? 0.1 : 0.03), z, rnd() * 6.283, dd > 0.3 ? dd + 0.6 : 0]); } }
  // balcony ledges: flush to a wall face, outward side open (no roof overhead, no other wall within 1.5 m)
  { const nt = wi.length / 3;
    for (let t = 0; t < nt && balc.length < 3500; t++) { if (rnd() > 0.2) continue;
      const a = wi[t * 3] * 3, b = wi[t * 3 + 1] * 3, c = wi[t * 3 + 2] * 3;
      const cx = (wp[a] + wp[b] + wp[c]) / 3, cy = (wp[a + 1] + wp[b + 1] + wp[c + 1]) / 3, cz = (wp[a + 2] + wp[b + 2] + wp[c + 2]) / 3;
      if (Math.abs(cx) > LIM || Math.abs(cz) > LIM || cy < 7 || cy > 70) continue;
      const ux = wp[b] - wp[a], uy = wp[b + 1] - wp[a + 1], uz = wp[b + 2] - wp[a + 2], vx = wp[c] - wp[a], vy = wp[c + 1] - wp[a + 1], vz = wp[c + 2] - wp[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const ln = Math.hypot(nx, ny, nz); if (ln < 1e-4) continue; nx /= ln; ny /= ln; nz /= ln;
      if (Math.abs(ny) > 0.08) continue;
      const hn = Math.hypot(nx, nz); nx /= hn; nz /= hn;
      const cA = roofAt(cx + nx * 1.3, cz + nz * 1.3) > cy + 1, cB = roofAt(cx - nx * 1.3, cz - nz * 1.3) > cy + 1;
      if (cA === cB) continue; if (cA) { nx = -nx; nz = -nz; }
      const fy = Math.round(cy / 3.4) * 3.4; if (Math.abs(fy - cy) > 1.2 || fy < 3.4) continue;
      const tx = -nz, tz = nx; let ok = true;
      for (const [o, s] of [[1.75, 0.8], [1.75, -0.8], [1.7, 0], [1.2, 0], [3.2, 2.1], [3.2, -2.1], [3.2, 0]]) { const px = cx + nx * o + tx * s, pz = cz + nz * o + tz * s; if (roofAt(px, pz) > fy - 0.5) { ok = false; break; } if (o > 1.1 && wallNear(px, pz)[0] < (o > 3 ? 1.5 : 1.2)) { ok = false; break; } }
      if (!ok) continue;
      const lx = cx + nx * 1.75, lz = cz + nz * 1.75, sgn = rnd() < 0.5 ? -1 : 1;
      balc.push([lx + tx * 0.8 * sgn, fy, lz + tz * 0.8 * sgn, Math.atan2(nx, nz), lx, lz]); } }
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // v23d/i: market clusters from the manifest get folk too, facing the cluster centre; only on valid ground
  { const cr = manifest.crowd; const extra = []; for (const p of cr) { const x = p[0] + (rnd() - 0.5) * 16, z = p[1] + (rnd() - 0.5) * 16; if (roofAt(x, z) >= 0) continue; const w = wallNear(x, z); if (w[0] < 2.4) continue; extra.push([x, 0.5, z, Math.atan2(p[0] - x, p[1] - z), w[0]]); } shuffle(extra); ground.unshift(...extra); }
  shuffle(roofs); shuffle(balc);
  { const seen = camPts.filter((p) => p[1] < 150); const dnear = (s) => { let d = 1e9; for (const p of seen) { const dx = p[0] - s[0], dz = p[2] - s[2], dy = p[1] - s[1]; const q = dx * dx + dz * dz + dy * dy * 0.3; if (q < d) d = q; } return d; };
    for (const pool of [ground, roofs, balc]) { const a = [], b = []; for (const s of pool) (dnear(s) < 230 * 230 ? a : b).push(s); pool.length = 0; pool.push(...a, ...b); } }
  // ---- plan: [race, where, count]
  const _sd = (x, z, a) => { const dx = a[2] - a[0], dz = a[3] - a[1]; const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz))); return Math.hypot(x - a[0] - dx * u, z - a[1] - dz * u); };
  // v23w: figures the close-up beats look at may sit near the camera route, but never within 3.5 m of the path line
  const _focusOk = (s) => (Math.hypot(s[0] + 61.3, s[2] - 56.4) < 14 && _sd(s[0], s[2], [-47.5, 66, -78, 56.4]) >= 7) || (Math.hypot(s[0] - 47.1, s[2] - 209.7) < 14 && _sd(s[0], s[2], [25.1, 209.7, 61.1, 209.7]) >= 7);
  const PLAN = [['human', 'g', 560], ['human', 'b', 340], ['human', 'r', 340], ['elf', 'r', 150], ['elf', 'b', 130], ['elf', 'g', 100],
    ['dwarf', 'g', 210], ['dwarf', 'b', 45], ['dwarf', 'r', 30], ['giant', 'g', 28]];
  const pools = { g: ground, b: balc, r: roofs }; const cur = { g: 0, b: 0, r: 0 };
  const items = []; // {race, v, x,y,z, yaw, ph, kind}
  for (const [race, w, cnt] of PLAN) {
    let made = 0, guard = 0; const pool = pools[w];
    while (made < cnt && cur[w] < pool.length && guard++ < 20000) {
      const s = pool[cur[w]++]; const clear = race === 'giant' ? 70 : 16;
      if (race === 'giant' && w === 'g' && s[4] < 6) continue;
      if (nearCam(s[0], s[1] + 3, s[2], clear) && !_focusOk(s)) continue; // v23v: keep the figures the close-up beats look at
      const yaw = s[3] + (rnd() - 0.5) * (w === 'g' ? 0.5 : 0.7);
      const rr = rnd(); let mode = 0;
      if (w === 'g') mode = race === 'giant' ? 0 : (s[4] >= 5.5 && rr < 0.35) ? 1 : rr < 0.6 ? 2 : rr < 0.8 ? 3 : 0;
      else if (w === 'r') mode = 6; else mode = 7;
      items.push({ race, v: (rnd() * 12) | 0, x: s[0], y: s[1], z: s[2], yaw, ph: rnd() * 6.28, w, lx: s[4], lz: s[5], ly: s[1], ledgeYaw: s[3], mode }); made++;
      FOLK_COUNT[race]++;
    }
  }
  // v23u: crowd along the street-level camera lanes (the normal pools skip anything near the camera route, which left these lanes empty)
  { const LANES = [[145, -150, 215, -150, 30], [148, -184, 148, -114, 30], [210.6, 196.7, 198.6, 196.7, 0], [-47.5, 66, -78, 56.4, 0]];
    for (const [ax, az, bx, bz, cnt] of LANES) { if (!cnt) continue; const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L, px = -uz, pz = ux;
      let made = 0, g = 0; while (made < cnt && g++ < 400) { const u = rnd() * L, side = rnd() < 0.5 ? -1 : 1, off = 2.6 + rnd() * 5.5; const x = ax + ux * u + px * off * side, z = az + uz * u + pz * off * side;
        if (roofAt(x, z) >= 0) continue; const wd = wallNear(x, z)[0]; if (wd < 2.0) continue;
        if (items.some((o) => Math.hypot(o.x - x, o.z - z) < 1.6)) continue;
        const rr = rnd(); let mode, yaw;
        if (rr < 0.4 && wd >= 5.5) { mode = 1; yaw = Math.atan2(ux, uz) + (rnd() < 0.5 ? 0 : Math.PI); }
        else if (rr < 0.7) { mode = 2; yaw = Math.atan2(-px * side, -pz * side) + (rnd() - 0.5) * 1.2; }
        else if (rr < 0.9) { mode = 3; yaw = Math.atan2(-px * side, -pz * side) + (rnd() - 0.5) * 0.5; }
        else { mode = 0; yaw = Math.atan2(ux, uz) + (rnd() - 0.5) * 3; }
        const q = rnd(), race = q < 0.7 ? 'human' : q < 0.82 ? 'elf' : 'dwarf';
        items.push({ race, v: (rnd() * 12) | 0, x, y: 0.5, z, yaw, ph: rnd() * 6.28, w: 'g', lx: wd, lz: 0, ly: 0.5, ledgeYaw: yaw, mode }); FOLK_COUNT[race]++; made++; } } }
  items.push({ race: 'giant', v: 4, x: 188.6, y: 0.5, z: 196.7, yaw: Math.PI / 2, ph: 1.3, w: 'g', lx: 10, lz: 0, ly: 0.5, ledgeYaw: Math.PI / 2, mode: 0 }); FOLK_COUNT.giant++; // v23w: the giant of the Giant of the Lanes beat
  // v23bg: keep ground folk out of the Festival Hall and the ground props (carts, drums, picnics, smith, mules, kids, procession)
  { const Z = [[212, -75, 22, 20], [224, -146, 9], [295, -163, 9], [150, -96, 9], [-173, 148, 9], [262, -172, 6], [150, -75, 6], [273, -129, 6], [146, -108, 6], [-150, 104, 6], [190, -170, 7], [151, -130, 11], [200, 170, 5], [-120, 106, 5], [162, -62, 15], [188.6, 196.7, 6]];
    const inZ = (x, z) => Z.some((q) => q.length === 4 ? (Math.abs(x - q[0]) < q[2] + 2 && Math.abs(z - q[1]) < q[3] + 2) : Math.hypot(x - q[0], z - q[1]) < q[2] + 1.5);
    let rm = 0; for (let i = items.length - 1; i >= 0; i--) { const o = items[i]; if (o.w === 'g' && o.race !== 'giant' || (o.w === 'g' && !(o.x === 188.6 && o.z === 196.7))) { if (inZ(o.x, o.z)) { FOLK_COUNT[o.race]--; items.splice(i, 1); rm++; } } } window.__PROPCLEAR = rm; }
  // ---- ledges (small balcony slabs)
  const ledgeSpots = items.filter((o) => o.w === 'b');
  const ledgeMat = new THREE.MeshLambertMaterial({ color: 0x6a5a4c, emissive: 0x2a2018, emissiveIntensity: 1.0 }); lamb.push(ledgeMat);
  const ledge = new THREE.InstancedMesh(new THREE.BoxGeometry(4.6, 0.5, 3.4), ledgeMat, Math.max(1, ledgeSpots.length));
  // ---- meshes per race x variant
  const dummy = new THREE.Object3D();
  const slots = {};
  for (const race of ['human', 'elf', 'dwarf', 'giant']) {
    const nv = race === 'giant' ? 3 : race === 'elf' ? 4 : 5;
    for (let v = 0; v < nv; v++) { slots[race + v] = []; }
  }
  for (const o of items) { const nv = o.race === 'giant' ? 3 : o.race === 'elf' ? 4 : 5; o.vi = o.v % nv; slots[o.race + o.vi].push(o); }
  const animated = [];
  for (const key in slots) {
    const list = slots[key]; if (!list.length) continue;
    const race = key.replace(/\d+$/, ''), v = +key.slice(race.length);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x3a2a20, emissiveIntensity: 1.0 }); lamb.push(mat); animate(mat, race);
    const geoF = BUILD[race](v); geoF.setAttribute('aAct', new THREE.InstancedBufferAttribute(new Float32Array(list.length * 2), 2)); const im = new THREE.InstancedMesh(geoF, mat, list.length); im.frustumCulled = false;
    list.forEach((o, i) => { geoF.attributes.aAct.setXY(i, o.ph, o.mode); o.im = im; o.i = i; const s = SC[race] * (o.w === 'g' ? 1 : 1.3); dummy.position.set(o.x, o.y, o.z); dummy.rotation.set(0, o.yaw, 0); dummy.scale.setScalar(s); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix); o.s = s; });
    im.instanceMatrix.needsUpdate = true; scene.add(im);
  }
  ledgeSpots.forEach((o, i) => { dummy.position.set(o.lx, o.y - 0.25, o.lz); dummy.rotation.set(0, o.ledgeYaw, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); ledge.setMatrixAt(i, dummy.matrix); });
  const terr = items.filter((o) => o.w === 'r' && o.lx > 0); // v23aj: wooden deck only where the roof is not flat; it runs down to the lowest roof corner so nothing floats
  const terrMat = new THREE.MeshLambertMaterial({ color: 0xa8794a, emissive: 0x3a2814, emissiveIntensity: 1.0 }); lamb.push(terrMat);
  const terrI = new THREE.InstancedMesh(new THREE.BoxGeometry(3.8, 1, 3.8).translate(0, -0.5, 0), terrMat, Math.max(1, terr.length));
  terr.forEach((o, i) => { dummy.position.set(o.x, o.y, o.z); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, o.lx, 1); dummy.updateMatrix(); terrI.setMatrixAt(i, dummy.matrix); });
  terrI.count = terr.length; terrI.instanceMatrix.needsUpdate = true; terrI.frustumCulled = false; scene.add(terrI);
  ledge.count = ledgeSpots.length; ledge.instanceMatrix.needsUpdate = true; ledge.frustumCulled = false; scene.add(ledge);
  // v23ae: picnic mood: balcony sitters get a chair, rooftop sitters get a blanket with a food basket
  { const seatF = items.filter((o) => o.mode === 7), picF = items.filter((o) => o.mode === 6);
    const chairGeo = merge([part(box(0.62, 0.07, 0.6), 0x8a5a2e, 0, 0.34, 0), part(box(0.62, 0.55, 0.07), 0x8a5a2e, 0, 0.62, -0.3), part(box(0.07, 0.34, 0.07), 0x5a3a1e, -0.26, 0.17, -0.24), part(box(0.07, 0.34, 0.07), 0x5a3a1e, 0.26, 0.17, -0.24), part(box(0.07, 0.34, 0.07), 0x5a3a1e, -0.26, 0.17, 0.24), part(box(0.07, 0.34, 0.07), 0x5a3a1e, 0.26, 0.17, 0.24)]);
    const chairMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a1c10, emissiveIntensity: 0.9 }); lamb.push(chairMat);
    const chairs = new THREE.InstancedMesh(chairGeo, chairMat, Math.max(1, seatF.length));
    seatF.forEach((o, i) => { const sc = SC[o.race] * 1.3; dummy.position.set(o.x, o.y, o.z); dummy.rotation.set(0, o.yaw, 0); dummy.scale.setScalar(sc); dummy.updateMatrix(); chairs.setMatrixAt(i, dummy.matrix); });
    chairs.count = seatF.length; chairs.instanceMatrix.needsUpdate = true; chairs.frustumCulled = false; scene.add(chairs);
    const blkGeo = merge([part(box(2.2, 0.04, 1.9), 0xffffff, 0, 0.02, 0.45), part(box(0.42, 0.22, 0.34), 0xd8a050, 0.55, 0.15, 0.7), part(box(0.2, 0.1, 0.2), 0xe05a4a, -0.35, 0.09, 0.9), part(box(0.18, 0.08, 0.18), 0x7ac860, -0.05, 0.08, 1.1)]);
    const blkMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a1c10, emissiveIntensity: 0.9 }); lamb.push(blkMat);
    const blk = new THREE.InstancedMesh(blkGeo, blkMat, Math.max(1, picF.length));
    const BC = [0xd04a4a, 0x4a7ad0, 0xe0b040, 0x4aa86a, 0xb060c0];
    picF.forEach((o, i) => { const sc = SC[o.race] * 1.3; dummy.position.set(o.x, o.y, o.z); dummy.rotation.set(0, o.yaw, 0); dummy.scale.setScalar(sc); dummy.updateMatrix(); blk.setMatrixAt(i, dummy.matrix); blk.setColorAt(i, new THREE.Color(BC[i % 5])); });
    blk.count = picF.length; blk.instanceMatrix.needsUpdate = true; if (blk.instanceColor) blk.instanceColor.needsUpdate = true; blk.frustumCulled = false; scene.add(blk);
    // retarget the balcony beat at a real seated balcony figure, with a camera line in open air (checked against roofs and walls)
    const ri = KEYS.findIndex((k) => k.title === 'Rooftop Glide');
    if (ri >= 0) { const cand = picF.filter((o) => o.y >= 8 && o.y <= 60).sort((p, q) => Math.hypot(p.x - 47, p.z - 205) - Math.hypot(q.x - 47, q.z - 205));
      outer: for (const o of cand.slice(0, 60)) for (let dir = 0; dir < 7; dir++) { const ang = o.yaw + [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5][dir], nx = Math.sin(ang), nz = Math.cos(ang), tx = -nz, tz = nx, cy = o.y + 12; let ok = true;
        const P = (u, d) => [o.x + nx * d + tx * u, o.z + nz * d + tz * u];
        for (const [u, d] of [[-14, 32], [-7, 32], [0, 32], [7, 32], [14, 32], [0, 24], [0, 16], [0, 8]]) { const [px, pz] = P(u, d); if (roofAt(px, pz) > cy - 3 || wallNear(px, pz)[0] < 3) { ok = false; break; } }
        if (!ok) continue; const a = P(-14, 32), b = P(14, 32), L = [o.x, o.y + 1.5, o.z];
        const set = (kk, p, y) => { kk.pos = [p[0], y, p[1]]; kk.look = L.slice(); };
        set(KEYS[ri], a, cy + 14); set(KEYS[ri + 1], a, cy); set(KEYS[ri + 2], b, cy); set(KEYS[ri + 3], b, cy + 14); window.__ROOF = { x: o.x, y: o.y, z: o.z, a, b, cy }; break outer; } }
    const bi = KEYS.findIndex((k) => k.title === 'Balcony Fly-by');
    if (bi >= 0) { const cand = seatF.filter((o) => o.y >= 6.5 && o.y <= 26).sort((p, q) => Math.hypot(p.x + 62, p.z - 60) - Math.hypot(q.x + 62, q.z - 60));
      for (const o of cand.slice(0, 40)) { const nx = Math.sin(o.ledgeYaw), nz = Math.cos(o.ledgeYaw), tx = -nz, tz = nx; let ok = true; const cy = o.y + 9;
        const P = (u, d) => [o.lx + nx * d + tx * u, o.lz + nz * d + tz * u];
        for (const [u, d] of [[-14, 30], [-7, 30], [0, 30], [7, 30], [14, 30], [0, 22], [0, 14], [0, 7]]) { const [px, pz] = P(u, d); if (roofAt(px, pz) > cy - 3 || wallNear(px, pz)[0] < 3) { ok = false; break; } }
        if (!ok) continue; const a = P(-14, 30), b = P(14, 30), L = [o.x, o.y + 1.4, o.z];
        const set = (k, p, y) => { k.pos = [p[0], y, p[1]]; k.look = L.slice(); };
        set(KEYS[bi], a, cy + 14); set(KEYS[bi + 1], a, cy); set(KEYS[bi + 2], b, cy); set(KEYS[bi + 3], b, cy + 14); window.__BALC = { x: o.x, y: o.y, z: o.z, a, b, cy }; break; } }
  }
  const touched = new Set(); let cursor = 0;
  folkTick = (t, phase) => {
    for (const m of lamb) m.emissiveIntensity = 0.55 + phase * 0.9;
    folkU.uTime.value = t;
    // sway a rotating slice of street folk each frame (cheap)
    const n = animated.length, step = Math.min(n, 160); touched.clear();
    for (let k = 0; k < step; k++) { const o = animated[(cursor + k) % n];
      dummy.position.set(o.x, o.y, o.z); dummy.rotation.set(0, o.yaw + Math.sin(t * 0.5 + o.ph) * 0.12, 0); dummy.scale.setScalar(o.s); dummy.updateMatrix();
      o.im.setMatrixAt(o.i, dummy.matrix); touched.add(o.im); }
    cursor = (cursor + step) % Math.max(1, n);
    for (const im of touched) im.instanceMatrix.needsUpdate = true;
  };
  // scripted clip test: every figure re-checked against the roof and wall data (same data the placement used, so it catches logic slips, not data errors)
  const clipTest = () => { const r = { ground: 0, roof: 0, balcony: 0, checked: items.length, bad: 0, badGiant: 0 };
    for (const o of items) { let bad = false;
      if (o.w === 'g') { const w = wallNear(o.x, o.z)[0]; bad = roofAt(o.x, o.z) >= 0 || w < (o.race === 'giant' ? 5.5 : o.race === 'dwarf' ? 2.0 : 1.6); if (bad) r.ground++; }
      else if (o.w === 'r') { const cm = cornerMax(o.x, o.z, 1.7); bad = !cm || cm[0] > o.y + 0.02 || o.y - cm[1] > Math.max(1.3, o.lx); if (bad) r.roof++; }
      else { const wd = wallNear(o.x, o.z)[0], ra = roofAt(o.x, o.z); bad = ra > o.y - 0.5 || wd < 1.0; if (bad) { r.balcony++; (r.dbg = r.dbg || []).length < 5 && r.dbg.push([+wd.toFixed(2), +ra.toFixed(1), +o.y.toFixed(1)]); } }
      if (bad) { r.bad++; if (o.race === 'giant') r.badGiant++; } }
    return r; };
  // route test: sample the whole camera loop; a sample is inside a building when a roof is above it, near a wall when <1.5 m from one
  const camTest = (step = 40) => { const out = { samples: 0, inside: 0, nearWall: 0, bad: [] }; let last = -1e9;
    for (let ms = 0; ms < LOOP_MS; ms += step) { const p = camAt(ms).pos; out.samples++;
      const r = roofAt(p[0], p[2]); const inside = r >= 0 && p[1] < r + 0.5; let near = false;
      if (!inside) for (let a = 0; a < 8 && !near; a++) { const rr = roofAt(p[0] + Math.cos(a * 0.785) * 1.8, p[2] + Math.sin(a * 0.785) * 1.8); if (rr >= 0 && p[1] < rr + 0.3) near = true; }
      if (inside) out.inside++; if (near) out.nearWall++;
      if ((inside || near) && ms - last > 400) { out.bad.push([Math.round(ms), +p[0].toFixed(0), +p[1].toFixed(0), +p[2].toFixed(0), inside ? 'inside' : 'wall']); last = ms; } }
    return out; };
  // QA helper: straight street lanes with clear air and folk beside them
  const lanes = (cx, cz, R, len = 70, clr = 3.2) => { const res = [], g = items.filter((o) => o.w === 'g');
    for (let x = cx - R; x <= cx + R; x += 10) for (let z = cz - R; z <= cz + R; z += 10) for (let h = 0; h < 12; h++) { const a = h * Math.PI / 6, dx = Math.cos(a), dz = Math.sin(a); let ok = true;
      for (let d = 0; d <= len && ok; d += 3) { const px = x + dx * d, pz = z + dz * d; if (roofAt(px, pz) >= 0 || wallNear(px, pz)[0] < clr || roofAt(px - dz * 2.5, pz + dx * 2.5) >= 0 || roofAt(px + dz * 2.5, pz - dx * 2.5) >= 0) ok = false; }
      if (!ok) continue; let sc = 0, L = 0, Rr = 0;
      for (const o of g) { const rx = o.x - x, rz = o.z - z, al = rx * dx + rz * dz, la = -rx * dz + rz * dx; if (al > 0 && al < len && Math.abs(la) < 9) { sc++; if (la > 0) L++; else Rr++; } }
      if (L >= 2 && Rr >= 2) res.push({ x, z, a: +a.toFixed(2), sc, L, R: Rr }); }
    return res.sort((p, q) => q.sc - p.sc).slice(0, 12); };
  const groundTest = () => { const r = { roofSitters: 0, maxGapRoof: 0, balcSitters: 0, standingRoofBalc: 0 }; for (const o of items) { if (o.w === 'r') { r.roofSitters++; if (o.mode < 6) r.standingRoofBalc++; for (const [a, b] of [[0, 0], [-2.5, -2], [2.5, -2], [-2.5, 3.5], [2.5, 3.5]]) { const c = Math.cos(o.yaw), sn = Math.sin(o.yaw); const px = o.x + a * c + b * sn, pz = o.z - a * sn + b * c; const g = roofAt(px, pz); if (!(o.lx > 0)) r.maxGapRoof = Math.max(r.maxGapRoof, Math.abs(o.y - g)); else r.decks = (r.decks || 0) + 1; } } else if (o.w === 'b') { r.balcSitters++; if (o.mode < 6) r.standingRoofBalc++; } } return r; };
  // v23au: sky life - hot air balloons and a zeppelin drifting on slow orbits above the city (original low-poly, ~1.5k tris each group, camera-safe by QA)
  { const cols = [0xe0503a, 0x3a9ae0, 0xe0b030, 0x4ac070, 0xb05ad0, 0xf0f0e0], skyG = new THREE.Group(); const mat = new THREE.MeshBasicMaterial({ vertexColors: true }); const fl = [];
    const bal = (c1, c2) => merge([part(new THREE.SphereGeometry(7, 10, 7), c1, 0, 10, 0, 0, 0, 1, 1.2, 1), part(cyl(7, 7, 2.2, 8), c2, 0, 10, 0, 0, 0, 1.02, 0.9, 1.02), part(cone(2.6, 4, 6), c1, 0, 1.2, 0, Math.PI), part(box(2.2, 1.6, 2.2), 0x6a4a2a, 0, -1.3, 0), part(box(0.2, 4, 0.2), 0x3a2a1a, 1.1, 0.8, 1.1), part(box(0.2, 4, 0.2), 0x3a2a1a, -1.1, 0.8, -1.1), part(box(0.5, 0.5, 0.5), 0xffe090, 0, -0.1, 0)]);
    for (let k = 0; k < 8; k++) { const m = new THREE.Mesh(bal(cols[k % 6], cols[(k + 2) % 6]), mat); m.frustumCulled = false; skyG.add(m); fl.push({ m, cx: -100 + (k % 4) * 140, cz: -150 + Math.floor(k / 4) * 330, r: 40 + (k % 3) * 25, y: 120 + (k % 3) * 18, w: 0.03682 * (1 + (k % 2)), ph: k * 0.9 }); }
    const zep = merge([part(new THREE.SphereGeometry(10, 12, 8), 0x6c6a86, 0, 0, 0, 0, 0, 4.2, 1, 1), part(box(30, 1.2, 0.4), 0xffc860, 0, -3.2, 9.6), part(box(30, 1.2, 0.4), 0xffc860, 0, -3.2, -9.6), part(box(14, 3, 3), 0xffd070, 0, -10.5, 0), part(box(8, 0.6, 14), 0xa04030, -34, 1.5, 0), part(box(8, 14, 0.6), 0xa04030, -34, 1.5, 0), part(box(3, 0.8, 24), 0x303a48, 8, -9.5, 0, 0, 0, 0.3, 1, 1), part(box(1, 6, 1), 0x606a78, 5, -8, 5), part(box(1, 6, 1), 0x606a78, 5, -8, -5)]);
    const zm = new THREE.Mesh(zep, mat); zm.frustumCulled = false; skyG.add(zm); scene.add(skyG);
    window.__SKYTICK = (t) => { for (const f of fl) { const a = f.ph + t * f.w; f.m.position.set(f.cx + Math.cos(a) * f.r, f.y + Math.sin(t * 0.2946 + f.ph) * 2, f.cz + Math.sin(a) * f.r); f.m.rotation.y = -a; }
      const za = t * 0.03682; zm.position.set(60 + Math.cos(za) * 260, 150 + Math.sin(t * 0.0737) * 3, 80 + Math.sin(za) * 260); zm.rotation.y = -za - Math.PI / 2; };
    window.__SKY = { fl, zm, G: skyG }; }
  // v23av: more sky life - fireworks, a flying ship, wyvern riders (all loop-clock driven, camera-checked)
  { const prev = window.__SKYTICK, basic = new THREE.MeshBasicMaterial({ vertexColors: true }), g2 = new THREE.Group(); scene.add(g2); const TAU = 6.2832, LP = 170.6;
    const ship = merge([part(box(26, 5, 8), 0x6a4a34, 0, 0, 0), part(box(8, 4, 8), 0x7a5a3a, -14, 3, 0), part(box(2, 24, 2), 0x4a3a2a, 0, 14, 0), part(box(0.6, 15, 18), 0xf0e0b8, 1.5, 15, 0), part(box(0.6, 9, 11), 0xf0c878, 1.5, 28, 0), part(box(10, 1.2, 0.6), 0xffd070, 0, 1.5, 4.2), part(box(10, 1.2, 0.6), 0xffd070, 0, 1.5, -4.2), part(new THREE.SphereGeometry(5, 8, 6), 0xd8503a, 0, 22, 0, 0, 0, 1.4, 0.6, 3)]);
    const sm = new THREE.Mesh(ship, basic); sm.frustumCulled = false; g2.add(sm);
    const wy = []; for (let k = 0; k < 3; k++) { const geo = merge([part(box(1.2, 1.2, 4), 0x5a7a4a, 0, 0, 0), part(box(0.7, 0.7, 1.6), 0x4a6a3a, 0, 0.4, 2.6), part(box(0.4, 0.4, 3), 0x4a6a3a, 0, 0, -3.4), part(box(5, 0.15, 2), 0x8aaa6a, 3.2, 0.3, 0.4), part(box(5, 0.15, 2), 0x8aaa6a, -3.2, 0.3, 0.4), part(box(0.6, 1.2, 0.6), [0xe0503a, 0x3a9ae0, 0xe0b030][k], 0, 1.2, 0.3), part(new THREE.SphereGeometry(0.4, 6, 5), 0xf0c8a0, 0, 2.1, 0.3)]); const m = new THREE.Mesh(geo, basic); m.frustumCulled = false; g2.add(m); wy.push(m); }
    const NF = 6, NP = 90, fp = new Float32Array(NF * NP * 3), fc = new Float32Array(NF * NP * 3), fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(fp, 3)); fg.setAttribute('color', new THREE.BufferAttribute(fc, 3));
    const dirs = []; for (let n = 0; n < NP; n++) { const a = Math.acos(1 - 2 * (n + 0.5) / NP), b = n * 2.39996; dirs.push([Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b)]); }
    const fwC = [[720, 215, 430], [640, 200, 330], [90, 190, 120], [-60, 185, 60], [320, 205, -40], [-250, 195, 200]], fwK = [[1, .4, .3], [.3, .8, 1], [1, .85, .3], [.4, 1, .5], [1, .4, .9], [.6, .5, 1]];
    const fm = new THREE.Points(fg, new THREE.PointsMaterial({ size: 2.6, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, map: (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 32; const x = cv.getContext('2d'), gr = x.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(cv); })() })); fm.frustumCulled = false; g2.add(fm);
    window.__SKYTICK = (t) => { prev(t); const sa = t * 0.03682 + 1;
      sm.position.set(40 + Math.cos(sa) * 300, 140 + Math.sin(t * 0.1474) * 3, 20 + Math.sin(sa) * 300); sm.rotation.y = -sa - Math.PI; sm.rotation.z = Math.sin(t * 0.2946) * 0.05;
      wy.forEach((m, k) => { const a = t * 0.03682 * 3 + k * 2.1, r = 110 + k * 35; m.position.set(-20 + Math.cos(a) * r, 105 + k * 8 + Math.sin(t * 0.2946 * 2 + k) * 4, 60 + Math.sin(a) * r); m.rotation.y = -a - Math.PI; m.rotation.z = Math.sin(t * 2.9 + k) * 0.12; });
      for (let f = 0; f < NF; f++) { const ph = ((t / 14 + f / NF * 2.3) % 1), life = Math.min(1, ph * 3.2), on = ph < 0.32, rad = 26 * (1 - Math.pow(1 - life, 2)), fade = on ? 1 - life * life : 0, c = fwC[f], k = fwK[f];
        for (let n = 0; n < NP; n++) { const o = (f * NP + n) * 3, d = dirs[n]; fp[o] = c[0] + d[0] * rad; fp[o + 1] = c[1] + d[1] * rad - life * life * 7; fp[o + 2] = c[2] + d[2] * rad; fc[o] = k[0] * fade * 0.7; fc[o + 1] = k[1] * fade * 0.7; fc[o + 2] = k[2] * fade * 0.7; } }
      fg.attributes.position.needsUpdate = true; fg.attributes.color.needsUpdate = true; };
    window.__SKY2 = { sm, wy, fwC }; }
  // v23aw: ground props - carts, drum circle, picnic blankets with shared food, lantern kids' lamps (static, merged, unlit)
  { const basic = new THREE.MeshBasicMaterial({ vertexColors: true }), P = [];
    const cart = (x, z, ry, col) => { const q = []; q.push(part(box(5, 1.4, 3), 0x6a4a2a, 0, 1.9, 0), part(box(5.2, 0.3, 3.2), 0x8a6a3a, 0, 2.7, 0), part(box(5.4, 0.35, 3.4), col, 0, 4.6, 0), part(box(0.25, 1.9, 0.25), 0x5a3a1a, -2.4, 3.6, -1.4), part(box(0.25, 1.9, 0.25), 0x5a3a1a, 2.4, 3.6, 1.4), part(box(0.25, 1.9, 0.25), 0x5a3a1a, -2.4, 3.6, 1.4), part(box(0.25, 1.9, 0.25), 0x5a3a1a, 2.4, 3.6, -1.4)); q.push(part(new THREE.SphereGeometry(0.6, 6, 5), 0xe84a3a, -1, 3.2, 0.5), part(new THREE.SphereGeometry(0.6, 6, 5), 0xf0b030, 0.2, 3.2, -0.4), part(new THREE.SphereGeometry(0.6, 6, 5), 0x8ac040, 1.3, 3.2, 0.6)); for (const [dx, dz] of [[-1.8, 1.7], [1.8, 1.7], [-1.8, -1.7], [1.8, -1.7]]) q.push(part(new THREE.CylinderGeometry(1, 1, 0.3, 10), 0x3a2a1a, dx, 1, dz, Math.PI / 2)); q.push(part(box(2, 0.3, 0.3), 0x5a3a1a, 4.5, 1.2, 0), part(box(1.8, 1.2, 3), 0x9a6a4a, 7, 1.8, 0), part(box(1.4, 0.9, 0.7), 0xe8d8b8, 8.1, 3.2, 0)); const m = merge(q); m.rotateY(ry); m.translate(x, 0.2, z); P.push(m); };
    const drums = (x, z) => { const q = []; for (let i = 0; i < 5; i++) { const a = i / 5 * TAUx, px = Math.cos(a) * 3.2, pz = Math.sin(a) * 3.2; q.push(part(new THREE.CylinderGeometry(0.8, 0.65, 1.5, 8), [0xc8503a, 0x3a7ac8, 0xe0a030, 0x5ab040, 0xa04ac0][i], px, 1.0, pz), part(new THREE.CylinderGeometry(0.8, 0.8, 0.15, 8), 0xf0e0c0, px, 1.8, pz), part(box(1, 1.1, 0.8), [0x3a8a6a, 0xc84a7a, 0x4a5ac8, 0xc89a3a, 0x7a4ac8][i], px * 1.6, 1.0, pz * 1.6), part(new THREE.SphereGeometry(0.55, 8, 6), 0xe8b890, px * 1.6, 2.1, pz * 1.6)); } q.push(part(new THREE.CylinderGeometry(0.6, 0.9, 0.5, 8), 0xffa030, 0, 0.5, 0), part(new THREE.SphereGeometry(0.7, 6, 5), 0xffd060, 0, 1.1, 0)); const m = merge(q); m.translate(x, 0.1, z); P.push(m); };
    const picnic = (x, z, ry) => { const q = [part(box(7, 0.12, 5), 0xd04a4a, 0, 0.2, 0), part(box(1.6, 0.12, 5), 0xf0e0c0, 0, 0.3, 0), part(new THREE.SphereGeometry(0.5, 6, 5), 0xf0c030, -1, 0.7, 0.5), part(new THREE.SphereGeometry(0.5, 6, 5), 0x8ac040, 1, 0.7, -0.6), part(box(0.9, 0.5, 0.9), 0xc8803a, 0, 0.6, 0)]; for (const [dx, dz, c] of [[-2.2, -1.6, 0x4a6ac8], [2.2, -1.2, 0xc86a9a], [-2.0, 1.8, 0x3aa87a], [2.4, 1.6, 0xe0a030]]) q.push(part(box(1, 1.1, 0.8), c, dx, 0.9, dz), part(new THREE.SphereGeometry(0.55, 8, 6), 0xe8b890, dx, 1.95, dz)); const m = merge(q); m.rotateY(ry); m.translate(x, 0.1, z); P.push(m); };
    const TAUx = 6.2832; cart(224, -146, 0, 0xd04a4a); cart(295, -163, Math.PI, 0x3a8ac8); cart(150, -96, Math.PI / 2, 0xe0a030); cart(-173, 148, 0.5, 0x8a4ac8);
    drums(262, -172); drums(150, -75); picnic(273, -129, 0.3); picnic(146, -108, 0.8); picnic(-150, 104, 0.2);
    const person = (q, x, z, c, h, lamp) => { q.push(part(box(0.9, 1.0, 0.7), c, x, 0.8 * h + 0.2, z), part(box(0.35, 0.9 * h, 0.35), 0x3a3a5a, x - 0.2, 0.45 * h, z), part(box(0.35, 0.9 * h, 0.35), 0x3a3a5a, x + 0.2, 0.45 * h, z), part(new THREE.SphereGeometry(0.5, 8, 6), 0xe8b890, x, 1.8 * h + 0.2, z), part(box(0.1, 0.1, 0.1), 0x222222, x - 0.17, 1.85 * h + 0.2, z + 0.45), part(box(0.1, 0.1, 0.1), 0x222222, x + 0.17, 1.85 * h + 0.2, z + 0.45), part(box(0.28, 0.07, 0.07), 0xd03040, x, 1.65 * h + 0.2, z + 0.47)); if (lamp) q.push(part(box(0.1, 0.9, 0.1), 0x5a3a1a, x + 0.6, 1.3 * h, z + 0.2), part(new THREE.SphereGeometry(0.4, 6, 5), 0xffc050, x + 0.6, 1.9 * h, z + 0.2)); };
    const smith = (x, z) => { const q = [part(box(3, 1.2, 1.6), 0x4a4a52, 0, 0.8, 0), part(box(1.2, 0.5, 0.8), 0x2a2a30, 1.8, 1.7, 0), part(box(2.4, 0.4, 1.4), 0xff7030, -0.2, 1.6, 0), part(new THREE.SphereGeometry(0.8, 6, 5), 0xffb040, -0.2, 2.1, 0), part(box(5, 0.3, 3), 0x7a5a3a, 0, 5, 0), part(box(0.3, 4.8, 0.3), 0x5a3a1a, -2.4, 2.6, -1.3), part(box(0.3, 4.8, 0.3), 0x5a3a1a, 2.4, 2.6, -1.3)]; person(q, -1.6, 2, 0x7a3a2a, 1.1, false); person(q, 2.8, 2.4, 0x3a6a8a, 0.8, false); const m = merge(q); m.translate(x, 0.1, z); P.push(m); };
    const mule = (q, x, z, c) => { q.push(part(box(3, 1.4, 1.1), c, x, 1.9, z), part(box(0.5, 1.6, 0.5), c, x + 1.7, 2.6, z), part(box(1, 0.7, 0.6), c, x + 2.2, 3.2, z), part(box(0.3, 1.4, 0.3), c, x - 1.1, 0.7, z - 0.4), part(box(0.3, 1.4, 0.3), c, x - 1.1, 0.7, z + 0.4), part(box(0.3, 1.4, 0.3), c, x + 1.1, 0.7, z - 0.4), part(box(0.3, 1.4, 0.3), c, x + 1.1, 0.7, z + 0.4), part(box(2.2, 0.9, 1.5), 0xd0503a, x, 2.9, z), part(box(1.2, 0.9, 1.2), 0xe8c050, x - 0.2, 3.7, z)); };
    const train = (x, z) => { const q = []; mule(q, 0, 0, 0x9a7a5a); mule(q, 5, 1.5, 0x7a6a5a); mule(q, 10, 0, 0xb0906a); person(q, 14, 1, 0x3a8a6a, 1, false); const m = merge(q); m.translate(x, 0.1, z); P.push(m); };
    const kids = (x, z) => { const q = []; for (let i = 0; i < 6; i++) person(q, Math.cos(i * 1.05) * 2.6, Math.sin(i * 1.05) * 2.6, [0xe0503a, 0x3a9ae0, 0xe0b030, 0x5ab040, 0xc04ac0, 0x40c0c0][i], 0.6, true); const m = merge(q); m.translate(x, 0.1, z); P.push(m); };
    const proc = (x, z) => { const q = []; for (let i = 0; i < 8; i++) person(q, i * 3, Math.sin(i * 0.9) * 1.2, [0xe0503a, 0x3a9ae0, 0xe0b030, 0x5ab040, 0xc04ac0, 0x40c0c0, 0xf08040, 0x8a6ae0][i], 1, i % 2 === 0); q.push(part(box(0.2, 7, 0.2), 0x5a3a1a, 10, 3.5, 3), part(box(0.2, 7, 0.2), 0x5a3a1a, 18, 3.5, 3), part(box(8.2, 2.5, 0.15), 0xd03a3a, 14, 6, 3), part(box(6, 0.8, 0.2), 0xf0c030, 14, 6, 3.1)); const m = merge(q); m.translate(x, 0.1, z); P.push(m); };
    smith(190, -170); train(144, -130); kids(200, 170); kids(-120, 106); proc(150, -62);
    { // v23bb: Festival Hall, open front facing west, people at tables and standing, wide interior beat
      const q = [], B = (w, h, d, c, x, y, z) => q.push(part(box(w, h, d), c, x, y, z));
      B(36, 0.4, 24, 0xa87444, 0, 0.2, -12); B(36, 12, 0.8, 0x7a5068, 0, 6, -24); B(0.8, 12, 24, 0x6a4a5e, -18, 6, -12); B(0.8, 12, 24, 0x6a4a5e, 18, 6, -12); B(40, 0.8, 28, 0x5a3a52, 0, 12.4, -12); B(40.4, 0.5, 28.4, 0xe0a030, 0, 11.9, -12); B(36, 1.6, 1, 0xd0503a, 0, 11, -0.4);
      for (const x of [-18, -9, 0, 9, 18]) B(1.2, 11, 1.2, 0xc8503a, x, 5.5, -0.4);
      B(6, 0.12, 24, 0xd04a4a, 0, 0.45, -12); B(14, 1, 5, 0xb08040, 0, 0.9, -21); B(11, 5, 0.3, 0xd03a3a, 0, 6.5, -23.5); B(8, 0.9, 0.35, 0xf0c030, 0, 6.5, -23.4);
      for (const x of [-13, -4.5, 4.5, 13]) for (const z of [-5, -13, -19]) { q.push(part(new THREE.SphereGeometry(0.8, 8, 6), 0xffcc66, x, 8.6, z)); B(0.08, 3, 0.08, 0x3a2a1a, x, 10.4, z); }
      // v23bi: dancing, smiling folk (animated meshes on the loop clock) instead of seated figures
      const hallG = new THREE.Group(); hallG.rotation.y = -Math.PI / 2; hallG.position.set(200, 0.1, -75); scene.add(hallG);
      const SKN = [0xe8b890, 0xd8a070, 0xf0c8a0, 0xb88058], HAIR = [0x2a1a10, 0x6a3a1a, 0xd0a040, 0x1a1a2a], COL = [0xe0503a, 0x3a9ae0, 0xe0b030, 0x5ab040, 0xc04ac0, 0x40c0c0, 0xf08040, 0x8a6ae0];
      const bodyGeo = COL.map((c, i) => merge([part(box(0.4, 0.95, 0.4), 0x2a2a4a, -0.25, 0.47, 0), part(box(0.4, 0.95, 0.4), 0x2a2a4a, 0.25, 0.47, 0), part(box(1.0, 1.3, 0.6), c, 0, 1.55, 0), part(new THREE.SphereGeometry(0.52, 8, 6), SKN[i % 4], 0, 2.6, 0), part(box(1.0, 0.35, 0.7), HAIR[i % 4], 0, 2.95, -0.05),
        part(box(0.2, 0.2, 0.08), 0xffffff, -0.2, 2.7, 0.47), part(box(0.2, 0.2, 0.08), 0xffffff, 0.2, 2.7, 0.47), part(box(0.1, 0.12, 0.06), 0x222222, -0.2, 2.7, 0.51), part(box(0.1, 0.12, 0.06), 0x222222, 0.2, 2.7, 0.51),
        part(box(0.42, 0.09, 0.06), 0xd8203a, 0, 2.36, 0.5), part(box(0.09, 0.12, 0.06), 0xd8203a, -0.25, 2.42, 0.5), part(box(0.09, 0.12, 0.06), 0xd8203a, 0.25, 2.42, 0.5), part(box(0.14, 0.08, 0.05), 0xf08080, -0.34, 2.52, 0.46), part(box(0.14, 0.08, 0.05), 0xf08080, 0.34, 2.52, 0.46)]));
      const armGeo = COL.map((c, i) => merge([part(box(0.28, 1.05, 0.28), c, 0, -0.52, 0), part(new THREE.SphereGeometry(0.2, 6, 5), SKN[i % 4], 0, -1.12, 0)]));
      const dancers = [];
      const mk = (i, x, y, z, ry, mode, ph, extra) => { const g = new THREE.Group(); g.add(new THREE.Mesh(bodyGeo[i % 8], basic)); const Lm = new THREE.Mesh(armGeo[i % 8], basic), Rm = new THREE.Mesh(armGeo[i % 8], basic); Lm.position.set(-0.62, 2.0, 0); Rm.position.set(0.62, 2.0, 0); g.add(Lm, Rm); g.position.set(x, y, z); g.rotation.y = ry; g.scale.setScalar(0.62); hallG.add(g); dancers.push(Object.assign({ g, L: Lm, R: Rm, mode, ph, x, y, z, ry }, extra || {})); };
      let di = 0; for (const [cx, cz, dir] of [[-8, -11, 1], [8, -11, -1]]) for (let k = 0; k < 6; k++) mk(di++, 0, 0.4, 0, 0, 'c', k * 1.1, { cx, cz, Rad: 3.6, th0: k / 6 * 6.2832, dir });
      for (let k = 0; k < 6; k++) mk(di++, -15 + k * 6, 0.4, -4.5, 0, 'j', k * 0.9);
      for (const x of [-4, 0, 4]) mk(di++, x, 1.4, -21, 0, 's', x);
      q.push(part(new THREE.CylinderGeometry(0.8, 0.65, 1.4, 8), 0xc8503a, 7, 2.2, -20), part(new THREE.CylinderGeometry(0.8, 0.65, 1.4, 8), 0x3a7ac8, -7, 2.2, -20));
      { const prev2 = window.__SKYTICK, W = 6.2832 / 170.6, bw = W * 100, aw = W * 50, ow = W * 6;
        window.__SKYTICK = (t) => { prev2(t); for (const d of dancers) { const s = Math.sin(bw * t + d.ph), a = Math.sin(aw * t + d.ph * 1.7);
          if (d.mode === 'c') { const th = d.th0 + d.dir * ow * t; d.g.position.set(d.cx + Math.cos(th) * d.Rad, d.y + Math.abs(s) * 0.45, d.cz + Math.sin(th) * d.Rad); d.g.rotation.y = Math.atan2(-Math.cos(th), -Math.sin(th)); }
          else if (d.mode === 'j') { d.g.position.y = d.y + Math.abs(s) * 0.8; d.g.rotation.y = d.ry + Math.sin(aw * t * 0.5 + d.ph) * 0.35; }
          else d.g.position.y = d.y + Math.abs(s) * 0.15;
          const up = d.mode === 's' ? 1.0 : 2.5; d.L.rotation.z = -(up + 0.55 * a); d.R.rotation.z = up - 0.55 * a; } }; window.__HALLD = dancers; }
      const m = merge(q); m.rotateY(-Math.PI / 2); m.translate(200, 0.1, -75); P.push(m); }
    const pm = new THREE.Mesh(merge(P), basic); pm.frustumCulled = false; scene.add(pm); window.__PROPS = pm; }
  // v23bd: drone rule tests over the whole loop. wallTest: clearance to every roof/wall (2.5 m and 4 m rings). hallTest: the Festival Hall shell (front pillars, lintel, side walls, back wall, roof).
  const wallTest = (step = 20) => { const out = { samples: 0, inside: 0, tight: 0, bad: [] };
    for (let ms = 0; ms < LOOP_MS; ms += step) { const p = camAt(ms).pos; out.samples++; const r0 = roofAt(p[0], p[2]); let bad = r0 >= 0 && p[1] < r0 + 0.5; let tight = false;
      if (bad) out.inside++; else for (const rad of [2.5, 4]) for (let a = 0; a < 12 && !tight; a++) { const rr = roofAt(p[0] + Math.cos(a * 0.5236) * rad, p[2] + Math.sin(a * 0.5236) * rad); if (rr >= 0 && p[1] < rr + 0.3) tight = true; }
      if (tight) out.tight++; if ((bad || tight) && out.bad.length < 8) out.bad.push([ms, +p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(1)]); }
    return out; };
  const hallTest = (step = 20) => { const out = { samples: 0, inHall: 0, bad: 0, ex: [] };
    for (let ms = 0; ms < LOOP_MS; ms += step) { const p = camAt(ms).pos, x = p[0], y = p[1], z = p[2]; out.samples++; let bad = false;
      if (x > 198.6 && x < 225.4 && z > -94.4 && z < -55.6 && y < 14) { out.inHall++;
        if (y > 11.4 || y < 0.8) bad = true; // roof slab 11.4-13.4 (with overhang), floor
        if (z < -91.6 || z > -58.4) bad = true; // side walls
        if (x > 222.6) bad = true; // back wall
        if (x < 202 && [-93, -84, -75, -66, -57].some((pz) => Math.abs(z - pz) < 1.6)) bad = true; // front pillars
        if (x < 202 && y > 9.4) bad = true; } // lintel
      if (bad) { out.bad++; if (out.ex.length < 5) out.ex.push([ms, +x.toFixed(1), +y.toFixed(1), +z.toFixed(1)]); } }
    return out; };
  window.__FOLK = { wallTest, hallTest, groundTest, camAt, LOOP_MS, KEYS, lanes, items, roofAt, wallNear, clipTest, camTest, counts: FOLK_COUNT, pools: { ground: ground.length, roofs: roofs.length, balconies: balc.length }, total: items.length };
}
function tickFolk(t, phase) { if (folkTick) folkTick(t, phase); }
{
  const c = FOLK_COUNT; const tot = c.human + c.elf + c.dwarf + c.giant;
  $('stats').textContent = `${manifest.counts.near.toLocaleString('en-US')} enchanted buildings · ${tot.toLocaleString('en-US')} folk (humans, elves, dwarves, giants) · ${manifest.counts.lanterns} sky lanterns · 3 dragons · 8 hot air balloons · 1 zeppelin · 1 flying ship · 3 wyvern riders · fireworks · carts, drum circles, picnics, a blacksmith, mule train, procession, lantern kids · invented, over real streets`;
}

// ---------------- run ----------------
bar.style.width = '100%';
clearTimeout(stallTimer);

{ const q = new URLSearchParams(location.search).get('cam'); if (q) window.__CAMOVR = q.split(',').map(Number); }
window.__SC = { scene, camera, THREE };
const PIN_U = (() => { const p = new URLSearchParams(location.search).get('u'); return p === null ? -1 : parseFloat(p); })();
let start = null;
let firstFrame = true;
const clock = new THREE.Clock();
// v23bd: tap anywhere to pause or resume the tour (for screenshots); virtual clock freezes camera, sky and folk
let paused = false, vt = 0, lastReal = 0;
window.__PAUSE = (v) => { paused = v === undefined ? !paused : !!v; const el = document.getElementById('pause'); if (el) { el.classList.toggle('on', paused); el.classList.toggle('flash', !paused); if (!paused) setTimeout(() => el.classList.remove('flash'), 900); } return paused; };
{ let d = null; const down = (e) => { if (e.target.closest && e.target.closest('#sound')) { d = null; return; } d = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  const up = (e) => { if (!d) return; const m = Math.hypot(e.clientX - d.x, e.clientY - d.y), dt = performance.now() - d.t; d = null; if (m < 12 && dt < 500) window.__PAUSE(); };
  addEventListener('pointerdown', down, { passive: true }); addEventListener('pointerup', up, { passive: true });
  addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); window.__PAUSE(); } }); }

function frame() {
  requestAnimationFrame(frame);
  const real = clock.getElapsedTime(); if (!paused) vt += real - lastReal; lastReal = real; const t = vt;
  if (start === null) start = t;
  const ms = (PIN_U >= 0 ? PIN_U * LOOP_MS : (t - start) * 1000 + 400);
  const u = (ms % LOOP_MS) / LOOP_MS;
  window.__U = u;

  const { pos, look } = camAt(ms);
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  if (window.__CAMOVR) { const c = window.__CAMOVR; camera.position.set(c[0], c[1], c[2]); camera.lookAt(c[3], c[4], c[5]); } // QA only

  const phase = phaseAt(u);
  skyMat.uniforms.uPhase.value = phase;
  skyMat.uniforms.uTime.value = t;
  if (window.__SKYTICK) window.__SKYTICK(ms / 1000 * 170600 / LOOP_MS);
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
  tickFolk(t, phase);
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
