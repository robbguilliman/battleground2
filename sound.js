// Battleground sound: 8-bit music and sound effects, synthesized live in the
// browser with the Web Audio API. No API calls, no audio files: every note is
// generated from pulse, triangle and noise waves, like an old console.
//
// Loaded by both pages before their own scripts. Exposes window.Sound:
//   Sound.music(name)     loop "title" | "loading" | "result", or null for silence
//   Sound.fanfare(upset)  one-shot victory fanfare, then the "result" loop
//   Sound.jingle(name)    one-shot "error" jingle, then silence
//   Sound.sfx(name)       "blip" | "pick" | "unpick" | "remove" | "click" |
//                         "bell" | "save" | "tick" | "ding" |
//                         "whoosh" | "hit" | "smash" | "clang" | "whiff" |
//                         "charge" | "blast" | "ko" (the loading brawl)
//   Sound.enabled()       true unless the player muted it
//
// Browsers only allow audio after the player clicks or presses a key, so the
// first music request waits for that. Sound is on by default; the choice in any
// [data-sound-toggle] button is remembered in localStorage.

(() => {
  const PREF_KEY = "battleground.sound";
  const MUSIC_VOLUME = 0.13;
  const SFX_VOLUME = 0.28;
  const LOOKAHEAD_S = 0.12; // how far ahead notes are scheduled
  const TICK_MS = 25;

  let enabled = true;
  try {
    enabled = localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    // storage blocked: just default to on
  }

  let ctx = null;
  let musicBus = null;
  let sfxBus = null;
  let noiseBuffer = null;
  const pulseWaves = {};

  let wanted = null; // { kind: "loop" | "once", name, then } the music that should be playing
  let current = null; // the song actually playing

  // -------------------------------------------------------------------------
  // Audio setup (lazy, on the first click or key press)
  // -------------------------------------------------------------------------
  function ensureContext() {
    if (ctx) return true;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    ctx = new AudioCtx();
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_VOLUME;
    musicBus.connect(master);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_VOLUME;
    sfxBus.connect(master);

    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  function unlocked() {
    return ctx && ctx.state === "running";
  }

  function unlock() {
    if (!enabled || !ensureContext()) return;
    if (ctx.state === "suspended" && !document.hidden) {
      ctx.resume().then(syncMusic, () => {});
    } else {
      syncMusic();
    }
  }
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);

  // Don't play to an empty room: pause everything while the tab is hidden.
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else if (enabled) ctx.resume().catch(() => {});
  });

  // A pulse wave with the given duty cycle (0.125, 0.25, 0.5), the classic
  // console square-wave voices.
  function pulseWave(duty) {
    if (!pulseWaves[duty]) {
      const n = 32;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 1; i < n; i++) real[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
      pulseWaves[duty] = ctx.createPeriodicWave(real, imag);
    }
    return pulseWaves[duty];
  }

  const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function noteFreq(name) {
    const m = /^([A-G])(#?)(\d)$/.exec(name);
    if (!m) return 0;
    const midi = 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + (m[2] ? 1 : 0);
    return 440 * 2 ** ((midi - 69) / 12);
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------
  // One pitched note with a short attack/decay envelope.
  function tone(dest, { wave = "pulse", duty = 0.5, freq, start, dur, vol = 0.5, slideTo = 0, vibrato = 0 }) {
    if (!freq) return;
    const osc = ctx.createOscillator();
    if (wave === "pulse") osc.setPeriodicWave(pulseWave(duty));
    else osc.type = wave;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    if (vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 7;
      depth.gain.value = freq * vibrato;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(start);
      lfo.stop(start + dur + 0.05);
    }
    const env = ctx.createGain();
    const release = Math.min(0.04, dur * 0.3);
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(vol, start + 0.005);
    env.gain.setTargetAtTime(vol * 0.65, start + 0.01, 0.06);
    env.gain.setValueAtTime(vol * 0.65, Math.max(start + 0.01, start + dur - release));
    env.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(env).connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // A burst of filtered noise: snares, hi-hats, crunches.
  function noise(dest, { start, dur, vol = 0.4, filter = "highpass", cutoff = 6000 }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = cutoff;
    const env = ctx.createGain();
    env.gain.setValueAtTime(vol, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(f).connect(env).connect(dest);
    src.start(start, Math.random() * 0.5);
    src.stop(start + dur + 0.02);
  }

  function kick(dest, start, vol = 0.9) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, start);
    osc.frequency.exponentialRampToValueAtTime(40, start + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(vol, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
    osc.connect(env).connect(dest);
    osc.start(start);
    osc.stop(start + 0.17);
  }

  function drum(dest, hit, start, vol) {
    if (hit === "k") kick(dest, start, vol);
    else if (hit === "s") noise(dest, { start, dur: 0.12, vol: vol * 0.7, filter: "bandpass", cutoff: 1800 });
    else if (hit === "h") noise(dest, { start, dur: 0.035, vol: vol * 0.35, filter: "highpass", cutoff: 7000 });
  }

  // -------------------------------------------------------------------------
  // Songs. Every track is a list of "note:steps" tokens (a step is a 16th note;
  // "." is a rest; drum tracks use k = kick, s = snare, h = hi-hat). All tracks
  // in a song add up to the same number of steps, so loops stay in sync.
  // All pieces are original.
  // -------------------------------------------------------------------------
  const rep = (s, n) => Array(n).fill(s).join(" ");
  const bassEighths = (lo, hi) => rep(`${lo}:2 ${hi}:2`, 4);
  const bassSixteenths = (lo, hi) => rep(`${lo}:1 ${lo}:1 ${hi}:1 ${lo}:1`, 4);
  const arp = (a, b, c, len = 1) => rep(`${a}:${len} ${b}:${len} ${c}:${len} ${b}:${len}`, 4 / len);

  const SONGS = {
    // Title screen and BattleDex: bright, bouncy, "insert coin".
    title: {
      bpm: 152,
      loop: true,
      tracks: [
        {
          voice: { wave: "pulse", duty: 0.25, vol: 0.5 },
          notes:
            "E5:2 G5:2 C6:4 B5:2 G5:2 E5:4 " +
            "F5:2 E5:2 D5:2 E5:2 G5:8 " +
            "A5:2 C6:2 E6:4 D6:2 C6:2 A5:4 " +
            "G5:2 A5:2 G5:2 E5:2 C5:8 " +
            "F5:2 A5:2 C6:4 A5:2 C6:2 F6:4 " +
            "E6:2 D6:2 C6:2 A5:2 G5:8 " +
            "G5:2 B5:2 D6:4 B5:2 D6:2 G6:4 " +
            "F6:2 E6:2 D6:2 B5:2 G5:4 .:4",
        },
        {
          voice: { wave: "pulse", duty: 0.125, vol: 0.18 },
          notes: [
            arp("C4", "E4", "G4"), arp("C4", "E4", "G4"),
            arp("A3", "C4", "E4"), arp("A3", "C4", "E4"),
            arp("F3", "A3", "C4"), arp("F3", "A3", "C4"),
            arp("G3", "B3", "D4"), arp("G3", "B3", "D4"),
          ].join(" "),
        },
        {
          voice: { wave: "triangle", vol: 0.8 },
          notes: [
            bassEighths("C3", "C4"), bassEighths("C3", "C4"),
            bassEighths("A2", "A3"), bassEighths("A2", "A3"),
            bassEighths("F2", "F3"), bassEighths("F2", "F3"),
            bassEighths("G2", "G3"), bassEighths("G2", "G3"),
          ].join(" "),
        },
        { drums: true, vol: 0.55, notes: rep("k:2 h:2 s:2 h:2 k:2 k:2 s:2 h:2", 8) },
      ],
    },

    // Loading: tense minor-key countdown, a ticking hi-hat and a driving bass.
    loading: {
      bpm: 132,
      loop: true,
      tracks: [
        {
          voice: { wave: "pulse", duty: 0.5, vol: 0.38 },
          notes:
            "A4:4 C5:4 E5:4 D5:4 " +
            "C5:4 B4:4 A4:8 " +
            "F4:4 A4:4 C5:4 E5:4 " +
            "D5:4 B4:4 G#4:8 " +
            "A5:4 G5:2 E5:2 A5:4 B5:4 " +
            "C6:4 B5:4 A5:8 " +
            "A5:4 F5:4 C6:4 A5:4 " +
            "G#5:4 B5:4 E5:4 .:4",
        },
        {
          voice: { wave: "triangle", vol: 0.75 },
          notes: [
            bassSixteenths("A2", "A3"), bassSixteenths("A2", "A3"),
            bassSixteenths("F2", "F3"), bassSixteenths("E2", "E3"),
            bassSixteenths("A2", "A3"), bassSixteenths("A2", "A3"),
            bassSixteenths("F2", "F3"), bassSixteenths("E2", "E3"),
          ].join(" "),
        },
        { drums: true, vol: 0.5, notes: rep("k:2 h:2 h:2 h:2 s:2 h:2 h:2 h:2", 8) },
      ],
    },

    // Result: a calmer, warm major-key loop to read the verdict to.
    result: {
      bpm: 104,
      loop: true,
      tracks: [
        {
          voice: { wave: "pulse", duty: 0.125, vol: 0.42 },
          notes:
            "A4:4 C5:4 F5:6 E5:2 " +
            "D5:4 F5:4 A5:8 " +
            "G5:4 F5:4 D5:4 F5:4 " +
            "E5:8 C5:8 " +
            "A5:4 G5:2 F5:2 C5:4 F5:4 " +
            "A5:6 G5:2 F5:4 D5:4 " +
            "D5:4 F5:4 A#5:4 A5:4 " +
            "G5:8 .:8",
        },
        {
          voice: { wave: "pulse", duty: 0.25, vol: 0.14 },
          notes: [
            arp("F4", "A4", "C5", 2), arp("D4", "F4", "A4", 2),
            arp("A#3", "D4", "F4", 2), arp("C4", "E4", "G4", 2),
            arp("F4", "A4", "C5", 2), arp("D4", "F4", "A4", 2),
            arp("A#3", "D4", "F4", 2), arp("C4", "E4", "G4", 2),
          ].join(" "),
        },
        {
          voice: { wave: "triangle", vol: 0.8 },
          notes:
            "F2:8 C3:8 D2:8 A2:8 A#2:8 F2:8 C3:8 G2:8 " +
            "F2:8 C3:8 D2:8 A2:8 A#2:8 F2:8 C3:8 G2:8",
        },
        { drums: true, vol: 0.4, notes: rep("k:4 h:4 s:4 h:4", 8) },
      ],
    },

    // Fight resolved: a short triumphant fanfare.
    fanfare: {
      bpm: 160,
      loop: false,
      tracks: [
        { voice: { wave: "pulse", duty: 0.25, vol: 0.55 }, notes: "G4:2 C5:2 E5:2 G5:6 E5:2 G5:2 A5:2 B5:2 C6:16" },
        { voice: { wave: "pulse", duty: 0.5, vol: 0.3 }, notes: "E4:2 G4:2 C5:2 E5:6 C5:2 E5:2 F5:2 G5:2 E5:16" },
        { voice: { wave: "triangle", vol: 0.85 }, notes: "C3:6 G2:6 C3:4 F2:4 G2:4 C3:12" },
        { drums: true, vol: 0.6, notes: "k:2 s:2 k:2 s:6 s:2 s:2 s:2 s:2 k:4 .:12" },
      ],
    },

    // Upset: the same fanfare knocked sideways by a strange chromatic climb.
    upset: {
      bpm: 150,
      loop: false,
      tracks: [
        { voice: { wave: "pulse", duty: 0.25, vol: 0.55, vibrato: 0.01 }, notes: "C5:2 D#5:2 F#5:2 A5:6 G#5:2 G5:2 F#5:2 G5:2 C6:16" },
        { voice: { wave: "pulse", duty: 0.125, vol: 0.28 }, notes: "G4:2 A4:2 C5:2 D#5:6 D5:2 C#5:2 C5:2 D5:2 E5:16" },
        { voice: { wave: "triangle", vol: 0.85 }, notes: "C3:6 D#3:6 F#3:4 G3:8 C3:12" },
        { drums: true, vol: 0.6, notes: "s:1 s:1 s:1 s:1 s:2 s:6 k:2 k:2 s:2 s:2 k:4 .:12" },
      ],
    },

    // Error: a falling alarm.
    error: {
      bpm: 150,
      loop: false,
      tracks: [
        { voice: { wave: "pulse", duty: 0.5, vol: 0.45 }, notes: "A5:2 .:1 A5:2 .:1 E5:2 C5:2 A4:8" },
        { voice: { wave: "triangle", vol: 0.8 }, notes: "A3:3 A3:3 E3:2 C3:2 A2:8" },
        { drums: true, vol: 0.5, notes: "s:3 s:3 k:2 k:2 k:8" },
      ],
    },
  };

  function parse(notes) {
    return notes
      .trim()
      .split(/\s+/)
      .map((token) => {
        const [note, steps] = token.split(":");
        return { note, steps: Number(steps) || 1 };
      });
  }
  for (const song of Object.values(SONGS)) {
    for (const track of song.tracks) track.events = parse(track.notes);
  }

  // -------------------------------------------------------------------------
  // Sequencer: schedules notes slightly ahead of time on the audio clock.
  // -------------------------------------------------------------------------
  function startSong(name, onEnd) {
    const song = SONGS[name];
    const gain = ctx.createGain();
    gain.connect(musicBus);
    const step = 60 / song.bpm / 4;
    const t0 = ctx.currentTime + 0.06;
    const tracks = song.tracks.map((track) => ({ track, idx: 0, time: t0 }));
    const state = { name, gain, timer: null, endTimer: null };

    const tick = () => {
      const horizon = ctx.currentTime + LOOKAHEAD_S;
      let finished = true;
      let endTime = 0;
      for (const t of tracks) {
        const { events } = t.track;
        while (t.time < horizon) {
          if (t.idx >= events.length) {
            if (!song.loop) break;
            t.idx = 0;
          }
          const ev = events[t.idx++];
          const dur = ev.steps * step;
          if (ev.note !== ".") {
            if (t.track.drums) drum(gain, ev.note, t.time, t.track.vol);
            else tone(gain, { ...t.track.voice, freq: noteFreq(ev.note), start: t.time, dur: dur * 0.92 });
          }
          t.time += dur;
        }
        if (song.loop || t.idx < events.length) finished = false;
        endTime = Math.max(endTime, t.time);
      }
      if (finished) {
        clearInterval(state.timer);
        state.timer = null;
        state.endTimer = setTimeout(() => {
          if (current === state) onEnd?.();
        }, Math.max(0, (endTime - ctx.currentTime) * 1000));
      }
    };
    tick();
    state.timer = setInterval(tick, TICK_MS);
    return state;
  }

  function stopSong(song) {
    if (!song) return;
    clearInterval(song.timer);
    clearTimeout(song.endTimer);
    const now = ctx.currentTime;
    song.gain.gain.setValueAtTime(song.gain.gain.value, now);
    song.gain.gain.linearRampToValueAtTime(0, now + 0.12);
    setTimeout(() => song.gain.disconnect(), 250);
  }

  // Makes what's playing match `wanted`.
  function syncMusic() {
    if (!ctx) return;
    if (!enabled || !wanted) {
      stopSong(current);
      current = null;
      return;
    }
    if (!unlocked()) return; // starts on the first click or key press
    const target = wanted;
    if (current && current.request === target) return;
    stopSong(current);
    current = startSong(target.name, () => {
      if (wanted !== target) return;
      wanted = target.then ? { kind: "loop", name: target.then } : null;
      syncMusic();
    });
    current.request = target;
  }

  function want(request) {
    // Asking for the loop that's already wanted keeps it going, uninterrupted.
    if (request?.kind === "loop" && wanted?.kind === "loop" && wanted.name === request.name) return;
    wanted = request;
    syncMusic();
  }

  // -------------------------------------------------------------------------
  // Sound effects
  // -------------------------------------------------------------------------
  const SFX = {
    blip: (t) => tone(sfxBus, { duty: 0.25, freq: 1320, start: t, dur: 0.035, vol: 0.35 }),
    click: (t) => tone(sfxBus, { wave: "triangle", freq: 660, start: t, dur: 0.04, vol: 0.6 }),
    pick: (t) => {
      ["C6", "E6", "G6", "C7"].forEach((n, i) =>
        tone(sfxBus, { duty: 0.25, freq: noteFreq(n), start: t + i * 0.045, dur: 0.06, vol: 0.45 }),
      );
    },
    unpick: (t) => {
      ["G5", "D5", "G4"].forEach((n, i) =>
        tone(sfxBus, { duty: 0.5, freq: noteFreq(n), start: t + i * 0.05, dur: 0.06, vol: 0.4 }),
      );
    },
    remove: (t) => {
      noise(sfxBus, { start: t, dur: 0.18, vol: 0.5, filter: "lowpass", cutoff: 2200 });
      tone(sfxBus, { duty: 0.5, freq: 220, slideTo: 55, start: t, dur: 0.22, vol: 0.4 });
    },
    bell: (t) => {
      tone(sfxBus, { duty: 0.125, freq: noteFreq("C6"), start: t, dur: 0.5, vol: 0.45 });
      tone(sfxBus, { duty: 0.125, freq: noteFreq("E6"), start: t + 0.09, dur: 0.5, vol: 0.4 });
      tone(sfxBus, { wave: "triangle", freq: noteFreq("C5"), start: t, dur: 0.6, vol: 0.5 });
    },
    save: (t) => {
      ["A5", "D6", "A6"].forEach((n, i) =>
        tone(sfxBus, { duty: 0.25, freq: noteFreq(n), start: t + i * 0.06, dur: i === 2 ? 0.2 : 0.07, vol: 0.45 }),
      );
    },
    tick: (t) => tone(sfxBus, { duty: 0.5, freq: 1000, start: t, dur: 0.025, vol: 0.25 }),
    ding: (t) => {
      tone(sfxBus, { duty: 0.25, freq: noteFreq("E6"), start: t, dur: 0.12, vol: 0.45 });
      tone(sfxBus, { duty: 0.25, freq: noteFreq("A6"), start: t + 0.1, dur: 0.3, vol: 0.45 });
    },
    // The loading view's warm-up brawl (brawl.js). These take a pitch factor
    // p, varied a little on every play so twenty seconds of hits don't sound
    // like one sample on repeat.
    whoosh: (t, p = 1) => {
      noise(sfxBus, { start: t, dur: 0.12, vol: 0.18, filter: "bandpass", cutoff: 1100 * p });
      noise(sfxBus, { start: t + 0.04, dur: 0.1, vol: 0.14, filter: "bandpass", cutoff: 2400 * p });
    },
    hit: (t, p = 1) => {
      kick(sfxBus, t, 0.7);
      noise(sfxBus, { start: t, dur: 0.15, vol: 0.45, filter: "lowpass", cutoff: 3200 * p });
      tone(sfxBus, { duty: 0.5, freq: 190 * p, slideTo: 55 * p, start: t, dur: 0.13, vol: 0.3 });
    },
    smash: (t, p = 1) => {
      kick(sfxBus, t, 1);
      noise(sfxBus, { start: t, dur: 0.06, vol: 0.4, filter: "highpass", cutoff: 4000 * p });
      noise(sfxBus, { start: t, dur: 0.4, vol: 0.6, filter: "lowpass", cutoff: 1600 * p });
      tone(sfxBus, { duty: 0.5, freq: 140 * p, slideTo: 32 * p, start: t, dur: 0.32, vol: 0.38 });
    },
    clang: (t, p = 1) => {
      tone(sfxBus, { duty: 0.125, freq: 1760 * p, start: t, dur: 0.2, vol: 0.26 });
      tone(sfxBus, { duty: 0.25, freq: 2490 * p, start: t, dur: 0.14, vol: 0.18 });
      noise(sfxBus, { start: t, dur: 0.05, vol: 0.28, filter: "highpass", cutoff: 5000 });
    },
    whiff: (t, p = 1) => {
      noise(sfxBus, { start: t, dur: 0.16, vol: 0.16, filter: "bandpass", cutoff: 3200 * p });
      tone(sfxBus, { wave: "triangle", freq: 700 * p, slideTo: 260 * p, start: t, dur: 0.16, vol: 0.4 });
    },
    charge: (t, p = 1) => {
      tone(sfxBus, { duty: 0.25, freq: 220 * p, slideTo: 1320 * p, start: t, dur: 0.66, vol: 0.22, vibrato: 0.03 });
      tone(sfxBus, { wave: "triangle", freq: 110 * p, slideTo: 660 * p, start: t, dur: 0.66, vol: 0.3 });
    },
    blast: (t, p = 1) => {
      kick(sfxBus, t, 1);
      noise(sfxBus, { start: t, dur: 0.45, vol: 0.6, filter: "lowpass", cutoff: 2200 * p });
      tone(sfxBus, { duty: 0.125, freq: 1800 * p, slideTo: 180 * p, start: t, dur: 0.28, vol: 0.28 });
      tone(sfxBus, { duty: 0.5, freq: 120 * p, slideTo: 30 * p, start: t, dur: 0.35, vol: 0.35 });
    },
    ko: (t) => {
      kick(sfxBus, t, 1);
      noise(sfxBus, { start: t, dur: 0.08, vol: 0.45, filter: "highpass", cutoff: 4000 });
      noise(sfxBus, { start: t, dur: 0.6, vol: 0.7, filter: "lowpass", cutoff: 1400 });
      tone(sfxBus, { duty: 0.5, freq: 160, slideTo: 28, start: t, dur: 0.6, vol: 0.42 });
    },
  };

  // Brawl sounds get a random pitch within about 3 semitones either way.
  const VARIED = new Set(["whoosh", "hit", "smash", "clang", "whiff", "charge", "blast"]);

  function sfx(name) {
    if (!enabled || !SFX[name]) return;
    if (!ensureContext() || !unlocked()) return;
    const pitch = VARIED.has(name) ? 2 ** ((Math.random() * 2 - 1) * 0.25) : 1;
    SFX[name](ctx.currentTime + 0.005, pitch);
  }

  // -------------------------------------------------------------------------
  // Mute toggle
  // -------------------------------------------------------------------------
  function renderToggles() {
    document.querySelectorAll("[data-sound-toggle]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(enabled));
      btn.setAttribute("aria-label", enabled ? "Sound on. Turn sound off" : "Sound off. Turn sound on");
      btn.textContent = enabled ? "♪ On" : "♪ Off";
      btn.classList.toggle("is-off", !enabled);
    });
  }

  function setEnabled(on) {
    enabled = on;
    try {
      localStorage.setItem(PREF_KEY, on ? "on" : "off");
    } catch {
      // not remembered, still works for this page
    }
    renderToggles();
    if (on) {
      unlock();
      sfx("click");
    } else {
      syncMusic();
    }
  }

  function initToggles() {
    document.querySelectorAll("[data-sound-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => setEnabled(!enabled));
    });
    renderToggles();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initToggles);
  else initToggles();

  window.Sound = {
    music: (name) => want(name ? { kind: "loop", name } : null),
    fanfare: (upset = false) => want({ kind: "once", name: upset ? "upset" : "fanfare", then: "result" }),
    jingle: (name) => want({ kind: "once", name, then: null }),
    sfx,
    enabled: () => enabled,
  };
})();
