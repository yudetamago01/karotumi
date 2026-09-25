import Matter from 'matter-js';
import { CANONICAL_SHAPES } from './canonicalShapes.js';
import { applyDropGravity, PHYSICS_STEP_MS } from './dropMotion.js';
import { makeCompoundTextBody } from './physicsBody.js';

const { Engine, Bodies, Body, Composite, Events, Sleeping } = Matter;

// Server Matter is the only authority. This worker only fills the gap between
// pose packets so the canvas stays smooth — it must not invent its own pile.
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
    this.lastAuthoritativeAt = 0;
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

  applyTransform(piece) {
    const local = this.pieces.get(piece.id);
    if (!local?.body) return;
    const body = local.body;
    local.offsetX = piece.offsetX ?? local.offsetX;
    local.offsetY = piece.offsetY ?? local.offsetY;
    local.term = piece.term;
    local.ownerId = piece.ownerId;
    // Matter keeps isSleeping across setPosition; wake before every write.
    Sleeping.set(body, false);
    Body.setPosition(body, { x: piece.x, y: piece.y });
    Body.setAngle(body, piece.angle || 0);
    Body.setVelocity(body, { x: piece.vx || 0, y: piece.vy || 0 });
    Body.setAngularVelocity(body, piece.va || 0);
    if (piece.sleeping) Sleeping.set(body, true);
    local.x = body.position.x;
    local.y = body.position.y;
    local.angle = body.angle;
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

  // Full room snapshot and compact pose streams share this write path.
  applyAuthoritative(room) {
    if (room.phase !== undefined && room.phase !== 'playing') {
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
    if (this.predictedId && room.currentPlayerId !== undefined) {
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
      else this.applyTransform(piece);
    }
    if (room.activeId !== undefined) {
      if (room.activeId !== this.activeId) {
        this.activeId = room.activeId;
        this.landed = Boolean(room.activeLanded);
      } else if (room.activeLanded) {
        this.landed = true;
      }
    }
    this.lastAuthoritativeAt = performance.now();
  }

  sync(room) {
    this.applyAuthoritative(room);
  }

  step(now, maxCatchupMs = 40) {
    if (this.lastTime === null) {
      this.lastTime = now;
      return;
    }
    // Local Matter is only a short gap-filler between server pose packets.
    const gap = Math.max(0, now - this.lastTime);
    const simulateMs = Math.min(gap, maxCatchupMs);
    this.lastTime = now - (gap - simulateMs);
    this.accumulator = Math.min(maxCatchupMs * 2, this.accumulator + simulateMs);
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
