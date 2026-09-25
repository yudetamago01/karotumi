export function isLost(body, base) {
  const leftLimit = base.bounds.min.x - 120;
  const rightLimit = base.bounds.max.x + 120;
  // A tilted word can reach below the plate while part of its collider is
  // still resting on the rim. It has fallen only after the whole collider
  // has passed the plate, or has escaped well beyond either side.
  return body.bounds.min.y > base.bounds.max.y + 8
    || body.bounds.max.x < leftLimit
    || body.bounds.min.x > rightLimit;
}
