import { CANONICAL_SHAPES } from './canonicalShapes.js';

const BASE_FRAME_MS = 1000 / 60;
const LERP_MS = 110;

function clonePose(pose) {
  return {
    x: pose.x, y: pose.y, angle: pose.angle,
    vx: pose.vx || 0, vy: pose.vy || 0, va: pose.va || 0,
    sleeping: Boolean(pose.sleeping),
    at: pose.at ?? performance.now(),
  };
}

// Server poses are the only thing drawn for confirmed pieces. Matter in the
// worker exists so a local drop still collides with the pile immediately —
// its body positions are never painted, which is what caused the jitter.
export class MultiPhysicsClient {
  constructor(geometry) {
    this.geometry = geometry;
    this.worker = new Worker(new URL('./multiPhysicsWorker.js', import.meta.url), { type: 'module' });
    this.pieces = new Map();
    this.trails = new Map();
    this.predictedId = null;
    this.epoch = 0;
    this.predictedPose = null;
    this.worker.onmessage = ({ data }) => {
      if (data.epoch !== this.epoch) return;
      for (const [id, x, y, angle, vx, vy, va] of data.poses) {
        if (id === this.predictedId) {
          this.predictedPose = { x, y, angle, vx, vy, va, at: performance.now() };
        }
      }
    };
    this.send({ type: 'init', geometry });
  }

  send(message) {
    this.worker.postMessage({ ...message, epoch: ++this.epoch });
  }

  ingest(piece) {
    const now = performance.now();
    const next = { ...clonePose(piece), at: now };
    const trail = this.trails.get(piece.id);
    if (!trail) {
      this.trails.set(piece.id, { prev: next, curr: next, interval: LERP_MS });
      return;
    }
    // Sleeping words do not travel — keep them glued to the latest server cell.
    if (next.sleeping && trail.curr.sleeping) {
      trail.prev = next;
      trail.curr = next;
      return;
    }
    const interval = Math.max(40, Math.min(200, now - trail.curr.at));
    trail.prev = trail.curr;
    trail.curr = next;
    trail.interval = interval;
  }

  sync(room) {
    if (room.phase !== 'playing') {
      this.pieces.clear();
      this.trails.clear();
      this.predictedId = null;
      this.predictedPose = null;
    } else {
      const incoming = new Set(room.pieces.map(piece => piece.id));
      if (this.predictedId && room.activeId) {
        const accepted = room.pieces.find(piece => piece.id === room.activeId);
        const predicted = this.pieces.get(this.predictedId);
        if (accepted && predicted && accepted.term === predicted.term && accepted.ownerId === predicted.ownerId) {
          // Continue from the predicted pixels so the handoff does not jump.
          const from = this.predictedPose || this.trails.get(this.predictedId)?.curr;
          if (from) {
            this.trails.set(accepted.id, {
              prev: clonePose(from),
              curr: { ...clonePose(accepted), at: performance.now() },
              interval: LERP_MS,
            });
          }
          this.pieces.delete(this.predictedId);
          this.trails.delete(this.predictedId);
          this.predictedId = null;
          this.predictedPose = null;
        }
      }
      if (this.predictedId && (room.currentPlayerId !== this.pieces.get(this.predictedId)?.ownerId || !room.turnDeadline)) {
        this.pieces.delete(this.predictedId);
        this.trails.delete(this.predictedId);
        this.predictedId = null;
        this.predictedPose = null;
      }
      for (const id of this.pieces.keys()) {
        if (id === this.predictedId || incoming.has(id)) continue;
        this.pieces.delete(id);
        this.trails.delete(id);
      }
      for (const piece of room.pieces) {
        this.pieces.set(piece.id, piece);
        this.ingest(piece);
      }
    }
    this.send({ type: 'sync', room: {
      phase: room.phase, activeId: room.activeId, activeLanded: room.activeLanded,
      currentPlayerId: room.currentPlayerId, term: room.term, turnDeadline: room.turnDeadline,
      pieces: room.pieces,
    } });
  }

  applyPoses(update) {
    if (!update?.pieces) return;
    for (const piece of update.pieces) {
      this.pieces.set(piece.id, piece);
      this.ingest(piece);
    }
    this.send({ type: 'poses', ...update });
  }

  predict(term, ownerId, x, y, angle) {
    const shape = CANONICAL_SHAPES[`t:${term}`] || CANONICAL_SHAPES[`e:${term}`];
    if (!shape) return null;
    const halfWidth = Math.abs(Math.cos(angle)) * shape.width / 2 + Math.abs(Math.sin(angle)) * shape.height / 2;
    const center = Math.max(halfWidth + 6, Math.min(this.geometry.width - halfWidth - 6, x));
    const area = shape.rectangles.reduce((sum, part) => sum + part.w * part.h, 0);
    const offsetX = shape.width / 2 - shape.rectangles.reduce((sum, part) => sum + part.x * part.w * part.h, 0) / area;
    const offsetY = shape.height / 2 - shape.rectangles.reduce((sum, part) => sum + part.y * part.w * part.h, 0) / area;
    const id = `predicted-${crypto.randomUUID()}`;
    const piece = { id, term, ownerId, x: center - offsetX, y: y - offsetY, angle, offsetX, offsetY };
    this.predictedId = id;
    this.pieces.set(id, piece);
    this.predictedPose = { x: piece.x, y: piece.y, angle, vx: 0, vy: 0, va: 0, at: performance.now() };
    this.trails.set(id, {
      prev: clonePose(this.predictedPose),
      curr: clonePose(this.predictedPose),
      interval: LERP_MS,
    });
    this.send({ type: 'predict', id, term, ownerId, x: center, y, angle });
    return piece;
  }

  clearPrediction() {
    if (!this.predictedId) return;
    this.pieces.delete(this.predictedId);
    this.trails.delete(this.predictedId);
    this.predictedId = null;
    this.predictedPose = null;
    this.send({ type: 'clear' });
  }

  pose(id) {
    if (id === this.predictedId && this.predictedPose) {
      const pose = this.predictedPose;
      const age = Math.min(24, Math.max(0, performance.now() - pose.at)) / BASE_FRAME_MS;
      return { x: pose.x + pose.vx * age, y: pose.y + pose.vy * age, angle: pose.angle + pose.va * age };
    }
    const trail = this.trails.get(id);
    if (!trail) return null;
    const { prev, curr, interval } = trail;
    if (curr.sleeping || prev.sleeping) {
      return { x: curr.x, y: curr.y, angle: curr.angle };
    }
    const t = Math.min(1, Math.max(0, (performance.now() - curr.at) / interval));
    // Smoothstep softens the 10Hz stair-steps without inventing motion.
    const s = t * t * (3 - 2 * t);
    return {
      x: prev.x + (curr.x - prev.x) * s,
      y: prev.y + (curr.y - prev.y) * s,
      angle: prev.angle + (curr.angle - prev.angle) * s,
    };
  }

  dispose() {
    this.worker.terminate();
    this.pieces.clear();
    this.trails.clear();
  }
}
