/**
 * First-run onboarding tour.
 *
 * Design goals — helpful without being annoying:
 *  - Shows exactly once (localStorage flag), never inside the MSFS panel
 *  - 4 short steps, skippable at any moment (✕, Esc, or "Skip")
 *  - Reopenable any time via the "?" button in the top bar
 *  - Pure overlay: the app keeps running behind it, nothing is blocked
 */
(function () {
  'use strict';

  const DONE_KEY = 'ifr-onboard-v1';
  const embedded = new URLSearchParams(location.search).has('embedded');

  const STEPS = [
    {
      icon: '🛫',
      title: 'Welcome to IFR Trainer',
      body:
        'This app connects to <b>MSFS 2024</b> automatically — just fly. ' +
        'The chip in the top-right shows the connection: ' +
        '<span class="ob-chip ob-ok">MSFS</span> live data, ' +
        '<span class="ob-chip ob-demo">DEMO</span> simulated flight, ' +
        '<span class="ob-chip ob-bad">OFFLINE</span> waiting for the sim.<br><br>' +
        'Your <b>flight track is recorded automatically</b> — every hold, ' +
        'procedure turn and intercept stays on the map for review.',
    },
    {
      icon: '🧭',
      title: 'A real IFR chart — from the sim itself',
      body:
        'VORs, NDBs, waypoints, airports, <b>runways and ILS feathers</b> come ' +
        'live from the native MSFS navdata around your aircraft.<br><br>' +
        '<b>Click any fix</b> to get live bearing / radial / distance to it. ' +
        'Select a <b>VOR</b> and you also get a compass rose — type an ' +
        '<b>OBS course</b> to draw the radial on the map and bring up a live ' +
        '<b>CDI</b> (2° per dot, TO/FROM flag) for raw-data intercepts.',
    },
    {
      icon: '⏱️',
      title: 'Holds & timing — like an instructor set them up',
      body:
        'Under <b>Training → Hold</b>: pick a fix, set the inbound course, ' +
        'turn direction and leg time, and a <b>racetrack template</b> is drawn ' +
        'on the chart — sized for standard-rate turns at your ground speed. ' +
        'Fly it, then compare your magenta track against it (wind correction!).' +
        '<br><br>The <b>TMR</b> leg timer in the top bar starts/stops with a ' +
        'click or <code>T</code>, resets with <code>R</code> — for hold legs, ' +
        'procedure turns and timed approaches.',
    },
    {
      icon: '📈',
      title: 'Your track is your teacher',
      body:
        'Fly the procedure first, <i>then</i> look at the map: the magenta ' +
        'track shows what you actually flew.<br><br>' +
        'In the panel (☰, top right) you can <b>clear</b> the track between ' +
        'exercises and <b>export</b> it as GeoJSON/KML — e.g. to replay an ' +
        'approach in Google Earth. Range rings and follow mode live there too.',
    },
    {
      icon: '⚡',
      title: 'Optional power-ups',
      body:
        '<b>MSFS toolbar panel</b> — copy the add-on from the ' +
        '<code>msfs-addon</code> folder into your Community folder and this ' +
        'map appears inside the sim.<br><br>' +
        '<b>Navigraph</b> — sign in under ☰ → Navigraph to add the official ' +
        'IFR enroute chart and approach plates as overlays under your track. ' +
        '<span class="ob-muted">(Optional — the native chart works without it.)</span>',
    },
  ];

  let step = 0;

  const el = {
    root: document.getElementById('onboard'),
    body: document.getElementById('onboard-body'),
    dots: document.getElementById('onboard-dots'),
    back: document.getElementById('onboard-back'),
    next: document.getElementById('onboard-next'),
    skip: document.getElementById('onboard-skip'),
    help: document.getElementById('btn-help'),
  };
  if (!el.root) return;

  function render() {
    const s = STEPS[step];
    el.body.innerHTML = `
      <div class="ob-icon">${s.icon}</div>
      <h2>${s.title}</h2>
      <p>${s.body}</p>`;
    el.dots.innerHTML = STEPS.map(
      (_, i) => `<span class="ob-dot${i === step ? ' on' : ''}"></span>`
    ).join('');
    el.back.style.visibility = step === 0 ? 'hidden' : 'visible';
    el.next.textContent = step === STEPS.length - 1 ? 'Start flying' : 'Next';
  }

  function open(atStep) {
    step = atStep || 0;
    render();
    el.root.classList.remove('hidden');
  }

  function close() {
    el.root.classList.add('hidden');
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch (_) {
      /* storage unavailable — just don't persist */
    }
  }

  el.next.addEventListener('click', () => {
    if (step >= STEPS.length - 1) {
      close();
    } else {
      step += 1;
      render();
    }
  });
  el.back.addEventListener('click', () => {
    if (step > 0) {
      step -= 1;
      render();
    }
  });
  el.skip.addEventListener('click', close);
  el.root.addEventListener('click', (e) => {
    if (e.target === el.root) close(); // click outside the card
  });
  document.addEventListener('keydown', (e) => {
    if (el.root.classList.contains('hidden')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight' || e.key === 'Enter') el.next.click();
    if (e.key === 'ArrowLeft') el.back.click();
  });

  if (el.help) {
    el.help.addEventListener('click', () => open(0));
    if (embedded) el.help.style.display = 'none';
  }

  // First run only, and never inside the in-sim panel.
  let done = null;
  try {
    done = localStorage.getItem(DONE_KEY);
  } catch (_) {
    done = '1';
  }
  if (!embedded && !done) {
    // Give the map a moment to paint first — feels calmer than an instant modal.
    setTimeout(() => open(0), 600);
  }
})();
