// PDF 3D 뷰어 (Android) - viewer UI on three.js
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { loadAnyBytes } from "./u3d.js";
import logoUrl from "../logo.png";

const $ = (id) => document.getElementById(id);
const SEL_COLOR = new THREE.Color("#ff6a00");
const APP_VERSION = "1.0";

// ------------------------------------------------------------------ three.js setup
const view = $("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.localClippingEnabled = true;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(35, 1, 0.001, 1000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
for (const c of [persp, ortho]) c.up.set(0, 0, 1);
let camera = persp;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a6, 1.6));
const headLight = new THREE.DirectionalLight(0xffffff, 1.5);
headLight.position.set(0.3, 0.6, 1);
persp.add(headLight);
const headLight2 = headLight.clone();
ortho.add(headLight2);
scene.add(persp, ortho);

let controls = makeControls(camera);
function makeControls(cam) {
  const c = new OrbitControls(cam, renderer.domElement);
  c.enableDamping = true;
  c.dampingFactor = 0.12;
  c.rotateSpeed = 0.9;
  c.zoomSpeed = 1.1;
  c.screenSpacePanning = true;
  c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  c.addEventListener("change", requestRender);
  return c;
}

const modelGroup = new THREE.Group();
scene.add(modelGroup);
const overlayGroup = new THREE.Group(); // measurement markers
scene.add(overlayGroup);

let needsRender = true;
function requestRender() { needsRender = true; }
function loop() {
  requestAnimationFrame(loop);
  const moved = controls.update();
  if (needsRender || moved) {
    needsRender = false;
    renderer.render(scene, camera);
  }
}
function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  persp.aspect = w / h;
  persp.updateProjectionMatrix();
  updateOrthoFrustum();
  requestRender();
}
function updateOrthoFrustum() {
  const w = view.clientWidth || 1, h = view.clientHeight || 1;
  const half = orthoHalf;
  ortho.left = (-half * w) / h; ortho.right = (half * w) / h;
  ortho.top = half; ortho.bottom = -half;
  ortho.updateProjectionMatrix();
}
let orthoHalf = 1;
new ResizeObserver(resize).observe(view);
window.addEventListener("resize", resize);
loop();

// ------------------------------------------------------------------ state
let parts = [];          // {part, mesh, mat, edges, visible, alpha, row, size}
let selected = new Set();
let multiMode = false;
let displayMode = 0;     // 0 shaded, 1 shaded+edges, 2 wire, 3 xray
let unitMode = "auto";
let unitToMm = 1000;
let clipPlane = null;
let clipAxis = -1, clipFlip = false;
let measureMode = false, measurePts = [];
let modelBox = new THREE.Box3();
let currentName = "";
let darkBg = false;
const selMat = new THREE.MeshPhongMaterial({ color: SEL_COLOR, side: THREE.DoubleSide, shininess: 30,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

// ------------------------------------------------------------------ UI helpers
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function showLoading(on, msg) {
  $("loading").classList.toggle("show", on);
  if (msg) $("loadmsg").textContent = msg;
}
function fmt(n, d = 1) { return n.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function shortName(path) {
  const seg = path.split("/").pop() || path;
  return seg;
}

// ------------------------------------------------------------------ open file
const fileInput = $("file");
$("btnOpen").onclick = $("btnOpen2").onclick = () => { fileInput.value = ""; fileInput.click(); };
fileInput.onchange = async () => {
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  openBytes(buf, f.name);
};

// Android: a file was handed to the app ("open with")
window.openFromAndroid = function (name) {
  try {
    const b64 = window.AndroidBridge.takePendingFile();
    if (!b64) return;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    openBytes(bytes, name || "도면.pdf");
  } catch (e) {
    toast("파일을 열 수 없습니다: " + e.message, 4000);
  }
};

function openBytes(bytes, name) {
  showLoading(true, "3D 모델을 읽는 중…");
  // let the spinner paint before the (synchronous) decode
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const { scenes, msgs } = loadAnyBytes(bytes);
      if (!scenes.length) throw new Error(msgs.join("\n") || "표시할 3D 모델이 없습니다.");
      const all = [];
      scenes.forEach((sc, i) => sc.parts.forEach((p) => {
        if (scenes.length > 1) p.path = `모델${i + 1}/${p.path}`;
        all.push(p);
      }));
      buildScene(all);
      currentName = name;
      $("title").textContent = name.replace(/\.(pdf|u3d)$/i, "");
      $("welcome").style.display = "none";
      const warn = [...new Set(scenes.flatMap((s) => s.warnings).concat(msgs))];
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      toast(warn.length ? warn.join(" / ") : `부품 ${parts.length}개를 불러왔습니다 (${dt}초)`, warn.length ? 5000 : 2600);
    } catch (e) {
      toast("열 수 없습니다: " + (e.message || e), 5000);
    } finally {
      showLoading(false);
    }
  }, 30);
}

// ------------------------------------------------------------------ scene build
function disposeScene() {
  for (const p of parts) {
    p.mesh.geometry.dispose();
    p.mat.dispose();
    if (p.edges) { p.edges.geometry.dispose(); }
  }
  modelGroup.clear();
  clearMeasure();
  parts = [];
  selected.clear();
}

function buildScene(list) {
  disposeScene();
  setClipAxis(-1);
  let tris = 0;
  for (const part of list) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(part.vertices, 3));
    if (part.normals) g.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3));
    else g.computeVertexNormals();
    // per-vertex colour from per-face RGBA
    const col = new Float32Array(part.nf * 9);
    let alpha = 0;
    for (let f = 0; f < part.nf; f++) {
      const r = part.colors[f * 4], gg = part.colors[f * 4 + 1], b = part.colors[f * 4 + 2];
      alpha += part.colors[f * 4 + 3];
      for (let k = 0; k < 3; k++) col.set([r, gg, b], f * 9 + k * 3);
    }
    alpha /= Math.max(part.nf, 1);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, shininess: 25,
      specular: 0x222222, flatShading: !part.normals, transparent: alpha < 0.99, opacity: alpha < 0.99 ? alpha : 1,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const mesh = new THREE.Mesh(g, mat);
    const idx = parts.length;
    mesh.userData.idx = idx;
    modelGroup.add(mesh);
    const bb = g.boundingBox;
    parts.push({ part, mesh, mat, edges: null, visible: true, alpha, row: null,
      color: new THREE.Color(part.colors[0], part.colors[1], part.colors[2]),
      size: [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z] });
    tris += part.nf;
  }
  modelBox = new THREE.Box3().setFromObject(modelGroup);
  updateUnits();
  buildTree();
  $("partcount").textContent = `${parts.length}개 · 삼각형 ${tris.toLocaleString("ko-KR")}`;
  applyDisplayMode();
  setView("iso");
  updateSelUI();
}

function updateUnits() {
  const s = modelBox.getSize(new THREE.Vector3());
  const ext = Math.max(s.x, s.y, s.z);
  let mode = unitMode;
  if (mode === "auto") mode = ext < 20 ? "m" : "mm";
  unitToMm = { m: 1000, mm: 1, in: 25.4 }[mode];
  document.querySelectorAll("#unitchips button").forEach((b) => b.classList.toggle("on", b.dataset.u === unitMode));
  return { ext, mode };
}

// ------------------------------------------------------------------ views
function visibleBox() {
  const box = new THREE.Box3();
  for (const p of parts) if (p.visible) box.expandByObject(p.mesh);
  return box.isEmpty() ? modelBox.clone() : box;
}
const DIRS = {
  iso: [[1, -1, 1], [0, 0, 1]], front: [[0, -1, 0], [0, 0, 1]], back: [[0, 1, 0], [0, 0, 1]],
  top: [[0, 0, 1], [0, 1, 0]], bottom: [[0, 0, -1], [0, -1, 0]], left: [[-1, 0, 0], [0, 0, 1]], right: [[1, 0, 0], [0, 0, 1]],
};
function setView(name, box) {
  if (!parts.length) return;
  const [d, up] = DIRS[name] || DIRS.iso;
  const dir = new THREE.Vector3(...d).normalize();
  for (const c of [persp, ortho]) c.up.set(...up);
  frame(box || visibleBox(), dir);
}
function frame(box, dir) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 1e-6);
  if (!dir) dir = camera.position.clone().sub(controls.target).normalize();
  const fov = THREE.MathUtils.degToRad(persp.fov);
  const aspect = persp.aspect || 1;
  const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect));
  const dist = (r / Math.sin(fit / 2)) * 1.08;
  const target = sphere.center;
  persp.position.copy(target).addScaledVector(dir, dist);
  persp.near = dist / 200; persp.far = dist * 50;
  persp.updateProjectionMatrix();
  ortho.position.copy(target).addScaledVector(dir, dist);
  orthoHalf = r * 1.08 / Math.min(1, aspect);
  ortho.near = -dist * 50; ortho.far = dist * 50;
  ortho.zoom = 1;
  updateOrthoFrustum();
  controls.target.copy(target);
  for (const c of [persp, ortho]) c.lookAt(target);
  // drop any leftover rotate/pan momentum so the new view stays put
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
  requestRender();
}
function toggleProjection() {
  const was = camera;
  camera = camera === persp ? ortho : persp;
  camera.position.copy(was.position);
  camera.up.copy(was.up);
  const target = controls.target.clone();
  controls.dispose();
  controls = makeControls(camera);
  controls.target.copy(target);
  if (camera === ortho) {
    const dist = was.position.distanceTo(target);
    orthoHalf = dist * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    ortho.zoom = 1;
    updateOrthoFrustum();
  }
  camera.lookAt(target);
  controls.update();
  $("projLbl").textContent = camera === persp ? "투시" : "평행";
  requestRender();
}

// ------------------------------------------------------------------ display modes
const MODE_NAMES = ["음영", "윤곽선", "와이어", "X-ray"];
function edgesFor(p) {
  if (!p.edges) {
    const eg = new THREE.EdgesGeometry(p.mesh.geometry, 35);
    const em = new THREE.LineBasicMaterial({ color: 0x1b1f24, clippingPlanes: clipPlane ? [clipPlane] : [] });
    p.edges = new THREE.LineSegments(eg, em);
    p.edges.raycast = () => {};
    p.mesh.add(p.edges);
  }
  return p.edges;
}
function applyDisplayMode() {
  const m = displayMode;
  if (m === 1 && parts.some((p) => !p.edges)) {
    showLoading(true, "윤곽선을 계산하는 중…");
    setTimeout(() => { parts.forEach(edgesFor); showLoading(false); applyDisplayMode(); }, 30);
    return;
  }
  for (const p of parts) {
    const mat = p.mat;
    mat.wireframe = m === 2;
    const xray = m === 3;
    mat.transparent = xray || p.alpha < 0.99;
    mat.opacity = xray ? 0.22 : (p.alpha < 0.99 ? p.alpha : 1);
    mat.depthWrite = !xray;
    mat.needsUpdate = true;
    if (p.edges) p.edges.visible = m === 1;
  }
  selMat.wireframe = m === 2;
  selMat.transparent = m === 3;
  selMat.opacity = m === 3 ? 0.55 : 1;
  selMat.depthWrite = m !== 3;
  selMat.needsUpdate = true;
  $("modeLbl").textContent = MODE_NAMES[m];
  $("tbMode").classList.toggle("on", m !== 0);
  document.querySelectorAll("#modechips button").forEach((b) => b.classList.toggle("on", +b.dataset.m === m));
  requestRender();
}

// ------------------------------------------------------------------ section (clipping)
function setClipAxis(axis) {
  clipAxis = axis;
  const allMats = () => [selMat, ...parts.map((p) => p.mat), ...parts.filter((p) => p.edges).map((p) => p.edges.material)];
  if (axis < 0) {
    clipPlane = null;
    for (const m of allMats()) { m.clippingPlanes = []; m.needsUpdate = true; }
    $("secpanel").classList.remove("show");
    $("tbSection").classList.remove("on");
    requestRender();
    return;
  }
  clipPlane = clipPlane || new THREE.Plane();
  for (const m of allMats()) { m.clippingPlanes = [clipPlane]; m.needsUpdate = true; }
  $("secpanel").classList.add("show");
  $("tbSection").classList.add("on");
  document.querySelectorAll("#secaxis button").forEach((b) => b.classList.toggle("on", +b.dataset.a === axis));
  updateClip();
}
function updateClip() {
  if (!clipPlane) return;
  const t = $("secslider").value / 1000;
  const b = modelBox;
  const lo = [b.min.x, b.min.y, b.min.z][clipAxis], hi = [b.max.x, b.max.y, b.max.z][clipAxis];
  const pad = (hi - lo) * 0.002;
  const pos = lo - pad + (hi - lo + 2 * pad) * t;
  const n = new THREE.Vector3(); n.setComponent(clipAxis, clipFlip ? 1 : -1);
  // keep points with n·p + c >= 0  ->  c = -n·(pos)
  clipPlane.normal.copy(n);
  clipPlane.constant = -(clipFlip ? pos : -pos);
  requestRender();
}
$("secslider").oninput = updateClip;
document.querySelectorAll("#secaxis button").forEach((b) => (b.onclick = () => setClipAxis(+b.dataset.a)));
$("secflip").onclick = () => { clipFlip = !clipFlip; updateClip(); };

// ------------------------------------------------------------------ picking (tap vs drag)
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down = null, pointers = 0;
renderer.domElement.addEventListener("pointerdown", (e) => {
  pointers++;
  down = pointers === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
});
renderer.domElement.addEventListener("pointercancel", () => { pointers = Math.max(0, pointers - 1); down = null; });
renderer.domElement.addEventListener("pointerup", (e) => {
  pointers = Math.max(0, pointers - 1);
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const dt = performance.now() - down.t;
  down = null;
  if (moved > 10 || dt > 600) return;
  onTap(e.clientX, e.clientY);
});

function pick(x, y) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(parts.filter((p) => p.visible).map((p) => p.mesh), false);
  for (const h of hits) {
    if (clipPlane && clipPlane.distanceToPoint(h.point) < 0) continue; // clipped away
    return h;
  }
  return null;
}

function onTap(x, y) {
  if (!parts.length) return;
  const hit = pick(x, y);
  if (measureMode) {
    if (hit) addMeasurePoint(hit.point);
    return;
  }
  const idx = hit ? hit.object.userData.idx : null;
  if (multiMode) {
    if (idx === null) return;
    const s = new Set(selected);
    s.has(idx) ? s.delete(idx) : s.add(idx);
    setSelection(s, idx, true);
  } else {
    setSelection(idx === null ? new Set() : new Set([idx]), idx, true);
  }
}

// ------------------------------------------------------------------ selection
function setSelection(set, focus = null, fromView = false) {
  for (const i of selected) if (!set.has(i)) parts[i].mesh.material = parts[i].mat;
  for (const i of set) parts[i].mesh.material = selMat;
  selected = set;
  markTree(focus, fromView);
  updateSelUI(focus);
  requestRender();
}
function updateSelUI(focus) {
  const bar = $("selbar");
  const n = selected.size;
  ["tbIso", "tbHide"].forEach((id) => $(id).toggleAttribute("disabled", n === 0));
  if (measureMode && measurePts.length) return;
  if (!n) { bar.classList.remove("show"); return; }
  bar.classList.add("show");
  if (n === 1) {
    const p = parts[[...selected][0]];
    $("selname").textContent = shortName(p.part.path);
    const s = p.size.map((v) => v * unitToMm);
    $("selinfo").textContent = `크기 ${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])} mm · 삼각형 ${p.part.nf.toLocaleString("ko-KR")}`;
  } else {
    $("selname").textContent = `${n}개 선택`;
    $("selinfo").textContent = [...selected].slice(0, 3).map((i) => shortName(parts[i].part.path)).join(", ") + (n > 3 ? " …" : "");
  }
}
$("selclear").onclick = () => {
  if (measureMode) { clearMeasure(); updateSelUI(); $("selbar").classList.toggle("show", selected.size > 0); return; }
  setSelection(new Set());
};
$("selzoom").onclick = () => {
  const ids = measureMode && measurePts.length ? [] : [...selected];
  if (!ids.length) return;
  const box = new THREE.Box3();
  ids.forEach((i) => box.expandByObject(parts[i].mesh));
  frame(box);
};

// ------------------------------------------------------------------ visibility
function setVisible(i, v) {
  const p = parts[i];
  p.visible = v;
  p.mesh.visible = v;
}
function applyVisibility(fn) {
  parts.forEach((p, i) => setVisible(i, fn(i)));
  const hiddenSel = [...selected].filter((i) => !parts[i].visible);
  if (hiddenSel.length) setSelection(new Set([...selected].filter((i) => parts[i].visible)));
  refreshTreeChecks();
  requestRender();
}

// ------------------------------------------------------------------ measurement
function clearMeasure() {
  measurePts = [];
  overlayGroup.clear();
  requestRender();
}
function markerSize() {
  const r = modelBox.getBoundingSphere(new THREE.Sphere()).radius || 1;
  return r * 0.012;
}
function addMeasurePoint(p) {
  if (measurePts.length >= 2) clearMeasure();
  measurePts.push(p.clone());
  const dot = new THREE.Mesh(new THREE.SphereGeometry(markerSize(), 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xc0392b, depthTest: false }));
  dot.renderOrder = 10;
  dot.position.copy(p);
  overlayGroup.add(dot);
  if (measurePts.length === 2) {
    const [a, b] = measurePts;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0xc0392b, depthTest: false }));
    line.renderOrder = 10;
    overlayGroup.add(line);
    const d = b.clone().sub(a).multiplyScalar(unitToMm);
    $("selbar").classList.add("show");
    $("selname").textContent = `거리 ${fmt(d.length(), 2)} mm`;
    $("selinfo").textContent = `X ${fmt(Math.abs(d.x), 2)} · Y ${fmt(Math.abs(d.y), 2)} · Z ${fmt(Math.abs(d.z), 2)} mm`;
  } else {
    $("selbar").classList.add("show");
    $("selname").textContent = "첫 번째 점 선택됨";
    $("selinfo").textContent = "두 번째 점을 탭하세요";
  }
  requestRender();
}
function setMeasureMode(on) {
  measureMode = on;
  $("tbMeasure").classList.toggle("on", on);
  clearMeasure();
  if (on) {
    toast("모델 위의 두 점을 차례로 탭하세요");
    $("selbar").classList.remove("show");
  } else {
    $("toast").classList.remove("show");
    updateSelUI();
  }
}

// ------------------------------------------------------------------ toolbar
document.querySelectorAll("#toolbar .tb").forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.act;
    if (!parts.length && a !== "views") { toast("먼저 PDF 파일을 여세요"); return; }
    switch (a) {
      case "fit": frame(visibleBox()); break;
      case "iso": case "front": case "top": case "right": setView(a); break;
      case "views": openSheet(); break;
      case "mode": displayMode = (displayMode + 1) % 4; applyDisplayMode(); toast(`표시: ${["음영", "음영 + 윤곽선", "와이어프레임", "X-ray(반투명)"][displayMode]}`, 1400); break;
      case "section":
        if (clipAxis >= 0) setClipAxis(-1);
        else { $("secslider").value = 500; setClipAxis(0); toast("슬라이더로 단면 위치를 옮기세요", 2000); }
        break;
      case "measure": setMeasureMode(!measureMode); break;
      case "multi":
        multiMode = !multiMode;
        $("tbMulti").classList.toggle("on", multiMode);
        toast(multiMode ? "여러 개 선택: 탭할 때마다 추가/해제됩니다" : "한 개씩 선택", 1800);
        break;
      case "isolate": { const ids = new Set(selected); if (ids.size) { applyVisibility((i) => ids.has(i)); frame(visibleBox()); } break; }
      case "hide": { const ids = new Set(selected); if (ids.size) { setSelection(new Set()); applyVisibility((i) => parts[i].visible && !ids.has(i)); } break; }
      case "showall": applyVisibility(() => true); break;
    }
  };
});

// ------------------------------------------------------------------ parts tree (drawer)
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
const CHEV = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
let treeRoot = null; // {name, children: Map, el, kidsEl, leaves:[idx], idx}

function buildTree() {
  const host = $("tree");
  host.innerHTML = "";
  treeRoot = { children: new Map(), leaves: [] };
  parts.forEach((p, i) => {
    const segs = p.part.path.split("/").filter(Boolean);
    if (!segs.length) segs.push(p.part.name);
    let node = treeRoot;
    for (const seg of segs) {
      if (!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), leaves: [], parent: node, idx: null });
      node = node.children.get(seg);
    }
    if (node.idx !== null || node.children.size) {
      const key = `${segs[segs.length - 1]} (형상)#${i}`;
      const leaf = { name: `${segs[segs.length - 1]} (형상)`, children: new Map(), leaves: [], parent: node, idx: i };
      node.children.set(key, leaf);
      node = leaf;
    } else node.idx = i;
  });
  const collect = (n) => { n.leaves = n.idx !== null && n.idx !== undefined ? [n.idx] : []; for (const c of n.children.values()) n.leaves.push(...collect(c)); return n.leaves; };
  collect(treeRoot);
  const frag = document.createDocumentFragment();
  for (const c of treeRoot.children.values()) renderNode(c, 0, frag, true);
  host.appendChild(frag);
}

function renderNode(n, depth, container, open) {
  const row = document.createElement("div");
  row.className = "row" + (open && n.children.size ? " open" : "");
  row.style.paddingLeft = depth * 14 + "px";
  const hasKids = n.children.size > 0;
  const color = n.idx !== null && n.idx !== undefined ? parts[n.idx].color : null;
  row.innerHTML =
    `<span class="tw">${hasKids ? CHEV : ""}</span>` +
    `<span class="ck on"><span>${CHECK}</span></span>` +
    (color ? `<span class="sw" style="background:#${color.getHexString()}"></span>` : "") +
    `<span class="nm"></span>` + (color ? `<span class="ct">${parts[n.idx].part.nf.toLocaleString("ko-KR")}</span>` : `<span class="ct">${n.leaves.length}</span>`);
  row.querySelector(".nm").textContent = n.name;
  n.el = row;
  if (color) parts[n.idx].row = row;
  container.appendChild(row);
  if (hasKids) {
    const kids = document.createElement("div");
    kids.className = "kids";
    n.kidsEl = kids;
    container.appendChild(kids);
    for (const c of n.children.values()) renderNode(c, depth + 1, kids, false);
  }
  row.querySelector(".tw").onclick = (e) => { e.stopPropagation(); if (hasKids) row.classList.toggle("open"); };
  row.querySelector(".ck").onclick = (e) => {
    e.stopPropagation();
    const anyHidden = n.leaves.some((i) => !parts[i].visible);
    n.leaves.forEach((i) => setVisible(i, anyHidden));
    if (!anyHidden) setSelection(new Set([...selected].filter((i) => parts[i].visible)));
    refreshTreeChecks();
    requestRender();
  };
  let lastTap = 0;
  row.querySelector(".nm").onclick = () => {
    const now = performance.now();
    const ids = new Set(n.leaves);
    if (now - lastTap < 350) { // double tap: zoom to it
      const box = new THREE.Box3();
      ids.forEach((i) => parts[i].visible && box.expandByObject(parts[i].mesh));
      if (!box.isEmpty()) { closeDrawer(); frame(box); }
      lastTap = 0;
      return;
    }
    lastTap = now;
    if (multiMode) {
      const s = new Set(selected);
      const all = [...ids].every((i) => s.has(i));
      ids.forEach((i) => (all ? s.delete(i) : s.add(i)));
      setSelection(s, n.idx ?? null);
    } else setSelection(ids, n.idx ?? null);
  };
}

function refreshTreeChecks() {
  if (!treeRoot) return;
  const walk = (n) => {
    if (n.el) {
      const vis = n.leaves.filter((i) => parts[i].visible).length;
      const ck = n.el.querySelector(".ck");
      ck.classList.toggle("on", vis === n.leaves.length && vis > 0);
      ck.classList.toggle("part", vis > 0 && vis < n.leaves.length);
    }
    for (const c of n.children.values()) walk(c);
  };
  walk(treeRoot);
}

function markTree(focus, scroll) {
  document.querySelectorAll("#tree .row.sel, #tree .row.par").forEach((r) => r.classList.remove("sel", "par"));
  let focusRow = null;
  const walkUp = (n) => {
    for (let p = n.parent; p && p.el; p = p.parent) {
      if (!p.el.classList.contains("sel")) p.el.classList.add("par");
      p.el.classList.add("open");
    }
  };
  const nodeOf = new Map();
  const index = (n) => { if (n.idx !== null && n.idx !== undefined) nodeOf.set(n.idx, n); for (const c of n.children.values()) index(c); };
  if (treeRoot) index(treeRoot);
  for (const i of selected) {
    const n = nodeOf.get(i);
    if (!n || !n.el) continue;
    n.el.classList.add("sel");
    n.el.classList.remove("par");
    walkUp(n);
    if (i === focus) focusRow = n.el;
  }
  if (scroll && focusRow) focusRow.scrollIntoView({ block: "center" });
}

$("search").oninput = () => {
  const q = $("search").value.trim().toLowerCase();
  const walk = (n) => {
    let match = !q || n.name.toLowerCase().includes(q);
    let kidMatch = false;
    for (const c of n.children.values()) kidMatch = walk(c) || kidMatch;
    if (n.el) {
      n.el.style.display = match || kidMatch ? "" : "none";
      if (q && kidMatch) n.el.classList.add("open");
    }
    return match || kidMatch;
  };
  if (treeRoot) walk(treeRoot);
};
$("expandAll").onclick = () => document.querySelectorAll("#tree .row").forEach((r) => r.querySelector(".tw svg") && r.classList.add("open"));
$("collapseAll").onclick = () => document.querySelectorAll("#tree .row").forEach((r) => r.classList.remove("open"));
$("treeShowAll").onclick = () => applyVisibility(() => true);

function openDrawer() {
  if (!parts.length) { toast("먼저 PDF 파일을 여세요"); return; }
  $("drawer").classList.add("show"); $("scrim").classList.add("show");
  const s = document.querySelector("#tree .row.sel");
  if (s) s.scrollIntoView({ block: "center" });
}
function closeDrawer() { $("drawer").classList.remove("show"); $("scrim").classList.remove("show"); }
$("btnTree").onclick = openDrawer;
$("drawerClose").onclick = closeDrawer;

// ------------------------------------------------------------------ menu sheet
function openSheet() { $("sheet").classList.add("show"); $("scrim").classList.add("show"); }
function closeSheet() { $("sheet").classList.remove("show"); if (!$("drawer").classList.contains("show")) $("scrim").classList.remove("show"); }
$("btnMenu").onclick = openSheet;
$("scrim").onclick = () => { closeDrawer(); closeSheet(); };
document.querySelectorAll("#viewchips button").forEach((b) => (b.onclick = () => { closeSheet(); setView(b.dataset.v); }));
document.querySelectorAll("#modechips button").forEach((b) => (b.onclick = () => { displayMode = +b.dataset.m; applyDisplayMode(); closeSheet(); }));
document.querySelectorAll("#unitchips button").forEach((b) => (b.onclick = () => {
  unitMode = b.dataset.u;
  const { ext, mode } = updateUnits();
  updateSelUI();
  closeSheet();
  if (parts.length) toast(`모델 단위: ${mode} (전체 크기 약 ${fmt(ext * unitToMm, 0)} mm)`);
}));
$("miProj").onclick = () => { toggleProjection(); closeSheet(); };
$("miBg").onclick = () => {
  darkBg = !darkBg;
  document.documentElement.style.setProperty("--bg-top", darkBg ? "#3a414b" : "#d9dee5");
  document.documentElement.style.setProperty("--bg-bot", darkBg ? "#1e2227" : "#f4f6f8");
  closeSheet();
};
$("miHelp").onclick = () => {
  closeSheet();
  alertBox("조작 방법",
    "• 한 손가락 드래그: 회전\n• 두 손가락 벌리기/모으기: 확대·축소\n• 두 손가락 드래그: 이동\n" +
    "• 부품 탭: 주황색으로 강조 + 부품 목록에 표시\n• 빈 곳 탭: 선택 해제\n" +
    "• [여러 개 선택]을 켜면 탭할 때마다 추가/해제\n• 부품 목록에서 이름 두 번 탭: 그 부품으로 확대\n" +
    "• [단면]: X/Y/Z 선택 후 슬라이더로 위치 이동\n• [거리 측정]: 두 점을 차례로 탭 (mm)");
};
$("miAbout").onclick = () => {
  closeSheet();
  alertBox("정보", `PDF 3D 뷰어 ${APP_VERSION} (Android)\n\n3D PDF에 들어 있는 U3D 모델을 표시합니다.\nPRC 형식 3D PDF는 아직 지원하지 않습니다.\n\nU3D 디코딩: ECMA-363 표준 / Intel U3D 참조 구현(Apache-2.0)\n3D 표시: three.js (MIT)`);
};
function alertBox(title, text) {
  if (window.AndroidBridge && window.AndroidBridge.showDialog) window.AndroidBridge.showDialog(title, text);
  else alert(title + "\n\n" + text);
}

// ------------------------------------------------------------------ Android back button
window.handleBack = function () {
  if ($("sheet").classList.contains("show")) { closeSheet(); return true; }
  if ($("drawer").classList.contains("show")) { closeDrawer(); return true; }
  if (measureMode) { setMeasureMode(false); return true; }
  if (clipAxis >= 0) { setClipAxis(-1); return true; }
  if (selected.size) { setSelection(new Set()); return true; }
  return false;
};

// ------------------------------------------------------------------ start
$("logoimg").src = logoUrl;
updateSelUI();
if (window.AndroidBridge && window.AndroidBridge.appReady) window.AndroidBridge.appReady();

// test hook (used by automated checks only)
window.__pdf3d = { get parts() { return parts; }, get selected() { return selected; }, setView, frame, pick,
  openBytes, camera: () => camera, render: () => renderer.render(scene, camera) };
