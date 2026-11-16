// Shared by host and client.
// Signaling over an untrusted pub/sub relay (ntfy). Every message is
// compressed, then AES-256-GCM encrypted with keys derived from the shared
// secret, so the relay only ever sees random-looking blobs on random topics.
// The WebRTC DTLS fingerprints travel inside these encrypted messages, which
// is what makes the media/input channel end-to-end authenticated.
const RD = (() => {
  const te = new TextEncoder();
  const CHUNK = 3000; // ntfy message limit is 4096 bytes

  function b64u(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  function rand(n) {
    return b64u(crypto.getRandomValues(new Uint8Array(n)));
  }
  async function pipe(bytes, transform) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(transform));
    return new Uint8Array(await res.arrayBuffer());
  }

  // `salt`: DEVICE for a device token (a client app's own secret, given to it by the host; see
  // host/devices.js), which gives keys and topics of its own; the access key uses the default.
  const DEVICE = 'my-remote-device-v1';
  async function derive(secret, salt) {
    const raw = unb64u(secret.trim());
    if (raw.length !== 32) throw new Error('접속 키 형식이 올바르지 않습니다');
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const p = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(salt || 'my-remote-v1'), info: te.encode(info) });
    const aes = (info) => crypto.subtle.deriveKey(p(info), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const topic = async (info) => {
      const bits = new Uint8Array(await crypto.subtle.deriveBits(p(info), base, 128));
      return 'mr' + Array.from(bits, (x) => x.toString(16).padStart(2, '0')).join('');
    };
    return {
      c2h: await aes('client-to-host'),
      h2c: await aes('host-to-client'),
      topicHost: await topic('topic-host'),
      topicClient: await topic('topic-client'),
    };
  }

  async function seal(key, obj) {
    const plain = await pipe(te.encode(JSON.stringify(obj)), new CompressionStream('deflate-raw'));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return b64u(out);
  }
  // A message can be 40 chunks, about 90 KB of deflate data, and that could inflate to some 90 MB.
  // Real ones are far smaller (the largest, the client page, about 110 KB), so the data goes in a
  // kilobyte at a time (deflate makes at most about a megabyte of that) and inflating stops past
  // MAX_PLAIN.
  const MAX_PLAIN = 1 << 20;
  async function inflate(bytes) {
    let at = 0;
    const input = new ReadableStream({
      pull(c) {
        if (at >= bytes.length) { c.close(); return; }
        c.enqueue(bytes.slice(at, at + 1024));
        at += 1024;
      },
    });
    const reader = input.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const dec = new TextDecoder();
    let text = '', size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + dec.decode();
      size += value.length;
      if (size > MAX_PLAIN) { reader.cancel().catch(() => {}); throw new Error('message too large'); }
      text += dec.decode(value, { stream: true });
    }
  }
  async function open(key, text) {
    const raw = unb64u(text);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(await inflate(new Uint8Array(plain)));
  }

  // opts: { server, subTopic, pubTopic, rxKey, txKey, onMessage, onState }
  // The host listens on several topics at once (its own and one per device token): `subTopic` is then
  // their names joined by commas (ntfy sends each message with the topic it came on), `rxKey` a function
  // of the topic giving its key (or nothing: the message is dropped), and `onMessage` hears the topic too.
  // `send(obj, { pubTopic, txKey })` sends elsewhere than `opts` says (the answer on a device's own topic).
  function channel(opts) {
    const parts = new Map();
    let es = null, closed = false, timer = null, quiet = null, wait = 2000;
    let readyResolve;
    const ready = new Promise((r) => (readyResolve = r));

    // A new subscription in `ms`, unless the current one has opened by then.
    function resubscribe(ms) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (closed || es.readyState === EventSource.OPEN) return;
        es.close();
        connect();
      }, ms);
    }
    // After a network error the EventSource reconnects by itself. An answer other than 200
    // text/event-stream (the relay restarting behind its proxy, a rate limit, a proxy's error page)
    // makes it give up for good (CLOSED), and a connection attempt can also hang. A host left like
    // that is unreachable until someone restarts it, so a new subscription is made here: after 2 s,
    // doubling up to a minute, once it gave up; after two minutes when it does not open.
    function connect() {
      const src = (es = new EventSource(`${opts.server}/${opts.subTopic}/sse`));
      clearTimeout(quiet); quiet = null;
      resubscribe(120000);
      // ntfy sends a keepalive event every 45 s (its default). A connection lost along the way
      // (behind a proxy, after a network change) can look open for a long time without an error,
      // so a stream that brought keepalives and then stays silent for three minutes is replaced
      // too. Armed by the first keepalive after each open: a relay that sends none is never
      // replaced for silence.
      const alive = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          quiet = null;
          if (closed || src !== es) return;
          opts.onState && opts.onState('retry');
          es.close();
          connect();
        }, 180000);
      };
      src.addEventListener('keepalive', () => { if (!closed && src === es) alive(); });
      src.onopen = () => {
        if (src !== es) return;
        clearTimeout(timer); timer = null; wait = 2000;
        clearTimeout(quiet); quiet = null;
        readyResolve(); opts.onState && opts.onState('open');
      };
      src.onerror = () => {
        if (closed || src !== es) return;
        opts.onState && opts.onState('retry');
        if (src.readyState === EventSource.CLOSED) { resubscribe(wait); wait = Math.min(wait * 2, 60000); }
        else if (!timer) resubscribe(120000);
      };
      src.onmessage = async (ev) => {
        if (quiet && src === es) alive();
        try {
          const m = JSON.parse(ev.data);
          const f = String(m.message || '').split('.');
          if (f.length !== 5 || f[0] !== 'mr1') return;
          const topic = typeof m.topic === 'string' ? m.topic : '';
          const key = typeof opts.rxKey === 'function' ? opts.rxKey(topic) : opts.rxKey;
          if (!key) return;
          const id = topic + '/' + f[1], i = +f[2], n = +f[3];
          // Every loader handed out drops a message of more than 40 chunks (120000 characters), so
          // the client page the host sends in one 'app' reply has to stay within that.
          if (!(n >= 1 && n <= 40 && i >= 0 && i < n)) return;
          if (!parts.has(id)) {
            // At most 30 messages being put together per topic: junk sent on one topic (by whoever holds a
            // blocked device's token) never pushes out what is coming on another.
            const mine = [...parts.keys()].filter((k) => k.startsWith(topic + '/'));
            if (mine.length > 30) for (const k of mine) parts.delete(k);
            parts.set(id, new Array(n).fill(null));
          }
          const arr = parts.get(id);
          if (arr.length !== n) return;
          arr[i] = f[4];
          if (arr.some((x) => x === null)) return;
          parts.delete(id);
          const obj = await open(key, arr.join(''));
          opts.onMessage(obj, topic);
        } catch (e) {
          // Not decryptable with our key (noise or forgery), or too large: ignore.
        }
      };
    }
    connect();

    async function send(obj, to) {
      const text = await seal((to && to.txKey) || opts.txKey, obj);
      const topic = (to && to.pubTopic) || opts.pubTopic;
      const id = rand(6);
      const n = Math.ceil(text.length / CHUNK);
      for (let i = 0; i < n; i++) {
        const body = `mr1.${id}.${i}.${n}.${text.slice(i * CHUNK, (i + 1) * CHUNK)}`;
        const r = await fetch(`${opts.server}/${topic}`, { method: 'POST', body });
        if (!r.ok) throw new Error('시그널링 서버 전송 실패: HTTP ' + r.status);
      }
    }
    function close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(quiet);
      if (es) es.close();
    }
    return { send, close, ready, get closed() { return closed; } };
  }

  function waitIce(pc, ms) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  return { derive, channel, waitIce, rand, DEVICE };
})();
