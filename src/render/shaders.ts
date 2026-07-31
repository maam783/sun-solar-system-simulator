/**
 * GLSL for the custom materials.
 *
 * Besides the depth chunks, every fragment shader here ends with three's
 * `tonemapping_fragment` and `colorspace_fragment`. A ShaderMaterial does not
 * apply those for free the way the built-in materials do, and without them the
 * renderer's exposure setting does nothing and linear values are written
 * straight to an sRGB target — which looks like a correctly lit planet with
 * the lights off. Only the body chunks belong here: three already injects the
 * matching `_pars_` declarations into the fragment prefix, and including them
 * a second time is a redefinition error that fails the whole shader.
 *
 * Every shader here includes three's `logdepthbuf` chunks. With a logarithmic
 * depth buffer the depth value is written by that chunk rather than by the
 * fixed pipeline, so a custom shader that omits it sorts against the built-in
 * materials as if it were at the wrong distance entirely — planets punching
 * through each other at random.
 *
 * There are no scene lights. Illumination comes from a single uniform holding
 * the Sun's position relative to the camera, which suits a scene where the
 * only light source is a body that is itself being rendered.
 */

export const PLANET_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;

/**
 * Planet surface.
 *
 * Falls back to procedural detail when a texture failed to download: banded
 * turbulence for gas giants, cratered noise for rocky bodies. The bands are
 * generated in latitude so they line up with the real rotation axis.
 */
export const PLANET_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uSunPos;
  uniform vec3 uBaseColor;
  uniform float uIrradiance;
  uniform sampler2D uMap;
  uniform bool uHasMap;
  uniform sampler2D uNightMap;
  uniform bool uHasNight;
  uniform bool uIsGasGiant;
  uniform bool uIsStar;
  uniform float uSeed;
  uniform float uRoughnessDetail;

  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec2 vUv;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    #include <logdepthbuf_fragment>

    vec3 n = normalize(vNormalW);
    vec3 albedo = uBaseColor;

    if (uHasMap) {
      albedo = texture2D(uMap, vUv).rgb;
    } else {
      // Procedural stand-in, used when the texture download failed.
      vec3 q = n * (uIsGasGiant ? 3.0 : 8.0) + uSeed;
      if (uIsGasGiant) {
        // Latitude bands, warped by turbulence so they swirl like real ones.
        float band = sin(n.y * 26.0 + fbm(q * 1.7) * 5.0);
        float storm = fbm(q * 3.1);
        albedo = uBaseColor * (0.78 + 0.30 * band + 0.22 * storm);
      } else {
        float craters = fbm(q * 2.2);
        float detail = fbm(q * 9.0);
        albedo = uBaseColor * (0.72 + 0.5 * craters + 0.18 * detail * uRoughnessDetail);
      }
    }

    vec3 toSun = normalize(uSunPos - vPosW);
    float lambert = max(dot(n, toSun), 0.0);

    // A touch of wrap lighting keeps the terminator from going pitch black in
    // one pixel, which is closer to how a real limb reads than a hard cut.
    float lit = clamp((lambert + 0.06) / 1.06, 0.0, 1.0);

    vec3 color = albedo * lit * uIrradiance;

    // City lights, and a faint floor so the night side is a silhouette rather
    // than a hole. Both are scaled by the local sunlight like everything else.
    //
    // Adding either *outside* uIrradiance makes it an absolute value that the
    // adaptive exposure then multiplies. At Jupiter that put the night side at
    // a third of the day side, so the planet looked lit from every direction at
    // once; at Pluto, where the exposure opens 480x against a sunlight of
    // 1/1500, the night side came out brighter than the day side.
    //
    // The lights are emitted, not reflected, so leaving them unscaled looks
    // like the honest choice — but the 1.4 is a legibility figure chosen at
    // Earth's own irradiance, where real city lights are some five orders of
    // magnitude below daylight. Carrying that fudge to a twenty-eighth of the
    // sunlight turned a body 5 AU out into a lamp: the whole night side filled
    // in, so it read as fully lit and brighter than the planet beside it.
    // Scaling keeps the ratio it was tuned to.
    if (uHasNight && lambert < 0.12) {
      float nightAmount = smoothstep(0.12, -0.05, lambert);
      color += texture2D(uNightMap, vUv).rgb * nightAmount * 1.4 * uIrradiance;
    }

    color += albedo * 0.015 * uIrradiance;

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * The Sun's disc: limb darkening from the standard quadratic law, so the edge
 * is visibly dimmer and redder than the centre, exactly as it looks.
 */
export const SUN_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uCameraPosW;
  uniform float uTime;
  uniform float uIrradiance;
  uniform sampler2D uMap;
  uniform bool uHasMap;

  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec2 vUv;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  void main() {
    #include <logdepthbuf_fragment>

    vec3 n = normalize(vNormalW);
    vec3 toEye = normalize(uCameraPosW - vPosW);
    float mu = max(dot(n, toEye), 0.0);

    // Quadratic limb darkening, I(mu)/I(1) = 1 - u1(1-mu) - u2(1-mu)^2,
    // with visible-band coefficients for the Sun.
    float u1 = 0.47;
    float u2 = 0.23;
    float d = 1.0 - mu;
    float intensity = 1.0 - u1 * d - u2 * d * d;
    intensity = max(intensity, 0.0);

    // Surface detail. The photosphere image is mip-mapped, so it stays put as
    // the ship closes; the procedural fallback is deliberately coarse, because
    // fine 3D noise aliases into big drifting blotches when the disc is small
    // and then resolves as you approach - which reads as the surface shrinking.
    float detail;
    if (uHasMap) {
      detail = dot(texture2D(uMap, vUv).rgb, vec3(0.333)) * 1.15;
    } else {
      detail = 0.94 + 0.12 * noise(n * 22.0 + vec3(0.0, 0.0, uTime * 0.02));
    }
    intensity *= clamp(detail, 0.5, 1.35);

    // The limb is cooler, so it reddens as it dims.
    vec3 core = vec3(1.0, 0.97, 0.92);
    vec3 limb = vec3(1.0, 0.62, 0.26);
    vec3 color = mix(limb, core, pow(clamp(intensity, 0.0, 1.0), 0.6));

    gl_FragColor = vec4(color * intensity * uIrradiance, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Atmospheric limb: a thin shell whose brightness peaks at the edge. */
export const ATMOSPHERE_VERT = PLANET_VERT;

export const ATMOSPHERE_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uSunPos;
  uniform vec3 uCameraPosW;
  uniform vec3 uColor;
  uniform float uIrradiance;

  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec2 vUv;

  void main() {
    #include <logdepthbuf_fragment>

    vec3 n = normalize(vNormalW);
    vec3 toEye = normalize(uCameraPosW - vPosW);
    vec3 toSun = normalize(uSunPos - vPosW);

    // Grazing rays travel through far more air, which is why the limb glows.
    float rim = pow(1.0 - max(dot(n, toEye), 0.0), 2.2);
    float lit = max(dot(n, toSun), 0.0);
    // Forward scattering: the crescent is brightest looking back toward the Sun.
    float forward = pow(max(dot(toEye, -toSun), 0.0), 2.0) * 0.5 + 1.0;

    float alpha = rim * clamp(lit * 1.3, 0.0, 1.0) * forward;
    gl_FragColor = vec4(uColor * uIrradiance, clamp(alpha, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Saturn's rings, including the planet's shadow falling across them. */
export const RING_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vPosW;
  varying vec3 vLocal;

  void main() {
    vLocal = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;

export const RING_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uSunPos;
  uniform vec3 uPlanetPosW;
  uniform float uPlanetRadius;
  uniform float uInner;
  uniform float uOuter;
  uniform vec3 uColor;
  uniform float uIrradiance;
  uniform sampler2D uMap;
  uniform bool uHasMap;

  varying vec3 vPosW;
  varying vec3 vLocal;

  float hash(float x) { return fract(sin(x * 127.1) * 43758.5453); }

  void main() {
    #include <logdepthbuf_fragment>

    float r = length(vLocal);
    float u = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);

    float density;
    vec3 tint;
    if (uHasMap) {
      vec4 texel = texture2D(uMap, vec2(u, 0.5));
      density = texel.a;
      tint = texel.rgb;
    } else {
      // Procedural banding, with the Cassini Division cut where it belongs.
      float bands = 0.0;
      for (float i = 1.0; i < 7.0; i += 1.0) {
        bands += sin(u * (18.0 * i) + hash(i) * 6.28) * (0.16 / i);
      }
      density = clamp(0.62 + bands, 0.0, 1.0);
      density *= smoothstep(0.0, 0.04, u) * smoothstep(1.0, 0.94, u);
      // Cassini Division: a real gap at about 62% of the way out.
      density *= 1.0 - 0.85 * exp(-pow((u - 0.62) / 0.035, 2.0));
      tint = uColor * (0.85 + 0.3 * density);
    }

    // Planet shadow: the ring point is eclipsed when it lies behind the planet
    // along the direction to the Sun.
    vec3 toSun = normalize(uSunPos - vPosW);
    vec3 rel = vPosW - uPlanetPosW;
    float along = dot(rel, toSun);
    float shadow = 1.0;
    if (along < 0.0) {
      float perp = length(rel - toSun * along);
      shadow = smoothstep(uPlanetRadius * 0.96, uPlanetRadius * 1.06, perp);
    }
    shadow = mix(0.14, 1.0, shadow);

    gl_FragColor = vec4(tint * uIrradiance * shadow, density);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Star field: one point per catalogue entry, sized by brightness. */
export const STAR_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uPixelRatio;
  attribute float aSize;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vSize;

  void main() {
    vColor = aColor;
    vSize = aSize;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * world;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio;
    #include <logdepthbuf_vertex>
  }
`;

export const STAR_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  varying vec3 vColor;
  varying float vSize;

  void main() {
    #include <logdepthbuf_fragment>
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    // Soft core with a faint halo, which reads as a star rather than a square.
    float core = exp(-r * r * 5.0);
    float halo = exp(-r * 2.5) * 0.25;
    float a = clamp(core + halo, 0.0, 1.0);
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }
`;
