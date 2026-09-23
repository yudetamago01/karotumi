import Matter from 'matter-js';

const { Bodies, Body } = Matter;

// Matter adds the inertia of compound parts without accounting for their
// distance from the shared centre. A wide word made of many narrow mask
// rectangles then spins like a single narrow rectangle on contact.
export function makeCompoundTextBody(rectangles, width, height, x, y) {
  const parts = rectangles.map(rect => Bodies.rectangle(
    x + rect.x - width / 2,
    y + rect.y - height / 2,
    rect.w,
    rect.h,
  ));
  if (!parts.length) parts.push(Bodies.rectangle(x, y, 22, 22));

  const body = Body.create({
    label: 'term', parts, friction: .9, frictionStatic: 1.2,
    restitution: 0, frictionAir: .035, sleepThreshold: 24,
  });
  const inertia = body.parts.slice(1).reduce((sum, part) => {
    const dx = part.position.x - body.position.x;
    const dy = part.position.y - body.position.y;
    return sum + part.inertia + Body._inertiaScale * part.mass * (dx * dx + dy * dy);
  }, 0);
  Body.setInertia(body, inertia);
  return body;
}
