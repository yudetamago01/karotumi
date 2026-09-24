import { MultiPhysicsView } from './multiPhysicsView.js';

let view = null;
let epoch = 0;

function publish() {
  if (!view) return;
  const poses = [];
  for (const [id, piece] of view.pieces) {
    const body = piece.body;
    poses.push([id, body.position.x, body.position.y, body.angle,
      body.velocity.x, body.velocity.y, body.angularVelocity]);
  }
  self.postMessage({ epoch, poses });
}

self.onmessage = ({ data }) => {
  epoch = data.epoch;
  if (data.type === 'init') {
    view = new MultiPhysicsView(data.geometry);
  } else if (data.type === 'sync') {
    view?.sync(data.room);
  } else if (data.type === 'predict') {
    view?.predict(data.term, data.ownerId, data.x, data.y, data.angle, data.id);
  } else if (data.type === 'clear') {
    view?.clearPrediction();
  }
  publish();
};

setInterval(() => {
  if (!view || !view.pieces.size) return;
  view.step(performance.now(), 100);
  publish();
}, 1000 / 60);
