export function rotationIcon(direction) {
  return `<svg class="rotate-icon${direction < 0 ? ' rotate-icon-left' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11a9 9 0 1 1-2.9-6.6"/><path d="M21 3v8h-8"/></svg>`;
}

/**
 * Attach press-and-hold rotation behavior to a pair of direction buttons.
 * Returns a cleanup function that removes listeners and stops any active repeat.
 */
export function bindHoldRotation(leftButton, rightButton, rotate) {
  if (!leftButton || !rightButton || typeof rotate !== 'function') {
    throw new TypeError('Two rotation buttons and a rotate callback are required.');
  }

  const initialDelay = 275;
  const repeatInterval = 100;
  let active = null;
  let initialTimer = null;
  let repeatTimer = null;
  let suppressClick = null;

  const clearTimers = () => {
    if (initialTimer !== null) clearTimeout(initialTimer);
    if (repeatTimer !== null) clearInterval(repeatTimer);
    initialTimer = null;
    repeatTimer = null;
  };

  const stop = () => {
    const previous = active;
    active = null;
    clearTimers();
    if (previous && previous.pointerId !== undefined) {
      try {
        if (previous.button.hasPointerCapture?.(previous.pointerId)) {
          previous.button.releasePointerCapture(previous.pointerId);
        }
      } catch {
        // Pointer capture can already be gone, especially after cancel/lost capture.
      }
    }
  };

  const begin = (button, direction, event) => {
    if (button.disabled || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault();
    stop();

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : undefined;
    active = { button, direction, pointerId };
    suppressClick = { button, expiresAt: Date.now() + 1000 };
    rotate(direction);

    if (pointerId !== undefined) {
      try {
        button.setPointerCapture?.(pointerId);
      } catch {
        // Window-level pointerup/cancel listeners below provide the fallback.
      }
    }

    initialTimer = setTimeout(() => {
      initialTimer = null;
      if (!active || active.button.disabled) {
        stop();
        return;
      }
      repeatTimer = setInterval(() => {
        if (!active || active.button.disabled) {
          stop();
          return;
        }
        rotate(active.direction);
      }, repeatInterval);
    }, initialDelay);
  };

  const makeHandlers = (button, direction) => {
    const onPointerDown = (event) => begin(button, direction, event);
    const onPointerStop = (event) => {
      if (!active) return;
      if (event.pointerId === undefined || active.pointerId === undefined || event.pointerId === active.pointerId) {
        stop();
      }
    };
    const onLostPointerCapture = (event) => {
      if (active && active.pointerId === event.pointerId) stop();
    };
    const onClick = (event) => {
      // Pointer clicks follow the immediate pointerdown rotation. detail=0 is
      // reserved for keyboard and assistive technology activation.
      if (event.detail === 0) {
        if (!button.disabled) rotate(direction);
        return;
      }
      if (suppressClick?.button === button && Date.now() <= suppressClick.expiresAt) {
        event.preventDefault();
        suppressClick = null;
      }
    };

    button.addEventListener('pointerdown', onPointerDown);
    button.addEventListener('pointerup', onPointerStop);
    button.addEventListener('pointercancel', onPointerStop);
    button.addEventListener('lostpointercapture', onLostPointerCapture);
    button.addEventListener('click', onClick);
    return () => {
      button.removeEventListener('pointerdown', onPointerDown);
      button.removeEventListener('pointerup', onPointerStop);
      button.removeEventListener('pointercancel', onPointerStop);
      button.removeEventListener('lostpointercapture', onLostPointerCapture);
      button.removeEventListener('click', onClick);
    };
  };

  const removeLeft = makeHandlers(leftButton, -1);
  const removeRight = makeHandlers(rightButton, 1);
  // These also end the hold if pointer capture is unavailable or rejected.
  const onWindowPointerStop = (event) => {
    if (active && active.pointerId === event.pointerId) stop();
  };
  window.addEventListener('pointerup', onWindowPointerStop, true);
  window.addEventListener('pointercancel', onWindowPointerStop, true);

  return () => {
    stop();
    removeLeft();
    removeRight();
    window.removeEventListener('pointerup', onWindowPointerStop, true);
    window.removeEventListener('pointercancel', onWindowPointerStop, true);
    suppressClick = null;
  };
}
