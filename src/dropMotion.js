export const PHYSICS_STEP_MS = 1000 / 120;
const FALL_SPEED_FACTOR = 1.5;
// Matter's Body.setVelocity uses a 60 Hz velocity unit, while our simulation
// advances at 120 Hz. The small remainder offsets Matter's air friction.
const MATTER_VELOCITY_CORRECTION = 2.1;

// Give only the falling word a head start. Increasing world gravity also
// accelerates the already stacked words and makes the pile unstable.
export function initialDropVelocity(distance, gravityY, gravityScale) {
  const acceleration = gravityY * gravityScale * PHYSICS_STEP_MS ** 2;
  const normalImpactSpeed = Math.sqrt(2 * acceleration * Math.max(0, distance));
  return MATTER_VELOCITY_CORRECTION
    * (FALL_SPEED_FACTOR ** 2 - 1) / (2 * FALL_SPEED_FACTOR) * normalImpactSpeed;
}
