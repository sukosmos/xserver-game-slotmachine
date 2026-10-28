const enabled = ({ sound, fast, reduced }) => sound && !fast && !reduced;

/** The asset contains only the original clip's first 1.06 seconds. */
export class SpinAudio {
  constructor({ createAudio = (url) => new Audio(url) } = {}) {
    this.createAudio = createAudio;
    this.audio = null;
  }

  prepare(preferences) {
    if (!enabled(preferences)) { this.stop(); return; }
    try {
      if (!this.audio) {
        this.audio = this.createAudio('/audio/spin-start.wav');
        this.audio.preload = 'auto';
        this.audio.loop = false;
        this.audio.volume = 0.3;
      }
    } catch { /* Audio availability never affects gameplay. */ }
  }

  start(preferences) {
    this.stop();
    this.prepare(preferences);
    if (!enabled(preferences) || !this.audio) return;
    try {
      // Called directly from the user's click/Space, before awaiting the server.
      this.audio.currentTime = 0;
      this.audio.play()?.catch(() => {});
    } catch { /* Unsupported media or autoplay restrictions are non-fatal. */ }
  }

  onStage(stage) {
    if (stage !== 'rolling' && stage !== 'stopping') this.stop();
  }

  stop() {
    if (!this.audio) return;
    try { this.audio.pause(); this.audio.currentTime = 0; } catch {}
  }
}
