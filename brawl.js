// The warm-up brawl on the loading view: while the real verdict loads, the two
// fighter cards trade attacks, blocks, dodges and the odd special move, with
// comic-book hit words, sparks, shakes, cracks, combo counters, HP bars and
// live commentary in the banner under the round title. The warm-up itself never hints at the winner: whoever is
// ahead tends to take the next hit, and when either bar runs low both refill
// and a new round starts. Only when the verdict is in does the real winner
// land a finishing blow (finish()), right before the result appears.
//
// Loaded by index.html before script.js. Exposes window.Brawl:
//   Brawl.start()         reset both cards to full HP and start trading blows
//   Brawl.stop()          stop at once and clear every effect (any other view)
//   Brawl.finish(side)    "a" | "b": the winner's K.O. blow; resolves when done
//                         (at once if the brawl isn't running)
//
// Card motion uses the Web Animations API (each swing's direction and reach is
// worked out per beat); the one-off effects are elements with CSS animations
// that remove themselves. With prefers-reduced-motion the cards just stand
// still at full HP.

(() => {
  const sound = window.Sound || { sfx() {} };
  const api = { start() {}, stop() {}, finish: () => Promise.resolve() };
  window.Brawl = api;

  const arena = document.getElementById("brawl");
  const fx = document.getElementById("brawl-fx");
  const roundTitle = document.getElementById("round-title");
  const callEl = document.getElementById("brawl-call");
  if (!arena || !fx || !roundTitle || !callEl || !arena.animate) return;

  const HIT_WORDS = ["POW!", "BANG!", "CRASH!", "WHAM!", "KRAK!", "THWACK!", "SMASH!", "BONK!", "ZAP!", "WHUMP!"];
  const BIG_WORDS = ["KA-BOOM!", "KRAKOOM!", "MEGA HIT!", "CRITICAL!"];
  const SPECIAL_WORDS = ["KA-BLAM!", "ZZZAP!", "MEGA BLAST!", "FWOOOM!"];
  const BLOCK_WORDS = ["CLANG!", "BLOCKED!", "TINK!", "PARRY!"];
  const MISS_WORDS = ["WHIFF!", "MISS!", "SWISH!", "TOO SLOW!"];

  // Live commentary; a = the attacker's name, d = the defender's.
  const CALLS = {
    hit: [
      (a) => `${a} connects!`,
      (a) => `${a} lands a clean one!`,
      (a, d) => `${d} takes one on the chin!`,
      (a) => `${a} goes for the body!`,
      (a, d) => `Ooh, ${d} felt that!`,
    ],
    big: [
      (a) => `HUGE hit from ${a}!`,
      (a) => `${a} unloads a haymaker!`,
      (a, d) => `${d} is seeing stars!`,
    ],
    block: [
      (a, d) => `${d} blocks it cold!`,
      (a, d) => `${d} shrugs it off!`,
      (a, d) => `Denied! ${d} saw it coming!`,
    ],
    miss: [
      (a, d) => `${d} dodges clean!`,
      (a) => `${a} swings at thin air!`,
      (a, d) => `Whiff! ${d} is too slippery!`,
    ],
    combo: [
      (a) => `${a} is on a roll!`,
      (a) => `${a} won't let up!`,
    ],
    charge: [
      (a) => `${a} is charging up something BIG…`,
      (a) => `Uh oh, ${a} is powering up…`,
    ],
    round: [() => `Both fighters catch their breath… ROUND ${round}!`],
    ko: [(a) => `${a} lands the finishing blow!`],
  };
  const CALL_GAP_MS = 1800; // ordinary calls wait this long after the last one

  const LUNGE_MS = 560;
  const IMPACT_MS = 310; // when the swing lands, about 55% into the lunge
  const DODGE_LEAD_MS = 120; // a dodge starts just before the swing would land
  const CHARGE_MS = 700;
  const ORB_MS = 330;
  // The freeze-frame on impact that makes a blow feel heavy.
  const HITSTOP = { block: 45, hit: 75, big: 120, special: 140, ko: 220 };
  const KO_HOLD_MS = 550; // after the K.O. freeze, before the result appears
  const LOW_HP = 22; // either side below this ends the round
  const MIN_HP = 4; // a warm-up hit never knocks anyone out

  const reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  function side(key) {
    const el = document.getElementById(`brawler-${key}`);
    return {
      el,
      body: el.querySelector(".brawler"),
      box: el.querySelector(".mystery-box"),
      flash: el.querySelector(".hit-flash"),
      bar: el.querySelector(".brawl-hp"),
      name: document.getElementById(`loading-name-${key}`),
      hp: 100,
    };
  }
  const sides = { a: side("a"), b: side("b") };

  let running = false;
  let round = 1;
  let lastAttacker = null;
  let lastWord = "";
  let combo = { side: null, count: 0 };
  let lastCallAt = 0;
  let finishResolve = null;
  const timers = new Set();

  // setTimeout that's cancelled by stop() and does nothing once stopped.
  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      if (running) fn();
    }, ms);
    timers.add(id);
  }

  const rand = (min, max) => min + Math.random() * (max - min);
  const other = (key) => (key === "a" ? "b" : "a");
  const pickFrom = (list) => list[Math.floor(Math.random() * list.length)];

  function pickWord(list) {
    let word = pickFrom(list);
    if (word === lastWord && list.length > 1) word = list[(list.indexOf(word) + 1) % list.length];
    lastWord = word;
    return word;
  }

  // The HP bar drops at once; a white "ghost" bar trails behind and drains
  // to the new value a moment later. Refills skip the ghost.
  function setHp(key, hp) {
    const s = sides[key];
    const dropped = hp < s.hp;
    s.hp = hp;
    s.bar.style.setProperty("--hp", hp);
    s.el.dataset.damage = hp <= 40 ? "2" : hp <= 70 ? "1" : "0";
    if (dropped) later(() => s.bar.style.setProperty("--ghost", s.hp), 450);
    else s.bar.style.setProperty("--ghost", hp);
  }

  // How far a card lunges, scaled to the arena so phones get a shorter swing.
  function reach() {
    return Math.max(18, Math.min(80, arena.clientWidth * 0.07));
  }

  function chooseAttacker() {
    const { a, b } = sides;
    // Keep the bars close: the fighter who's ahead usually takes the next hit.
    if (Math.abs(a.hp - b.hp) > 15) {
      const leader = a.hp > b.hp ? "a" : "b";
      return Math.random() < 0.8 ? other(leader) : leader;
    }
    if (!lastAttacker) return Math.random() < 0.5 ? "a" : "b";
    return Math.random() < 0.3 ? lastAttacker : other(lastAttacker); // room for combos
  }

  function rollKind() {
    const roll = Math.random();
    if (roll < 0.1) return "special";
    if (roll < 0.34) return "block";
    if (roll < 0.46) return "miss";
    if (roll < 0.58) return "big";
    return "hit";
  }

  // ---------------------------------------------------------------------------
  // Commentary
  // ---------------------------------------------------------------------------
  function fighterName(key) {
    const name = sides[key].name.textContent.trim().toUpperCase();
    return name.length > 22 ? `${name.slice(0, 21)}…` : name;
  }

  // Ordinary calls are spaced out so each can be read; `force` is for the
  // moments worth shouting about. Each new call pops into the banner.
  function call(list, atk, def, force = false) {
    const now = Date.now();
    if (!force && now - lastCallAt < CALL_GAP_MS) return;
    lastCallAt = now;
    callEl.textContent = pickFrom(list)(fighterName(atk), fighterName(def));
    callEl.getAnimations().forEach((anim) => anim.cancel());
    callEl.animate(
      [
        { transform: "scale(1.2)", opacity: 0 },
        { transform: "scale(0.97)", opacity: 1, offset: 0.6 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: 280, easing: "ease-out" },
    );
  }

  // ---------------------------------------------------------------------------
  // One exchange: a lunge, then a hit, a big hit, a block or a dodge, or a
  // charged-up special move instead.
  // ---------------------------------------------------------------------------
  function beat() {
    const atk = chooseAttacker();
    const def = other(atk);
    const kind = rollKind();
    lastAttacker = atk;
    if (kind === "special") {
      special(atk);
      return;
    }
    const dir = atk === "a" ? 1 : -1; // +1 swings right (A at B), -1 swings left
    const r = reach();
    const lunge = lungeAt(atk, dir, r, 1);
    later(() => sound.sfx("whoosh"), 150);
    later(() => impact(def, atk, dir, kind, r, lunge), kind === "miss" ? IMPACT_MS - DODGE_LEAD_MS : IMPACT_MS);
    later(afterBeat, rand(1050, 1400) + (HITSTOP[kind] || 0) + (kind === "big" ? 300 : 0));
  }

  function lungeAt(key, dir, r, power) {
    const s = sides[key];
    const p = r * power;
    s.el.classList.add("is-attacking");
    const anim = s.body.animate(
      [
        { transform: "translateX(0) scale(1) rotate(0)" },
        { transform: `translateX(${-dir * p * 0.25}px) scale(0.95) rotate(${-dir * 3}deg)`, offset: 0.3 },
        { transform: `translateX(${dir * p}px) scale(1.07) rotate(${dir * 5}deg)`, offset: 0.55 },
        { transform: `translateX(${dir * p * 0.85}px) scale(1.04) rotate(${dir * 3}deg)`, offset: 0.68 },
        { transform: "translateX(0) scale(1) rotate(0)" },
      ],
      { duration: LUNGE_MS, easing: "ease-out" },
    );
    anim.onfinish = () => s.el.classList.remove("is-attacking");
    return anim;
  }

  function impact(def, atk, dir, kind, r, lunge) {
    const s = sides[def];
    const point = impactPoint(s, dir);
    if (kind === "miss") {
      dodge(s, dir, r);
      burst(point, pickWord(MISS_WORDS), "is-miss");
      sound.sfx("whiff");
      combo = { side: null, count: 0 };
      call(CALLS.miss, atk, def);
    } else if (kind === "block") {
      blockIt(def, atk, dir, r, lunge, point);
    } else {
      landHit({ def, atk, dir, r, kind, lunge, point });
    }
  }

  function blockIt(def, atk, dir, r, lunge, point) {
    const s = sides[def];
    shield(s);
    burst(point, pickWord(BLOCK_WORDS), "is-block");
    sparks(point, 5, "is-block");
    sound.sfx("clang");
    combo = { side: null, count: 0 };
    call(CALLS.block, atk, def);
    hitStop(HITSTOP.block, lunge, () => {
      s.body.animate(
        [
          { transform: "translateX(0)" },
          { transform: `translateX(${dir * r * 0.18}px)`, offset: 0.25 },
          { transform: "translateX(0)" },
        ],
        { duration: 320, easing: "ease-out" },
      );
    });
  }

  // A blow that lands: "hit", "big", "special" or the final "ko".
  function landHit({ def, atk, dir, r, kind, lunge, point }) {
    const s = sides[def];
    const heavy = kind !== "hit";
    const ko = kind === "ko";
    const dmg = ko ? s.hp : Math.round(heavy ? rand(17, 25) : rand(8, 15));
    const words = { hit: HIT_WORDS, big: BIG_WORDS, special: SPECIAL_WORDS, ko: ["K.O.!"] }[kind];

    burst(point, pickWord(words), ko ? "is-big is-ko" : heavy ? "is-big" : "");
    sparks(point, ko ? 16 : heavy ? 12 : 7, "");
    s.flash.animate(
      [
        { opacity: 0.95, backgroundColor: "#ffffff" },
        { opacity: 0.75, backgroundColor: "#ff3b4f", offset: 0.3 },
        { opacity: 0, backgroundColor: "#ff3b4f" },
      ],
      { duration: heavy ? 520 : 380, easing: "ease-out" },
    );
    if (heavy) spawn("fx-flash", 0, 0);
    sound.sfx({ hit: "hit", big: "smash", special: "blast", ko: "ko" }[kind]);
    setHp(def, ko ? 0 : Math.max(MIN_HP, s.hp - dmg));
    if (!ko) {
      damageNumber(s, dmg, heavy);
      countCombo(atk, def);
      if (kind === "big") call(CALLS.big, atk, def, true);
      else if (kind === "hit" && combo.count < 3) call(CALLS.hit, atk, def);
    }

    hitStop(HITSTOP[kind], lunge, () => {
      knockback(s, dir, r, ko ? 2.2 : heavy ? 1.6 : 1);
      if (heavy) cameraPunch(ko ? 1.08 : 1.05);
    });
  }

  // Freeze the swing (and both cards' idle bob) for a beat on impact.
  function hitStop(ms, lunge, then) {
    if (lunge) lunge.pause();
    arena.classList.add("is-hitstop");
    later(() => {
      arena.classList.remove("is-hitstop");
      if (lunge && lunge.playState === "paused") lunge.play();
      then();
    }, ms);
  }

  function countCombo(atk, def) {
    combo = combo.side === atk ? { side: atk, count: combo.count + 1 } : { side: atk, count: 1 };
    if (combo.count < 2) return;
    const { x, y } = boxPoint(sides[atk], 0.5, 0.12);
    spawn("fx-combo", x, y, `${combo.count} HIT COMBO!`);
    if (combo.count >= 3) call(CALLS.combo, atk, def, true);
  }

  function knockback(s, dir, r, k) {
    s.body.animate(
      [
        { transform: "translate(0, 0) rotate(0)" },
        { transform: `translate(${dir * r * 0.4 * k}px, -4px) rotate(${dir * 7 * k}deg)`, offset: 0.15 },
        { transform: `translate(${dir * r * 0.1}px, 3px) rotate(${-dir * 4}deg)`, offset: 0.35 },
        { transform: `translate(${dir * r * 0.2}px, -2px) rotate(${dir * 3}deg)`, offset: 0.55 },
        { transform: `translate(${-dir * 3}px, 1px) rotate(${-dir * 1}deg)`, offset: 0.75 },
        { transform: "translate(0, 0) rotate(0)" },
      ],
      { duration: k > 1 ? 560 : 420, easing: "ease-out" },
    );
  }

  // The defender sidesteps away and leans out of the swing.
  function dodge(s, dir, r) {
    s.body.animate(
      [
        { transform: "translate(0, 0) skewX(0)" },
        { transform: `translate(${dir * r * 0.6}px, -10px) skewX(${-dir * 8}deg)`, offset: 0.35 },
        { transform: `translate(${dir * r * 0.5}px, -6px) skewX(${-dir * 4}deg)`, offset: 0.6 },
        { transform: "translate(0, 0) skewX(0)" },
      ],
      { duration: 480, easing: "ease-out" },
    );
  }

  // A shake plus a quick zoom of the whole arena, for the heavy blows.
  function cameraPunch(scale) {
    const mid = 1 + (scale - 1) / 2;
    arena.animate(
      [
        { transform: "translate(0, 0) scale(1)" },
        { transform: `translate(-7px, 4px) scale(${scale})`, offset: 0.15 },
        { transform: `translate(6px, -5px) scale(${scale})`, offset: 0.3 },
        { transform: `translate(-5px, -2px) scale(${mid})`, offset: 0.5 },
        { transform: "translate(4px, 3px) scale(1.01)", offset: 0.7 },
        { transform: "translate(-2px, 1px) scale(1)", offset: 0.85 },
        { transform: "translate(0, 0) scale(1)" },
      ],
      { duration: 480, easing: "ease-out" },
    );
  }

  // The special move: the attacker glows and trembles while it charges, then
  // fires an energy ball across the arena. It can still be blocked.
  function special(atk) {
    const def = other(atk);
    const s = sides[atk];
    const dir = atk === "a" ? 1 : -1;
    const r = reach();
    combo = combo.side === atk ? combo : { side: null, count: 0 };
    s.el.classList.add("is-charging");
    s.body.animate(
      Array.from({ length: 12 }, (_, i) => ({
        transform: i === 11 ? "translate(0, 0)" : `translate(${i % 2 ? 2 : -2}px, ${i % 3 ? -1 : 1}px)`,
      })),
      { duration: CHARGE_MS, easing: "linear" },
    );
    sound.sfx("charge");
    call(CALLS.charge, atk, def, true);

    later(() => {
      s.el.classList.remove("is-charging");
      s.body.animate(
        [
          { transform: "translateX(0)" },
          { transform: `translateX(${-dir * r * 0.3}px)`, offset: 0.3 },
          { transform: "translateX(0)" },
        ],
        { duration: 360, easing: "ease-out" },
      );
      sound.sfx("whoosh");
      const from = boxPoint(s, dir > 0 ? 0.75 : 0.25, 0.5);
      const to = impactPoint(sides[def], dir);
      const orb = spawn(`fx-orb is-${atk}`, from.x, from.y);
      orb.animate(
        [
          { transform: "translate(-50%, -50%) scale(0.5)" },
          { transform: `translate(calc(-50% + ${(to.x - from.x).toFixed(0)}px), calc(-50% + ${(to.y - from.y).toFixed(0)}px)) scale(1.15)` },
        ],
        { duration: ORB_MS, easing: "ease-in", fill: "forwards" },
      );
      later(() => {
        orb.remove();
        if (Math.random() < 0.3) blockIt(def, atk, dir, r, null, to);
        else landHit({ def, atk, dir, r, kind: "special", lunge: null, point: to });
      }, ORB_MS);
    }, CHARGE_MS);
    later(afterBeat, CHARGE_MS + ORB_MS + HITSTOP.special + rand(1000, 1300));
  }

  function afterBeat() {
    if (Math.min(sides.a.hp, sides.b.hp) < LOW_HP) newRound();
    else beat();
  }

  // Both bars refill and the round number goes up; nobody ever loses the warm-up.
  function newRound() {
    later(() => {
      round += 1;
      roundTitle.textContent = `Round ${round}`;
      roundTitle.animate(
        [
          { transform: "scale(1.5)", opacity: 0 },
          { transform: "scale(0.94)", opacity: 1, offset: 0.6 },
          { transform: "scale(1)", opacity: 1 },
        ],
        { duration: 450, easing: "ease-out" },
      );
      setHp("a", 100);
      setHp("b", 100);
      lastAttacker = null;
      combo = { side: null, count: 0 };
      sound.sfx("bell");
      call(CALLS.round, "a", "b", true);
    }, 250);
    later(beat, 1350);
  }

  // ---------------------------------------------------------------------------
  // The finishing blow, once the verdict is in.
  // ---------------------------------------------------------------------------
  function finish(winner) {
    if (!running || (winner !== "a" && winner !== "b")) return Promise.resolve();
    return new Promise((resolve) => {
      finishResolve = resolve;
      // Drop whatever exchange was coming; `running` stays on so later() works.
      timers.forEach(clearTimeout);
      timers.clear();
      cancelMotion();
      const loser = other(winner);
      const dir = winner === "a" ? 1 : -1;
      const r = reach();
      const lunge = lungeAt(winner, dir, r, 1.2);
      later(() => sound.sfx("whoosh"), 150);
      later(() => {
        landHit({ def: loser, atk: winner, dir, r, kind: "ko", lunge, point: impactPoint(sides[loser], dir) });
        call(CALLS.ko, winner, loser, true);
      }, IMPACT_MS);
      later(() => sides[loser].el.classList.add("is-ko"), IMPACT_MS + HITSTOP.ko);
      later(settle, IMPACT_MS + HITSTOP.ko + KO_HOLD_MS);
    });
  }

  function settle() {
    const resolve = finishResolve;
    finishResolve = null;
    if (resolve) resolve();
  }

  // ---------------------------------------------------------------------------
  // Effects: positioned in the arena's own coordinates, gone when they finish.
  // ---------------------------------------------------------------------------
  // A point on a card's art box, as fractions of its width and height.
  function boxPoint(s, px, py) {
    const a = arena.getBoundingClientRect();
    const b = s.box.getBoundingClientRect();
    return { x: b.left - a.left + b.width * px, y: b.top - a.top + b.height * py };
  }

  // The spot where a blow lands: the defender's edge that faces the attacker.
  function impactPoint(s, dir) {
    return boxPoint(s, dir > 0 ? rand(0.22, 0.38) : rand(0.62, 0.78), rand(0.3, 0.6));
  }

  function spawn(className, x, y, text = "") {
    const el = document.createElement("div");
    el.className = className;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (text) {
      const span = document.createElement("span");
      span.textContent = text;
      el.append(span);
    }
    el.addEventListener("animationend", () => el.remove(), { once: true });
    fx.append(el);
    setTimeout(() => el.remove(), 1500); // in case animationend never fires
    return el;
  }

  function burst({ x, y }, word, variant) {
    const el = spawn(`fx-burst ${variant}`.trim(), x, y, word);
    el.style.setProperty("--rot", `${rand(-14, 14).toFixed(1)}deg`);
  }

  function sparks({ x, y }, count, variant) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + rand(-0.3, 0.3);
      const dist = rand(40, 95);
      const el = spawn(`fx-spark ${variant}`.trim(), x, y);
      el.style.setProperty("--dx", `${(Math.cos(angle) * dist).toFixed(0)}px`);
      el.style.setProperty("--dy", `${(Math.sin(angle) * dist).toFixed(0)}px`);
    }
  }

  function damageNumber(s, dmg, big) {
    const { x, y } = boxPoint(s, rand(0.4, 0.6), 0.15);
    spawn(big ? "fx-dmg is-big" : "fx-dmg", x, y, `-${dmg}`);
  }

  function shield(s) {
    const { x, y } = boxPoint(s, 0.5, 0.5);
    const el = spawn("fx-shield", x, y);
    el.style.width = `${(s.box.getBoundingClientRect().width * 0.92).toFixed(0)}px`;
  }

  // ---------------------------------------------------------------------------
  function cancelMotion() {
    for (const el of [arena, roundTitle, sides.a.body, sides.b.body, sides.a.flash, sides.b.flash]) {
      el.getAnimations().forEach((anim) => anim.cancel());
    }
    for (const s of Object.values(sides)) s.el.classList.remove("is-attacking", "is-charging");
    arena.classList.remove("is-hitstop");
    fx.querySelectorAll(".fx-orb").forEach((orb) => orb.remove());
  }

  function stop() {
    running = false;
    timers.forEach(clearTimeout);
    timers.clear();
    cancelMotion();
    for (const s of Object.values(sides)) s.el.classList.remove("is-ko");
    fx.replaceChildren();
    callEl.getAnimations().forEach((anim) => anim.cancel());
    callEl.textContent = "";
    settle(); // a finish() that got cut short still resolves
  }

  function start() {
    stop();
    round = 1;
    lastAttacker = null;
    combo = { side: null, count: 0 };
    lastCallAt = 0;
    roundTitle.textContent = "Round 1";
    callEl.textContent = "Fighters, take your corners…";
    setHp("a", 100);
    setHp("b", 100);
    if (reduceMotion.matches) return; // the cards just stand ready
    running = true;
    later(beat, 750);
  }

  Object.assign(api, { start, stop, finish });
})();
