// Shared by host and client.
// Signaling over an untrusted pub/sub relay (ntfy). Every message is
// compressed, then AES-256-GCM encrypted with keys derived from the shared
// secret, so the relay only ever sees random-looking blobs on random topics.
// The WebRTC DTLS fingerprints travel inside these encrypted messages, which
// is what makes the media/input channel end-to-end authenticated.
const RD = (() => {
  const te = new TextEncoder(), td = new TextDecoder();
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

  async function derive(secret) {
    const raw = unb64u(secret.trim());
    if (raw.length !== 32) throw new Error('접속 키 형식이 올바르지 않습니다');
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const p = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('my-remote-v1'), info: te.encode(info) });
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
  async function open(key, text) {
    const raw = unb64u(text);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(td.decode(await pipe(new Uint8Array(plain), new DecompressionStream('deflate-raw'))));
  }

  // opts: { server, subTopic, pubTopic, rxKey, txKey, onMessage, onState }
  function channel(opts) {
    const parts = new Map();
    let es = null, closed = false;
    let readyResolve;
    const ready = new Promise((r) => (readyResolve = r));

    function connect() {
      es = new EventSource(`${opts.server}/${opts.subTopic}/sse`);
      es.onopen = () => { readyResolve(); opts.onState && opts.onState('open'); };
      es.onerror = () => { opts.onState && opts.onState('retry'); }; // EventSource reconnects by itself
      es.onmessage = async (ev) => {
        try {
          const m = JSON.parse(ev.data);
          const f = String(m.message || '').split('.');
          if (f.length !== 5 || f[0] !== 'mr1') return;
          const id = f[1], i = +f[2], n = +f[3];
          if (!(n >= 1 && n <= 40 && i >= 0 && i < n)) return;
          if (!parts.has(id)) {
            if (parts.size > 30) parts.clear();
            parts.set(id, new Array(n).fill(null));
          }
          const arr = parts.get(id);
          if (arr.length !== n) return;
          arr[i] = f[4];
          if (arr.some((x) => x === null)) return;
          parts.delete(id);
          const obj = await open(opts.rxKey, arr.join(''));
          opts.onMessage(obj);
        } catch (e) {
          // Not decryptable with our key: noise or forgery. Ignore.
        }
      };
    }
    connect();

    async function send(obj) {
      const text = await seal(opts.txKey, obj);
      const id = rand(6);
      const n = Math.ceil(text.length / CHUNK);
      for (let i = 0; i < n; i++) {
        const body = `mr1.${id}.${i}.${n}.${text.slice(i * CHUNK, (i + 1) * CHUNK)}`;
        const r = await fetch(`${opts.server}/${opts.pubTopic}`, { method: 'POST', body });
        if (!r.ok) throw new Error('시그널링 서버 전송 실패: HTTP ' + r.status);
      }
    }
    function close() {
      closed = true;
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

  return { derive, channel, waitIce, rand };
})();
