// Hyperspeed Animation - Full Vanilla JavaScript Implementation
// Converted from React component
// Complete Three.js implementation

(function() {
  'use strict';

  // Helper Functions
  const random = base => {
    if (Array.isArray(base)) return Math.random() * (base[1] - base[0]) + base[0];
    return Math.random() * base;
  };

  const pickRandom = arr => {
    if (Array.isArray(arr)) return arr[Math.floor(Math.random() * arr.length)];
    return arr;
  };

  function lerp(current, target, speed = 0.1, limit = 0.001) {
    let change = (target - current) * speed;
    if (Math.abs(change) < limit) {
      change = target - current;
    }
    return change;
  }

  let nsin = val => Math.sin(val) * 0.5 + 0.5;

  function resizeRendererToDisplaySize(renderer, setSize) {
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const needResize = canvas.width !== width || canvas.height !== height;
    if (needResize) {
      setSize(width, height, false);
    }
    return needResize;
  }

  // Shader Code - These will be processed by Three.js shader chunks
  const carLightsFragment = `
    #define USE_FOG;
    #include <fog_pars_fragment>
    varying vec3 vColor;
    varying vec2 vUv; 
    uniform vec2 uFade;
    void main() {
      vec3 color = vec3(vColor);
      float alpha = smoothstep(uFade.x, uFade.y, vUv.x);
      gl_FragColor = vec4(color, alpha);
      if (gl_FragColor.a < 0.0001) discard;
      #include <fog_fragment>
    }
  `;

  const carLightsVertex = `
    #define USE_FOG;
    #include <fog_pars_vertex>
    attribute vec3 aOffset;
    attribute vec3 aMetrics;
    attribute vec3 aColor;
    uniform float uTravelLength;
    uniform float uTime;
    varying vec2 vUv; 
    varying vec3 vColor; 
    #include <getDistortion_vertex>
    void main() {
      vec3 transformed = position.xyz;
      float radius = aMetrics.r;
      float myLength = aMetrics.g;
      float speed = aMetrics.b;
      transformed.xy *= radius;
      transformed.z *= myLength;
      transformed.z += myLength - mod(uTime * speed + aOffset.z, uTravelLength);
      transformed.xy += aOffset.xy;
      float progress = abs(transformed.z / uTravelLength);
      transformed.xyz += getDistortion(progress);
      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.);
      gl_Position = projectionMatrix * mvPosition;
      vUv = uv;
      vColor = aColor;
      #include <fog_vertex>
    }
  `;

  const sideSticksVertex = `
    #define USE_FOG;
    #include <fog_pars_vertex>
    attribute float aOffset;
    attribute vec3 aColor;
    attribute vec2 aMetrics;
    uniform float uTravelLength;
    uniform float uTime;
    varying vec3 vColor;
    mat4 rotationY( in float angle ) {
      return mat4(	cos(angle),		0,		sin(angle),	0,
                   0,		1.0,			 0,	0,
              -sin(angle),	0,		cos(angle),	0,
              0, 		0,				0,	1);
    }
    #include <getDistortion_vertex>
    void main(){
      vec3 transformed = position.xyz;
      float width = aMetrics.x;
      float height = aMetrics.y;
      transformed.xy *= vec2(width, height);
      float time = mod(uTime * 60. * 2. + aOffset, uTravelLength);
      transformed = (rotationY(3.14/2.) * vec4(transformed,1.)).xyz;
      transformed.z += - uTravelLength + time;
      float progress = abs(transformed.z / uTravelLength);
      transformed.xyz += getDistortion(progress);
      transformed.y += height / 2.;
      transformed.x += -width / 2.;
      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.);
      gl_Position = projectionMatrix * mvPosition;
      vColor = aColor;
      #include <fog_vertex>
    }
  `;

  const sideSticksFragment = `
    #define USE_FOG;
    #include <fog_pars_fragment>
    varying vec3 vColor;
    void main(){
      vec3 color = vec3(vColor);
      gl_FragColor = vec4(color,1.);
      #include <fog_fragment>
    }
  `;

  const roadMarkings_vars = `
    uniform float uLanes;
    uniform vec3 uBrokenLinesColor;
    uniform vec3 uShoulderLinesColor;
    uniform float uShoulderLinesWidthPercentage;
    uniform float uBrokenLinesWidthPercentage;
    uniform float uBrokenLinesLengthPercentage;
    highp float random(vec2 co) {
      highp float a = 12.9898;
      highp float b = 78.233;
      highp float c = 43758.5453;
      highp float dt = dot(co.xy, vec2(a, b));
      highp float sn = mod(dt, 3.14);
      return fract(sin(sn) * c);
    }
  `;

  const roadMarkings_fragment = `
    uv.y = mod(uv.y + uTime * 0.05, 1.);
    float laneWidth = 1.0 / uLanes;
    float brokenLineWidth = laneWidth * uBrokenLinesWidthPercentage;
    float laneEmptySpace = 1. - uBrokenLinesLengthPercentage;
    float brokenLines = step(1.0 - brokenLineWidth, fract(uv.x * 2.0)) * step(laneEmptySpace, fract(uv.y * 10.0));
    float sideLines = step(1.0 - brokenLineWidth, fract((uv.x - laneWidth * (uLanes - 1.0)) * 2.0)) + step(brokenLineWidth, uv.x);
    brokenLines = mix(brokenLines, sideLines, uv.x);
  `;

  const roadBaseFragment = `
    #define USE_FOG;
    varying vec2 vUv; 
    uniform vec3 uColor;
    uniform float uTime;
    #include <roadMarkings_vars>
    #include <fog_pars_fragment>
    void main() {
      vec2 uv = vUv;
      vec3 color = vec3(uColor);
      #include <roadMarkings_fragment>
      gl_FragColor = vec4(color, 1.);
      #include <fog_fragment>
    }
  `;

  const islandFragment = roadBaseFragment
    .replace('#include <roadMarkings_fragment>', '')
    .replace('#include <roadMarkings_vars>', '');

  const roadFragment = roadBaseFragment
    .replace('#include <roadMarkings_fragment>', roadMarkings_fragment)
    .replace('#include <roadMarkings_vars>', roadMarkings_vars);

  const roadVertex = `
    #define USE_FOG;
    uniform float uTime;
    #include <fog_pars_vertex>
    uniform float uTravelLength;
    varying vec2 vUv; 
    #include <getDistortion_vertex>
    void main() {
      vec3 transformed = position.xyz;
      vec3 distortion = getDistortion((transformed.y + uTravelLength / 2.) / uTravelLength);
      transformed.x += distortion.x;
      transformed.z += distortion.y;
      transformed.y += -1. * distortion.z;  
      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.);
      gl_Position = projectionMatrix * mvPosition;
      vUv = uv;
      #include <fog_vertex>
    }
  `;

  // Distortion Configurations
  const createDistortions = () => {
    const mountainUniforms = {
      uFreq: { value: new THREE.Vector3(3, 6, 10) },
      uAmp: { value: new THREE.Vector3(30, 30, 20) }
    };

    const xyUniforms = {
      uFreq: { value: new THREE.Vector2(5, 2) },
      uAmp: { value: new THREE.Vector2(25, 15) }
    };

    const LongRaceUniforms = {
      uFreq: { value: new THREE.Vector2(2, 3) },
      uAmp: { value: new THREE.Vector2(35, 10) }
    };

    const turbulentUniforms = {
      uFreq: { value: new THREE.Vector4(4, 8, 8, 1) },
      uAmp: { value: new THREE.Vector4(25, 5, 10, 10) }
    };

    const deepUniforms = {
      uFreq: { value: new THREE.Vector2(4, 8) },
      uAmp: { value: new THREE.Vector2(10, 20) },
      uPowY: { value: new THREE.Vector2(20, 2) }
    };

    return {
      mountainDistortion: {
        uniforms: mountainUniforms,
        getDistortion: `
          uniform vec3 uAmp;
          uniform vec3 uFreq;
          #define PI 3.14159265358979
          float nsin(float val){
            return sin(val) * 0.5 + 0.5;
          }
          vec3 getDistortion(float progress){
            float movementProgressFix = 0.02;
            return vec3( 
              cos(progress * PI * uFreq.x + uTime) * uAmp.x - cos(movementProgressFix * PI * uFreq.x + uTime) * uAmp.x,
              nsin(progress * PI * uFreq.y + uTime) * uAmp.y - nsin(movementProgressFix * PI * uFreq.y + uTime) * uAmp.y,
              nsin(progress * PI * uFreq.z + uTime) * uAmp.z - nsin(movementProgressFix * PI * uFreq.z + uTime) * uAmp.z
            );
          }
        `,
        getJS: (progress, time) => {
          let movementProgressFix = 0.02;
          let uFreq = mountainUniforms.uFreq.value;
          let uAmp = mountainUniforms.uAmp.value;
          let distortion = new THREE.Vector3(
            Math.cos(progress * Math.PI * uFreq.x + time) * uAmp.x -
              Math.cos(movementProgressFix * Math.PI * uFreq.x + time) * uAmp.x,
            nsin(progress * Math.PI * uFreq.y + time) * uAmp.y -
              nsin(movementProgressFix * Math.PI * uFreq.y + time) * uAmp.y,
            nsin(progress * Math.PI * uFreq.z + time) * uAmp.z -
              nsin(movementProgressFix * Math.PI * uFreq.z + time) * uAmp.z
          );
          let lookAtAmp = new THREE.Vector3(2, 2, 2);
          let lookAtOffset = new THREE.Vector3(0, 0, -5);
          return distortion.multiply(lookAtAmp).add(lookAtOffset);
        }
      },
      xyDistortion: {
        uniforms: xyUniforms,
        getDistortion: `
          uniform vec2 uFreq;
          uniform vec2 uAmp;
          #define PI 3.14159265358979
          vec3 getDistortion(float progress){
            float movementProgressFix = 0.02;
            return vec3( 
              cos(progress * PI * uFreq.x + uTime) * uAmp.x - cos(movementProgressFix * PI * uFreq.x + uTime) * uAmp.x,
              sin(progress * PI * uFreq.y + PI/2. + uTime) * uAmp.y - sin(movementProgressFix * PI * uFreq.y + PI/2. + uTime) * uAmp.y,
              0.
            );
          }
        `,
        getJS: (progress, time) => {
          let movementProgressFix = 0.02;
          let uFreq = xyUniforms.uFreq.value;
          let uAmp = xyUniforms.uAmp.value;
          let distortion = new THREE.Vector3(
            Math.cos(progress * Math.PI * uFreq.x + time) * uAmp.x -
              Math.cos(movementProgressFix * Math.PI * uFreq.x + time) * uAmp.x,
            Math.sin(progress * Math.PI * uFreq.y + time + Math.PI / 2) * uAmp.y -
              Math.sin(movementProgressFix * Math.PI * uFreq.y + time + Math.PI / 2) * uAmp.y,
            0
          );
          let lookAtAmp = new THREE.Vector3(2, 0.4, 1);
          let lookAtOffset = new THREE.Vector3(0, 0, -3);
          return distortion.multiply(lookAtAmp).add(lookAtOffset);
        }
      },
      LongRaceDistortion: {
        uniforms: LongRaceUniforms,
        getDistortion: `
          uniform vec2 uFreq;
          uniform vec2 uAmp;
          #define PI 3.14159265358979
          vec3 getDistortion(float progress){
            float camProgress = 0.0125;
            return vec3( 
              sin(progress * PI * uFreq.x + uTime) * uAmp.x - sin(camProgress * PI * uFreq.x + uTime) * uAmp.x,
              sin(progress * PI * uFreq.y + uTime) * uAmp.y - sin(camProgress * PI * uFreq.y + uTime) * uAmp.y,
              0.
            );
          }
        `,
        getJS: (progress, time) => {
          let camProgress = 0.0125;
          let uFreq = LongRaceUniforms.uFreq.value;
          let uAmp = LongRaceUniforms.uAmp.value;
          let distortion = new THREE.Vector3(
            Math.sin(progress * Math.PI * uFreq.x + time) * uAmp.x -
              Math.sin(camProgress * Math.PI * uFreq.x + time) * uAmp.x,
            Math.sin(progress * Math.PI * uFreq.y + time) * uAmp.y -
              Math.sin(camProgress * Math.PI * uFreq.y + time) * uAmp.y,
            0
          );
          let lookAtAmp = new THREE.Vector3(1, 1, 0);
          let lookAtOffset = new THREE.Vector3(0, 0, -5);
          return distortion.multiply(lookAtAmp).add(lookAtOffset);
        }
      },
      turbulentDistortion: {
        uniforms: turbulentUniforms,
        getDistortion: `
          uniform vec4 uFreq;
          uniform vec4 uAmp;
          float nsin(float val){
            return sin(val) * 0.5 + 0.5;
          }
          #define PI 3.14159265358979
          float getDistortionX(float progress){
            return (
              cos(PI * progress * uFreq.r + uTime) * uAmp.r +
              pow(cos(PI * progress * uFreq.g + uTime * (uFreq.g / uFreq.r)), 2. ) * uAmp.g
            );
          }
          float getDistortionY(float progress){
            return (
              -nsin(PI * progress * uFreq.b + uTime) * uAmp.b +
              -pow(nsin(PI * progress * uFreq.a + uTime / (uFreq.b / uFreq.a)), 5.) * uAmp.a
            );
          }
          vec3 getDistortion(float progress){
            return vec3(
              getDistortionX(progress) - getDistortionX(0.0125),
              getDistortionY(progress) - getDistortionY(0.0125),
              0.
            );
          }
        `,
        getJS: (progress, time) => {
          const uFreq = turbulentUniforms.uFreq.value;
          const uAmp = turbulentUniforms.uAmp.value;
          const getX = p =>
            Math.cos(Math.PI * p * uFreq.x + time) * uAmp.x +
            Math.pow(Math.cos(Math.PI * p * uFreq.y + time * (uFreq.y / uFreq.x)), 2) * uAmp.y;
          const getY = p =>
            -nsin(Math.PI * p * uFreq.z + time) * uAmp.z -
            Math.pow(nsin(Math.PI * p * uFreq.w + time / (uFreq.z / uFreq.w)), 5) * uAmp.w;
          let distortion = new THREE.Vector3(
            getX(progress) - getX(progress + 0.007),
            getY(progress) - getY(progress + 0.007),
            0
          );
          let lookAtAmp = new THREE.Vector3(-2, -5, 0);
          let lookAtOffset = new THREE.Vector3(0, 0, -10);
          return distortion.multiply(lookAtAmp).add(lookAtOffset);
        }
      },
      deepDistortion: {
        uniforms: deepUniforms,
        getDistortion: `
          uniform vec4 uFreq;
          uniform vec4 uAmp;
          uniform vec2 uPowY;
          float nsin(float val){
            return sin(val) * 0.5 + 0.5;
          }
          #define PI 3.14159265358979
          float getDistortionX(float progress){
            return (
              sin(progress * PI * uFreq.x + uTime) * uAmp.x
            );
          }
          float getDistortionY(float progress){
            return (
              pow(abs(progress * uPowY.x), uPowY.y) + sin(progress * PI * uFreq.y + uTime) * uAmp.y
            );
          }
          vec3 getDistortion(float progress){
            return vec3(
              getDistortionX(progress) - getDistortionX(0.02),
              getDistortionY(progress) - getDistortionY(0.02),
              0.
            );
          }
        `,
        getJS: (progress, time) => {
          const uFreq = deepUniforms.uFreq.value;
          const uAmp = deepUniforms.uAmp.value;
          const uPowY = deepUniforms.uPowY.value;
          const getX = p => Math.sin(p * Math.PI * uFreq.x + time) * uAmp.x;
          const getY = p => Math.pow(p * uPowY.x, uPowY.y) + Math.sin(p * Math.PI * uFreq.y + time) * uAmp.y;
          let distortion = new THREE.Vector3(
            getX(progress) - getX(progress + 0.01),
            getY(progress) - getY(progress + 0.01),
            0
          );
          let lookAtAmp = new THREE.Vector3(-2, -4, 0);
          let lookAtOffset = new THREE.Vector3(0, 0, -10);
          return distortion.multiply(lookAtAmp).add(lookAtOffset);
        }
      }
    };
  };

  // CarLights Class
  class CarLights {
    constructor(webgl, options, colors, speed, fade) {
      this.webgl = webgl;
      this.options = options;
      this.colors = colors;
      this.speed = speed;
      this.fade = fade;
    }

    init() {
      const options = this.options;
      let curve = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
      let geometry = new THREE.TubeGeometry(curve, 40, 1, 8, false);
      let instanced = new THREE.InstancedBufferGeometry().copy(geometry);
      instanced.instanceCount = options.lightPairsPerRoadWay * 2;

      let laneWidth = options.roadWidth / options.lanesPerRoad;
      let aOffset = [];
      let aMetrics = [];
      let aColor = [];

      let colors = this.colors;
      if (Array.isArray(colors)) {
        colors = colors.map(c => new THREE.Color(c));
      } else {
        colors = new THREE.Color(colors);
      }

      for (let i = 0; i < options.lightPairsPerRoadWay; i++) {
        let radius = random(options.carLightsRadius);
        let length = random(options.carLightsLength);
        let speed = random(this.speed);
        let carLane = i % options.lanesPerRoad;
        let laneX = carLane * laneWidth - options.roadWidth / 2 + laneWidth / 2;
        let carWidth = random(options.carWidthPercentage) * laneWidth;
        let carShiftX = random(options.carShiftX) * laneWidth;
        laneX += carShiftX;
        let offsetY = random(options.carFloorSeparation) + radius * 1.3;
        let offsetZ = -random(options.length);

        aOffset.push(laneX - carWidth / 2);
        aOffset.push(offsetY);
        aOffset.push(offsetZ);
        aOffset.push(laneX + carWidth / 2);
        aOffset.push(offsetY);
        aOffset.push(offsetZ);

        aMetrics.push(radius);
        aMetrics.push(length);
        aMetrics.push(speed);
        aMetrics.push(radius);
        aMetrics.push(length);
        aMetrics.push(speed);

        let color = pickRandom(colors);
        aColor.push(color.r);
        aColor.push(color.g);
        aColor.push(color.b);
        aColor.push(color.r);
        aColor.push(color.g);
        aColor.push(color.b);
      }

      instanced.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(aOffset), 3, false));
      instanced.setAttribute('aMetrics', new THREE.InstancedBufferAttribute(new Float32Array(aMetrics), 3, false));
      instanced.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(aColor), 3, false));

      let material = new THREE.ShaderMaterial({
        fragmentShader: carLightsFragment,
        vertexShader: carLightsVertex,
        transparent: true,
        uniforms: Object.assign(
          {
            uTime: { value: 0 },
            uTravelLength: { value: options.length },
            uFade: { value: this.fade }
          },
          this.webgl.fogUniforms,
          this.options.distortion.uniforms
        )
      });

      material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <getDistortion_vertex>',
          this.options.distortion.getDistortion
        );
      };

      let mesh = new THREE.Mesh(instanced, material);
      mesh.frustumCulled = false;
      this.webgl.scene.add(mesh);
      this.mesh = mesh;
    }

    update(time) {
      this.mesh.material.uniforms.uTime.value = time;
    }
  }

  // LightsSticks Class
  class LightsSticks {
    constructor(webgl, options) {
      this.webgl = webgl;
      this.options = options;
    }

    init() {
      const options = this.options;
      const geometry = new THREE.PlaneGeometry(1, 1);
      let instanced = new THREE.InstancedBufferGeometry().copy(geometry);
      let totalSticks = options.totalSideLightSticks;
      instanced.instanceCount = totalSticks;

      let stickoffset = options.length / (totalSticks - 1);
      const aOffset = [];
      const aColor = [];
      const aMetrics = [];

      let colors = options.colors.sticks;
      if (Array.isArray(colors)) {
        colors = colors.map(c => new THREE.Color(c));
      } else {
        colors = new THREE.Color(colors);
      }

      for (let i = 0; i < totalSticks; i++) {
        let width = random(options.lightStickWidth);
        let height = random(options.lightStickHeight);
        aOffset.push((i - 1) * stickoffset * 2 + stickoffset * Math.random());
        let color = pickRandom(colors);
        aColor.push(color.r);
        aColor.push(color.g);
        aColor.push(color.b);
        aMetrics.push(width);
        aMetrics.push(height);
      }

      instanced.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(aOffset), 1, false));
      instanced.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(aColor), 3, false));
      instanced.setAttribute('aMetrics', new THREE.InstancedBufferAttribute(new Float32Array(aMetrics), 2, false));

      const material = new THREE.ShaderMaterial({
        fragmentShader: sideSticksFragment,
        vertexShader: sideSticksVertex,
        side: THREE.DoubleSide,
        uniforms: Object.assign(
          {
            uTravelLength: { value: options.length },
            uTime: { value: 0 }
          },
          this.webgl.fogUniforms,
          this.options.distortion.uniforms
        )
      });

      material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <getDistortion_vertex>',
          this.options.distortion.getDistortion
        );
      };

      const mesh = new THREE.Mesh(instanced, material);
      mesh.frustumCulled = false;
      this.webgl.scene.add(mesh);
      this.mesh = mesh;
    }

    update(time) {
      this.mesh.material.uniforms.uTime.value = time;
    }
  }

  // Road Class
  class Road {
    constructor(webgl, options) {
      this.webgl = webgl;
      this.options = options;
      this.uTime = { value: 0 };
    }

    createPlane(side, width, isRoad) {
      const options = this.options;
      let segments = 100;
      const geometry = new THREE.PlaneGeometry(
        isRoad ? options.roadWidth : options.islandWidth,
        options.length,
        20,
        segments
      );

      let uniforms = {
        uTravelLength: { value: options.length },
        uColor: { value: new THREE.Color(isRoad ? options.colors.roadColor : options.colors.islandColor) },
        uTime: this.uTime
      };

      if (isRoad) {
        uniforms = Object.assign(uniforms, {
          uLanes: { value: options.lanesPerRoad },
          uBrokenLinesColor: { value: new THREE.Color(options.colors.brokenLines) },
          uShoulderLinesColor: { value: new THREE.Color(options.colors.shoulderLines) },
          uShoulderLinesWidthPercentage: { value: options.shoulderLinesWidthPercentage },
          uBrokenLinesLengthPercentage: { value: options.brokenLinesLengthPercentage },
          uBrokenLinesWidthPercentage: { value: options.brokenLinesWidthPercentage }
        });
      }

      const material = new THREE.ShaderMaterial({
        fragmentShader: isRoad ? roadFragment : islandFragment,
        vertexShader: roadVertex,
        side: THREE.DoubleSide,
        uniforms: Object.assign(uniforms, this.webgl.fogUniforms, options.distortion.uniforms)
      });

      material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <getDistortion_vertex>',
          options.distortion.getDistortion
        );
      };

      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.z = -options.length / 2;
      mesh.position.x += (this.options.islandWidth / 2 + options.roadWidth / 2) * side;
      this.webgl.scene.add(mesh);
      return mesh;
    }

    init() {
      this.leftRoadWay = this.createPlane(-1, this.options.roadWidth, true);
      this.rightRoadWay = this.createPlane(1, this.options.roadWidth, true);
      this.island = this.createPlane(0, this.options.islandWidth, false);
    }

    update(time) {
      this.uTime.value = time;
    }
  }

  // Main App Class
  class HyperspeedApp {
    constructor(container, options = {}) {
      this.options = options;
      this.container = container;
      this.renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true
      });
      // Ensure container has size
      const width = container.offsetWidth || window.innerWidth;
      const height = container.offsetHeight || window.innerHeight;
      
      console.log('HyperspeedApp: Container size:', width, 'x', height);
      
      this.renderer.setSize(width, height, false);
      this.renderer.setPixelRatio(window.devicePixelRatio);
      
      // Make canvas full screen and transparent
      this.renderer.domElement.style.position = 'fixed';
      this.renderer.domElement.style.top = '0';
      this.renderer.domElement.style.left = '0';
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.renderer.domElement.style.zIndex = '0';
      this.renderer.domElement.style.pointerEvents = 'none';
      
      // Get postprocessing - try different ways it might be exposed
      const PP = window.postprocessing || window.PP || (typeof postprocessing !== 'undefined' ? postprocessing : null);
      if (!PP) {
        console.error('postprocessing not available');
        console.error('window.postprocessing:', typeof window.postprocessing);
        console.error('window.PP:', typeof window.PP);
        console.error('postprocessing:', typeof postprocessing);
        throw new Error('postprocessing library not loaded');
      }
      
      console.log('HyperspeedApp: postprocessing library found:', PP);
      console.log('HyperspeedApp: Creating EffectComposer...');
      try {
        this.composer = new PP.EffectComposer(this.renderer);
        console.log('HyperspeedApp: EffectComposer created');
      } catch (e) {
        console.error('HyperspeedApp: Error creating EffectComposer:', e);
        throw e;
      }
      this.PP = PP; // Store for later use
      container.append(this.renderer.domElement);
      console.log('HyperspeedApp: Renderer DOM element added to container');

      const aspect = (container.offsetWidth && container.offsetHeight) 
        ? container.offsetWidth / container.offsetHeight 
        : window.innerWidth / window.innerHeight;
      
      this.camera = new THREE.PerspectiveCamera(
        options.fov,
        aspect,
        0.1,
        10000
      );
      this.camera.position.z = -5;
      this.camera.position.y = 8;
      this.camera.position.x = 0;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x000000);

      let fog = new THREE.Fog(options.colors.background, options.length * 0.2, options.length * 500);
      this.scene.fog = fog;

      this.fogUniforms = {
        fogColor: { value: fog.color },
        fogNear: { value: fog.near },
        fogFar: { value: fog.far }
      };

      this.clock = new THREE.Clock();
      this.assets = {};
      this.disposed = false;

      this.road = new Road(this, options);
      this.leftCarLights = new CarLights(
        this,
        options,
        options.colors.leftCars,
        options.movingAwaySpeed,
        new THREE.Vector2(0, 1 - options.carLightsFade)
      );
      this.rightCarLights = new CarLights(
        this,
        options,
        options.colors.rightCars,
        options.movingCloserSpeed,
        new THREE.Vector2(1, 0 + options.carLightsFade)
      );
      this.leftSticks = new LightsSticks(this, options);

      this.fovTarget = options.fov;
      this.speedUpTarget = 0;
      this.speedUp = 0;
      this.timeOffset = 0;
      this.tick = this.tick.bind(this);
      this.init = this.init.bind(this);
      this.setSize = this.setSize.bind(this);
      this.onMouseDown = this.onMouseDown.bind(this);
      this.onMouseUp = this.onMouseUp.bind(this);
      this.onTouchStart = this.onTouchStart.bind(this);
      this.onTouchEnd = this.onTouchEnd.bind(this);
      this.onContextMenu = this.onContextMenu.bind(this);

      window.addEventListener('resize', this.onWindowResize.bind(this));
    }

    onWindowResize() {
      const width = this.container.offsetWidth;
      const height = this.container.offsetHeight;
      this.renderer.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.composer.setSize(width, height);
    }

    initPasses() {
      const PP = this.PP;
      this.renderPass = new PP.RenderPass(this.scene, this.camera);
      this.bloomPass = new PP.EffectPass(
        this.camera,
        new PP.BloomEffect({
          luminanceThreshold: 0.2,
          luminanceSmoothing: 0,
          resolutionScale: 1
        })
      );

      const smaaPass = new PP.EffectPass(
        this.camera,
        new PP.SMAAEffect({
          preset: PP.SMAAPreset.MEDIUM,
          searchImage: PP.SMAAEffect.searchImageDataURL,
          areaImage: PP.SMAAEffect.areaImageDataURL
        })
      );

      this.renderPass.renderToScreen = false;
      this.bloomPass.renderToScreen = false;
      smaaPass.renderToScreen = true;

      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(smaaPass);
    }

    loadAssets() {
      const assets = this.assets;
      return new Promise(resolve => {
        const manager = new THREE.LoadingManager(resolve);
        const searchImage = new Image();
        const areaImage = new Image();
        assets.smaa = {};

        searchImage.addEventListener('load', function () {
          assets.smaa.search = this;
          manager.itemEnd('smaa-search');
        });

        areaImage.addEventListener('load', function () {
          assets.smaa.area = this;
          manager.itemEnd('smaa-area');
        });

        manager.itemStart('smaa-search');
        manager.itemStart('smaa-area');

        const PP = this.PP;
        searchImage.src = PP.SMAAEffect.searchImageDataURL;
        areaImage.src = PP.SMAAEffect.areaImageDataURL;
      });
    }

    init() {
      try {
        console.log('HyperspeedApp.init: Starting initialization...');
        this.initPasses();
        console.log('HyperspeedApp.init: Passes initialized');
        const options = this.options;
        this.road.init();
        console.log('HyperspeedApp.init: Road initialized');
        this.leftCarLights.init();
        this.leftCarLights.mesh.position.setX(-options.roadWidth / 2 - options.islandWidth / 2);
        console.log('HyperspeedApp.init: Left car lights initialized');
        this.rightCarLights.init();
        this.rightCarLights.mesh.position.setX(options.roadWidth / 2 + options.islandWidth / 2);
        console.log('HyperspeedApp.init: Right car lights initialized');
        this.leftSticks.init();
        this.leftSticks.mesh.position.setX(-(options.roadWidth + options.islandWidth / 2));
        console.log('HyperspeedApp.init: Light sticks initialized');

        this.container.addEventListener('mousedown', this.onMouseDown);
        this.container.addEventListener('mouseup', this.onMouseUp);
        this.container.addEventListener('mouseout', this.onMouseUp);
        this.container.addEventListener('touchstart', this.onTouchStart, { passive: true });
        this.container.addEventListener('touchend', this.onTouchEnd, { passive: true });
        this.container.addEventListener('touchcancel', this.onTouchEnd, { passive: true });
        this.container.addEventListener('contextmenu', this.onContextMenu);

        console.log('HyperspeedApp.init: Starting animation loop...');
        this.tick();
        console.log('HyperspeedApp.init: Initialization complete!');
      } catch (error) {
        console.error('HyperspeedApp.init: Error during initialization:', error);
        console.error('Stack:', error.stack);
        throw error;
      }
    }

    onMouseDown(ev) {
      if (this.options.onSpeedUp) this.options.onSpeedUp(ev);
      this.fovTarget = this.options.fovSpeedUp;
      this.speedUpTarget = this.options.speedUp;
    }

    onMouseUp(ev) {
      if (this.options.onSlowDown) this.options.onSlowDown(ev);
      this.fovTarget = this.options.fov;
      this.speedUpTarget = 0;
    }

    onTouchStart(ev) {
      if (this.options.onSpeedUp) this.options.onSpeedUp(ev);
      this.fovTarget = this.options.fovSpeedUp;
      this.speedUpTarget = this.options.speedUp;
    }

    onTouchEnd(ev) {
      if (this.options.onSlowDown) this.options.onSlowDown(ev);
      this.fovTarget = this.options.fov;
      this.speedUpTarget = 0;
    }

    onContextMenu(ev) {
      ev.preventDefault();
    }

    update(delta) {
      let lerpPercentage = Math.exp(-(-60 * Math.log2(1 - 0.1)) * delta);
      this.speedUp += lerp(this.speedUp, this.speedUpTarget, lerpPercentage, 0.00001);
      this.timeOffset += this.speedUp * delta;
      let time = this.clock.elapsedTime + this.timeOffset;

      this.rightCarLights.update(time);
      this.leftCarLights.update(time);
      this.leftSticks.update(time);
      this.road.update(time);

      let updateCamera = false;
      let fovChange = lerp(this.camera.fov, this.fovTarget, lerpPercentage);

      if (fovChange !== 0) {
        this.camera.fov += fovChange * delta * 6;
        updateCamera = true;
      }

      if (this.options.distortion && this.options.distortion.getJS) {
        const distortion = this.options.distortion.getJS(0.025, time);
        this.camera.lookAt(
          new THREE.Vector3(
            this.camera.position.x + distortion.x,
            this.camera.position.y + distortion.y,
            this.camera.position.z + distortion.z
          )
        );
        updateCamera = true;
      }

      if (updateCamera) {
        this.camera.updateProjectionMatrix();
      }
    }

    render(delta) {
      this.composer.render(delta);
    }

    dispose() {
      this.disposed = true;
      if (this.renderer) {
        this.renderer.dispose();
      }
      if (this.composer) {
        this.composer.dispose();
      }
      if (this.scene) {
        this.scene.clear();
      }
      window.removeEventListener('resize', this.onWindowResize.bind(this));
      if (this.container) {
        this.container.removeEventListener('mousedown', this.onMouseDown);
        this.container.removeEventListener('mouseup', this.onMouseUp);
        this.container.removeEventListener('mouseout', this.onMouseUp);
        this.container.removeEventListener('touchstart', this.onTouchStart);
        this.container.removeEventListener('touchend', this.onTouchEnd);
        this.container.removeEventListener('touchcancel', this.onTouchEnd);
        this.container.removeEventListener('contextmenu', this.onContextMenu);
      }
    }

    setSize(width, height, updateStyles) {
      this.composer.setSize(width, height, updateStyles);
    }

    tick() {
      if (this.disposed || !this) return;

      if (resizeRendererToDisplaySize(this.renderer, this.setSize)) {
        const canvas = this.renderer.domElement;
        this.camera.aspect = canvas.clientWidth / canvas.clientHeight;
        this.camera.updateProjectionMatrix();
      }

      const delta = this.clock.getDelta();
      this.render(delta);
      this.update(delta);
      requestAnimationFrame(this.tick);
    }
  }

  // Main HyperspeedAnimation Class
  window.HyperspeedAnimation = class HyperspeedAnimation {
    constructor(container, options = {}) {
      this.container = container;
      
      // Merge options with defaults
      this.options = {
        onSpeedUp: options.onSpeedUp || (() => {}),
        onSlowDown: options.onSlowDown || (() => {}),
        distortion: options.distortion || 'turbulentDistortion',
        length: options.length || 400,
        roadWidth: options.roadWidth || 10,
        islandWidth: options.islandWidth || 2,
        lanesPerRoad: options.lanesPerRoad || 4,
        fov: options.fov || 90,
        fovSpeedUp: options.fovSpeedUp || 150,
        speedUp: options.speedUp || 2,
        carLightsFade: options.carLightsFade || 0.4,
        totalSideLightSticks: options.totalSideLightSticks || 20,
        lightPairsPerRoadWay: options.lightPairsPerRoadWay || 40,
        shoulderLinesWidthPercentage: options.shoulderLinesWidthPercentage || 0.05,
        brokenLinesWidthPercentage: options.brokenLinesWidthPercentage || 0.1,
        brokenLinesLengthPercentage: options.brokenLinesLengthPercentage || 0.5,
        lightStickWidth: options.lightStickWidth || [0.12, 0.5],
        lightStickHeight: options.lightStickHeight || [1.3, 1.7],
        movingAwaySpeed: options.movingAwaySpeed || [60, 80],
        movingCloserSpeed: options.movingCloserSpeed || [-120, -160],
        carLightsLength: options.carLightsLength || [400 * 0.03, 400 * 0.2],
        carLightsRadius: options.carLightsRadius || [0.05, 0.14],
        carWidthPercentage: options.carWidthPercentage || [0.3, 0.5],
        carShiftX: options.carShiftX || [-0.8, 0.8],
        carFloorSeparation: options.carFloorSeparation || [0, 5],
        colors: options.colors || {
          roadColor: 0x080808,
          islandColor: 0x0a0a0a,
          background: 0x000000,
          shoulderLines: 0xFFFFFF,
          brokenLines: 0xFFFFFF,
          leftCars: [0xD856BF, 0x6750A2, 0xC247AC],
          rightCars: [0x03B3C3, 0x0E5EA5, 0x324555],
          sticks: 0x03B3C3,
        }
      };
      
      // Create distortions when THREE is available
      this.distortions = null;
      this.app = null;
      this.init();
    }
    
    async init() {
      // Check if libraries are loaded
      if (typeof THREE === 'undefined') {
        console.log('Waiting for THREE...');
        setTimeout(() => this.init(), 100);
        return;
      }
      
      // Check for postprocessing - it might be PP or postprocessing
      const pp = window.postprocessing || window.PP;
      if (!pp) {
        console.log('Waiting for postprocessing...', typeof postprocessing, typeof PP);
        setTimeout(() => this.init(), 100);
        return;
      }
      
      console.log('Libraries loaded, setting up distortion...');
      
      // Create distortions now that THREE is available
      if (!this.distortions) {
        this.distortions = createDistortions();
      }
      
      // Set up distortion
      const distortionName = this.options.distortion;
      this.options.distortion = this.distortions[distortionName] || this.distortions.turbulentDistortion;
      
      if (!this.options.distortion) {
        console.error('Distortion not found:', distortionName);
        return;
      }

      console.log('Initializing HyperspeedApp...');
      // Initialize the App
      this.app = new HyperspeedApp(this.container, this.options);
      console.log('Loading assets...');
      await this.app.loadAssets();
      console.log('Initializing app...');
      this.app.init();
      console.log('Hyperspeed animation initialized!');
    }
    
    dispose() {
      if (this.app && this.app.dispose) {
        this.app.dispose();
      }
      this.app = null;
    }
  };

})();
