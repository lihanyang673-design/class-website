// ============================================================
// codec.js —— 玩家编号 + 奶币兑换码（游戏端 & 管理员后台共用）
//
// 防伪原理（纯前端无服务器方案）：
//   兑换码 = 数据体(base64url) + HMAC-SHA256 签名
//   没有 SECRET 就造不出有效签名，玩家无法自行伪造奶币。
//   ⚠️ 懂技术的人读源码仍能看到 SECRET —— 对休闲游戏足够；
//      想彻底防伪以后接云端账号（路线A）即可。
//   想换密钥：把下面 SECRET 改成任意字符串（游戏端和后台是同一个文件，改一处两边同步）。
//
// ★ 内置纯 JS 版 SHA-256：手机用 http://局域网IP 访问时
//   浏览器会禁用 crypto.subtle，此时自动切换纯 JS 实现，兑换功能照常工作。
// ============================================================
(function(){
  'use strict';

  // ★★★ 密钥：正式上线前建议改成只有你知道的字符串 ★★★
  const SECRET = 'naiwa-dance-2024-secret-change-me';

  // 编号字符集：去掉易混淆的 0/O、1/I/L
  const ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function rndStr(len){
    const a = new Uint8Array(len);
    crypto.getRandomValues(a);
    let s = '';
    for(let i=0;i<len;i++) s += ID_CHARS[a[i] % ID_CHARS.length];
    return s;
  }

  // 生成玩家编号：NAI-XXXXXX
  function genPlayerId(){
    return 'NAI-' + rndStr(6);
  }

  // ---- base64url ----
  function b64urlEncode(bytes){
    let bin='';
    bytes.forEach(b=>bin+=String.fromCharCode(b));
    return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function b64urlDecode(str){
    str = String(str).replace(/-/g,'+').replace(/_/g,'/');
    while(str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ============================================================
  // 纯 JS SHA-256（crypto.subtle 不可用时的兜底，如 http 局域网IP）
  // ============================================================
  const SHA_K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);
  function rotr(x,n){ return (x>>>n) | (x<<(32-n)); }
  function sha256Bytes(input){
    const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
    const H = new Uint32Array([
      0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
    ]);
    const padLen = Math.ceil((bytes.length + 9) / 64) * 64;
    const buf = new Uint8Array(padLen);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 4, (bytes.length * 8) >>> 0, false);
    dv.setUint32(padLen - 8, Math.floor(bytes.length / 0x20000000), false);
    const w = new Uint32Array(64);
    for(let off = 0; off < padLen; off += 64){
      for(let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i*4, false);
      for(let i = 16; i < 64; i++){
        const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
        const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
      }
      let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for(let i = 0; i < 64; i++){
        const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
        const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
      H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for(let i=0;i<8;i++) ov.setUint32(i*4, H[i], false);
    return out;
  }
  // SHA-256 → 十六进制字符串（管理员密码哈希用）
  function sha256Hex(str){
    const b = sha256Bytes(new TextEncoder().encode(str));
    let hex='';
    for(let i=0;i<b.length;i++) hex += b[i].toString(16).padStart(2,'0');
    return hex;
  }

  // HMAC-SHA256（纯 JS，取前 8 字节）
  function hmac8Bytes(keyStr, msgStr){
    const block = 64;
    let key = new TextEncoder().encode(keyStr);
    if(key.length > block) key = sha256Bytes(key);
    const ipad = new Uint8Array(block), opad = new Uint8Array(block);
    for(let i=0;i<block;i++){ ipad[i] = (key[i]||0) ^ 0x36; opad[i] = (key[i]||0) ^ 0x5c; }
    const msg = new TextEncoder().encode(msgStr);
    const inner = new Uint8Array(block + msg.length);
    inner.set(ipad); inner.set(msg, block);
    const si = sha256Bytes(inner);
    const outer = new Uint8Array(block + 32);
    outer.set(opad); outer.set(si, block);
    return sha256Bytes(outer).slice(0, 8);
  }

  // 优先用浏览器原生（更快），不可用时（http 局域网IP / file://）自动兜底纯 JS
  async function hmac8(message){
    if(window.crypto && crypto.subtle){
      try{
        const key = await crypto.subtle.importKey(
          'raw', new TextEncoder().encode(SECRET),
          {name:'HMAC', hash:'SHA-256'}, false, ['sign']
        );
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
        return sig.slice(0, 8);
      }catch(e){ /* 落到纯 JS */ }
    }
    return hmac8Bytes(SECRET, message);
  }

  // 恒定时间比较，防计时攻击
  function timingSafeEqual(a, b){
    if(a.length !== b.length) return false;
    let diff = 0;
    for(let i=0;i<a.length;i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  // ============================================================
  // 生成兑换码（管理员后台调用）
  //   opts: { coins:奶币数, uid:绑定玩家编号或'', expireDays:有效天数或0 }
  // ============================================================
  async function makeCode(opts){
    const coins = Math.max(1, Math.floor(opts.coins) || 0);
    const nonce = rndStr(6);
    const payload = {
      c: coins,
      u: (opts.uid || '').trim().toUpperCase(),
      e: opts.expireDays > 0 ? Date.now() + opts.expireDays*86400000 : 0,
      n: nonce,
    };
    const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const sig = b64urlEncode(await hmac8(body));
    return 'NAI-' + body + '-' + sig;
  }

  // ============================================================
  // 验证兑换码（游戏端调用）
  //   code: 玩家输入的码；uid: 当前玩家编号；usedList: 本地已用码签名列表
  //   返回 {ok, reason, coins, key}
  // ============================================================
  async function verifyCode(code, uid, usedList){
    // 去掉所有空白（含中文全角空格），防止玩家从微信复制时带入换行/空格
    code = (code || '').replace(/[\s\u3000]+/g, '');
    usedList = usedList || [];
    if(!code) return {ok:false, reason:'请输入兑换码'};

    // ★ 玩家把自己的编号当成兑换码输入了 —— 给明确引导，而不是"格式不对"
    if(/^NAI-[A-HJ-NP-Z2-9]{6}$/i.test(code)){
      return {ok:false, reason:'这是你的「玩家编号」不是兑换码～把编号发给管理员，管理员会把兑换码发给你'};
    }
    if(!/^NAI-/i.test(code)) return {ok:false, reason:'兑换码格式不对，应以 NAI- 开头（注意别和玩家编号搞混）'};
    code = 'NAI-' + code.slice(4);              // 仅把前缀规范化为大写（码体大小写敏感）

    const parts = code.slice(4).split('-');
    if(parts.length !== 2 || !parts[0] || !parts[1])
      return {ok:false, reason:'兑换码不完整，兑换码是 NAI- 后面带两长串字符，请整段复制'};

    let payload;
    try{
      payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    }catch(e){ return {ok:false, reason:'兑换码已损坏，请核对后重新复制'}; }

    // 验签
    let expectSig, givenSig;
    try{
      expectSig = await hmac8(parts[0]);
      givenSig = b64urlDecode(parts[1]);
    }catch(e){ return {ok:false, reason:'验证失败：浏览器环境异常，请用最新版浏览器重试'}; }
    if(!timingSafeEqual(expectSig, givenSig)) return {ok:false, reason:'兑换码无效（可能被改动过）'};

    if(!payload || typeof payload.c !== 'number' || payload.c <= 0)
      return {ok:false, reason:'兑换码内容异常'};
    if(payload.e && Date.now() > payload.e) return {ok:false, reason:'兑换码已过期'};
    if(payload.u && payload.u !== (uid||'').toUpperCase())
      return {ok:false, reason:'这个码是发给其他奶娃的，用不了'};
    const key = parts[1];
    if(usedList.includes(key)) return {ok:false, reason:'这个码已经兑换过啦'};

    return {ok:true, coins:payload.c, key};
  }

  window.NaiCode = { genPlayerId, makeCode, verifyCode, sha256Hex, SECRET_LEN: SECRET.length };
})();
