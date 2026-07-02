// All GLSL for the scene. One splat material draws every point buffer
// (terrain tiles, crane, blooms, drifting leaves, pollen), so they all share
// the same watercolor stroke rendering and the same wind / wake response.

export const splatVert = `
  attribute vec3 splatColor;   // u8 normalized
  attribute float splatSize;   // f32, world units
  attribute float splatAngle;  // f32, radians
  attribute float splatAspect; // u8 normalized 0..1
  attribute float splatType;   // u8 raw
  attribute float splatPhase;  // u8 normalized 0..1
  attribute float splatFlex;   // u8 normalized 0..1
  uniform float uScale;
  uniform float uTime;
  uniform float uWind;
  uniform vec2 uWindDir;
  uniform vec2 uBirdXZ;
  uniform vec2 uBirdDir;
  uniform float uBirdWake;
  uniform vec2 uCamXZ;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying vec3 vColor;
  varying float vType;
  varying float vAir;
  varying float vAngle;
  varying float vAspect;
  varying float vSeed;
  varying float vPuff;
  varying float vEdge;

  void main() {
    vColor = splatColor;
    vType = splatType;
    vAspect = splatAspect;
    vSeed = fract(position.x * 12.9898 + position.z * 78.233);
    vPuff = 1.0;
    // dissolve strokes into the air at the edge of the loaded world
    vEdge = 1.0 - smoothstep(uFadeIn, uFadeOut, length(position.xz - uCamXZ));
    if (splatSize <= 0.0 || vEdge <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

    vec3 p = position;
    float ang = splatAngle;
    float ph = splatPhase * 6.28318;
    float sizeMul = 1.0;

    float front = dot(p.xz, uWindDir);
    float gust = sin(front * 0.045 - uTime * 1.5) * 0.5 + 0.5;
    gust *= gust;
    float swell = 0.65 + 0.35 * sin(uTime * 0.37);
    float windAmp = uWind * swell * (0.3 + 0.9 * gust);
    vec2 birdDelta = vec2(0.0);
    float birdDist = 9999.0;
    vec2 birdAway = vec2(0.0);
    float birdWake = 0.0;
    if (uBirdWake > 0.001 && splatType > 0.5 && splatType < 4.5) {
      birdDelta = p.xz - uBirdXZ;
      birdDist = length(birdDelta);
      birdAway = birdDelta / max(birdDist, 0.001);
      float trailBack = -dot(birdDelta, uBirdDir);
      float trailSide = abs(dot(birdDelta, vec2(-uBirdDir.y, uBirdDir.x)));
      float radialWake = 1.0 - smoothstep(4.0, 18.0, birdDist);
      float trailWake = (1.0 - smoothstep(1.5, 11.0, trailSide))
                      * smoothstep(0.0, 18.0, trailBack)
                      * (1.0 - smoothstep(18.0, 38.0, trailBack));
      birdWake = clamp(uBirdWake * (radialWake + trailWake * 0.6), 0.0, 1.35);
    }

    if (splatType > 0.5 && splatType < 1.5) {
      // canopy foliage
      vec2 lean = uWindDir * windAmp * splatFlex * 0.55;
      p.x += lean.x + sin(uTime * 3.1 + ph) * 0.1 * splatFlex * (0.4 + windAmp);
      p.z += lean.y + cos(uTime * 2.6 + ph * 1.3) * 0.08 * splatFlex * (0.4 + windAmp);
      p.y -= windAmp * splatFlex * 0.12;
      ang += sin(uTime * 2.2 + ph) * 0.2 * splatFlex * windAmp;
      float foliageWake = birdWake * splatFlex;
      float shake = sin(uTime * 13.0 + ph * 1.7 + birdDist * 0.32);
      p.xz += (birdAway * 2.1 + uBirdDir * 0.7) * foliageWake;
      p.y += shake * foliageWake * 0.25 - foliageWake * 0.12;
      ang += shake * foliageWake * 0.9;
    }
    else if (splatType > 2.5 && splatType < 3.5) {
      // grass & flowers
      float bend = windAmp * splatFlex;
      p.x += uWindDir.x * bend * 0.5 + sin(uTime * 2.3 + ph + front * 0.2) * 0.05 * splatFlex;
      p.z += uWindDir.y * bend * 0.5;
      p.y -= bend * 0.1;
      ang += uWindDir.x * bend * 0.45;
      float grassWake = birdWake * splatFlex;
      p.xz += (birdAway * 0.8 + uBirdDir * 0.45) * grassWake * 1.25;
      p.y -= grassWake * 0.28;
      ang += (birdAway.x * 0.65 + sin(uTime * 10.5 + ph) * 0.35) * grassWake;
      sizeMul *= 1.0 + grassWake * 0.12;
    }
    else if (splatType > 3.5 && splatType < 4.5) {
      // loose leaves
      vec2 perp = vec2(-uWindDir.y, uWindDir.x);
      float t = uTime * (0.25 + splatPhase * 0.25);
      p.x += (uWindDir.x * sin(t + ph) * 5.0 + perp.x * cos(t * 1.4 + ph) * 2.5) * (0.4 + uWind * 0.5);
      p.z += (uWindDir.y * sin(t + ph) * 5.0 + perp.y * cos(t * 1.4 + ph) * 2.5) * (0.4 + uWind * 0.5);
      p.y += sin(uTime * 1.2 + ph * 1.7) * 1.1;
      ang += uTime * (1.5 + splatPhase * 2.0);
      float leafWake = birdWake * (0.55 + splatFlex);
      p.xz += (uBirdDir * 4.2 + birdAway * 2.2) * leafWake;
      p.y += (0.25 + sin(uTime * 8.5 + ph) * 0.65) * leafWake;
      ang += leafWake * (2.0 + sin(uTime * 6.0 + ph));
      sizeMul *= 1.0 + leafWake * 0.22;
    }
    else if (splatType > 4.5 && splatType < 5.5) {
      // butterflies / pollen motes
      float t = uTime * (0.6 + splatPhase * 0.5);
      p.x += sin(t + ph) * 2.2 + sin(t * 3.7 + ph) * 0.5;
      p.z += cos(t * 0.8 + ph * 2.0) * 2.2;
      p.y += abs(sin(t * 5.0 + ph)) * 0.5 + sin(t * 0.9) * 0.4;
      ang += sin(uTime * 14.0 + ph) * 0.9;
    }
    else if (splatType > 5.5 && splatType < 6.5) {
      // circling swallows
      float t = uTime * (0.18 + splatPhase * 0.12);
      float R = 6.0 + splatFlex * 14.0;
      p.x += cos(t + ph) * R;
      p.z += sin(t + ph) * R;
      p.y += sin(t * 2.3 + ph) * 1.6;
      ang = t + ph + 1.57;
    }
    else if (splatType > 6.5 && splatType < 7.5) {
      // chimney smoke
      float t = fract(uTime * 0.07 * (0.6 + splatPhase * 0.8) + splatPhase);
      p.y += t * 10.0;
      p.x += uWindDir.x * t * t * 7.0 * (0.5 + uWind * 0.5) + sin(uTime + ph) * 0.3 * t;
      p.z += uWindDir.y * t * t * 7.0 * (0.5 + uWind * 0.5);
      sizeMul = 0.5 + t * 2.6;
      vPuff = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.55, 1.0, t));
    }
    else if (splatType > 7.5) {
      // pond water: slow horizontal shimmer, gentle sparkle breathing
      p.x += sin(uTime * 0.5 + ph + position.z * 0.32) * 0.24 * splatFlex;
      p.z += cos(uTime * 0.42 + ph * 1.7 + position.x * 0.27) * 0.18 * splatFlex;
      sizeMul *= 0.86 + 0.22 * sin(uTime * (0.7 + splatPhase * 0.8) + ph * 3.0);
      ang += sin(uTime * 0.35 + ph) * 0.05;
    }

    vAngle = ang;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = -mv.z;
    gl_PointSize = clamp(splatSize * sizeMul * uScale / dist, 1.0, 350.0);
    vAir = smoothstep(42.0, 138.0, dist); // aerial perspective across the loaded disc
    gl_Position = projectionMatrix * mv;
  }
`;

export const splatFrag = `
  precision highp float;
  varying vec3 vColor;
  varying float vType;
  varying float vAir;
  varying float vAngle;
  varying float vAspect;
  varying float vSeed;
  varying float vPuff;
  varying float vEdge;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    uv.y = -uv.y;
    float ca = cos(vAngle), sa = sin(vAngle);
    vec2 r = vec2(ca * uv.x + sa * uv.y, -sa * uv.x + ca * uv.y);
    r.y /= max(vAspect, 0.08);
    float d = dot(r, r);

    // blobby wet-edge wobble — watercolor dabs, not bristled oil strokes
    float blob = hash(floor(r * 2.6) + vSeed * 97.0);
    d *= 1.0 + (blob - 0.5) * 0.3;
    if (d > 1.0) discard;

    float alpha;
    if (vType > 6.5 && vType < 7.5) {
      alpha = exp(-d * 2.8) * 0.3 * vPuff;                 // smoke
    } else if (vType > 7.5) {
      alpha = smoothstep(1.0, 0.5, d) * 0.82;              // water wash, translucent
    } else {
      alpha = smoothstep(1.0, 0.55, d) * 0.92;
    }

    // pigment pools toward the rim of a wet stroke, and granulates on paper
    float rim = smoothstep(0.3, 1.0, d);
    vec3 color = vColor * (1.0 - rim * 0.2);
    float gr = hash(floor(r * 5.2 + 31.7) + vSeed * 57.0);
    color *= 1.0 + (gr - 0.5) * 0.09;
    if (vType > 4.5 && vType < 5.5) color *= 1.32; // pollen motes catch the light

    // aerial perspective: distance pales toward a luminous lavender, but the
    // hue survives — Monet distance is colored light, not fog
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(lum), vAir * 0.22);
    color = mix(color, vec3(0.78, 0.8, 0.92), vAir * 0.44);
    alpha *= (1.0 - vAir * 0.16);
    alpha *= vEdge;

    gl_FragColor = vec4(color, alpha);
  }
`;

export const skyVert = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Watercolor sky: layered wet washes. A cerulean-to-cream gradient, a rose
// band toward the sun, soft fbm cloud washes, and three pale ridge washes on
// the horizon that drift slowly with flight (distant hills the strokes never
// have to reach).
export const skyFrag = `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform vec2 uDrift;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float y = dir.y;
    float sunAmt = max(dot(dir, uSunDir), 0.0);

    // base washes
    vec3 zenith = vec3(0.5, 0.65, 0.87);
    vec3 mid = vec3(0.74, 0.81, 0.91);
    vec3 horizon = vec3(0.95, 0.89, 0.8);
    vec3 col = mix(mid, zenith, smoothstep(0.14, 0.62, y));
    col = mix(horizon, col, smoothstep(-0.04, 0.2, y));

    // rose light near the horizon, warmer toward the sun
    float band = exp(-abs(y - 0.05) * 9.0);
    col = mix(col, vec3(0.96, 0.8, 0.74), band * (0.24 + 0.34 * sunAmt));

    // cloud washes — wet-on-wet, brighter on the sun side, lavender beneath
    if (y > -0.02) {
      vec2 cuv = dir.xz / (y + 0.24) * 0.6 + uDrift + vec2(uTime * 0.006, uTime * 0.002);
      float m = fbm(cuv) * 0.8 + fbm(cuv * 3.1 + 9.3) * 0.3;
      float m2 = fbm(cuv * 1.9 + 4.7);
      float mask = smoothstep(0.4, 0.62, m + m2 * 0.25)
                 * smoothstep(0.0, 0.1, y) * (1.0 - smoothstep(0.6, 0.98, y));
      float shade = smoothstep(0.4, 0.75, m2);
      vec3 cloudCol = mix(vec3(0.77, 0.77, 0.9), vec3(1.0, 0.98, 0.94), shade);
      cloudCol = mix(cloudCol, vec3(1.0, 0.93, 0.85), sunAmt * 0.4 * shade);
      col = mix(col, cloudCol, mask * 0.8);
    }

    // three distant ridge washes below the horizon line
    float az = atan(dir.x, dir.z);
    vec3 mist = vec3(0.75, 0.78, 0.88);
    if (y < 0.2) {
      vec3 hillCols[3];
      hillCols[0] = vec3(0.77, 0.79, 0.92);  // farthest, palest cobalt
      hillCols[1] = vec3(0.67, 0.71, 0.87);
      hillCols[2] = vec3(0.58, 0.67, 0.75);  // nearest, a breath of sage
      for (int L = 0; L < 3; L++) {
        float fL = float(L);
        float drift = (0.2 + fL * 0.28);
        float ridge = 0.105 - fL * 0.038
          + (fbm(vec2(az * (1.6 + fL * 1.1) + fL * 13.7 + uDrift.x * drift,
                      fL * 7.0 + uDrift.y * drift)) - 0.5) * (0.09 - fL * 0.014);
        float m = 1.0 - smoothstep(ridge - 0.014, ridge + 0.004, y);
        vec3 hc = mix(hillCols[L], vec3(0.93, 0.85, 0.8), band * 0.35);
        col = mix(col, hc, m * (0.9 - fL * 0.1));
      }
      // beneath everything: layered morning-fog washes, not one flat pour
      float fogBands = fbm(vec2(az * 2.2 + uDrift.x * 0.5, y * 14.0 - uDrift.y * 0.3));
      vec3 fogCol = mist
        + vec3(0.035, 0.028, 0.02) * (fogBands - 0.5) * 2.0
        + vec3(-0.05, -0.02, 0.01) * smoothstep(-0.06, -0.4, y); // cooler, faintly deeper low
      col = mix(col, fogCol, 1.0 - smoothstep(-0.2, -0.05, y));
    }

    // sun: a wide warm bloom and a soft core — no hard disc in watercolor
    col += vec3(1.0, 0.88, 0.66) * pow(sunAmt, 6.0) * 0.2;
    col += vec3(1.0, 0.76, 0.52) * pow(sunAmt, 42.0) * 0.34;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const quadVert = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Single watercolor post pass:
//   cohesion (small Kuwahara)  -> strokes melt together like wet pigment
//   halation glow              -> luminous Monet light
//   edge darkening             -> pigment pooling along value boundaries
//   paper grain + granulation  -> cold-press tooth showing through washes
//   luminous lift + grade      -> no blacks, warm lights / violet shadows
//   deckled paper border       -> the painting dissolves into paper at the frame
export const paintFrag = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 uPx;
  uniform float uGrain;
  uniform float uGlow;

  float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    vec3 raw = texture2D(tDiffuse, vUv).rgb;

    // wet cohesion: pick the least-varying quadrant mean (mini Kuwahara)
    vec3 bestMean = raw;
    float bestVar = 1e9;
    for (int q = 0; q < 4; q++) {
      vec2 s = vec2(q == 0 || q == 3 ? 1.0 : -1.0, q < 2 ? 1.0 : -1.0);
      vec3 mean = vec3(0.0);
      float m2 = 0.0;
      for (int i = 0; i <= 1; i++) {
        for (int j = 0; j <= 1; j++) {
          vec3 cc = texture2D(tDiffuse, vUv + vec2(float(i), float(j)) * s * uPx * 1.4).rgb;
          mean += cc;
          float l = lum(cc);
          m2 += l * l;
        }
      }
      mean *= 0.25;
      float ml = lum(mean);
      float v = m2 * 0.25 - ml * ml;
      if (v < bestVar) { bestVar = v; bestMean = mean; }
    }
    vec3 col = mix(raw, bestMean, 0.5);

    // halation: bright washes bleed light into their neighbours
    vec3 g1 = texture2D(tDiffuse, vUv + vec2( 5.0,  3.0) * uPx).rgb;
    vec3 g2 = texture2D(tDiffuse, vUv + vec2(-5.0,  3.0) * uPx).rgb;
    vec3 g3 = texture2D(tDiffuse, vUv + vec2( 3.0, -5.0) * uPx).rgb;
    vec3 g4 = texture2D(tDiffuse, vUv + vec2(-3.0, -5.0) * uPx).rgb;
    vec3 glow = (g1 + g2 + g3 + g4) * 0.25;
    col += glow * glow * 0.2 * uGlow;

    // pigment pooling: darken along value edges (the watercolor signature)
    float lx1 = lum(texture2D(tDiffuse, vUv + vec2(uPx.x, 0.0) * 1.5).rgb);
    float lx0 = lum(texture2D(tDiffuse, vUv - vec2(uPx.x, 0.0) * 1.5).rgb);
    float ly1 = lum(texture2D(tDiffuse, vUv + vec2(0.0, uPx.y) * 1.5).rgb);
    float ly0 = lum(texture2D(tDiffuse, vUv - vec2(0.0, uPx.y) * 1.5).rgb);
    float edge = clamp(length(vec2(lx1 - lx0, ly1 - ly0)) * 2.6, 0.0, 1.0);
    col *= 1.0 - edge * 0.24;

    // paper tooth & granulation: pigment settles into the grain, more in shade
    vec2 fc = vUv / uPx;
    float tooth = vnoise(fc * 0.55) - 0.5;
    float fine = vnoise(fc * 1.7 + 31.0) - 0.5;
    float fiber = vnoise(vec2(fc.x * 0.12, fc.y * 1.9) + 7.0) - 0.5;
    float paper = tooth * 0.6 + fine * 0.3 + fiber * 0.35;
    float l0 = lum(col);
    col *= 1.0 + paper * uGrain * (0.05 + (1.0 - l0) * 0.1);

    // luminous watercolor lift: white paper glows through every wash
    col = col * 0.9 + vec3(0.085, 0.082, 0.075);

    // Monet grade: gentle saturation, warm lights, cool violet shadows
    float l1 = lum(col);
    col = mix(vec3(l1), col, 1.12);
    col += vec3(0.05, 0.024, -0.018) * l1;
    col += vec3(-0.012, 0.002, 0.04) * (1.0 - l1);

    // soft breathing vignette, then a deckled paper edge
    vec2 vg = vUv - 0.5;
    col *= 1.0 - dot(vg, vg) * 0.22;
    float m = max(abs(vg.x), abs(vg.y)) * 2.0;
    float wob = (vnoise(vUv * 90.0) - 0.5) * 0.02;
    float deckle = smoothstep(0.972 + wob, 0.998 + wob, m);
    col = mix(col, vec3(0.95, 0.93, 0.87), deckle * 0.92);

    gl_FragColor = vec4(col, 1.0);
  }
`;
