import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../src/index.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeWorker(request) {
  const exit = deferred();
  return {
    closed: exit.promise,
    request,
    stops: 0,
    exited: false,
    stop() {
      this.stops++;
      this.exited = true;
      exit.resolve();
      return this.closed;
    },
    exit() { this.exited = true; exit.resolve(); },
  };
}

test('shutdown owns a pending launch and rejects late launch completion', async () => {
  const launch = deferred();
  const worker = fakeWorker(() => launch.promise);
  const manager = new SessionManager({ createWorker: () => worker });
  const starting = manager.start({});
  assert.equal(manager.workers.size, 1);
  await manager.closeAll();
  assert.equal(worker.stops, 1);
  launch.resolve({ clientPid: 42, consoleHostPid: 43 });
  await assert.rejects(starting, /closed during startup/);
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.workers.size, 0);
  await assert.rejects(manager.start({}), /shutting down/);
});

test('shutdown is idempotent and waits for workers to actually exit', async () => {
  const worker = fakeWorker(async () => ({}));
  const exit = deferred();
  worker.stop = function () { this.stops++; return exit.promise; };
  const manager = new SessionManager({ createWorker: () => worker });
  await manager.start({});
  const first = manager.closeAll();
  assert.equal(manager.closeAll(), first);
  assert.equal(worker.stops, 1);
  let done = false;
  void first.then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  worker.exit();
  exit.resolve();
  await first;
  assert.deepEqual(manager.list(), []);
});

test('worker exit automatically removes its session', async () => {
  const worker = fakeWorker(async () => ({ clientPid: 42 }));
  const manager = new SessionManager({ createWorker: () => worker });
  const session = await manager.start({});
  assert.equal(manager.list().length, 1);
  worker.exit();
  await worker.closed;
  assert.deepEqual(manager.list(), []);
  assert.throws(() => manager.get(session.sessionId), /Unknown Telnet session/);
});

test('failed launches stop their worker and leave no tracked resources', async () => {
  const worker = fakeWorker(async () => { throw new Error('launch failed'); });
  const manager = new SessionManager({ createWorker: () => worker });
  await assert.rejects(manager.start({}), /launch failed/);
  assert.equal(worker.stops, 1);
  assert.equal(manager.workers.size, 0);
  assert.deepEqual(manager.list(), []);
});

test('force-close failure still stops its worker', async () => {
  const worker = fakeWorker(async (op) => {
    if (op === 'close') throw new Error('close timed out');
    return {};
  });
  const manager = new SessionManager({ createWorker: () => worker });
  const session = await manager.start({});
  await assert.rejects(manager.close(session.sessionId, true), /close timed out/);
  assert.equal(worker.stops, 1);
  assert.deepEqual(manager.list(), []);
});

test('unsuccessful graceful close preserves the usable session', async () => {
  const worker = fakeWorker(async (op) => op === 'close' ? { closed: false } : {});
  const manager = new SessionManager({ createWorker: () => worker });
  const session = await manager.start({});
  assert.deepEqual(await manager.close(session.sessionId, false), { closed: false });
  assert.equal(worker.stops, 0);
  assert.equal(manager.list().length, 1);
  await manager.closeAll();
});
