// Connections that come back on themselves (the user's go-ahead, 2026-11-17, after comparing how other remote
// programs treat them):
//   self  a client app on this very PC connects to this host (its own key, a one-time code, a device token): the
//         picture shows itself without end and input comes back to where it came from (a key pressed once is
//         typed for ever: the window it lands in is the one that sends it)
//   loop  the client app of a PC that this PC's own client app is controlling right now connects to this host:
//         A controls B while B controls A, and input that lands on B's window of A goes back to A, and on A's
//         window of B back to B
// A host makes an id at every start (`instance`: in running.json and in its offer). A client app puts the id of
// its own PC's host into its hello (`from`), and keeps the ids of the hosts its windows control in live.json in
// its profile (`hosts`, with its pid and the time, written again every 10 s while one is on). A browser says
// neither (it can read neither file), so for it neither case can be told: the input guard in input.js is the net.
// A chain (A controls B, and from B someone controls C) is no loop and stays allowed.
//
// Electron-free (release/test-cycle.js).
'use strict';
const STALE_MS = 30000; // a live.json not written again for this long is from an app that is gone
const ID = /^[A-Za-z0-9_-]{8,40}$/;

// -> 'self' | 'loop' | ''
function decide({ from, mine, live, now = Date.now(), alive = () => true } = {}) {
  if (typeof from !== 'string' || !ID.test(from)) return '';
  if (from === mine) return 'self';
  const hosts = live && Array.isArray(live.hosts) ? live.hosts : [];
  if (hosts.includes(from) && Number(live.pid) > 0 && now - Number(live.at) < STALE_MS && alive(Number(live.pid))) return 'loop';
  return '';
}

module.exports = { decide, STALE_MS, ID };
