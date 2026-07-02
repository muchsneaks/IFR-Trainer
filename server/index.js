'use strict';

/**
 * IFR Trainer for MSFS 2024 — command-line entry point.
 *
 * Usage:
 *   node server/index.js          connect to MSFS (default port 8642)
 *   node server/index.js --demo   simulated flight, no MSFS needed
 *   PORT=9000 node server/index.js
 */

const { createIfrServer } = require('./createServer');

const demo = process.argv.includes('--demo');
const port = Number(process.env.PORT) || 8642;

const app = createIfrServer({ port, demo });

app
  .listen()
  .then((boundPort) => {
    console.log('┌──────────────────────────────────────────────────┐');
    console.log('│  IFR Trainer for MSFS 2024                        │');
    console.log('└──────────────────────────────────────────────────┘');
    console.log(`Map UI:    http://localhost:${boundPort}`);
    console.log(`Mode:      ${demo ? 'DEMO (simulated flight)' : 'SimConnect (MSFS 2024)'}`);
    console.log('');
  })
  .catch((err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try: PORT=9000 npm start`);
    } else {
      console.error('Failed to start IFR Trainer server:', err);
    }
    process.exit(1);
  });

process.on('SIGINT', async () => {
  await app.close();
  process.exit(0);
});
