/**
 * The process stem separation runs in.
 *
 * Kept apart from the app for two reasons. The network keeps every processor
 * core busy for minutes, and the window should stay responsive while it does.
 * And it is native code: if it ever faults, it takes this process with it and
 * the app carries on, able to say what happened.
 */

const { StemSeparator } = require('./stems.cjs');

// Background work, and told to behave like it: anything the user is doing
// in the app, or anywhere else on the computer, goes first.
try {
  const os = require('os');
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch { /* not allowed here; the thread limit still applies */ }

const port = process.parentPort;
let separator;

const send = message => port.postMessage(message);

port.on('message', async ({ data }) => {
  try {
    if (data.type === 'init') {
      separator = new StemSeparator(data.dataFolder);
      return;
    }
    if (!separator) throw new Error('The separator was not started properly.');

    if (data.type === 'cancel') {
      separator.cancel();
      return;
    }
    if (data.type === 'download') {
      await separator.downloadModel(fraction => send({ type: 'progress', stage: 'download', fraction }));
      send({ type: 'done', job: data.job, result: separator.status() });
      return;
    }
    if (data.type === 'separate') {
      const left = new Float32Array(data.left);
      const right = new Float32Array(data.right);
      const result = await separator.separate(left, right,
        fraction => send({ type: 'progress', stage: 'separate', fraction }));
      send({ type: 'done', job: data.job, result });
    }
  } catch (error) {
    send({ type: 'error', job: data.job, message: error instanceof Error ? error.message : String(error) });
  }
});
