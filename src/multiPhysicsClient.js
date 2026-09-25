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

// Server poses are what we paint for confirmed pieces. The worker's Matter
// world only supplies the local drop's motion so the piece collides with the
// pile — every piece (including the prediction) goes through the same trail.
export class MultiPhysicsClient {
  constructor(geometry) {
    this.geometry = geometry;
    this.worker = new Worker(new URL('./multiPhysicsWorker.js', import.meta.url), { type: 'module' });
    this.pieces = new Map();
    this.trails = new Map();
    this.predictedId = null;
    this.epoch = 0;
    this.worker.onmessage = ({ data }) => {
      // Always take the newest simulation poses for the local drop. Filtering
      // by command epoch threw away in-flight frames and froze the dropper.
      if (!Array.isArray(data.poses)) return;
      for (const [id, x, y, angle, vx, vy, va] of data.poses) {
        if (id !== this.predictedId) continue;
        const piece = this.pieces.get(id);
        this.ingest({
          id,
          x, y, angle, vx, vy, va,
          sleeping: false,
          term: piece?.term,
          ownerId: piece?.ownerId,
          offsetX: piece?.offsetX,
          offsetY: piece?.offsetY,
        });
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
    // A drop is published at the spawn cell before the first physics step.
    // Clamp that rewind (keep current motion) so the word neither jumps up
    // nor stalls at zero velocity.
    const rise = trail.curr.y - next.y;
    if (!next.sleeping && !trail.curr.sleeping && rise > 8 && next.vy > -.5) {
      next.y = trail.curr.y;
      next.x = trail.curr.x;
      next.angle = trail.curr.angle;
      next.vx = trail.curr.vx;
      next.vy = trail.curr.vy;
      next.va = trail.curr.va;
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
    } else {
      const incoming = new Set(room.pieces.map(piece => piece.id));
      if (this.predictedId && room.activeId) {
        const accepted = room.pieces.find(piece => piece.id === room.activeId);
        const predicted = this.pieces.get(this.predictedId);
        if (accepted && predicted && accepted.term === predicted.term && accepted.ownerId === predicted.ownerId) {
          // Keep the prediction trail under the new id — do not rewind to spawn.
          const trail = this.trails.get(this.predictedId);
          if (trail) this.trails.set(accepted.id, trail);
          this.pieces.delete(this.predictedId);
          this.trails.delete(this.predictedId);
          this.predictedId = null;
        }
      }
      if (this.predictedId && (room.currentPlayerId !== this.pieces.get(this.predictedId)?.ownerId || !room.turnDeadline)) {
        this.pieces.delete(this.predictedId);
        this.trails.delete(this.predictedId);
        this.predictedId = null;
      }
      for (const id of this.pieces.keys()) {
        if (id === this.predictedId || incoming.has(id)) continue;
        this.pieces.delete(id);
        this.trails.delete(id);
      }
      for (const piece of room.pieces) {
        this.pieces.set(piece.id, piece);
        if (piece.id === this.predictedId) continue;
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
      if (piece.id === this.predictedId) continue;
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
    const start = clonePose({ x: piece.x, y: piece.y, angle, vx: 0, vy: 0, va: 0 });
    this.trails.set(id, { prev: start, curr: start, interval: LERP_MS });
    this.send({ type: 'predict', id, term, ownerId, x: center, y, angle });
    return piece;
  }

  clearPrediction() {
    if (!this.predictedId) return;
    this.pieces.delete(this.predictedId);
    this.trails.delete(this.predictedId);
    this.predictedId = null;
    this.send({ type: 'clear' });
  }

  pose(id) {
    const trail = this.trails.get(id);
    if (!trail) return null;
    const { prev, curr, interval } = trail;
    if (curr.sleeping || prev.sleeping) {
      return { x: curr.x, y: curr.y, angle: curr.angle };
    }
    const elapsed = performance.now() - curr.at;
    const t = elapsed / interval;
    if (t <= 1) {
      // Smoothstep softens the stair-steps without inventing motion.
      const s = t * t * (3 - 2 * t);
      return {
        x: prev.x + (curr.x - prev.x) * s,
        y: prev.y + (curr.y - prev.y) * s,
        angle: prev.angle + (curr.angle - prev.angle) * s,
      };
    }
    // Keep coasting on the last velocity when samples are late or clamped.
    const extra = Math.min(90, elapsed - interval) / BASE_FRAME_MS;
    return {
      x: curr.x + curr.vx * extra,
      y: curr.y + curr.vy * extra,
      angle: curr.angle + curr.va * extra,
    };
  }

  dispose() {
    this.worker.terminate();
    this.pieces.clear();
    this.trails.clear();
  }
}
