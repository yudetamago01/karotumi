export const PHYSICS_STEP_MS = 1000 / 120;
const FALL_GRAVITY_FACTOR = 1.75;

// Accelerate only the falling word. It begins at rest when released, while
// the existing pile keeps its normal gravity and collision behavior.
export function applyDropGravity(body, gravity) {
  body.force.x += body.mass * gravity.x * gravity.scale * (FALL_GRAVITY_FACTOR - 1);
  body.force.y += body.mass * gravity.y * gravity.scale * (FALL_GRAVITY_FACTOR - 1);
}
