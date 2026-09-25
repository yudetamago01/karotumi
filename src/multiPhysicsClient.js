import { CANONICAL_SHAPES } from './canonicalShapes.js';

const BASE_FRAME_MS = 1000 / 60;

// Matter runs in a worker; canvas input and drawing never wait for a solver step.
export class MultiPhysicsClient {
  constructor(geometry) {
    this.geometry = geometry;
    this.worker = new Worker(new URL('./multiPhysicsWorker.js', import.meta.url), { type: 'module' });
    this.pieces = new Map();
    this.poses = new Map();
    this.predictedId = null;
    this.epoch = 0;
    this.lastUpdateAt = 0;
    this.worker.onmessage = ({ data }) => {
      if (data.epoch !== this.epoch) return;
      this.lastUpdateAt = performance.now();
      for (const [id, x, y, angle, vx, vy, va] of data.poses) {
        this.poses.set(id, { x, y, angle, vx, vy, va });
      }
    };
    this.send({ type: 'init', geometry });
  }

  send(message) {
    this.worker.postMessage({ ...message, epoch: ++this.epoch });
  }

  sync(room) {
    if (room.phase !== 'playing') {
      this.pieces.clear();
      this.poses.clear();
      this.predictedId = null;
    } else {
      const incoming = new Set(room.pieces.map(piece => piece.id));
      if (this.predictedId && room.activeId) {
        const accepted = room.pieces.find(piece => piece.id === room.activeId);
        const predicted = this.pieces.get(this.predictedId);
        if (accepted && predicted && accepted.term === predicted.term && accepted.ownerId === predicted.ownerId) {
          this.pieces.delete(this.predictedId);
          this.poses.delete(this.predictedId);
          this.predictedId = null;
        }
      }
      if (this.predictedId && (room.currentPlayerId !== this.pieces.get(this.predictedId)?.ownerId || !room.turnDeadline)) {
        this.pieces.delete(this.predictedId);
        this.poses.delete(this.predictedId);
        this.predictedId = null;
      }
      for (const id of this.pieces.keys()) {
        if (id === this.predictedId || incoming.has(id)) continue;
        this.pieces.delete(id);
        this.poses.delete(id);
      }
      for (const piece of room.pieces) {
        this.pieces.set(piece.id, piece);
        // Keep the last worker pose when we already have one. Overwriting with
        // raw server coordinates every packet makes the canvas jump (jitter);
        // the worker soft-follows the server and publishes smooth poses.
        if (!this.poses.has(piece.id)) {
          this.poses.set(piece.id, { x: piece.x, y: piece.y, angle: piece.angle,
            vx: piece.vx || 0, vy: piece.vy || 0, va: piece.va || 0 });
        }
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
    this.lastUpdateAt = performance.now();
    for (const piece of update.pieces) {
      this.pieces.set(piece.id, piece);
      if (!this.poses.has(piece.id)) {
        this.poses.set(piece.id, {
          x: piece.x, y: piece.y, angle: piece.angle,
          vx: piece.vx || 0, vy: piece.vy || 0, va: piece.va || 0,
        });
      }
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
    this.poses.set(id, { x: piece.x, y: piece.y, angle, vx: 0, vy: 0, va: 0 });
    this.lastUpdateAt = performance.now();
    this.send({ type: 'predict', id, term, ownerId, x: center, y, angle });
    return piece;
  }

  clearPrediction() {
    if (!this.predictedId) return;
    this.pieces.delete(this.predictedId);
    this.poses.delete(this.predictedId);
    this.predictedId = null;
    this.send({ type: 'clear' });
  }

  pose(id) {
    const pose = this.poses.get(id);
    if (!pose) return null;
    // Fill only the gap between worker frames. No easing towards old network
    // coordinates: the newest physical velocity determines the next pixels.
    const age = Math.min(30, Math.max(0, performance.now() - this.lastUpdateAt)) / BASE_FRAME_MS;
    return { x: pose.x + pose.vx * age, y: pose.y + pose.vy * age, angle: pose.angle + pose.va * age };
  }

  dispose() {
    this.worker.terminate();
    this.pieces.clear();
    this.poses.clear();
  }
}
