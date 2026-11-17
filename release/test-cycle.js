// Connections that come back on themselves (host/cycle.js), in plain Node: a client app on this very PC
// (`self`), the client app of a PC this PC's client app controls (`loop`), and what is no such case.
//   node release/test-cycle.js
'use strict';
const { decide, STALE_MS } = require('../host/cycle');

let failed = 0, passed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (cond) passed++; else failed++; };
const mine = 'HostOfThisPC_123', other = 'HostOfPCB_45678', third = 'HostOfPCC_90123';
const now = 1_800_000_000_000;
const live = (hosts, o = {}) => ({ pid: 4242, at: now - 1000, hosts, ...o });
const alive = (p) => p === 4242;

ok('a client app on this PC (its hello names this host) is self', decide({ from: mine, mine, live: live([]), now, alive }) === 'self');
ok('the PC this PC\'s client app controls connecting back is a loop', decide({ from: other, mine, live: live([other]), now, alive }) === 'loop');
ok('another PC (not controlled from here) is fine: a chain is no loop', decide({ from: third, mine, live: live([other]), now, alive }) === '');
ok('a browser (no from) can be told neither', decide({ from: undefined, mine, live: live([other]), now, alive }) === '' && decide({ from: '', mine, live: live([other]), now, alive }) === '');
ok('a live.json not written for a while (an app that crashed) does not count', decide({ from: other, mine, live: live([other], { at: now - STALE_MS - 1 }), now, alive }) === '');
ok('a live.json of a process that is gone does not count', decide({ from: other, mine, live: live([other], { pid: 99 }), now, alive }) === '');
ok('no live.json at all: only self can be told', decide({ from: other, mine, live: null, now, alive }) === '' && decide({ from: mine, mine, live: null, now, alive }) === 'self');
ok('a from that is no id (junk, too long) is ignored', decide({ from: 'x'.repeat(41), mine, live: live(['x'.repeat(41)]), now, alive }) === '' && decide({ from: 'a b', mine: 'a b', now, alive }) === '');

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
process.exit(failed ? 1 : 0);
