// Three.js rendering of the poker table and chips. Bundled by esbuild into
// public/table3d.js. Seats, cards and labels stay in the DOM: the page pins
// them to 3D anchor points via pin(), so they track the camera.
import {
  ACESFilmicToneMapping,
  CanvasTexture,
  CylinderGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Path,
  PCFShadowMap,
  PerspectiveCamera,
  RepeatWrapping,
  Scene,
  Shape,
  ShapeGeometry,
  SpotLight,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';

// ------------------------------------------------------------------ dimensions

const FELT = { rx: 4.95, rz: 2.6 };
const RAIL = { rx: 5.6, rz: 3.25, height: 0.2, bevel: 0.15 };
const FELT_Y = 0.12;
const SEAT_RING = { rx: 6.15, rz: 3.75, y: 0.3 };
const BET_RING = { rx: 3.7, rz: 2.1 };
const POT_POINT = new Vector3(0, FELT_Y, -1.05);
const BOARD_POINT = new Vector3(0, FELT_Y, 0.05);

const CHIP_RADIUS = 0.26;
const CHIP_HEIGHT = 0.07;
const MAX_CHIPS_PER_COLUMN = 10;
// columns of one stack are clustered around the stack's anchor
const COLUMN_OFFSETS = [
  [0, 0], [0.56, 0.03], [-0.56, 0.03], [0.28, -0.5], [-0.28, -0.5], [0, 0.52],
];

const DENOMINATIONS = [
  { value: 1000, base: '#d9a521', stripe: '#3a2a0c', ink: '#3a2a0c' },
  { value: 500, base: '#6b2fa3', stripe: '#f4efe4', ink: '#f4efe4' },
  { value: 100, base: '#24272d', stripe: '#f4efe4', ink: '#f4efe4' },
  { value: 25, base: '#1d8a4d', stripe: '#f4efe4', ink: '#f4efe4' },
  { value: 5, base: '#c0392b', stripe: '#f4efe4', ink: '#f4efe4' },
  { value: 1, base: '#efebe0', stripe: '#2f5fb3', ink: '#2f5fb3' },
];

// ------------------------------------------------------------------ helpers

const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

function ellipseShape(rx, rz, hole) {
  const shape = new Shape();
  shape.absellipse(0, 0, rx, rz, 0, Math.PI * 2, false, 0);
  if (hole) {
    const path = new Path();
    path.absellipse(0, 0, hole.rx, hole.rz, 0, Math.PI * 2, true, 0);
    shape.holes.push(path);
  }
  return shape;
}

function canvas(width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return [c, c.getContext('2d')];
}

function texture(c, { repeat = false } = {}) {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = RepeatWrapping;
  return t;
}

function feltTexture() {
  const [c, g] = canvas(1024, 540);
  const grad = g.createRadialGradient(512, 270, 40, 512, 270, 560);
  // moss-green cloth
  grad.addColorStop(0, '#5a7040');
  grad.addColorStop(0.6, '#465a31');
  grad.addColorStop(1, '#2f3e21');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // fine cloth noise
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // betting line
  g.strokeStyle = 'rgba(240, 228, 200, 0.22)';
  g.lineWidth = 3;
  g.beginPath();
  g.ellipse(512, 270, 380, 185, 0, 0, Math.PI * 2);
  g.stroke();
  return texture(c);
}

// Light oak planks: long, slightly wavy grain lines plus fine noise.
function oakTexture() {
  const [c, g] = canvas(1024, 512);
  g.fillStyle = '#b8935f';
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 140; i++) {
    const y0 = Math.random() * c.height;
    const amp = 2 + Math.random() * 6;
    const freq = 0.004 + Math.random() * 0.01;
    const phase = Math.random() * Math.PI * 2;
    g.strokeStyle = Math.random() < 0.6
      ? `rgba(110, 72, 36, ${0.08 + Math.random() * 0.22})`
      : `rgba(255, 236, 200, ${0.05 + Math.random() * 0.12})`;
    g.lineWidth = 0.6 + Math.random() * 2.2;
    g.beginPath();
    for (let x = 0; x <= c.width; x += 8) {
      const y = y0 + Math.sin(x * freq + phase) * amp;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = texture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(0.16, 0.3); // extrude UVs are in world units
  return t;
}

function chipSideTexture(d) {
  const [c, g] = canvas(256, 32);
  g.fillStyle = d.base;
  g.fillRect(0, 0, 256, 32);
  g.fillStyle = d.stripe;
  for (let i = 0; i < 8; i++) g.fillRect(i * 32 + 10, 0, 12, 32);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 0, 256, 3);
  g.fillRect(0, 29, 256, 3);
  return texture(c, { repeat: true });
}

function chipTopTexture(d) {
  const [c, g] = canvas(256, 256);
  const mid = 128;
  g.fillStyle = d.base;
  g.beginPath();
  g.arc(mid, mid, 128, 0, Math.PI * 2);
  g.fill();
  // edge spots
  g.fillStyle = d.stripe;
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2;
    g.beginPath();
    g.arc(mid, mid, 128, a0, a0 + 0.32);
    g.arc(mid, mid, 100, a0 + 0.32, a0, true);
    g.closePath();
    g.fill();
  }
  // inlay
  g.strokeStyle = d.stripe;
  g.lineWidth = 5;
  g.setLineDash([10, 8]);
  g.beginPath();
  g.arc(mid, mid, 84, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.beginPath();
  g.arc(mid, mid, 72, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = d.ink;
  g.font = `800 ${d.value >= 1000 ? 56 : 66}px ui-sans-serif, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(d.value >= 1000 ? '1K' : String(d.value), mid, mid + 4);
  return texture(c);
}

// Deterministic jitter so stacks look hand-placed but don't twitch on re-render.
function jitter(seed) {
  const x = Math.sin(seed * 127.1) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

// ------------------------------------------------------------------ class

export class Table3D {
  static supported() {
    try {
      const c = document.createElement('canvas');
      return Boolean(window.WebGL2RenderingContext && c.getContext('webgl2'));
    } catch {
      return false;
    }
  }

  constructor(container) {
    this.container = container;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.stacks = new Map(); // key -> { group, amount }
    this.pins = new Map(); // element -> Vector3
    this.anims = [];
    this.frame = 0;

    const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.domElement.className = 'table3d-canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.prepend(renderer.domElement);
    this.renderer = renderer;

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(30, 2, 0.1, 100);
    this.target = new Vector3(0, 0, 0.45);

    this.buildTable();
    this.buildLights();
    this.buildChipKit();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  // ---------------------------------------------------------------- scene

  buildTable() {
    const table = new Group();

    const rail = new Mesh(
      new ExtrudeGeometry(ellipseShape(RAIL.rx, RAIL.rz, { rx: FELT.rx + 0.05, rz: FELT.rz + 0.05 }), {
        depth: RAIL.height,
        bevelEnabled: true,
        bevelThickness: RAIL.bevel,
        bevelSize: RAIL.bevel,
        bevelSegments: 6,
        curveSegments: 120,
      }).rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ map: oakTexture(), roughness: 0.55, metalness: 0 }),
    );
    rail.position.y = FELT_Y - 0.02;
    rail.castShadow = true;
    rail.receiveShadow = true;

    const trim = new Mesh(
      new ExtrudeGeometry(ellipseShape(FELT.rx + 0.12, FELT.rz + 0.12, { rx: FELT.rx, rz: FELT.rz }), {
        depth: 0.05,
        bevelEnabled: true,
        bevelThickness: 0.02,
        bevelSize: 0.02,
        bevelSegments: 2,
        curveSegments: 120,
      }).rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ color: '#3b2a1c', roughness: 0.45, metalness: 0.05 }),
    );
    trim.position.y = FELT_Y - 0.01;
    trim.receiveShadow = true;

    const feltGeo = new ShapeGeometry(ellipseShape(FELT.rx, FELT.rz), 120).rotateX(-Math.PI / 2);
    // ShapeGeometry UVs are in shape units; map them onto the 0..1 texture
    const uv = feltGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) + FELT.rx) / (2 * FELT.rx), (uv.getY(i) + FELT.rz) / (2 * FELT.rz));
    }
    const felt = new Mesh(feltGeo, new MeshStandardMaterial({ map: feltTexture(), roughness: 0.95 }));
    felt.position.y = FELT_Y;
    felt.receiveShadow = true;

    const apron = new Mesh(
      new ExtrudeGeometry(ellipseShape(RAIL.rx - 0.1, RAIL.rz - 0.1), { depth: 0.45, bevelEnabled: false, curveSegments: 80 })
        .rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ color: '#2a1f15', roughness: 0.8 }),
    );
    apron.position.y = -0.45;

    table.add(apron, rail, trim, felt);
    this.scene.add(table);
  }

  buildLights() {
    this.scene.add(new HemisphereLight('#fff4e0', '#13221a', 0.85));

    const key = new DirectionalLight('#fff1d6', 1.6);
    key.position.set(2.5, 11, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -7;
    key.shadow.camera.right = 7;
    key.shadow.camera.top = 5;
    key.shadow.camera.bottom = -5;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key);

    // warm "card room lamp" pool of light over the felt
    const lamp = new SpotLight('#ffe2b3', 1.7, 0, 0.62, 0.85, 0);
    lamp.position.set(0, 10, 0);
    lamp.target.position.set(0, 0, 0);
    this.scene.add(lamp, lamp.target);
  }

  buildChipKit() {
    this.chipGeometry = new CylinderGeometry(CHIP_RADIUS, CHIP_RADIUS, CHIP_HEIGHT, 48);
    this.chipMaterials = new Map(
      DENOMINATIONS.map((d) => {
        const side = new MeshStandardMaterial({ map: chipSideTexture(d), roughness: 0.4 });
        const top = new MeshStandardMaterial({ map: chipTopTexture(d), roughness: 0.35 });
        return [d.value, [side, top, top]];
      }),
    );
  }

  // ---------------------------------------------------------------- layout

  seatAngle(rel, maxPlayers) {
    return Math.PI / 2 + (rel * Math.PI * 2) / maxPlayers;
  }

  seatPoint(rel, maxPlayers) {
    const a = this.seatAngle(rel, maxPlayers);
    return new Vector3(SEAT_RING.rx * Math.cos(a), SEAT_RING.y, SEAT_RING.rz * Math.sin(a));
  }

  betPoint(rel, maxPlayers) {
    const a = this.seatAngle(rel, maxPlayers);
    return new Vector3(BET_RING.rx * Math.cos(a), FELT_Y, BET_RING.rz * Math.sin(a));
  }

  get potPoint() {
    return POT_POINT.clone();
  }

  get boardPoint() {
    return BOARD_POINT.clone();
  }

  // The table screen may have been hidden when we were created, or resized
  // since; make sure the camera matches the box before projecting anything.
  ensureSize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w !== this.width || h !== this.height) this.resize();
    return Boolean(this.width && this.height);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // pull back on narrow screens so the whole table stays in view
    const distance = 14 * Math.max(1, 1.75 / aspect);
    const dir = new Vector3(0, 0.78, 0.63).normalize();
    this.camera.position.copy(this.target).addScaledVector(dir, distance);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  // Keeps a DOM element positioned over a 3D point.
  pin(el, point) {
    this.pins.set(el, point);
    this.placePin(el, point);
  }

  clearPins() {
    this.pins.clear();
  }

  placePin(el, point) {
    if (!this.ensureSize()) return;
    const v = point.clone().project(this.camera);
    el.style.left = `${((v.x + 1) / 2) * this.width}px`;
    el.style.top = `${((1 - v.y) / 2) * this.height}px`;
  }

  // ---------------------------------------------------------------- chips

  buildStack(amount, seed = 1) {
    const group = new Group();
    let rest = amount;
    let column = 0;
    for (const d of DENOMINATIONS) {
      const count = Math.floor(rest / d.value);
      rest -= count * d.value;
      if (!count || column >= COLUMN_OFFSETS.length) continue;
      const [ox, oz] = COLUMN_OFFSETS[column++];
      for (let i = 0; i < Math.min(count, MAX_CHIPS_PER_COLUMN); i++) {
        const chip = new Mesh(this.chipGeometry, this.chipMaterials.get(d.value));
        const s = seed * 31 + column * 7 + i;
        chip.position.set(ox + jitter(s) * 0.03, CHIP_HEIGHT / 2 + i * CHIP_HEIGHT, oz + jitter(s + 3) * 0.03);
        chip.rotation.y = jitter(s + 5) * Math.PI;
        chip.castShadow = true;
        chip.receiveShadow = true;
        group.add(chip);
      }
    }
    return group;
  }

  /**
   * Syncs the chip stacks with the game state.
   *   stacks: [{ key, amount, point }]  — every stack that should be on the felt
   *   flows:  [{ from, to }]            — stack keys whose chips slide elsewhere
   */
  update({ stacks, flows = [] }) {
    const wanted = new Map(stacks.map((s) => [s.key, s]));
    let slideDelay = 0;

    // chips leaving: slide towards their destination (pot or winner), then vanish
    for (const [key, current] of this.stacks) {
      const next = wanted.get(key);
      if (next && next.amount === current.amount) continue;
      this.stacks.delete(key);
      const flow = !next && flows.find((f) => f.from === key);
      const dest = flow && wanted.get(flow.to);
      if (dest && !this.reducedMotion) {
        slideDelay = 420;
        this.slide(current.group, dest.point, 420);
      } else {
        this.scene.remove(current.group);
      }
    }

    // chips arriving: drop onto the felt (after any slide has landed)
    let seed = 1;
    for (const s of stacks) {
      seed += 1;
      if (this.stacks.has(s.key)) continue;
      const group = this.buildStack(s.amount, seed);
      group.position.copy(s.point);
      this.scene.add(group);
      this.stacks.set(s.key, { group, amount: s.amount });
      const fromFlow = flows.some((f) => f.to === s.key);
      this.drop(group, fromFlow ? slideDelay : 0);
    }
    this.requestRender();
  }

  slide(group, to, duration) {
    const from = group.position.clone();
    const target = to.clone();
    this.animate(duration, 0, (t) => {
      const e = easeInOutCubic(t);
      group.position.lerpVectors(from, target, e);
      group.position.y = from.y + Math.sin(e * Math.PI) * 0.35;
      if (t >= 1) this.scene.remove(group);
    });
  }

  drop(group, delay) {
    group.children.forEach((chip, i) => {
      const finalY = chip.position.y;
      if (this.reducedMotion) return;
      chip.visible = false;
      this.animate(200, delay + i * 14, (t) => {
        chip.visible = true;
        chip.position.y = finalY + (1 - easeOutCubic(t)) * 0.6;
      });
    });
  }

  // ---------------------------------------------------------------- loop

  animate(duration, delay, step) {
    if (this.reducedMotion) {
      step(1);
      return;
    }
    this.anims.push({ start: performance.now() + delay, duration, step });
    this.requestRender();
  }

  requestRender() {
    if (!this.frame) this.frame = requestAnimationFrame((now) => this.render(now));
  }

  render(now) {
    this.frame = 0;
    this.anims = this.anims.filter((a) => {
      if (now < a.start) return true;
      const t = Math.min(1, (now - a.start) / a.duration);
      a.step(t);
      return t < 1;
    });
    for (const [el, point] of this.pins) this.placePin(el, point);
    this.renderer.render(this.scene, this.camera);
    if (this.anims.length) this.requestRender();
  }
}
