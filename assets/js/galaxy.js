// Galaxy Animation - Vanilla JavaScript version
// Converted from React component

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = `
precision highp float;
uniform float uTime;
uniform vec3 uResolution;
uniform vec2 uFocal;
uniform vec2 uRotation;
uniform float uStarSpeed;
uniform float uDensity;
uniform float uHueShift;
uniform float uSpeed;
uniform vec2 uMouse;
uniform float uGlowIntensity;
uniform float uSaturation;
uniform bool uMouseRepulsion;
uniform float uTwinkleIntensity;
uniform float uRotationSpeed;
uniform float uRepulsionStrength;
uniform float uMouseActiveFactor;
uniform float uAutoCenterRepulsion;
uniform bool uTransparent;

varying vec2 vUv;

#define NUM_LAYER 4.0
#define STAR_COLOR_CUTOFF 0.2
#define MAT45 mat2(0.7071, -0.7071, 0.7071, 0.7071)
#define PERIOD 3.0

float Hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float tri(float x) {
  return abs(fract(x) * 2.0 - 1.0);
}

float tris(float x) {
  float t = fract(x);
  return 1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0));
}

float trisn(float x) {
  float t = fract(x);
  return 2.0 * (1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0))) - 1.0;
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float Star(vec2 uv, float flare) {
  float d = length(uv);
  float m = (0.05 * uGlowIntensity) / d;
  float rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * flare * uGlowIntensity;
  uv *= MAT45;
  rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * 0.3 * flare * uGlowIntensity;
  m *= smoothstep(1.0, 0.2, d);
  return m;
}

vec3 StarLayer(vec2 uv) {
  vec3 col = vec3(0.0);
  vec2 gv = fract(uv) - 0.5; 
  vec2 id = floor(uv);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 si = id + vec2(float(x), float(y));
      float seed = Hash21(si);
      float size = fract(seed * 345.32);
      float glossLocal = tri(uStarSpeed / (PERIOD * seed + 1.0));
      float flareSize = smoothstep(0.9, 1.0, size) * glossLocal;
      // Purple and Cyan color scheme
      // Purple: rgb(186, 66, 255) = vec3(0.729, 0.259, 1.0)
      // Cyan: rgb(0, 225, 255) = vec3(0.0, 0.882, 1.0)
      float colorChoice = Hash21(si + 5.0);
      vec3 purple = vec3(0.729, 0.259, 1.0);
      vec3 cyan = vec3(0.0, 0.882, 1.0);
      vec3 base = mix(cyan, purple, step(0.5, colorChoice));
      
      // Add some variation in brightness
      float brightness = 0.7 + Hash21(si + 7.0) * 0.3;
      base *= brightness;
      vec2 pad = vec2(tris(seed * 34.0 + uTime * uSpeed / 10.0), tris(seed * 38.0 + uTime * uSpeed / 30.0)) - 0.5;
      float star = Star(gv - offset - pad, flareSize);
      vec3 color = base;
      float twinkle = trisn(uTime * uSpeed + seed * 6.2831) * 0.5 + 1.0;
      twinkle = mix(1.0, twinkle, uTwinkleIntensity);
      star *= twinkle;
      
      col += star * size * color;
    }
  }
  return col;
}

void main() {
  vec2 focalPx = uFocal * uResolution.xy;
  vec2 uv = (vUv * uResolution.xy - focalPx) / uResolution.y;
  vec2 mouseNorm = uMouse - vec2(0.5);
  
  if (uAutoCenterRepulsion > 0.0) {
    vec2 centerUV = vec2(0.0, 0.0);
    float centerDist = length(uv - centerUV);
    vec2 repulsion = normalize(uv - centerUV) * (uAutoCenterRepulsion / (centerDist + 0.1));
    uv += repulsion * 0.05;
  } else if (uMouseRepulsion) {
    vec2 mousePosUV = (uMouse * uResolution.xy - focalPx) / uResolution.y;
    float mouseDist = length(uv - mousePosUV);
    vec2 repulsion = normalize(uv - mousePosUV) * (uRepulsionStrength / (mouseDist + 0.1));
    uv += repulsion * 0.05 * uMouseActiveFactor;
  } else {
    vec2 mouseOffset = mouseNorm * 0.1 * uMouseActiveFactor;
    uv += mouseOffset;
  }

  float autoRotAngle = uTime * uRotationSpeed;
  mat2 autoRot = mat2(cos(autoRotAngle), -sin(autoRotAngle), sin(autoRotAngle), cos(autoRotAngle));
  uv = autoRot * uv;
  uv = mat2(uRotation.x, -uRotation.y, uRotation.y, uRotation.x) * uv;

  vec3 col = vec3(0.0);

  for (float i = 0.0; i < 1.0; i += 1.0 / NUM_LAYER) {
    float depth = fract(i + uStarSpeed * uSpeed);
    float scale = mix(20.0 * uDensity, 0.5 * uDensity, depth);
    float fade = depth * smoothstep(1.0, 0.9, depth);
    col += StarLayer(uv * scale + i * 453.32) * fade;
  }

  if (uTransparent) {
    float alpha = length(col);
    alpha = smoothstep(0.0, 0.3, alpha);
    alpha = min(alpha, 1.0);
    gl_FragColor = vec4(col, alpha);
  } else {
    gl_FragColor = vec4(col, 1.0);
  }
}
`;

class GalaxyAnimation {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      focal: options.focal || [0.5, 0.5],
      rotation: options.rotation || [1.0, 0.0],
      starSpeed: options.starSpeed !== undefined ? options.starSpeed : 0.5,
      density: options.density !== undefined ? options.density : 1,
      hueShift: options.hueShift !== undefined ? options.hueShift : 140,
      disableAnimation: options.disableAnimation || false,
      speed: options.speed !== undefined ? options.speed : 1.0,
      mouseInteraction: options.mouseInteraction !== undefined ? options.mouseInteraction : true,
      glowIntensity: options.glowIntensity !== undefined ? options.glowIntensity : 0.3,
      saturation: options.saturation !== undefined ? options.saturation : 0.0,
      mouseRepulsion: options.mouseRepulsion !== undefined ? options.mouseRepulsion : true,
      repulsionStrength: options.repulsionStrength !== undefined ? options.repulsionStrength : 2,
      twinkleIntensity: options.twinkleIntensity !== undefined ? options.twinkleIntensity : 0.3,
      rotationSpeed: options.rotationSpeed !== undefined ? options.rotationSpeed : 0.1,
      autoCenterRepulsion: options.autoCenterRepulsion !== undefined ? options.autoCenterRepulsion : 0,
      transparent: options.transparent !== undefined ? options.transparent : true
    };

    this.targetMousePos = { x: 0.5, y: 0.5 };
    this.smoothMousePos = { x: 0.5, y: 0.5 };
    this.targetMouseActive = 0.0;
    this.smoothMouseActive = 0.0;
    this.animateId = null;
    this.renderer = null;
    this.program = null;
    this.mesh = null;
  }

  init() {
    if (!this.container) {
      console.error('GalaxyAnimation: Container element not found');
      return;
    }

    // Access OGL from global scope
    const { Renderer, Program, Mesh, Color, Triangle } = window.OGL;

    if (!Renderer || !Program || !Mesh || !Color || !Triangle) {
      console.error('GalaxyAnimation: OGL library not loaded. Make sure ogl.min.js is loaded before galaxy.js');
      return;
    }

    this.renderer = new Renderer({
      alpha: this.options.transparent,
      premultipliedAlpha: false
    });

    const gl = this.renderer.gl;

    if (this.options.transparent) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
    } else {
      gl.clearColor(0, 0, 0, 1);
    }

    this.resize();
    window.addEventListener('resize', () => this.resize(), false);

    const geometry = new Triangle(gl);
    this.program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: {
          value: new Color(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height)
        },
        uFocal: { value: new Float32Array(this.options.focal) },
        uRotation: { value: new Float32Array(this.options.rotation) },
        uStarSpeed: { value: this.options.starSpeed },
        uDensity: { value: this.options.density },
        uHueShift: { value: this.options.hueShift },
        uSpeed: { value: this.options.speed },
        uMouse: {
          value: new Float32Array([this.smoothMousePos.x, this.smoothMousePos.y])
        },
        uGlowIntensity: { value: this.options.glowIntensity },
        uSaturation: { value: this.options.saturation },
        uMouseRepulsion: { value: this.options.mouseRepulsion },
        uTwinkleIntensity: { value: this.options.twinkleIntensity },
        uRotationSpeed: { value: this.options.rotationSpeed },
        uRepulsionStrength: { value: this.options.repulsionStrength },
        uMouseActiveFactor: { value: 0.0 },
        uAutoCenterRepulsion: { value: this.options.autoCenterRepulsion },
        uTransparent: { value: this.options.transparent }
      }
    });

    this.mesh = new Mesh(gl, { geometry, program: this.program });
    this.container.appendChild(gl.canvas);

    this.setupEventListeners();
    this.animate();
  }

  resize() {
    if (!this.renderer || !this.container) return;
    const scale = 1;
    this.renderer.setSize(this.container.offsetWidth * scale, this.container.offsetHeight * scale);
    if (this.program) {
      const gl = this.renderer.gl;
      this.program.uniforms.uResolution.value = new window.OGL.Color(
        gl.canvas.width,
        gl.canvas.height,
        gl.canvas.width / gl.canvas.height
      );
    }
  }

  setupEventListeners() {
    if (!this.options.mouseInteraction) return;

    this.handleMouseMove = (e) => {
      const rect = this.container.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = 1.0 - (e.clientY - rect.top) / rect.height;
      this.targetMousePos = { x, y };
      this.targetMouseActive = 1.0;
    };

    this.handleMouseLeave = () => {
      this.targetMouseActive = 0.0;
    };

    this.container.addEventListener('mousemove', this.handleMouseMove);
    this.container.addEventListener('mouseleave', this.handleMouseLeave);
  }

  animate() {
    this.animateId = requestAnimationFrame(() => this.animate());

    if (!this.options.disableAnimation) {
      const t = performance.now();
      this.program.uniforms.uTime.value = t * 0.001;
      this.program.uniforms.uStarSpeed.value = (t * 0.001 * this.options.starSpeed) / 10.0;
    }

    const lerpFactor = 0.05;
    this.smoothMousePos.x += (this.targetMousePos.x - this.smoothMousePos.x) * lerpFactor;
    this.smoothMousePos.y += (this.targetMousePos.y - this.smoothMousePos.y) * lerpFactor;
    this.smoothMouseActive += (this.targetMouseActive - this.smoothMouseActive) * lerpFactor;

    this.program.uniforms.uMouse.value[0] = this.smoothMousePos.x;
    this.program.uniforms.uMouse.value[1] = this.smoothMousePos.y;
    this.program.uniforms.uMouseActiveFactor.value = this.smoothMouseActive;

    this.renderer.render({ scene: this.mesh });
  }

  dispose() {
    if (this.animateId) {
      cancelAnimationFrame(this.animateId);
      this.animateId = null;
    }

    window.removeEventListener('resize', () => this.resize());

    if (this.options.mouseInteraction && this.container) {
      this.container.removeEventListener('mousemove', this.handleMouseMove);
      this.container.removeEventListener('mouseleave', this.handleMouseLeave);
    }

    if (this.container && this.renderer) {
      const canvas = this.renderer.gl.canvas;
      if (canvas && canvas.parentNode === this.container) {
        this.container.removeChild(canvas);
      }
      const gl = this.renderer.gl;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
}

// Make it globally available
window.GalaxyAnimation = GalaxyAnimation;

