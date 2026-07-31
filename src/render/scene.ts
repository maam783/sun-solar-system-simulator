/**
 * The view out of the window.
 *
 * Two ideas carry the whole renderer:
 *
 *  1. **Floating origin.** The camera never moves. Every frame each body is
 *     placed at (body position - ship position), computed in f64 and only then
 *     narrowed to the f32 the GPU wants. Absolute coordinates would be hopeless
 *     — f32 has about seven digits, and the distance to Pluto in metres needs
 *     thirteen — but a *relative* coordinate shrinks as you approach, so the
 *     precision is always concentrated exactly where the detail is.
 *
 *  2. **Logarithmic depth.** The near plane is one metre and the far plane is
 *     ten thousand AU. A conventional depth buffer cannot span that; a
 *     logarithmic one can.
 *
 * Nothing here is scaled for legibility. Jupiter is 1.4e8 m across because
 * Jupiter is 1.4e8 m across, which is the entire point: from four radii out it
 * fills the window like a wall, and from Earth it is a dot you can cover with
 * a fingernail.
 */

import * as THREE from 'three';
import { RENDER, PHOTOMETRY } from '../config';
import { AU, BODIES, SATURN_RING_INNER, SATURN_RING_OUTER, getBody, type BodyPhysical } from '../data/constants';
import type { World } from '../sim/world';
import {
  angularDiameter, apparentMagnitude, apparentPixels, magnitudeToBrightness,
  solarIrradiance,
} from '../sim/photometry';
import { STARS } from '../data/stars';
import { colorIndexToRGB } from '../sim/photometry';
import {
  PLANET_VERT, PLANET_FRAG, SUN_FRAG, ATMOSPHERE_FRAG,
  RING_VERT, RING_FRAG, STAR_VERT, STAR_FRAG,
} from './shaders';
import { vec, sub, len, normalize, dot, type Vec3 } from '../math/vec3d';
import { toQuaternion } from '../math/mat3d';

const relPos = vec();
const sunRel = vec();
const dirA = vec();
const dirB = vec();
const quatScratch = [0, 0, 0, 1];

interface BodyView {
  def: BodyPhysical;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  atmosphere: THREE.Mesh | null;
  ring: THREE.Mesh | null;
  sprite: THREE.Sprite;
  spriteMaterial: THREE.SpriteMaterial;
  /** LOD index currently applied. */
  lod: number;
}

/**
 * Radial-gradient texture for point sources and the solar glare.
 *
 * `warm` tints the falloff for the Sun's glare. Everything else gets a neutral
 * white gradient, so the sprite's own colour decides the hue — otherwise every
 * distant body reads as the same yellow blob regardless of what it is.
 */
const makeGlowTexture = (softness: number, warm = false): THREE.Texture => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const mid = warm ? '255,246,224' : '255,255,255';
  const outer = warm ? '255,230,190' : '255,255,255';
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.12 * softness, `rgba(${mid},0.85)`);
  gradient.addColorStop(0.35 * softness, `rgba(${mid},0.28)`);
  gradient.addColorStop(0.7, `rgba(${outer},0.05)`);
  gradient.addColorStop(1, `rgba(${outer},0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

export class SolarSystemRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly views = new Map<string, BodyView>();
  private readonly geometries = new Map<number, THREE.SphereGeometry>();
  private sunGlare!: THREE.Sprite;
  private stars!: THREE.Points;
  private glowTexture!: THREE.Texture;

  private contextLost = false;
  /** Set when the GL context is lost so the caller can surface it. */
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;

  texturesLoaded = 0;
  texturesFailed = 0;

  /**
   * Exposure, adapting the way an eye does.
   *
   * Sunlight at Jupiter is 1/27 of Earth's and at Pluto 1/1500, and the shader
   * applies that literally — which is correct radiometry and a black screen.
   * A real observer's eye (or a camera's exposure) opens up instead, so the
   * scene here is exposed for the local light level. The compensation is
   * deliberately partial, so the outer system still reads as dimmer rather
   * than being flattened to look like Earth orbit.
   */
  private exposure = 1;
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // The depth range here spans thirteen orders of magnitude; nothing else
      // gets the near and the far right at the same time.
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 1);

    this.camera = new THREE.PerspectiveCamera(
      RENDER.fov, 1, RENDER.near, RENDER.far);
    // The camera stays at the origin forever. Only its orientation changes.
    this.camera.position.set(0, 0, 0);

    this.glowTexture = makeGlowTexture(1);
    this.buildStars();
    this.buildBodies();
    this.buildSunGlare();
    this.installContextHandlers();
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private sphere(segments: number): THREE.SphereGeometry {
    let geometry = this.geometries.get(segments);
    if (!geometry) {
      geometry = new THREE.SphereGeometry(1, segments, Math.max(8, segments / 2));
      // three builds spheres with the poles on +/-Y; the IAU body frame puts
      // them on +/-Z. Rotating the geometry once here means the orientation
      // matrix can be used directly, and it leaves the equirectangular UVs
      // mapping longitude eastward from the prime meridian, as textures expect.
      geometry.rotateX(Math.PI / 2);
      this.geometries.set(segments, geometry);
    }
    return geometry;
  }

  private buildBodies(): void {
    for (const def of BODIES) {
      const isStar = def.kind === 'star';
      const isGasGiant = ['jupiter', 'saturn', 'uranus', 'neptune'].includes(def.id);

      const material = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERT,
        fragmentShader: isStar ? SUN_FRAG : PLANET_FRAG,
        uniforms: {
          uSunPos: { value: new THREE.Vector3() },
          uCameraPosW: { value: new THREE.Vector3() },
          uBaseColor: { value: new THREE.Color(def.color) },
          uIrradiance: { value: 1 },
          uMap: { value: null },
          uHasMap: { value: false },
          uNightMap: { value: null },
          uHasNight: { value: false },
          uIsGasGiant: { value: isGasGiant },
          uIsStar: { value: isStar },
          uSeed: { value: (def.id.charCodeAt(0) * 7.31) % 100 },
          uRoughnessDetail: { value: def.kind === 'moon' ? 1.4 : 1.0 },
          uTime: { value: 0 },
        },
      });

      const mesh = new THREE.Mesh(this.sphere(RENDER.lodSegments[1]!), material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 0;
      this.scene.add(mesh);

      let atmosphere: THREE.Mesh | null = null;
      if (def.atmosphere) {
        const atmoMaterial = new THREE.ShaderMaterial({
          vertexShader: PLANET_VERT,
          fragmentShader: ATMOSPHERE_FRAG,
          uniforms: {
            uSunPos: { value: new THREE.Vector3() },
            uCameraPosW: { value: new THREE.Vector3() },
            uColor: { value: new THREE.Color(def.atmosphereColor) },
            uIrradiance: { value: 1 },
          },
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.FrontSide,
        });
        atmosphere = new THREE.Mesh(this.sphere(48), atmoMaterial);
        atmosphere.frustumCulled = false;
        // Drawn after the surface so the glow sits on top of the limb.
        atmosphere.renderOrder = 1;
        this.scene.add(atmosphere);
      }

      let ring: THREE.Mesh | null = null;
      if (def.id === 'saturn') ring = this.buildRings(def);

      const spriteMaterial = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: new THREE.Color(def.color),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        sizeAttenuation: false,
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.frustumCulled = false;
      sprite.renderOrder = 2;
      this.scene.add(sprite);

      this.views.set(def.id, {
        def, mesh, material, atmosphere, ring, sprite, spriteMaterial, lod: 1,
      });
    }
  }

  private buildRings(def: BodyPhysical): THREE.Mesh {
    const geometry = new THREE.RingGeometry(SATURN_RING_INNER, SATURN_RING_OUTER, 256, 1);
    const material = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uSunPos: { value: new THREE.Vector3() },
        uPlanetPosW: { value: new THREE.Vector3() },
        uPlanetRadius: { value: def.radiusEq },
        uInner: { value: SATURN_RING_INNER },
        uOuter: { value: SATURN_RING_OUTER },
        uColor: { value: new THREE.Color(0xd8c9a8) },
        uIrradiance: { value: 1 },
        uMap: { value: null },
        uHasMap: { value: false },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    return mesh;
  }

  private buildSunGlare(): void {
    const material = new THREE.SpriteMaterial({
      map: makeGlowTexture(0.6, true),
      color: new THREE.Color(0xfff2d8),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Depth-tested so the glare disappears behind a planet, and faded
      // analytically as well so a partial eclipse dims it smoothly.
      depthTest: true,
      sizeAttenuation: false,
    });
    this.sunGlare = new THREE.Sprite(material);
    this.sunGlare.frustumCulled = false;
    this.sunGlare.renderOrder = 3;
    this.scene.add(this.sunGlare);
  }

  /**
   * Real stars from the HYG catalogue, placed on a shell far outside the
   * planetary system. They are fixed: at solar-system scale even Alpha
   * Centauri shows no measurable parallax from a ship at Pluto.
   */
  private buildStars(): void {
    const count = STARS.length / 4;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const R = RENDER.starDistance;

    for (let i = 0; i < count; i++) {
      const ra = STARS[i * 4]!;
      const dec = STARS[i * 4 + 1]!;
      const mag = STARS[i * 4 + 2]!;
      const ci = STARS[i * 4 + 3]!;

      // Catalogue coordinates are equatorial; the scene frame is ecliptic.
      const cd = Math.cos(dec);
      const xEq = cd * Math.cos(ra);
      const yEq = cd * Math.sin(ra);
      const zEq = Math.sin(dec);
      const eps = 23.43929111 * (Math.PI / 180);
      positions[i * 3] = R * xEq;
      positions[i * 3 + 1] = R * (Math.cos(eps) * yEq + Math.sin(eps) * zEq);
      positions[i * 3 + 2] = R * (-Math.sin(eps) * yEq + Math.cos(eps) * zEq);

      const brightness = magnitudeToBrightness(mag);
      const [r, g, b] = colorIndexToRGB(ci);
      colors[i * 3] = r * brightness;
      colors[i * 3 + 1] = g * brightness;
      colors[i * 3 + 2] = b * brightness;
      sizes[i] = 1.4 + 4.2 * brightness * brightness;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uPixelRatio: { value: this.renderer.getPixelRatio() } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.stars = new THREE.Points(geometry, material);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1;
    this.scene.add(this.stars);
  }

  // -------------------------------------------------------------------------
  // Textures
  // -------------------------------------------------------------------------

  /**
   * Load surface maps. Every body keeps working without them — the shader
   * falls back to procedural detail — so a failed download degrades the view
   * rather than breaking it.
   */
  loadTextures(basePath = './assets/textures'): void {
    const loader = new THREE.TextureLoader();
    const load = (file: string, onDone: (t: THREE.Texture) => void) => {
      loader.load(
        `${basePath}/${file}`,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
          onDone(texture);
          this.texturesLoaded++;
        },
        undefined,
        () => {
          this.texturesFailed++;
          console.warn(`[ASSETS] no texture for ${file}; using procedural surface`);
        },
      );
    };

    for (const view of this.views.values()) {
      load(`${view.def.id}.jpg`, (texture) => {
        view.material.uniforms.uMap!.value = texture;
        view.material.uniforms.uHasMap!.value = true;
      });
    }

    load('earth_night.jpg', (texture) => {
      const earth = this.views.get('earth');
      if (!earth) return;
      earth.material.uniforms.uNightMap!.value = texture;
      earth.material.uniforms.uHasNight!.value = true;
    });

    load('saturn_ring.png', (texture) => {
      const saturn = this.views.get('saturn');
      if (!saturn?.ring) return;
      const material = saturn.ring.material as THREE.ShaderMaterial;
      material.uniforms.uMap!.value = texture;
      material.uniforms.uHasMap!.value = true;
    });
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * Match the drawing buffer to the element. Checked every frame rather than
   * only on window resize events: the canvas can be laid out after the
   * renderer is constructed, or resized by something other than the window,
   * and either leaves the scene rendering into a corner of itself.
   */
  private syncSize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    // A hidden tab reports zero for both. Keep the last real size rather than
    // allocating a zero-sized buffer; the next visible frame corrects it.
    if (width <= 0 || height <= 0) return;
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.resize();
  }

  resize(): void {
    const stars = this.stars?.material as THREE.ShaderMaterial | undefined;
    if (stars?.uniforms.uPixelRatio) {
      stars.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    }
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setFov(fov: number): void {
    this.camera.fov = Math.max(RENDER.fovMin, Math.min(RENDER.fovMax, fov));
    this.camera.updateProjectionMatrix();
  }

  render(world: World): void {
    if (this.contextLost) return;
    this.syncSize();

    const shipPos = world.ship.pos;
    const height = this.renderer.domElement.height || 1;
    const fovRad = (this.camera.fov * Math.PI) / 180;

    // Orientation only: the camera's position is the origin, by construction.
    const q = world.ship.attitude;
    this.camera.quaternion.set(q[0], q[1], q[2], q[3]);

    this.updateExposure(world);

    // The Sun's position relative to the ship drives every lighting term.
    const sunState = world.bodyState('sun');
    sub(sunRel, sunState.pos, shipPos);
    const sunDistance = len(sunRel);
    const sunVector = new THREE.Vector3(sunRel.x, sunRel.y, sunRel.z);

    for (const view of this.views.values()) {
      this.updateBody(view, world, shipPos, sunVector, sunDistance, fovRad, height);
    }

    this.updateSunGlare(world, shipPos, sunRel, sunDistance, fovRad, height);

    this.renderer.render(this.scene, this.camera);
  }

  private updateExposure(world: World): void {
    // Light level where the ship is, relative to Earth's 1361 W/m^2.
    const distance = Math.max(len(world.ship.pos), getBody('sun').radius);
    const level = solarIrradiance(distance) / 1361;
    // Exponent below 1 leaves some of the real falloff visible.
    //
    // The floor matters more than it looks. A lit surface's radiance does not
    // depend on how far away the observer is - only the solid angle does - so
    // the Sun's disc emits the same value from Mercury as from Pluto. Letting
    // the exposure close arbitrarily far while approaching the Sun would
    // therefore make the Sun get *darker* as you fly into it. Stopping the
    // adaptation here keeps it blazing, which is both correct and the point.
    const target = Math.max(0.3, Math.min(4000, Math.pow(1 / level, 0.85)));
    // Adaptation takes a moment, as it does for eyes.
    this.exposure += (target - this.exposure) * 0.08;
    this.renderer.toneMappingExposure = this.exposure;
  }

  private updateBody(
    view: BodyView,
    world: World,
    shipPos: Vec3,
    sunVector: THREE.Vector3,
    _sunDistance: number,
    fovRad: number,
    viewportHeight: number,
  ): void {
    const state = world.bodyState(view.def.id);
    sub(relPos, state.pos, shipPos);
    const distance = Math.max(len(relPos), 1);

    // f64 subtraction first, f32 only for what the GPU sees. Near a body the
    // relative coordinate is small, so the f32 precision goes where it counts.
    const px = relPos.x;
    const py = relPos.y;
    const pz = relPos.z;

    const pixels = apparentPixels(view.def.radius, distance, fovRad, viewportHeight);
    const useMesh = pixels >= RENDER.impostorPixels;

    view.mesh.visible = useMesh;
    if (view.atmosphere) view.atmosphere.visible = useMesh && pixels > 8;
    if (view.ring) view.ring.visible = useMesh && pixels > 4;
    view.sprite.visible = !useMesh;

    // Sunlight falling on this body, normalised to Earth's 1361 W/m^2 so that
    // Pluto really does look dim and Mercury really does look harsh.
    // A lit surface is scaled by the sunlight falling on it. The Sun itself is
    // not lit by anything: it emits, at a radiance that does not vary with
    // where the observer stands.
    const irradiance = view.def.id === 'sun'
      ? 4
      : Math.min(6, solarIrradiance(len(state.pos)) / 1361);

    if (useMesh) {
      view.mesh.position.set(px, py, pz);
      const scaleEq = view.def.radiusEq;
      const scalePol = view.def.radiusPol;
      view.mesh.scale.set(scaleEq, scaleEq, scalePol);

      toQuaternion(state.orientation, quatScratch);
      view.mesh.quaternion.set(
        quatScratch[0]!, quatScratch[1]!, quatScratch[2]!, quatScratch[3]!);

      // Tessellate by apparent size: a body filling the screen needs far more
      // segments than one a few pixels across.
      const lod = pixels > 900 ? 4 : pixels > 300 ? 3 : pixels > 80 ? 2 : pixels > 16 ? 1 : 0;
      if (lod !== view.lod) {
        view.mesh.geometry = this.sphere(RENDER.lodSegments[lod]!);
        view.lod = lod;
      }

      const u = view.material.uniforms;
      u.uSunPos!.value.copy(sunVector);
      u.uCameraPosW!.value.set(0, 0, 0);
      u.uIrradiance!.value = irradiance;
      if (u.uTime) u.uTime.value = world.clock.elapsed * 0.001;

      if (view.atmosphere) {
        view.atmosphere.position.set(px, py, pz);
        const shell = 1 + view.def.atmosphereScale;
        view.atmosphere.scale.set(scaleEq * shell, scaleEq * shell, scalePol * shell);
        view.atmosphere.quaternion.copy(view.mesh.quaternion);
        const au = (view.atmosphere.material as THREE.ShaderMaterial).uniforms;
        au.uSunPos!.value.copy(sunVector);
        au.uCameraPosW!.value.set(0, 0, 0);
        au.uIrradiance!.value = irradiance;
      }

      if (view.ring) {
        view.ring.position.set(px, py, pz);
        view.ring.quaternion.copy(view.mesh.quaternion);
        const ru = (view.ring.material as THREE.ShaderMaterial).uniforms;
        ru.uSunPos!.value.copy(sunVector);
        ru.uPlanetPosW!.value.set(px, py, pz);
        ru.uIrradiance!.value = irradiance;
      }
    } else {
      // Too small to be a disc: draw it as a point of the brightness it really
      // has, which is the only honest way to show a planet from across the
      // solar system.
      const magnitude = apparentMagnitude(view.def, state.pos, shipPos);
      const brightness = magnitudeToBrightness(magnitude);
      if (brightness <= 0.002) {
        view.sprite.visible = false;
        return;
      }
      // Keep the sprite at a fixed, near distance along the true direction so
      // it never falls outside the far plane.
      const scaleToNear = Math.min(1, 1e9 / distance);
      view.sprite.position.set(px * scaleToNear, py * scaleToNear, pz * scaleToNear);

      let size = 2.5 + 7 * brightness;
      if (magnitude < PHOTOMETRY.saturationMagnitude) {
        // Brighter than saturation: grow rather than clip, so Venus reads as a
        // hard spark with a halo.
        size *= Math.sqrt(Math.pow(10, -0.4 * (magnitude - PHOTOMETRY.saturationMagnitude)));
      }
      view.sprite.scale.set(size / viewportHeight * 2, size / viewportHeight * 2, 1);
      view.spriteMaterial.opacity = Math.min(1, brightness * 1.6);
    }
  }

  /**
   * Glare around the Sun, faded by how much of its disc is actually visible.
   *
   * The visible fraction is the analytic overlap of two circles on the sky —
   * the Sun's disc and each body that might be in front of it. That gives a
   * smooth eclipse for free, and avoids the depth-buffer readback that a
   * screen-space bloom would have needed (and which a logarithmic depth buffer
   * makes awkward).
   */
  private updateSunGlare(
    world: World,
    shipPos: Vec3,
    sunRelative: Vec3,
    sunDistance: number,
    fovRad: number,
    viewportHeight: number,
  ): void {
    const sunRadius = getBody('sun').radius;
    const sunAngular = angularDiameter(sunRadius, sunDistance) / 2;
    normalize(dirA, sunRelative);

    let visible = 1;
    for (const body of BODIES) {
      if (body.id === 'sun') continue;
      const state = world.bodyState(body.id);
      sub(relPos, state.pos, shipPos);
      const d = len(relPos);
      // Only bodies between the ship and the Sun can occlude it.
      if (d >= sunDistance) continue;
      const bodyAngular = angularDiameter(body.radius, d) / 2;
      if (bodyAngular < sunAngular * 0.02) continue;

      normalize(dirB, relPos);
      const separation = Math.acos(Math.max(-1, Math.min(1, dot(dirA, dirB))));

      if (separation >= sunAngular + bodyAngular) continue;
      if (separation <= bodyAngular - sunAngular) { visible = 0; break; }

      // Partial overlap: area of the lens between two circles.
      const r1 = sunAngular;
      const r2 = bodyAngular;
      const dSep = Math.max(separation, 1e-9);
      const a1 = Math.acos(Math.max(-1, Math.min(1,
        (dSep * dSep + r1 * r1 - r2 * r2) / (2 * dSep * r1))));
      const a2 = Math.acos(Math.max(-1, Math.min(1,
        (dSep * dSep + r2 * r2 - r1 * r1) / (2 * dSep * r2))));
      const overlap = r1 * r1 * (a1 - Math.sin(2 * a1) / 2)
                    + r2 * r2 * (a2 - Math.sin(2 * a2) / 2);
      const sunArea = Math.PI * r1 * r1;
      visible = Math.min(visible, Math.max(0, 1 - overlap / sunArea));
    }

    if (visible <= 0.001) {
      this.sunGlare.visible = false;
      return;
    }
    this.sunGlare.visible = true;

    const scaleToNear = Math.min(1, 1e9 / sunDistance);
    this.sunGlare.position.set(
      sunRelative.x * scaleToNear,
      sunRelative.y * scaleToNear,
      sunRelative.z * scaleToNear);

    // The glare grows with the Sun's apparent size but never swamps the frame:
    // the brightness is carried by opacity, not by covering every pixel.
    const sunPixels = (sunAngular * 2 / fovRad) * viewportHeight;
    const size = Math.min(viewportHeight * 1.5, 90 + sunPixels * 2.2);
    const s = (size / viewportHeight) * 2;
    this.sunGlare.scale.set(s, s, 1);
    (this.sunGlare.material as THREE.SpriteMaterial).opacity = 0.85 * visible;
  }

  // -------------------------------------------------------------------------
  // Context loss
  // -------------------------------------------------------------------------

  private installContextHandlers(): void {
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      // Every GPU resource is rebuilt from simulation state, which the render
      // layer never owns — that is what makes recovery possible at all.
      this.renderer.resetState();
      this.resize();
      this.onContextRestored?.();
    });
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  /** Apparent diameter of a body from the ship, in degrees. */
  apparentDiameterDeg(world: World, bodyId: string): number {
    const state = world.bodyState(bodyId);
    sub(relPos, state.pos, world.ship.pos);
    return (angularDiameter(getBody(bodyId).radius, len(relPos)) * 180) / Math.PI;
  }

  /** Project a world-relative direction to normalised screen coordinates. */
  projectDirection(direction: Vec3): { x: number; y: number; behind: boolean } {
    const v = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
    v.applyQuaternion(this.camera.quaternion.clone().invert());
    const behind = v.z > 0;
    // Perspective divide by hand so points behind the camera stay usable as a
    // direction for the edge markers rather than folding onto the wrong side.
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    const z = Math.abs(v.z) < 1e-9 ? 1e-9 : Math.abs(v.z);
    return {
      x: v.x / (z * tanHalf * this.camera.aspect),
      y: v.y / (z * tanHalf),
      behind,
    };
  }

  dispose(): void {
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.renderer.dispose();
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }
}

export { AU };
