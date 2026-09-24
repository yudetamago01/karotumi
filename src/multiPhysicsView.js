import Matter from 'matter-js';
import { CANONICAL_SHAPES } from './canonicalShapes.js';
import { applyDropGravity, PHYSICS_STEP_MS } from './dropMotion.js';
import { makeCompoundTextBody } from './physicsBody.js';

const { Engine, Bodies, Body, Composite, Events, Sleeping } = Matter;

// The server decides turns and losses. This matching Matter world only draws
// the motion locally, so a word does not jump between delayed network frames.
export class MultiPhysicsView {
  constructor(geometry) {
    this.geometry = geometry;
    this.engine = Engine.create({ gravity: { x: 0, y: 1.15 }, enableSleeping: true });
    this.engine.positionIterations = 10;
    this.engine.velocityIterations = 10;
    this.engine.constraintIterations = 4;
    this.base = Bodies.rectangle(geometry.width / 2, geometry.baseY, geometry.baseWidth, 28, {
      isStatic: true, label: 'base', friction: 1.1,
    });
    Composite.add(this.engine.world, this.base);
    this.pieces = new Map();
    this.activeId = null;
    this.landed = false;
    this.lastTime = null;
    this.accumulator = 0;
    this.predictedId = null;
    Events.on(this.engine, 'collisionStart', event => {
      const active = this.pieces.get(this.activeId)?.body;
      if (!active || this.landed) return;
      for (const pair of event.pairs) {
        const a = pair.bodyA.parent;
        const b = pair.bodyB.parent;
        const other = a === active ? b : b === active ? a : null;
        if (other && active.position.y < other.position.y + 20) {
          this.landed = true;
          break;
        }
      }
    });
  }

  add(piece) {
    const shape = CANONICAL_SHAPES[`t:${piece.term}`] || CANONICAL_SHAPES[`e:${piece.term}`];
    if (!shape) return null;
    const spriteX = piece.x + (piece.offsetX || 0);
    const spriteY = piece.y + (piece.offsetY || 0);
    const body = makeCompoundTextBody(shape.rectangles, shape.width, shape.height, spriteX, spriteY);
    const offsetX = piece.offsetX ?? spriteX - body.position.x;
    const offsetY = piece.offsetY ?? spriteY - body.position.y;
    if (piece.offsetX !== undefined && piece.offsetY !== undefined) {
      Body.setPosition(body, { x: piece.x, y: piece.y });
    }
    Body.setAngle(body, piece.angle || 0);
    if (piece.vx !== undefined && piece.vy !== undefined) {
      Body.setVelocity(body, { x: piece.vx, y: piece.vy });
      Body.setAngularVelocity(body, piece.va || 0);
    }
    if (piece.sleeping) Sleeping.set(body, true);
    Composite.add(this.engine.world, body);
    this.pieces.set(piece.id, { ...piece, x: body.position.x, y: body.position.y, offsetX, offsetY, body });
    return this.pieces.get(piece.id);
  }

  predict(term, ownerId, x, y, angle, id = `predicted-${crypto.randomUUID()}`) {
    const shape = CANONICAL_SHAPES[`t:${term}`] || CANONICAL_SHAPES[`e:${term}`];
    if (!shape) return;
    const halfWidth = Math.abs(Math.cos(angle)) * shape.width / 2 + Math.abs(Math.sin(angle)) * shape.height / 2;
    const center = Math.max(halfWidth + 6, Math.min(this.geometry.width - halfWidth - 6, x));
    this.predictedId = id;
    const piece = this.add({ id: this.predictedId, term, ownerId, x: center, y, angle });
    this.activeId = this.predictedId;
    this.landed = false;
    return piece;
  }

  clearPrediction() {
    if (!this.predictedId) return;
    const piece = this.pieces.get(this.predictedId);
    if (piece) Composite.remove(this.engine.world, piece.body);
    this.pieces.delete(this.predictedId);
    if (this.activeId === this.predictedId) this.activeId = null;
    this.predictedId = null;
  }

  sync(room) {
    if (room.phase !== 'playing') {
      for (const piece of this.pieces.values()) Composite.remove(this.engine.world, piece.body);
      this.pieces.clear();
      this.activeId = null;
      this.predictedId = null;
      return;
    }
    const serverIds = new Set(room.pieces.map(piece => piece.id));
    if (this.predictedId && room.activeId) {
      const authoritative = room.pieces.find(piece => piece.id === room.activeId);
      const predicted = this.pieces.get(this.predictedId);
      if (authoritative && predicted && authoritative.term === predicted.term && authoritative.ownerId === predicted.ownerId) {
        this.pieces.delete(this.predictedId);
        predicted.id = authoritative.id;
        predicted.offsetX = authoritative.offsetX;
        predicted.offsetY = authoritative.offsetY;
        this.pieces.set(authoritative.id, predicted);
        this.activeId = authoritative.id;
        this.predictedId = null;
      }
    }
    if (this.predictedId) {
      const predicted = this.pieces.get(this.predictedId);
      if (!predicted || room.currentPlayerId !== predicted.ownerId || room.term !== predicted.term || !room.turnDeadline) {
        this.clearPrediction();
      }
    }
    for (const [id, piece] of this.pieces) {
      if (id === this.predictedId || serverIds.has(id)) continue;
      Composite.remove(this.engine.world, piece.body);
      this.pieces.delete(id);
    }
    for (const piece of room.pieces) {
      const local = this.pieces.get(piece.id);
      if (!local) this.add(piece);
      else {
        local.offsetX = piece.offsetX;
        local.offsetY = piece.offsetY;
        // Full state messages are infrequent. Correct a large divergence, but
        // never pull a falling word a few pixels backwards on every packet.
        const distance = Math.hypot(local.body.position.x - piece.x, local.body.position.y - piece.y);
        if (distance > 100) {
          Body.setPosition(local.body, { x: piece.x, y: piece.y });
          Body.setAngle(local.body, piece.angle);
          Body.setVelocity(local.body, { x: piece.vx || 0, y: piece.vy || 0 });
          Body.setAngularVelocity(local.body, piece.va || 0);
        }
      }
    }
    if (room.activeId !== this.activeId) {
      this.activeId = room.activeId;
      this.landed = Boolean(room.activeLanded);
    } else if (room.activeLanded) {
      this.landed = true;
    }
  }

  step(now, maxCatchupMs = 40) {
    const delta = this.lastTime === null ? 0 : Math.min(maxCatchupMs, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    this.accumulator = Math.min(maxCatchupMs + PHYSICS_STEP_MS, this.accumulator + delta);
    while (this.accumulator >= PHYSICS_STEP_MS) {
      const active = this.pieces.get(this.activeId)?.body;
      if (active && !this.landed) applyDropGravity(active, this.engine.gravity);
      Engine.update(this.engine, PHYSICS_STEP_MS);
      this.accumulator -= PHYSICS_STEP_MS;
    }
  }

  pose(id) {
    const piece = this.pieces.get(id);
    if (!piece) return null;
    return { x: piece.body.position.x, y: piece.body.position.y, angle: piece.body.angle };
  }
}
