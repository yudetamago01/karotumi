export function isLost(body, base) {
  const leftLimit = base.bounds.min.x - 120;
  const rightLimit = base.bounds.max.x + 120;
  return body.bounds.min.y > base.bounds.min.y + 2
    || body.position.y > base.bounds.max.y + 14
    || body.bounds.max.x < leftLimit
    || body.bounds.min.x > rightLimit;
}
