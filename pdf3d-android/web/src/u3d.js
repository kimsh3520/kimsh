// U3D (ECMA-363) decoder + 3D-PDF stream extractor.
// JavaScript port of u3d_reader.py (PDF 3D Viewer for Windows).
// The arithmetic-coded bitstream follows the Intel/ECMA reference
// implementation (CIFXBitStreamX, Apache-2.0).
import { inflate } from "pako";

const STATIC_FULL = 0x400;
const MAX_RANGE = STATIC_FULL + 0x3fff;
const CTX_BASE_SHADING_ID = 1;
const ELEPHANT = 0x1fff;

const BT_HEADER = 0x00443355;
const BT_MODCHAIN = 0xffffff14;
const BT_GROUP = 0xffffff21;
const BT_MODEL = 0xffffff22;
const BT_LIGHT = 0xffffff23;
const BT_VIEW = 0xffffff24;
const BT_CLOD_DECL = 0xffffff31;
const BT_CLOD_BASE = 0xffffff3b;
const BT_CLOD_PROG = 0xffffff3c;
const BT_POINTSET = 0xffffff36;
const BT_LINESET = 0xffffff37;
const BT_SHADING_MOD = 0xffffff45;
const BT_SHADER = 0xffffff53;
const BT_MATERIAL = 0xffffff54;

export class U3DError extends Error {}

function revTable(bits) {
  const t = new Uint16Array(1 << bits);
  for (let i = 1; i < 1 << bits; i++) t[i] = (t[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  return t;
}
const SWAP8 = revTable(8);
const REV15 = revTable(15);

const utf8 = new TextDecoder("utf-8");
const f32buf = new DataView(new ArrayBuffer(4));

// ---------------------------------------------------------------- histogram
class Histogram {
  constructor() {
    this.counts = new Map([[0, 1]]);
    this.keys = [0]; // sorted symbols
    this.total = 1;
  }
  add(sym) {
    if (sym > 0xffff) return;
    if (this.total >= ELEPHANT) {
      const n = new Map();
      let tot = 0;
      for (const [k, v0] of this.counts) {
        const v = v0 >> 1;
        if (v) { n.set(k, v); tot += v; }
      }
      n.set(0, (n.get(0) || 0) + 1);
      this.counts = n;
      this.keys = [...n.keys()].sort((a, b) => a - b);
      this.total = tot + 1;
    }
    const c = this.counts.get(sym);
    if (c === undefined) {
      this.counts.set(sym, 1);
      // insert keeping order
      let i = this.keys.length;
      while (i > 0 && this.keys[i - 1] > sym) i--;
      this.keys.splice(i, 0, sym);
    } else {
      this.counts.set(sym, c + 1);
    }
    this.total += 1;
  }
  find(cf) {
    let cum = 0;
    for (const s of this.keys) {
      const f = this.counts.get(s);
      if (f && cf < cum + f) return [s, cum, f];
      cum += f;
    }
    throw new U3DError("histogram lookup failed");
  }
}

// ---------------------------------------------------------------- bitstream
class BitStream {
  constructor(bytes, noCompression) {
    this.d = new Uint8Array(bytes.length + 16);
    this.d.set(bytes);
    this.pos = 0;
    this.low = 0;
    this.high = 0xffff;
    this.uf = 0;
    this.ctx = new Map();
    this.nocomp = noCompression;
  }
  bits(pos, n) {
    const d = this.d, b = pos >> 3;
    const v = (d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24)) >>> 0;
    return (v >>> (pos & 7)) & ((1 << n) - 1);
  }
  decode(total, lookup) {
    const pos = this.pos;
    const code = (this.bits(pos, 1) << 15) | REV15[this.bits(pos + 1 + this.uf, 15)];
    let low = this.low, high = this.high;
    const rng = high + 1 - low;
    const cf = Math.floor((total * (1 + code - low) - 1) / rng);
    const [sym, cum, freq] = lookup(cf);
    high = low - 1 + Math.floor((rng * (cum + freq)) / total);
    low = low + Math.floor((rng * cum) / total);
    let bc = 0;
    while ((low & 0x8000) === (high & 0x8000)) {
      low = (low & 0x7fff) << 1;
      high = ((high & 0x7fff) << 1) | 1;
      bc++;
    }
    const sl = low & 0x8000, sh = high & 0x8000;
    if (bc) { bc += this.uf; this.uf = 0; }
    let u = 0;
    while ((low & 0x4000) && !(high & 0x4000)) {
      low = (low & 0x3fff) << 1;
      high = ((high & 0x3fff) << 1) | 1;
      u++;
    }
    this.uf += u;
    this.low = low | sl;
    this.high = high | sh;
    this.pos = pos + bc;
    return sym;
  }
  staticSym(n) {
    return this.decode(n, (cf) => [cf + 1, cf, 1]);
  }
  dynamicSym(context) {
    let h = this.ctx.get(context);
    if (!h) { h = new Histogram(); this.ctx.set(context, h); }
    const sym = this.decode(h.total, (cf) => h.find(cf));
    h.add(sym);
    return sym;
  }
  get reset() {
    return this.high === 0xffff && this.low === 0 && this.uf === 0;
  }
  u8() {
    if (this.reset) {
      const v = this.bits(this.pos, 8);
      this.pos += 8;
      return v;
    }
    return SWAP8[this.staticSym(256) - 1];
  }
  u16() { const a = this.u8(); return a | (this.u8() << 8); }
  u32() { const a = this.u16(); return (a | (this.u16() << 16)) >>> 0; }
  f32() { f32buf.setUint32(0, this.u32(), true); return f32buf.getFloat32(0, true); }
  string() {
    const n = this.u16();
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = this.u8();
    return utf8.decode(raw);
  }
  cu32(context) {
    if (this.nocomp) return this.u32();
    if (context && context < MAX_RANGE) {
      const sym = context > STATIC_FULL ? this.staticSym(context - STATIC_FULL) : this.dynamicSym(context);
      if (sym) return sym - 1;
      const v = this.u32();
      if (context <= STATIC_FULL) this.ctx.get(context).add(v + 1);
      return v;
    }
    return this.u32();
  }
  f32Array(count) {
    const out = new Float32Array(count);
    if (this.reset && (this.pos & 7) === 0) {
      const dv = new DataView(this.d.buffer, this.d.byteOffset + (this.pos >> 3), count * 4);
      for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true);
      this.pos += 32 * count;
      return out;
    }
    for (let i = 0; i < count; i++) out[i] = this.f32();
    return out;
  }
}

// ---------------------------------------------------------------- blocks
function* iterBlocks(data, start = 0, end = data.length) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let i = start;
  while (i + 12 <= end) {
    const t = dv.getUint32(i, true), ds = dv.getUint32(i + 4, true), ms = dv.getUint32(i + 8, true);
    const body = data.subarray(i + 12, Math.min(i + 12 + ds, data.length));
    i += 12 + ((ds + 3) & ~3) + ((ms + 3) & ~3);
    yield [t, body];
  }
}

const mat4Identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// row-major 4x4 multiply
function mul(a, b) {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      r[i * 4 + j] = s;
    }
  return r;
}
function inv3T(m) {
  // inverse-transpose of the upper-left 3x3 of a row-major 4x4 (returned as row-major 3x3)
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], k = m[10];
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-30) return [a, b, c, d, e, f, g, h, k];
  const D = -(b * k - c * h), E = a * k - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), K = a * e - b * d;
  // inverse = adj^T/det ; inverse-transpose = adj/det -> rows: [A B C],[D E F],[G H K]
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, K / det];
}

export class U3DDecoder {
  constructor(data) {
    if (!(data[0] === 0x55 && data[1] === 0x33 && data[2] === 0x44 && data[3] === 0))
      throw new U3DError("U3D 형식이 아닙니다");
    this.data = data;
    this.nocomp = false;
    this.decls = new Map();
    this.meshes = new Map();
    this.nodes = new Map();
    this.shading = new Map();
    this.shaders = new Map();
    this.materials = new Map();
    this.warnings = [];
    this.unitsScale = 1.0;
  }
  warn(msg) { if (!this.warnings.includes(msg)) this.warnings.push(msg); }
  bs(body) { return new BitStream(body, this.nocomp); }

  decode() {
    for (const [t, body] of iterBlocks(this.data)) this.block(t, body);
    return this.build();
  }
  block(t, body) {
    try {
      switch (t) {
        case BT_HEADER: return this.header(body);
        case BT_MODCHAIN: return this.modchain(body);
        case BT_GROUP: case BT_MODEL: case BT_LIGHT: case BT_VIEW: return this.node(t, body);
        case BT_CLOD_DECL: return this.clodDecl(body);
        case BT_CLOD_BASE: return this.clodBase(body);
        case BT_CLOD_PROG: return this.warn("점진적(progressive) 메시는 기본 해상도로 표시합니다.");
        case BT_POINTSET: case BT_LINESET: return this.warn("점/선 집합은 표시하지 않습니다.");
        case BT_SHADING_MOD: return this.shadingMod(body);
        case BT_SHADER: return this.shader(body);
        case BT_MATERIAL: return this.material(body);
      }
    } catch (e) {
      if (e instanceof U3DError) throw e;
      this.warn(`블록 0x${t.toString(16).toUpperCase()} 해석 실패: ${e.message}`);
    }
  }
  header(body) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const profile = dv.getUint32(4, true);
    this.nocomp = !!(profile & 4);
    if (profile & 8 && body.length >= 32) this.unitsScale = dv.getFloat64(24, true);
  }
  modchain(body) {
    const bs = this.bs(body);
    const name = bs.string();
    bs.u32(); // chain type
    const attrs = bs.u32();
    const nlen = new TextEncoder().encode(name).length;
    let off = 2 + nlen + 8;
    if (attrs & 1) off += 16;
    if (attrs & 2) off += 24;
    off += (4 - ((2 + nlen) & 3)) & 3;
    off += 4;
    for (const [t, sub] of iterBlocks(body, off)) this.block(t, sub);
  }
  node(t, body) {
    const bs = this.bs(body);
    const name = bs.string();
    const parents = [];
    const np = bs.u32();
    for (let i = 0; i < np; i++) {
      const pname = bs.string();
      const a = bs.f32Array(16); // column-major
      const m = new Array(16);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[r * 4 + c] = a[c * 4 + r];
      parents.push([pname, m]);
    }
    if (t === BT_MODEL) {
      const res = bs.string();
      const vis = bs.u32() & 3;
      this.nodes.set(name, { name, kind: "model", parents, resource: res, visibility: vis });
    } else {
      this.nodes.set(name, { name, kind: "group", parents, resource: null });
    }
  }
  clodDecl(body) {
    const bs = this.bs(body);
    const name = bs.string();
    bs.u32();
    const excl = !!(bs.u32() & 1);
    const nf = bs.u32(), npos = bs.u32();
    bs.u32(); bs.u32(); bs.u32(); bs.u32();
    const nmat = bs.u32();
    const mats = [];
    for (let i = 0; i < nmat; i++) {
      const a = bs.u32();
      const layers = bs.u32();
      for (let j = 0; j < layers; j++) bs.u32();
      const orig = bs.u32();
      mats.push({ diffuse: !!(a & 1), specular: !!(a & 2), layers, orig });
    }
    this.decls.set(name, { name, excl, nf, npos, mats });
  }
  clodBase(body) {
    const bs = this.bs(body);
    const name = bs.string();
    bs.u32();
    const decl = this.decls.get(name);
    if (!decl) { this.warn(`선언 없는 메시: ${name}`); return; }
    const nf = bs.u32(), npos = bs.u32(), nn = bs.u32(), nd = bs.u32(), ns = bs.u32(), nt = bs.u32();
    if (nf < decl.nf) this.warn("일부 메시는 기본 해상도만 표시됩니다.");
    const pos = bs.f32Array(npos * 3);
    const nrm = nn ? bs.f32Array(nn * 3) : null;
    const dif = nd ? bs.f32Array(nd * 4) : null;
    if (ns) bs.f32Array(ns * 4);
    if (nt) bs.f32Array(nt * 4);
    const cP = STATIC_FULL + npos, cN = STATIC_FULL + nn, cD = STATIC_FULL + nd;
    const cS = STATIC_FULL + ns, cT = STATIC_FULL + nt;
    const mats = decl.mats, excl = decl.excl;
    const fp = new Uint32Array(nf * 3);
    const fn = excl ? null : new Uint32Array(nf * 3);
    const fd = nd ? new Int32Array(nf * 3).fill(-1) : null;
    const fm = new Uint32Array(nf);
    const none = { diffuse: false, specular: false, layers: 0 };
    let maxP = 0;
    for (let i = 0; i < nf; i++) {
      const m = bs.cu32(CTX_BASE_SHADING_ID);
      fm[i] = m;
      const md = m < mats.length ? mats[m] : none;
      for (let c = 0; c < 3; c++) {
        const p = bs.cu32(cP);
        fp[i * 3 + c] = p;
        if (p > maxP) maxP = p;
        if (!excl) fn[i * 3 + c] = bs.cu32(cN);
        if (md.diffuse) { const v = bs.cu32(cD); if (fd) fd[i * 3 + c] = v; }
        if (md.specular) bs.cu32(cS);
        for (let l = 0; l < md.layers; l++) bs.cu32(cT);
      }
    }
    if (npos && nf && maxP >= npos) throw new U3DError(`메시 ${name}: 인덱스 범위 오류 (디코딩 실패)`);
    this.meshes.set(name, { name, pos, nrm, dif, fp, fn, fd, fm, nf });
  }
  shadingMod(body) {
    const bs = this.bs(body);
    const name = bs.string();
    bs.u32(); bs.u32();
    const lists = [];
    const n = bs.u32();
    for (let i = 0; i < n; i++) {
      const k = bs.u32();
      const l = [];
      for (let j = 0; j < k; j++) l.push(bs.string());
      lists.push(l);
    }
    this.shading.set(name, lists);
  }
  shader(body) {
    const bs = this.bs(body);
    const name = bs.string();
    bs.u32(); bs.f32(); bs.u32(); bs.u32(); bs.u32(); bs.u32(); bs.u32();
    this.shaders.set(name, bs.string());
  }
  material(body) {
    const bs = this.bs(body);
    const name = bs.string();
    bs.u32();
    const r3 = () => [bs.f32(), bs.f32(), bs.f32()];
    const amb = r3(), dif = r3(); r3(); const emi = r3();
    bs.f32();
    const opa = bs.f32();
    let col = dif;
    if (Math.max(...dif) < 0.02) col = Math.max(...emi) > Math.max(...amb) ? emi : amb;
    this.materials.set(name, [col[0], col[1], col[2], opa]);
  }

  world(name, depth = 0) {
    const node = this.nodes.get(name);
    if (!node || depth > 64) return [[mat4Identity(), ""]];
    if (!node.parents.length) return [[mat4Identity(), name]];
    const out = [];
    for (const [pname, m] of node.parents) {
      if (!pname || !this.nodes.has(pname)) out.push([m, name]);
      else for (const [pw, ppath] of this.world(pname, depth + 1))
        out.push([mul(pw, m), ppath ? `${ppath}/${name}` : name]);
    }
    return out;
  }
  matColor(lists, idx) {
    if (lists && idx < lists.length && lists[idx].length) {
      const mat = this.shaders.get(lists[idx][0]);
      if (mat !== undefined && this.materials.has(mat)) return this.materials.get(mat);
    }
    return [0.75, 0.75, 0.78, 1.0];
  }

  build() {
    const resShading = new Map();
    for (const n of this.nodes.values())
      if (n.kind === "model" && n.resource && this.shading.has(n.name) && !resShading.has(n.resource))
        resShading.set(n.resource, this.shading.get(n.name));
    const parts = [];
    for (const node of this.nodes.values()) {
      if (node.kind !== "model" || !node.resource) continue;
      const mesh = this.meshes.get(node.resource);
      if (!mesh || mesh.nf === 0) continue;
      const lists = this.shading.get(node.name) || this.shading.get(node.resource) || resShading.get(node.resource);
      const decl = this.decls.get(node.resource);
      let nm = 0;
      for (let i = 0; i < mesh.nf; i++) if (mesh.fm[i] + 1 > nm) nm = mesh.fm[i] + 1;
      const pal = [];
      for (let k = 0; k < nm; k++) {
        const o = decl && k < decl.mats.length ? decl.mats[k].orig : k;
        pal.push(this.matColor(lists, o));
      }
      const nf = mesh.nf;
      // per-face colour (RGBA)
      const colors = new Float32Array(nf * 4);
      for (let i = 0; i < nf; i++) {
        let c = pal[mesh.fm[i]];
        if (mesh.dif && mesh.fd && mesh.fd[i * 3] >= 0) {
          const j = mesh.fd[i * 3] * 4;
          c = [mesh.dif[j], mesh.dif[j + 1], mesh.dif[j + 2], mesh.dif[j + 3]];
        }
        colors.set(c, i * 4);
      }
      const hasN = mesh.nrm && mesh.fn && mesh.nrm.length;
      const nN = hasN ? mesh.nrm.length / 3 : 0;
      for (const [w, path] of this.world(node.name)) {
        const v = new Float32Array(nf * 9);
        const n = hasN ? new Float32Array(nf * 9) : null;
        const it = hasN ? inv3T(w) : null;
        for (let i = 0; i < nf * 3; i++) {
          const p = mesh.fp[i] * 3;
          const x = mesh.pos[p], y = mesh.pos[p + 1], z = mesh.pos[p + 2];
          v[i * 3] = w[0] * x + w[1] * y + w[2] * z + w[3];
          v[i * 3 + 1] = w[4] * x + w[5] * y + w[6] * z + w[7];
          v[i * 3 + 2] = w[8] * x + w[9] * y + w[10] * z + w[11];
          if (hasN) {
            const q = Math.min(Math.max(mesh.fn[i], 0), nN - 1) * 3;
            const a = mesh.nrm[q], b = mesh.nrm[q + 1], c = mesh.nrm[q + 2];
            let nx = it[0] * a + it[1] * b + it[2] * c;
            let ny = it[3] * a + it[4] * b + it[5] * c;
            let nz = it[6] * a + it[7] * b + it[8] * c;
            const l = Math.hypot(nx, ny, nz) || 1;
            n[i * 3] = nx / l; n[i * 3 + 1] = ny / l; n[i * 3 + 2] = nz / l;
          }
        }
        parts.push({ name: node.name, path, vertices: v, normals: n, colors: colors.slice(), nf });
      }
    }
    return { parts, warnings: this.warnings, unitsScale: this.unitsScale };
  }
}

// ---------------------------------------------------------------- PDF side
// Streams can never live inside PDF object streams, so their dictionaries are
// always plain text in the file: scan for "N G obj << ... >> stream".
function latin1(bytes, start, end) {
  let s = "";
  const CH = 0x8000;
  for (let i = start; i < end; i += CH)
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, end)));
  return s;
}

export function extract3DStreams(pdf) {
  const text = latin1(pdf, 0, pdf.length);
  const out = [];
  const re = /\/Subtype\s*\/(U3D|PRC)\b/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) {
    // find the enclosing object start and the following "stream" keyword
    const objStart = text.lastIndexOf(" obj", m.index);
    const streamKw = text.indexOf("stream", m.index);
    if (objStart < 0 || streamKw < 0) continue;
    const endobjBefore = text.lastIndexOf("endobj", m.index);
    if (endobjBefore > objStart) continue; // dictionary not inside an object header
    const dict = text.slice(objStart, streamKw);
    if (dict.includes("endobj") || seen.has(streamKw)) continue;
    seen.add(streamKw);
    let ds = streamKw + 6;
    if (text[ds] === "\r") ds++;
    if (text[ds] === "\n") ds++;
    let len = -1;
    const lm = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict);
    if (lm && !lm[2]) len = parseInt(lm[1], 10);
    let de;
    if (len > 0 && text.startsWith("endstream", text.indexOf("endstream", ds + len - 2)) &&
        text.indexOf("endstream", ds + len - 2) - (ds + len) <= 4) de = ds + len;
    else {
      de = text.indexOf("endstream", ds);
      if (de < 0) continue;
      while (de > ds && (text[de - 1] === "\n" || text[de - 1] === "\r")) de--;
    }
    let data = pdf.subarray(ds, de);
    if (/\/FlateDecode/.test(dict) || /\/Fl\b/.test(dict)) {
      try { data = inflate(data); } catch (e) { continue; }
    }
    out.push({ subtype: m[1], data });
  }
  return out;
}

export function loadPdfBytes(bytes) {
  const streams = extract3DStreams(bytes);
  if (!streams.length) throw new U3DError("이 PDF에는 3D 모델이 들어 있지 않습니다.");
  const scenes = [], msgs = [];
  streams.forEach((s, i) => {
    const isU3D = s.data[0] === 0x55 && s.data[1] === 0x33 && s.data[2] === 0x44 && s.data[3] === 0;
    if (isU3D) scenes.push(new U3DDecoder(s.data).decode());
    else if (s.subtype === "PRC") msgs.push(`${i + 1}번째 3D 모델은 PRC 형식이라 표시할 수 없습니다.`);
    else msgs.push(`${i + 1}번째 3D 모델의 형식을 알 수 없습니다.`);
  });
  return { scenes, msgs };
}

export function loadAnyBytes(bytes) {
  if (bytes[0] === 0x55 && bytes[1] === 0x33 && bytes[2] === 0x44 && bytes[3] === 0)
    return { scenes: [new U3DDecoder(bytes).decode()], msgs: [] };
  return loadPdfBytes(bytes);
}
