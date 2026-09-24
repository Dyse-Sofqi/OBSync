/**
 * SHA-256 与 HMAC-SHA256（纯 JS 实现）。
 *
 * ## 为什么不用 `crypto.subtle`
 *
 * `crypto.subtle` 只在**安全上下文**（secure context）里存在，而 Obsidian 在移动端
 * 是用自定义 scheme 加载页面的 —— 桌面端有它，移动端不一定。R2 签名是同步逻辑
 * （SigV4 的签名链每一步都要等上一步的摘要），写成 async 会把它整条链路染成异步，
 * 而收益只是「少写 150 行」。参考项目 remotely-save 同样自带实现。
 *
 * ## 正确性怎么保证
 *
 * 算法完全照 FIPS 180-4 与 RFC 2104 写，并由 `tests/features/images/sha256.test.ts`
 * 对着公开测试向量（空串、`abc`、长于一个分组的输入、RFC 4231 的 HMAC 用例）钉住。
 * 这里**不要**做「看起来等价」的优化 —— 位运算是这类实现最容易改错的地方。
 */

/** SHA-256 轮常量（FIPS 180-4 §4.2.2，前 64 个素数立方根小数部分的前 32 位）。 */
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
]);

const H_INIT = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19,
]);

const BLOCK_SIZE = 64;
const DIGEST_SIZE = 32;

function rotr(value: number, bits: number): number {
    return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** 把 4 字节大端写进目标位置。 */
function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}

function readUint32BE(source: Uint8Array, offset: number): number {
    return (
        ((source[offset] << 24) |
            (source[offset + 1] << 16) |
            (source[offset + 2] << 8) |
            source[offset + 3]) >>>
        0
    );
}

/** 对**已经补齐到分组整数倍**的数据做压缩，返回 8 个字的中间状态。 */
function compress(state: Uint32Array, block: Uint8Array, offset: number): void {
    const w = new Uint32Array(64);

    for (let index = 0; index < 16; index++) {
        w[index] = readUint32BE(block, offset + index * 4);
    }
    for (let index = 16; index < 64; index++) {
        const s0 =
            rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
        const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
        w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];

    for (let index = 0; index < 64; index++) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        // 五项相加最大约 2^34，远在 Number 的安全整数范围内，最后统一 `>>> 0`。
        const temp1 = (h + s1 + ch + K[index] + w[index]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
}

/** 补齐：追加 `0x80`、若干 `0x00`，最后 8 字节是大端比特长度。 */
function pad(data: Uint8Array): Uint8Array {
    const bitLength = data.length * 8;
    // `+ 8` 是给长度字段留的位置；`>> 6 << 6` 向上取整到 64 的倍数。
    const paddedLength = (((data.length + 8) >> 6) + 1) << 6;
    const padded = new Uint8Array(paddedLength);
    padded.set(data);
    padded[data.length] = 0x80;

    // 比特长度用两个 32 位字写，避免超过 32 位后 `>>>` 截断。
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    writeUint32BE(padded, paddedLength - 8, high);
    writeUint32BE(padded, paddedLength - 4, low);
    return padded;
}

/** SHA-256 摘要（32 字节）。 */
export function sha256(data: Uint8Array): Uint8Array {
    const state = Uint32Array.from(H_INIT);
    const padded = pad(data);

    for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
        compress(state, padded, offset);
    }

    const digest = new Uint8Array(DIGEST_SIZE);
    for (let index = 0; index < 8; index++) {
        writeUint32BE(digest, index * 4, state[index]);
    }
    return digest;
}

/** SHA-256 的十六进制小写形式 —— SigV4 的各个字段都用这个形状。 */
export function sha256Hex(data: Uint8Array): string {
    return toHex(sha256(data));
}

/** HMAC-SHA256（RFC 2104）。 */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
    // 密钥长于分组时先摘要一次；短于分组时右侧补零。两种情况都归一到 BLOCK_SIZE。
    const normalized = new Uint8Array(BLOCK_SIZE);
    normalized.set(key.length > BLOCK_SIZE ? sha256(key) : key);

    const inner = new Uint8Array(BLOCK_SIZE + data.length);
    const outer = new Uint8Array(BLOCK_SIZE + DIGEST_SIZE);
    for (let index = 0; index < BLOCK_SIZE; index++) {
        inner[index] = normalized[index] ^ 0x36;
        outer[index] = normalized[index] ^ 0x5c;
    }
    inner.set(data, BLOCK_SIZE);
    outer.set(sha256(inner), BLOCK_SIZE);

    return sha256(outer);
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
    let out = "";
    for (const byte of bytes) {
        out += HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
    }
    return out;
}

/**
 * 字符串 → UTF-8 字节。
 *
 * 用 `TextEncoder`（浏览器与 Node 都有）。**不要**用 `unescape(encodeURIComponent())`
 * 那套老写法：它在代理对（emoji）上会产出错误的字节，而图片路径里出现 emoji 完全正常。
 */
export function utf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}
