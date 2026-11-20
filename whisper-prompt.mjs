export const WHISPER_LANGS = new Set((
    "af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw " +
    "he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt " +
    "my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl " +
    "tr tt uk ur uz vi yi yo yue zh"
).split(" "));

const LOCALE_ALIASES = { fil: "tl", in: "id", iw: "he", ji: "yi", jv: "jw", nb: "no" };
const CLDR_LOOKUP = { jw: "jv", no: "nb", tl: "fil" };

export function formatVocabPrompt(initialPrompt, words) {
    const base = (initialPrompt || "").trim();
    const vocab = (words || []).join(", ");
    const prefix = base && vocab && !/[.!?:;,\u2026\u3002\uff01\uff1f\uff1b\uff1a\u3001]$/.test(base)
        ? base + "."
        : base;
    return [prefix, vocab && vocab + "."].filter(Boolean).join(" ");
}

export function normalizeLanguageCode(tag) {
    if (!tag || typeof tag !== "string")
        return "";
    const raw = tag.trim().split(/[-_@.]/)[0].toLowerCase();
    const code = LOCALE_ALIASES[raw] || raw;
    return WHISPER_LANGS.has(code) ? code : "";
}

export function languageLabel(code, localeObj, qtLocaleFn) {
    if (code === "en")
        return "English (en)";
    let raw = "";
    if (qtLocaleFn) {
        const loc = qtLocaleFn(CLDR_LOOKUP[code] || code);
        if (loc && loc.name && loc.name !== "C" && normalizeLanguageCode(loc.name) === code)
            raw = (loc.nativeLanguageName || "").trim();
    }
    if (!raw && localeObj && typeof localeObj.nativeLanguageName === "string")
        raw = localeObj.nativeLanguageName.trim();
    if (!raw)
        return code;
    const chars = Array.from(raw);
    return chars[0].toUpperCase() + chars.slice(1).join("") + " (" + code + ")";
}

export function buildLanguageOptions(uiLanguages, sessionLocales, presentLocales, savedCode, qtLocaleFn) {
    const localeByCode = {};
    if (presentLocales && typeof presentLocales === "object") {
        for (const key of Object.keys(presentLocales)) {
            const code = normalizeLanguageCode(key);
            if (code && !localeByCode[code])
                localeByCode[code] = presentLocales[key];
        }
    }

    const opts = [{ label: "Auto-detect", value: "auto" }];
    const seen = new Set(["auto"]);

    function addCode(code) {
        if (!code || seen.has(code))
            return;
        seen.add(code);
        opts.push({ label: languageLabel(code, localeByCode[code], qtLocaleFn), value: code });
    }

    for (const tag of (uiLanguages || []))
        addCode(normalizeLanguageCode(tag));
    for (const tag of (sessionLocales || []))
        addCode(normalizeLanguageCode(tag));
    addCode("en");

    if (savedCode && savedCode !== "auto")
        addCode(normalizeLanguageCode(savedCode));

    const extra = [];
    for (const code of Object.keys(localeByCode)) {
        if (seen.has(code))
            continue;
        seen.add(code);
        extra.push({ label: languageLabel(code, localeByCode[code], qtLocaleFn), value: code });
    }
    extra.sort((a, b) => a.label.localeCompare(b.label));
    return opts.concat(extra);
}
