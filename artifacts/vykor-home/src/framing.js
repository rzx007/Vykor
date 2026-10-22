import { MathUtils, Quaternion, Vector3 } from 'three';

const center = new Vector3();
const axis = new Vector3();
const corner = new Vector3();
const inverseRotation = new Quaternion();

/**
 * Fit a world-space box inside a CSS-pixel region of the full canvas.
 * `direction` points from the box center toward an unparented perspective camera.
 * Padding is a fraction of the region reserved on each side; .1 leaves 80% usable.
 * Returns the resulting distance from the camera to the box center.
 */
export function fitCameraToBox(camera, box, direction, { width, height, region, padding = .1 }) {
  const area = region ?? { left: 0, top: 0, width, height };
  const dimensions = [width, height, area.width, area.height];
  const coordinates = [area.left, area.top, ...box.min.toArray(), ...box.max.toArray(), ...direction.toArray()];
  if (dimensions.some(value => !Number.isFinite(value) || value <= 0)
    || coordinates.some(value => !Number.isFinite(value))
    || box.isEmpty() || direction.lengthSq() === 0
    || !Number.isFinite(padding) || padding < 0 || padding >= .5) {
    throw new RangeError('Camera framing needs a finite box, nonzero direction, positive viewport, and padding below .5.');
  }

  box.getCenter(center);
  axis.copy(direction).normalize();
  camera.position.copy(center).add(axis);
  camera.lookAt(center);
  inverseRotation.copy(camera.quaternion).invert();

  const tanY = Math.tan(MathUtils.degToRad(camera.fov / 2)) / camera.zoom;
  const tanX = tanY * area.width / area.height;
  const usable = 1 - 2 * padding;
  let distance = Math.max(camera.near * 2, .001);
  let closestZ = -Infinity;
  let farthestZ = Infinity;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        corner.set(x, y, z).sub(center).applyQuaternion(inverseRotation);
        // Perspective makes nearer corners larger, so each corner contributes its
        // own required distance. Fitting width/height alone misses this depth.
        distance = Math.max(
          distance,
          Math.abs(corner.x) / (tanX * usable) + corner.z,
          Math.abs(corner.y) / (tanY * usable) + corner.z,
          corner.z + camera.near * 1.01,
        );
        closestZ = Math.max(closestZ, corner.z);
        farthestZ = Math.min(farthestZ, corner.z);
      }
    }
  }

  // Small floating-point slack keeps an exactly fitted corner inside the region.
  distance += Math.max(distance, 1) * 1e-7;
  camera.position.copy(center).addScaledVector(axis, distance);
  camera.lookAt(center);
  camera.far = Math.max(camera.far, distance - farthestZ + Math.max(1, distance - closestZ) * .05);
  // The region is a virtual full view. Negative offsets place that view in the
  // specified part of a larger canvas without moving or cropping the canvas.
  camera.setViewOffset(area.width, area.height, -area.left, -area.top, width, height);
  camera.updateMatrixWorld(true);
  return distance;
}
