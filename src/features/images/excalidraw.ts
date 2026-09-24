/**
 * Excalidraw 画布里的图片引用。
 *
 * ## 为什么必须解压
 *
 * obsidian-excalidraw-plugin 默认把场景 JSON 用 **LZString 压成 base64** 后
 * 写进 `.excalidraw.md` 的 ` ```compressed-json ` 代码块（设置里可以关掉压缩，
 * 那时是 ` ```json `）。压缩之后，场景里的 `"fileId":"<hash>"` 在文件正文里
 * **一个字都搜不到** —— 靠正则扫文本的方案在这里会得出「这张图没被引用」，
 * 而它是被引用的，于是「清理失联图片」会把它删掉。
 *
 * 所以这里实现了 LZString 的解压（约 60 行，无依赖）。**不用第三方包**：
 * 移动端可达的静态导入图里多一个依赖就多一份风险，而这个算法的输出格式是
 * 稳定的（`lz-string` 1.x 十年没变过，Excalidraw 也只写这一种）。
 *
 * ## 怎么确认它对
 *
 * 拿真实文件校准：`tests/features/images/fixtures/` 里存着一份从测试库
 * `.excalidraw.md` 抽出来的**真实压缩载荷**，测试断言它能被解成合法 JSON。
 * 这比自造期望值可靠得多 —— 自己造的样本两边一起错也照样绿，而线上表现是
 * 「图片被当成失联删掉」，代价不可逆。
 */

/** LZString 的 base64 字母表（`=` 在末尾，是补位符）。 */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** 字母表 → 索引的反查表。建一次就够。 */
const BASE64_REVERSE: Map<string, number> = (() => {
    const table = new Map<string, number>();
    for (let index = 0; index < BASE64_ALPHABET.length; index++) {
        table.set(BASE64_ALPHABET.charAt(index), index);
    }
    return table;
})();

/**
 * LZString 的解压核心。
 *
 * 这段逻辑照抄 `lz-string` 的 `_decompress`（位读顺序、字典增长时机都不能改），
 * 只是把回调写成了具名函数并加了类型。**改任何一处都会让输出错位** ——
 * 它没有校验和，错了只会得到一段乱码或 `undefined`。
 */
function decompress(
    length: number,
    resetValue: number,
    getNextValue: (index: number) => number
): string | undefined {
    const dictionary: string[] = [];
    let enlargeIn = 4;
    let dictSize = 4;
    let numBits = 3;
    let entry = "";
    const result: string[] = [];
    let w: string;

    const data = { val: getNextValue(0), position: resetValue, index: 1 };

    /** 按位读一个 `count` 位的整数。位流跨字节时自动取下一个字符。 */
    const readBits = (count: number): number => {
        let bits = 0;
        let power = 1;
        const maxPower = 2 ** count;
        while (power !== maxPower) {
            const resb = data.val & data.position;
            data.position >>= 1;
            if (data.position === 0) {
                data.position = resetValue;
                data.val = getNextValue(data.index++);
            }
            bits |= (resb > 0 ? 1 : 0) * power;
            power <<= 1;
        }
        return bits;
    };

    for (let index = 0; index < 3; index++) {
        dictionary[index] = String.fromCharCode(index);
    }

    // 首字符：0 = 8 位、1 = 16 位、2 = 空输入。
    const marker = readBits(2);
    let first: string;
    if (marker === 0) first = String.fromCharCode(readBits(8));
    else if (marker === 1) first = String.fromCharCode(readBits(16));
    else return "";

    dictionary[3] = first;
    w = first;
    result.push(first);

    for (;;) {
        // 位流读到头说明输入被截断 —— 返回 undefined 而不是半截结果。
        if (data.index > length) return undefined;

        const code = readBits(numBits);
        let c: number;

        if (code === 0) {
            dictionary[dictSize++] = String.fromCharCode(readBits(8));
            c = dictSize - 1;
            enlargeIn--;
        } else if (code === 1) {
            dictionary[dictSize++] = String.fromCharCode(readBits(16));
            c = dictSize - 1;
            enlargeIn--;
        } else if (code === 2) {
            return result.join("");
        } else {
            c = code;
        }

        if (enlargeIn === 0) {
            enlargeIn = 2 ** numBits;
            numBits++;
        }

        if (dictionary[c]) entry = dictionary[c];
        else if (c === dictSize) entry = w + w.charAt(0);
        else return undefined;

        result.push(entry);
        dictionary[dictSize++] = w + entry.charAt(0);
        enlargeIn--;
        w = entry;

        if (enlargeIn === 0) {
            enlargeIn = 2 ** numBits;
            numBits++;
        }
    }
}

/**
 * 解一段 LZString 的 base64 压缩文本。
 *
 * ## 必须先剥掉所有空白
 *
 * **插件写出来的载荷是折行的** —— 实测真实文件（见 fixtures）里每 256 个字符
 * 折一次，于是载荷里夹着换行。不剥掉的话，`getBaseValue` 拿到换行符查不到索引
 * （退化成 0），位流当场错位，解压结果是 `null`/乱码 —— 而**不会抛错**。
 * 症状是「画布里的图片被当成失联」，看起来像扫描逻辑的 bug，其实差在这一步。
 *
 * 反过来这也说明为什么不能靠「自己造一份压缩样本」来验：自己造的样本不带换行，
 * 于是这条真实的折行永远不会被发现。
 *
 * 畸形输入返回 `undefined`（不是抛错）：调用方在扫描整库，一个坏文件不该
 * 让整轮扫描失败 —— 它的后果只是「这个文件里的引用看不到」。
 */
export function decompressFromBase64(input: string): string | undefined {
    const packed = input.replace(/\s+/g, "");
    if (!packed) return undefined;
    try {
        return decompress(packed.length, 32, (index) => {
            const character = packed.charAt(index);
            return BASE64_REVERSE.get(character) ?? 0;
        });
    } catch {
        return undefined;
    }
}

/** 从 markdown 里取出 ` ```<language> ` 代码块的内容。取第一个匹配。 */
function codeBlock(markdown: string, language: string): string | undefined {
    // 语言名后面的空白（含换行）不计入内容；结尾的 ``` 必须独占一行。
    const pattern = new RegExp("```" + language + "[^\\S\\n]*\\n([\\s\\S]*?)\\n```");
    const match = pattern.exec(markdown);
    return match ? match[1] : undefined;
}

/**
 * 把 `.excalidraw.md` 里的场景 JSON 取出来。
 *
 * 两种写法都认：压缩的 `compressed-json` 与未压缩的 `json`。都不在就返回
 * `undefined` —— 那是「这个文件不是画布数据」，不是错误。
 */
export function excalidrawScene(markdown: string): unknown | undefined {
    const compressed = codeBlock(markdown, "compressed-json");
    if (compressed) {
        const json = decompressFromBase64(compressed.trim());
        if (!json) return undefined;
        try {
            return JSON.parse(json) as unknown;
        } catch {
            return undefined;
        }
    }

    const plain = codeBlock(markdown, "json");
    if (plain) {
        try {
            return JSON.parse(plain) as unknown;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * 画布里的文本节点原文。
 *
 * 与 `excalidrawCandidates` 分开：那个返回的是**可能当路径用**的字符串
 * （fileId、文件名），而文本节点里写的是 `![[a.png]]` 这种 markdown 片段 ——
 * 它整段都不是路径，要按 markdown 语法再解析一次才能拿到里面的路径。
 * 两种东西混在一个数组里，调用方就没法判断该拿它做什么。
 */
export function excalidrawTexts(scene: unknown): string[] {
    const nodes = (scene as { elements?: unknown } | null)?.elements;
    if (!Array.isArray(nodes)) return [];

    const texts: string[] = [];
    for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const text = (node as { text?: unknown }).text;
        if (typeof text === "string" && text) texts.push(text);
    }
    return texts;
}

/** 以图片扩展名结尾的字符串（含 JSON 转义斜杠）。 */
const IMAGE_STRING_RE = /"([^"]*\.(?:jpe?g|png|gif|svg|webp|avif|bmp))"/gi;

/**
 * 从画布场景里收集**所有可能指向库内图片**的字符串。
 *
 * 刻意不做精确解析，而是三路取并集：
 *
 * 1. `elements[].fileId` —— 图片元素引用的是 Excalidraw 的 fileId，
 *    而插件把那一份存在库里的文件名就是 `<fileId>.<ext>`（无扩展名的情况也存在，
 *    见 `resolveImageReference` 的「按主干名匹配」）。
 * 2. `files` 这个映射的**键** —— 同一件事的另一种写法（老版本 / 不同设置）。
 * 3. 整个 JSON 文本里任何以图片扩展名结尾的字符串 —— 兜底。数据 URL
 *    （`data:image/png;base64,…`）不会命中，因为它们以 base64 内容结尾。
 *
 * 多算的代价只是「这张图被认为有人引用」（少删一张），漏算的代价是删掉在用的图。
 * 两者不对称，所以一律往多的一边倒。
 */
export function excalidrawCandidates(scene: unknown): string[] {
    const found = new Set<string>();

    const sceneJson = safeStringify(scene);

    const nodes = (scene as { elements?: unknown } | null)?.elements;
    if (Array.isArray(nodes)) {
        for (const node of nodes) {
            if (!node || typeof node !== "object") continue;
            const fileId = (node as { fileId?: unknown }).fileId;
            if (typeof fileId === "string" && fileId) found.add(fileId);
        }
    }

    const files = (scene as { files?: unknown } | null)?.files;
    if (files && typeof files === "object" && !Array.isArray(files)) {
        for (const key of Object.keys(files)) {
            if (key) found.add(key);
        }
    }

    if (sceneJson) {
        IMAGE_STRING_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = IMAGE_STRING_RE.exec(sceneJson)) !== null) {
            const value = match[1];
            if (value) found.add(value.replace(/\\\//g, "/"));
        }
    }

    return [...found];
}

function safeStringify(value: unknown): string | undefined {
    try {
        return JSON.stringify(value);
    } catch {
        // 循环引用之类 —— 场景 JSON 是从 `JSON.parse` 来的，正常不会发生，
        // 但解析出来的东西也可能被别的代码改过。
        return undefined;
    }
}
