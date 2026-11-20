// Run with: node --test tests/recording-lifecycle.test.mjs
// Exercise the QML functions with controlled process completion, and execute
// their file-management shell commands against temporary runtime directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import vm from 'node:vm';
import {
    WHISPER_LANGS,
    formatVocabPrompt,
    normalizeLanguageCode,
    languageLabel,
    buildLanguageOptions,
} from '../whisper-prompt.mjs';

const source = readFileSync(new URL('../Whisperer.qml', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../WhispererSettings.qml', import.meta.url), 'utf8');
function harness() {
    const pending = [], detached = [];
    const context = vm.createContext({
        console, sessionDir: '', startGeneration: 0, shuttingDown: false,
        instanceId: 'test', backend: 'whisper.cpp', whisperBin: '/missing/bin',
        modelPath: '/model.bin', fwModelsDir: '/models', ctModel: 'base.en',
        serverUrl: 'http://127.0.0.1:8910', activeAiKey: 'test-key',
        aiSession: false, sttState: 'idle', overlayActive: false,
        history: [], copyText: false, typeText: false,
        initialPrompt: '', customWords: [], snippets: [], aiStyle: '',
        whisperUseGpu: false, translateToEnglish: false, transcribeThreads: 4,
        language: 'en', recordingPath: '/runtime/recording.wav', vocabPrompt: '',
        WhisperPrompt: { formatVocabPrompt },
        errorResetTimer: { stop() {}, restart() {} }, doneLingerTimer: { restart() {} },
        playCue() {}, checkPreflight() {}, pushHistory() {},
        recorder: { running: false, signal() {} }, transcriber: { running: false }, restoreMedia() {},
        Proc: { runCommand(id, command, callback) { pending.push({ id, command, callback }); } },
        Quickshell: { execDetached(command) { detached.push(command); } },
    });
    context.root = context;
    for (const name of ['levelMonitorCommand', 'cleanupSession', 'removeSessionDirectory', 'checkRecordingReady',
        'startRecording', 'cancelRecording', 'finishCancel', 'deliver', 'noSpeech',
        'fail', 'enterAiError', 'cancelAiError', 'fallbackToLocal', 'checkPreflight', 'vocabWords',
        'whisperCppCommand', 'fasterWhisperCommand', 'whisperServerCommand', 'aiSystemPrompt',
        'duckMedia', 'restoreMedia', 'ensureAecModule']) {
        const match = source.match(new RegExp(`^    function ${name}\\([^]*?^    }`, 'm'));
        assert.ok(match, `missing QML function ${name}`);
        vm.runInContext(match[0], context);
    }
    context.beginRecording = () => { context.sttState = 'recording'; };
    return { context, pending, detached };
}
function run(command, env = {}) {
    return spawnSync(command[0], Array.from(command.slice(1)), {
        encoding: 'utf8', env: { ...process.env, ...env },
    });
}

test('IPC start probes current backend even when cached readiness is false', () => {
    const { context: c, pending } = harness();
    c.localReady = false;
    c.startRecording(false);
    assert.equal(c.sttState, 'preparing');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].command[0], 'sh');
    pending.shift().callback('/found/whisper-cli\n', 0);
    assert.equal(c.whisperBin, '/found/whisper-cli');
    assert.equal(pending.length, 1);
    pending.shift().callback('/runtime/whisperer.unique\n', 0);
    assert.equal(c.sttState, 'recording');
    assert.equal(c.sessionDir, '/runtime/whisperer.unique');
});

test('cancelled preparation cannot start a later recording or leak its directory', () => {
    const { context: c, pending, detached } = harness();
    c.startRecording(true);
    const first = pending.shift();
    c.cancelRecording();
    c.startRecording(true);
    first.callback('/runtime/whisperer.old\n', 0);
    assert.equal(c.sttState, 'preparing');
    assert.equal(c.sessionDir, '');
    assert.equal(detached.at(-1).at(-1), '/runtime/whisperer.old');
    pending.shift().callback('/runtime/whisperer.new\n', 0);
    assert.equal(c.sessionDir, '/runtime/whisperer.new');
});

test('backend failure never opens the microphone', () => {
    const { context: c, pending } = harness();
    c.checkPreflight = () => {};
    c.startRecording(false);
    pending.shift().callback('', 1);
    assert.equal(c.sttState, 'error');
    assert.equal(c.recorder.running, false);
    assert.equal(pending.length, 0);
});

test('runtime directories are unique and private, and quoted paths clean up safely', () => {
    const runtime = mkdtempSync(join(tmpdir(), "whisperer-test 'quoted-"));
    try {
        const { context: c, pending, detached } = harness();
        c.startRecording(true);
        const cmd = pending.shift().command;
        const a = run(cmd, { XDG_RUNTIME_DIR: runtime });
        const b = run(cmd, { XDG_RUNTIME_DIR: runtime });
        assert.equal(a.status, 0, a.stderr);
        assert.equal(b.status, 0, b.stderr);
        const first = a.stdout.trim(), second = b.stdout.trim();
        assert.notEqual(first, second);
        assert.equal(statSync(first).mode & 0o777, 0o700);
        assert.equal(run(cmd, { XDG_RUNTIME_DIR: '' }).status > 0, true);
        c.sessionDir = first;
        writeFileSync(join(first, 'recording.wav'), 'private audio');
        c.cleanupSession();
        assert.equal(c.sessionDir, '');
        assert.equal(run(detached.at(-1)).status, 0);
        assert.equal(existsSync(first), false);
        assert.equal(existsSync(second), true);
    } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test('terminal outcomes clean audio, while AI fallback retains it until cancelled', () => {
    for (const action of ['deliver', 'noSpeech', 'fail', 'finishCancel']) {
        const { context: c, detached } = harness();
        c.sessionDir = '/runtime/whisperer.take';
        c[action]('result');
        assert.equal(c.sessionDir, '', action);
        assert.equal(detached.at(-1).at(-1), '/runtime/whisperer.take', action);
    }
    const { context: c, detached } = harness();
    c.sessionDir = '/runtime/whisperer.take';
    c.enterAiError('network failure');
    assert.equal(c.sessionDir, '/runtime/whisperer.take');
    assert.equal(detached.length, 0);
    c.cancelAiError();
    assert.equal(c.sessionDir, '');
});

test('widget probes server only when selected, with no periodic preflight timer', () => {
    const { context: c, pending } = harness();
    c.detectBackends = () => {};
    c.checkPreflight();
    assert.equal(pending.some(p => p.command[0] === 'curl'), false);
    pending.length = 0;
    c.backend = 'whisper-server';
    c.checkPreflight();
    assert.equal(pending.filter(p => p.command[0] === 'curl').length, 1);
    assert.equal(source.includes('id: preflightTimer'), false);
});

test('model swap passes the path literally and never changes service files', () => {
    const pending = [];
    const c = vm.createContext({
        modelFullPath: () => '/models/a;type=text & b.bin', pluginId: 'whisperer',
        PluginService: { loadPluginData: () => 'http://server:8910' },
        Proc: { runCommand(id, command, callback) { pending.push({ command, callback }); } },
    });
    vm.runInContext(settings.match(/^    function serverLoadModel\([^]*?^    }/m)[0], c);
    c.serverLoadModel({ name: 'model' });
    const command = pending[0].command;
    assert.equal(command[0], 'curl');
    assert.equal(command[4], '--form-string');
    assert.equal(command[5], 'model=/models/a;type=text & b.bin');
    assert.equal(command[6], 'http://server:8910/load');
    assert.doesNotMatch(command.join(' '), /systemctl|sed|\.service/);
});

test('AI local fallback rechecks readiness while preserving the take', () => {
    const { context: c, pending } = harness();
    c.sessionDir = '/runtime/whisperer.take';
    c.sttState = 'aiError';
    c.localReady = false;
    c.fallbackToLocal();
    assert.equal(c.sessionDir, '/runtime/whisperer.take');
    assert.equal(c.transcriber.running, false);
    pending.shift().callback('/found/whisper-cli\n', 0);
    assert.equal(c.transcriber.running, true);
});

test('recorder creates mode-0600 audio even with a permissive parent umask', () => {
    const runtime = mkdtempSync(join(tmpdir(), "whisperer-record 'quoted-"));
    try {
        writeFileSync(join(runtime, 'pw-record'), '#!/bin/sh\nfor last do :; done\nprintf audio > "$last"\n', { mode: 0o755 });
        const { context: c } = harness();
        c.aecActive = false;
        c.recordingPath = join(runtime, 'recording.wav');
        const body = source.match(/id: recorder[^]*?        command: {\n([^]*?)^        }/m)[1];
        const command = vm.runInContext(`(function() {${body}})()`, c);
        const oldMask = process.umask(0);
        let result;
        try { result = run(command, { PATH: `${runtime}:${process.env.PATH}` }); }
        finally { process.umask(oldMask); }
        assert.equal(result.status, 0, result.stderr);
        assert.equal(statSync(c.recordingPath).mode & 0o777, 0o600);
    } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test('faster-whisper output stays inside the take and is removed after reading', () => {
    const runtime = mkdtempSync(join(tmpdir(), "whisperer-cli 'quoted-"));
    try {
        writeFileSync(join(runtime, 'whisper-ctranslate2'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
    if [ "$1" = --output_dir ]; then shift; printf 'test transcript' > "$1/recording.txt"; exit 0; fi
    shift
done
exit 1
`, { mode: 0o755 });
        const { context: c } = harness();
        Object.assign(c, { sessionDir: runtime, recordingPath: join(runtime, 'recording.wav'),
            translateToEnglish: false, transcribeThreads: 4, language: 'en', vocabPrompt: '' });
        const result = run(c.fasterWhisperCommand(), { PATH: `${runtime}:${process.env.PATH}` });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'test transcript');
        assert.equal(existsSync(join(runtime, 'cli-out')), false);
    } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test('cleanup waits for media ducking and restores players before deleting the marker', async () => {
    const runtime = mkdtempSync(join(tmpdir(), "whisperer-media 'quoted-"));
    const take = join(runtime, 'take');
    // Keep the fake playerctl outside the directory cleanup removes.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(take, { mode: 0o700 });
    try {
        writeFileSync(join(runtime, 'playerctl'), `#!/bin/sh
case "$1" in
    -l) printf 'player\\n';;
    -p) case "$3" in
        status) printf ready > "$TEST_RUNTIME/ready"; sleep 0.1; printf Playing;;
        pause|play) printf '%s\\n' "$3" >> "$TEST_RUNTIME/events";;
    esac;;
esac
`, { mode: 0o755 });
        const { context: c, detached } = harness();
        Object.assign(c, { sessionDir: take, duckMarkerPath: join(take, 'ducked'),
            cancelBackgroundMusic: true, aecTier: 'duck' });
        const env = { ...process.env, PATH: `${runtime}:${process.env.PATH}`, TEST_RUNTIME: runtime };
        c.duckMedia();
        const command = detached.shift();
        const child = spawn(command[0], Array.from(command.slice(1)), { env });
        const ended = once(child, 'exit');
        // Wait until ducking holds the lock, then race cleanup against its pause.
        const deadline = Date.now() + 2000;
        while (!existsSync(join(runtime, 'ready')) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(existsSync(join(runtime, 'ready')), true);
        c.cleanupSession();
        const cleanup = detached.shift();
        assert.equal(run(cleanup, env).status, 0);
        await ended;
        assert.equal(readFileSync(join(runtime, 'events'), 'utf8'), 'pause\nplay\n');
        assert.equal(existsSync(take), false);
    } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test('late AEC probe callbacks do nothing after widget teardown', () => {
    for (const destroyed of [false, true]) {
        const { context: c, pending } = harness();
        Object.assign(c, { cancelBackgroundMusic: true, aecTier: 'aec', aecReady: false,
            aecSourceName: 'whisperer-aec' });
        let called = false;
        c.ensureAecModule(() => { called = true; });
        if (destroyed) c.root = null;
        else c.shuttingDown = true;
        assert.doesNotThrow(() => pending.shift().callback('', 0));
        assert.equal(c.aecReady, false);
        assert.equal(called, false);
    }
});

test('a take directory created after widget destruction is still removed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'whisperer-late-session-'));
    try {
        const { context: c, pending, detached } = harness();
        c.startRecording(true);
        c.root = null;
        assert.doesNotThrow(() => pending.shift().callback(directory + '\n', 0));
        assert.equal(c.sessionDir, '');
        assert.equal(run(detached.shift()).status, 0);
        assert.equal(existsSync(directory), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

function meterFixture() {
    const pcm = Buffer.alloc(4800);
    for (let i = 800; i < 1600; i++) pcm.writeInt16LE(i % 2 ? -1234 : 1234, i * 2);
    for (let i = 1600; i < 2400; i++) pcm.writeInt16LE(-32768, i * 2);
    return pcm;
}

for (const capability of ['raw', 'legacy', 'help-fails']) {
    for (const aecActive of [false, true]) {
        test(`level meter decodes exact peaks with ${capability}, AEC=${aecActive}`, async () => {
            const runtime = mkdtempSync(join(tmpdir(), "whisperer-meter 'quoted-"));
            try {
                const pcm = meterFixture();
                const { endianness } = await import('node:os');
                if (endianness() === 'BE') pcm.swap16();
                writeFileSync(join(runtime, 'pcm'), pcm);
                writeFileSync(join(runtime, 'pw-record'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) {
    console.log(process.env.METER_CAPABILITY === 'raw' ? '  -a, --raw RAW mode' : '  --format Sample format');
    process.exit(process.env.METER_CAPABILITY === 'help-fails' ? 1 : 0);
}
fs.writeFileSync(process.env.METER_RUNTIME + '/args', JSON.stringify(args));
const raw = process.env.METER_CAPABILITY === 'raw';
if (args.includes('--raw') !== raw || args.at(-1) !== (raw ? '-' : process.env.METER_RUNTIME + '/level-meter.raw')) process.exit(2);
const pcm = fs.readFileSync(process.env.METER_RUNTIME + '/pcm');
if (raw) process.stdout.write(pcm);
else fs.writeFileSync(args.at(-1), pcm);
`, { mode: 0o755 });
                const { context: c } = harness();
                // Pass even shell metacharacters literally rather than interpolating.
                Object.assign(c, { sessionDir: runtime, aecActive, aecSourceName: "aec ' source; $(false)" });
                const result = run(c.levelMonitorCommand(), {
                    PATH: `${runtime}:${process.env.PATH}`, METER_RUNTIME: runtime, METER_CAPABILITY: capability,
                });
                assert.equal(result.status, 0, result.stderr);
                assert.equal(result.stderr, '');
                assert.equal(result.stdout, '0\n1234\n32768\n');
                const args = JSON.parse(readFileSync(join(runtime, 'args'), 'utf8'));
                assert.equal(args.includes('--target'), aecActive);
                if (aecActive) assert.equal(args[args.indexOf('--target') + 1], c.aecSourceName);
            } finally { rmSync(runtime, { recursive: true, force: true }); }
        });
    }
}

test('formatVocabPrompt handles ASCII, CJK, and ellipsis punctuation without prefixes', () => {
    const { context: c } = harness();
    assert.equal(formatVocabPrompt('', []), '');

    c.customWords = [{ word: 'Wayfire' }, 'Quickshell'];
    c.snippets = [{ trigger: 'sign off' }];
    assert.equal(formatVocabPrompt('', c.vocabWords()), 'Wayfire, Quickshell, sign off.');

    assert.equal(formatVocabPrompt('  Context text.  ', []), 'Context text.');
    assert.equal(formatVocabPrompt('Context text.', c.vocabWords()), 'Context text. Wayfire, Quickshell, sign off.');
    assert.equal(formatVocabPrompt('Context text', ['Wayfire']), 'Context text. Wayfire.');
    assert.equal(formatVocabPrompt('Terms:', ['Wayfire']), 'Terms: Wayfire.');
    assert.equal(formatVocabPrompt('\u30c6\u30b9\u30c8\u3002', ['Wayfire']), '\u30c6\u30b9\u30c8\u3002 Wayfire.');
    assert.equal(formatVocabPrompt('\u4f60\u597d\uff01', ['Wayfire']), '\u4f60\u597d\uff01 Wayfire.');
    assert.equal(formatVocabPrompt('Wait\u2026', ['Wayfire']), 'Wait\u2026 Wayfire.');
});

test('local and AI prompts both forward initialPrompt and vocabulary', () => {
    const { context: c } = harness();
    assert.equal(c.aiSystemPrompt().includes('Context for this dictation:'), false);

    c.language = 'ja';
    c.vocabPrompt = '';

    const cppEmpty = c.whisperCppCommand();
    assert.equal(cppEmpty[cppEmpty.indexOf('-l') + 1], 'ja');
    assert.equal(cppEmpty.includes('--prompt'), false);

    const serverEmpty = c.whisperServerCommand();
    assert.equal(serverEmpty.includes('language=ja'), true);
    assert.equal(serverEmpty.some(a => a.startsWith('prompt=')), false);

    c.language = 'ru';
    c.initialPrompt = '  Backend architecture notes  ';
    c.customWords = [{ word: 'Wayfire' }];
    c.aiStyle = 'concise';
    c.vocabPrompt = formatVocabPrompt(c.initialPrompt, c.vocabWords());

    assert.match(c.aiSystemPrompt(), /Context for this dictation: Backend architecture notes/);
    assert.match(c.aiSystemPrompt(), /use these exact spellings when you hear them: Wayfire\./);
    assert.match(c.aiSystemPrompt(), /Additional style instructions: concise/);

    const cppWithPrompt = c.whisperCppCommand();
    assert.equal(cppWithPrompt[cppWithPrompt.indexOf('-l') + 1], 'ru');
    assert.equal(cppWithPrompt[cppWithPrompt.indexOf('--prompt') + 1], 'Backend architecture notes. Wayfire.');
    assert.equal(cppWithPrompt.includes('--carry-initial-prompt'), true);

    const fwCmd = c.fasterWhisperCommand().slice(5);
    assert.equal(fwCmd[fwCmd.indexOf('--language') + 1], 'ru');
    assert.equal(fwCmd[fwCmd.indexOf('--initial_prompt') + 1], 'Backend architecture notes. Wayfire.');

    const serverWithPrompt = c.whisperServerCommand();
    assert.equal(serverWithPrompt.includes('language=ru'), true);
    assert.equal(serverWithPrompt.includes('prompt=Backend architecture notes. Wayfire.'), true);
    assert.equal(serverWithPrompt.includes('carry_initial_prompt=true'), true);

    c.language = 'auto';
    const fwAuto = c.fasterWhisperCommand().slice(5);
    assert.equal(fwAuto.includes('--language'), false);
});

test('buildLanguageOptions enforces Whisper whitelist and handles real QLocale quirks', () => {
    assert.equal(WHISPER_LANGS.size, 100);
    assert.equal(WHISPER_LANGS.has('yue'), true);
    assert.equal(WHISPER_LANGS.has('haw'), true);
    assert.equal(WHISPER_LANGS.has('eo'), false);
    assert.equal(WHISPER_LANGS.has('ast'), false);

    // Mirrors real Qt 6 QLocale on an non-English OS:
    // - "en" maps to en_US ("American English")
    // - empty or bogus fallback returns OS default ("ru_RU") or "C"
    // - CLDR canonical codes ("jv", "nb", "fil") resolve to regional names
    const cldr = {
        en: { name: 'en_US', nativeLanguageName: 'American English' },
        ru: { name: 'ru_RU', nativeLanguageName: 'russian' },
        zh: { name: 'zh_CN', nativeLanguageName: 'chinese' },
        pt: { name: 'pt_PT', nativeLanguageName: 'portugues' },
        de: { name: 'de_DE', nativeLanguageName: 'deutsch' },
        fr: { name: 'fr_FR', nativeLanguageName: 'french' },
        ja: { name: 'ja_JP', nativeLanguageName: 'japanese' },
        ka: { name: 'ka_GE', nativeLanguageName: 'georgian' },
        uk: { name: 'uk_UA', nativeLanguageName: 'ukrainian' },
        yue: { name: 'yue_HK', nativeLanguageName: 'cantonese' },
        jv: { name: 'jv_ID', nativeLanguageName: 'jawa' },
        nb: { name: 'nb_NO', nativeLanguageName: 'norsk bokmal' },
        fil: { name: 'fil_PH', nativeLanguageName: 'filipino' },
    };
    const mockQtLocale = code => {
        if (!code)
            return { name: 'ru_RU', nativeLanguageName: 'russian' };
        return cldr[code] || { name: 'ru_RU', nativeLanguageName: 'russian' };
    };

    assert.equal(normalizeLanguageCode('ru-RU'), 'ru');
    assert.equal(normalizeLanguageCode('zh_CN.UTF-8'), 'zh');
    assert.equal(normalizeLanguageCode('nb_NO.UTF-8'), 'no');
    assert.equal(normalizeLanguageCode('fil_PH'), 'tl');
    assert.equal(normalizeLanguageCode('jv_ID'), 'jw');
    assert.equal(normalizeLanguageCode('yue-HK'), 'yue');
    assert.equal(normalizeLanguageCode('C'), '');
    assert.equal(normalizeLanguageCode('posix'), '');
    assert.equal(normalizeLanguageCode('eo'), '');
    assert.equal(normalizeLanguageCode('ast'), '');
    assert.equal(normalizeLanguageCode('kab'), '');
    assert.equal(normalizeLanguageCode('ckb'), '');
    assert.equal(normalizeLanguageCode(null), '');

    assert.equal(languageLabel('en', cldr.en, mockQtLocale), 'English (en)');
    assert.equal(languageLabel('zz', null, mockQtLocale), 'zz');
    assert.equal(languageLabel('zz', { name: 'C', nativeLanguageName: '' }, mockQtLocale), 'zz');
    assert.equal(languageLabel('jw', null, mockQtLocale), 'Jawa (jw)');
    assert.equal(languageLabel('no', null, mockQtLocale), 'Norsk bokmal (no)');
    assert.equal(languageLabel('tl', null, mockQtLocale), 'Filipino (tl)');
    assert.equal(languageLabel('zh', { name: 'zh_TW', nativeLanguageName: 'traditional chinese' }, mockQtLocale), 'Chinese (zh)');
    assert.equal(languageLabel('es', { nativeLanguageName: 'espanol' }, null), 'Espanol (es)');
    assert.equal(languageLabel('es', { nativeLanguageName: 'espanol' }, () => ({ name: 'C', nativeLanguageName: '' })), 'Espanol (es)');

    const presentLocales = {
        en: cldr.en,
        zh_TW: { name: 'zh_TW', nativeLanguageName: 'traditional chinese' },
        zh_CN: { name: 'zh_CN', nativeLanguageName: 'simplified chinese' },
        pt_BR: { name: 'pt_BR', nativeLanguageName: 'portugues do brasil' },
        es: { nativeLanguageName: 'espanol' },
        eo: { name: 'eo_001', nativeLanguageName: 'Esperanto' },
        ast_ES: { name: 'ast_ES', nativeLanguageName: 'asturianu' },
        ja: cldr.ja,
        fr: cldr.fr,
        ru: cldr.ru,
    };
    const opts = buildLanguageOptions(
        ['ru-RU', 'C', 'posix', 'ast_ES', 'zh-Hans-CN', 'nb_NO'],
        ['de_DE', 'kab_DZ', ''],
        presentLocales,
        'ka',
        mockQtLocale
    );
    assert.deepEqual(opts, [
        { label: 'Auto-detect', value: 'auto' },
        { label: 'Russian (ru)', value: 'ru' },
        { label: 'Chinese (zh)', value: 'zh' },
        { label: 'Norsk bokmal (no)', value: 'no' },
        { label: 'Deutsch (de)', value: 'de' },
        { label: 'English (en)', value: 'en' },
        { label: 'Georgian (ka)', value: 'ka' },
        { label: 'Espanol (es)', value: 'es' },
        { label: 'French (fr)', value: 'fr' },
        { label: 'Japanese (ja)', value: 'ja' },
        { label: 'Portugues (pt)', value: 'pt' },
    ]);

    const bogusSaved = buildLanguageOptions(['uk-UA'], null, null, 'ckb', mockQtLocale);
    assert.deepEqual(Array.from(bogusSaved, o => o.value), ['auto', 'uk', 'en']);
});
