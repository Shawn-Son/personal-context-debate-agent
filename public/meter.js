const UPDATE_INTERVAL = 33;

export function createMicrophoneMeter(onLevel) {
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (typeof onLevel !== 'function' || !AudioContext) return null;

  let context;
  let analyser;
  try {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
  } catch {
    if (context) void context.close().catch(() => {});
    return null;
  }

  let source;
  let frame = null;
  let lastUpdate = 0;
  let level = 0;
  const samples = new Float32Array(analyser.fftSize);

  function resume() {
    if (context.state === 'suspended') void context.resume().catch(() => {});
  }

  // Call while the connect button's user activation is still available.
  resume();

  function sample(now) {
    frame = requestAnimationFrame(sample);
    if (now - lastUpdate < UPDATE_INTERVAL) return;
    lastUpdate = now;

    let peak = 0;
    if (context.state === 'running') {
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const value of samples) energy += value * value;
      const rms = Math.sqrt(energy / samples.length);
      const decibels = 20 * Math.log10(Math.max(rms, 0.0001));
      peak = Math.min(1, Math.max(0, (decibels + 56) / 38));
    }

    level += (peak - level) * (peak > level ? 0.65 : 0.3);
    if (level < 0.005) level = 0;
    onLevel(level);
  }

  function setActive(active) {
    if (active && source) {
      resume();
      if (frame === null) frame = requestAnimationFrame(sample);
    } else if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
      level = 0;
      onLevel(0);
    }
  }

  function close() {
    setActive(false);
    source?.disconnect();
    source = undefined;
    if (context.state !== 'closed') void context.close().catch(() => {});
  }

  return {
    attach(stream) {
      try {
        source = context.createMediaStreamSource(stream);
        source.connect(analyser);
      } catch {
        close();
      }
    },
    setActive,
    close,
  };
}
