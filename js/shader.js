// Background shader: a slow, grainy linen gradient that warms up around the
// pointer. Purely decorative: if WebGL is unavailable the plain CSS background
// shows instead. Draws a single still frame for people who prefer reduced motion.

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_mouse;   // 0..1, origin bottom-left
uniform float u_glow;   // 0..1, fades in while the pointer is over the page
uniform float u_scroll; // page scroll, in viewport heights

// 2D simplex noise (Ashima Arts / Stefan Gustavson, MIT)
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * aspect, uv.y - u_scroll * 0.12);
  float t = u_time * 0.04;

  // Domain-warped noise: soft, fabric-like folds that drift slowly
  vec2 q = vec2(snoise(p * 0.9 + vec2(0.0, t)), snoise(p * 0.9 + vec2(5.2, -t)));
  vec2 r = vec2(snoise(p * 1.1 + 0.9 * q + vec2(1.7, 9.2) + t * 0.7),
                snoise(p * 1.1 + 0.9 * q + vec2(8.3, 2.8) - t * 0.6));
  float n = snoise(p * 0.7 + 0.8 * r);

  vec3 linen = vec3(0.933, 0.922, 0.898);
  vec3 sand  = vec3(0.906, 0.878, 0.831);
  vec3 sage  = vec3(0.871, 0.890, 0.855);
  vec3 chalk = vec3(0.969, 0.961, 0.945);

  vec3 col = mix(linen, sand, smoothstep(-0.7, 0.9, q.x));
  col = mix(col, sage, smoothstep(-0.1, 1.0, r.y) * 0.65);
  col = mix(col, chalk, smoothstep(-0.2, 1.0, n) * 0.55);

  // Warm marigold glow around the pointer
  vec2 m = vec2(u_mouse.x * aspect, u_mouse.y);
  vec2 pm = vec2(uv.x * aspect, uv.y);
  float d = distance(pm, m);
  col = mix(col, vec3(0.973, 0.878, 0.690), exp(-d * d * 10.0) * 0.38 * u_glow);

  // Gentle vignette and film grain
  col *= mix(0.955, 1.0, smoothstep(1.0, 0.25, length(uv - 0.5)));
  col += (hash(gl_FragCoord.xy + fract(u_time) * 91.7) - 0.5) * 0.03;

  gl_FragColor = vec4(col, 1.0);
}
`;

const RENDER_SCALE = 0.6; // the gradient is soft, so render below screen resolution
const FRAME_MS = 1000 / 30;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Background shader failed to compile:', gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

function start() {
  const canvas = document.createElement('canvas');
  canvas.className = 'bg-shader';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) return;

  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return;
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = {
    res: gl.getUniformLocation(program, 'u_res'),
    time: gl.getUniformLocation(program, 'u_time'),
    mouse: gl.getUniformLocation(program, 'u_mouse'),
    glow: gl.getUniformLocation(program, 'u_glow'),
    scroll: gl.getUniformLocation(program, 'u_scroll'),
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: 0.5, y: 0.6, tx: 0.5, ty: 0.6, glow: 0, tglow: 0 };
  const startTime = performance.now();
  let raf = 0;
  let last = 0;

  function resize() {
    const w = Math.max(1, Math.round(window.innerWidth * RENDER_SCALE));
    const h = Math.max(1, Math.round(window.innerHeight * RENDER_SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function draw(now) {
    pointer.x += (pointer.tx - pointer.x) * 0.06;
    pointer.y += (pointer.ty - pointer.y) * 0.06;
    pointer.glow += (pointer.tglow - pointer.glow) * 0.05;
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.time, reduceMotion.matches ? 12 : (now - startTime) / 1000);
    gl.uniform2f(u.mouse, pointer.x, pointer.y);
    gl.uniform1f(u.glow, reduceMotion.matches ? 0 : pointer.glow);
    gl.uniform1f(u.scroll, window.scrollY / window.innerHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < FRAME_MS) return;
    last = now;
    draw(now);
  }

  function play() {
    cancelAnimationFrame(raf);
    raf = 0;
    resize();
    draw(performance.now());
    if (!reduceMotion.matches && !document.hidden) raf = requestAnimationFrame(loop);
  }

  window.addEventListener('resize', play);
  document.addEventListener('visibilitychange', play);
  reduceMotion.addEventListener?.('change', play);
  window.addEventListener('scroll', () => { if (reduceMotion.matches) draw(performance.now()); }, { passive: true });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer.tx = e.clientX / window.innerWidth;
    pointer.ty = 1 - e.clientY / window.innerHeight;
    pointer.tglow = 1;
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer.tglow = 0; });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); canvas.remove(); });

  document.body.prepend(canvas);
  play();
  // Fade in only once a frame exists, so an unpainted (black) canvas never shows
  void canvas.offsetWidth;
  canvas.classList.add('is-ready');
}

start();
