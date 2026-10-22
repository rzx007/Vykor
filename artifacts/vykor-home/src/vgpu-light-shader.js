const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Coordinates stay in CSS pixels; the fragment UV makes the same optics work
// at every rendering resolution, including the lower interactive DPR.
export function lightUniforms({ width, height, progress = 0, handoff = 0, region, aim = [0, 0], strength = 1 } = {}) {
  const w = Math.max(1, finite(width, 1));
  const h = Math.max(1, finite(height, 1));
  return {
    viewport: [w, h, clamp(finite(progress, 0), 0, 1), clamp(finite(handoff, 0), 0, 1)],
    region: [finite(region?.left, w * .48), finite(region?.top, h * .2), Math.max(1, finite(region?.width, w * .48)), Math.max(1, finite(region?.height, h * .65))],
    aim: [clamp(finite(aim?.[0], 0), -1, 1), clamp(finite(aim?.[1], 0), -1, 1)],
    strength: clamp(finite(strength, 1), 0, 2),
    padding: 0,
  };
}

export const lightShader = /* wgsl */ `
struct Light {
  viewport: vec4f,
  region: vec4f,
  aim: vec2f,
  strength: f32,
  padding: f32,
}
@group(0) @binding(0) var<uniform> light: Light;

fn gaussian(distance: f32, width: f32) -> f32 {
  let x = distance / max(width, 0.001);
  return exp(-x * x);
}

// Broad sensor responses rather than HSV bands. Mixing the response with the
// warm incident light keeps the paper's reflected spectrum deliberately quiet.
fn wavelengthColor(nm: f32) -> vec3f {
  let response = vec3f(
    gaussian(nm - 610.0, 64.0),
    gaussian(nm - 546.0, 48.0),
    gaussian(nm - 455.0, 44.0)
  );
  let rgb = response / max(max(response.r, response.g), max(response.b, 0.001));
  return mix(vec3f(1.0, 0.93, 0.79), rgb, 0.50);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let progress = light.viewport.z;
  let handoff = light.viewport.w;
  let center = light.region.xy + light.region.zw * vec2f(0.52, 0.54);
  let scale = max(min(light.region.z, light.region.w) * 0.72, 1.0);
  let p = (uv * light.viewport.xy - center) / scale;
  let angle = 0.48 + progress * 0.42 + light.aim.x * 0.065;
  let axis = vec2f(cos(angle), sin(angle));
  let normal = vec2f(-axis.y, axis.x);
  let origin = vec2f(-0.05, 0.05 + light.aim.y * 0.025);
  let ray = p - origin;
  let along = dot(ray, axis);
  let across = dot(ray, normal);

  var energy = 0.0;
  var radiance = vec3f(0.0);
  // Twelve wavelengths are refracted separately. Cauchy's law gives blue a
  // larger refractive index; the prism's minimum-deviation equation separates
  // their receiver positions. A curved exit face folds the ray density into
  // a bright narrow caustic with a softer unfocused shoulder.
  for (var i = 0; i < 12; i = i + 1) {
    let wavelength = 440.0 + f32(i) * (230.0 / 11.0);
    let micrometers = wavelength * 0.001;
    let refractiveIndex = 1.50 + 0.0042 / (micrometers * micrometers);
    let prismAngle = 0.80 + progress * 0.12;
    let deviation = 2.0 * asin(refractiveIndex * sin(prismAngle * 0.5)) - prismAngle;
    let spectralOffset = (deviation - 0.495) * 7.0 * max(along, 0.0);
    let fold = 0.20 * along * along - 0.09 * along + sin(progress * 2.6) * 0.035 * along;
    let distance = across - fold - spectralOffset;
    let width = 0.012 + max(along, 0.0) * 0.018;
    let focus = gaussian(distance, width) + 0.22 * gaussian(distance, width * 3.5);
    let lengthFade = smoothstep(0.015, 0.16, along) * (1.0 - smoothstep(0.58, 1.20, along));
    let contribution = focus * lengthFade / 4.5;
    energy += contribution;
    radiance += wavelengthColor(wavelength) * contribution;
  }

  // The incident beam is narrow, warm, and much fainter than the refracted
  // receiver light; it ends at the model rather than becoming a page gradient.
  let incoming = gaussian(across + 0.025, 0.025)
    * smoothstep(-0.78, -0.52, along) * (1.0 - smoothstep(-0.12, 0.02, along)) * 0.11;
  energy += incoming;
  radiance += vec3f(1.0, 0.95, 0.84) * incoming;

  // Outside the local optical region, the canvas is exactly transparent.
  let boundary = 1.0 - smoothstep(0.85, 1.4, length(p));
  let visibility = (1.0 - smoothstep(0.18, 0.88, handoff)) * boundary;
  let alpha = clamp((1.0 - exp(-energy * 0.65)) * visibility * light.strength, 0.0, 0.48);
  let color = radiance / max(energy, 0.0001);
  // The browser canvas uses premultiplied alpha: RGB must carry the same alpha.
  return vec4f(color * alpha, alpha);
}
`;
