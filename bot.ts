import { chromium } from 'playwright';
import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOT_VERSION = 'v19-quiz-advance';

/** 9-step workflow (see processStudent + runCourseFlow). */
function stepLog(step: number, message: string): void {
    console.log(`\n📍 Step ${step}: ${message}`);
}
const CONTINUE_POLL_MS = 350;
const CONTINUE_POST_CLICK_MS = 1500;
const CHAPTER_QUIZ_MAX_Q = 6;
const DEBUG_LOG = path.join(__dirname, 'debug-93bca3.log');
const DEBUG_SESSION_LOG = path.join(__dirname, 'debug-6829b8.log');
const DEBUG_SESSION_ID = '6829b8';

function debugLog(payload: Record<string, unknown>) {
    const line = JSON.stringify({ sessionId: DEBUG_SESSION_ID, timestamp: Date.now(), ...payload }) + '\n';
    for (const logPath of [
        DEBUG_SESSION_LOG,
        DEBUG_LOG,
        path.join(process.cwd(), 'debug-6829b8.log'),
        path.join(process.cwd(), 'debug-93bca3.log'),
        path.join(__dirname, '.cursor', 'debug-6829b8.log'),
    ]) {
        try { fs.appendFileSync(logPath, line); } catch {}
    }
    fetch('http://127.0.0.1:7785/ingest/033e1045-1a8d-439a-aec7-78fd76285c5f', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': DEBUG_SESSION_ID },
        body: line.trim(),
    }).catch(() => {});
}

/** Runtime probe when stuck — tests H1–H5 (frames, sidebar, video, continue/exam counts). */
async function debugProbePageState(page: any, loop: number, continueResult: { method: string }) {
    const frameUrls = page.frames().map((f: any) => f.url());
    const scormUrl = getScormContentFrame(page)?.url() || null;
    const perFrame: Record<string, unknown>[] = [];

    for (const frame of page.frames()) {
        try {
            const stats = await frame.evaluate(() => {
                const isVis = (el: Element) => {
                    const r = el.getBoundingClientRect();
                    return r.width > 8 && r.height > 5 && r.bottom > 0 && r.top < window.innerHeight;
                };
                const countText = (needle: string) => {
                    let total = 0;
                    let visible = 0;
                    document.querySelectorAll('button, a, span, p, div, label, li').forEach((el) => {
                        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                        if (!t.includes(needle)) return;
                        total++;
                        if (isVis(el)) visible++;
                    });
                    return { total, visible };
                };
                const sidebarQuiz = [...document.querySelectorAll('a, button, li, div, span')].filter((el) => {
                    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    return /ጥያቄ|ማጠቃለያ|ፈተና/.test(t) && t.length < 120;
                }).map((el) => ({
                    tag: el.tagName,
                    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
                    visible: isVis(el),
                }));

                return {
                    continueBtn: countText('መማር ይቀጥሉ'),
                    examBtn: countText('ፈተና'),
                    videoTags: document.querySelectorAll('video').length,
                    youtubeIframes: document.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu.be"]').length,
                    bodyTextLen: (document.body?.innerText || '').length,
                    sidebarQuizItems: sidebarQuiz.slice(0, 8),
                };
            });
            perFrame.push({ frameUrl: frame.url(), ...stats });
        } catch (e: any) {
            perFrame.push({ frameUrl: frame.url(), error: e?.message || 'evaluate-failed' });
        }
    }

    // #region agent log
    debugLog({
        runId: 'stuck-probe',
        hypothesisId: 'H1-H5',
        location: 'bot.ts:debugProbePageState',
        message: 'stuck page state',
        data: {
            loop,
            pageUrl: page.url(),
            scormUrl,
            continueMethod: continueResult.method,
            frameCount: frameUrls.length,
            frameUrls: frameUrls.map((u: string) => u.slice(0, 120)),
            perFrame,
        },
    });
    // #endregion
}

async function safePageWait(page: any, ms: number): Promise<void> {
    try {
        if (page.isClosed()) return;
        await page.waitForTimeout(ms);
    } catch {
        /* page closed or navigated away */
    }
}

// ====================== ANSWERS ======================
/** Per-chapter columns (ምዕራፍ 1, 2, …) + optional final column (total). */
type CourseAnswers = { chapters: string[][]; final: string[] };
const answersCache: Record<string, CourseAnswers> = {};

function chapterIndexFromHeader(header: string): number | null {
    const h = header.trim();
    if (/^total$/i.test(h)) return null;
    if (!/ራፍ|chapter|መዕ|ምዕ|ምእ/i.test(h)) return null;
    const m = h.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function flatFallbackAnswers(ca: CourseAnswers): string[] {
    for (const ch of ca.chapters) {
        if (ch.length) return ch;
    }
    return ca.final.length ? ca.final : ['ለ', 'ሐ', 'መ'];
}

/** Keywords (longest first) → answers/*.csv basename */
const courseToFileMap: { [key: string]: string } = {
    'legal foundation & regulation': 'legal_foundation',
    'legal foundation and regulation': 'legal_foundation',
    'entrepreneurial mindset': 'enterprunership',
    'communication skill': 'communications',
    'financial literacy': 'finacial_litrecy',
    'customer understanding': 'costomer_understanding',
    'negotiation skill': 'negotiations_skill',
    'negotiations skill': 'negotiations_skill',
    'design thinking': 'design_thinking',
    'decision making': 'decision_making',
    'legal foundation': 'legal_foundation',
    'financial': 'finacial_litrecy',
    'finacial': 'finacial_litrecy',
    'finance': 'finacial_litrecy',
    'literacy': 'finacial_litrecy',
    'communication': 'communications',
    'communications': 'communications',
    'entrepreneurial': 'enterprunership',
    'entrepreneurship': 'enterprunership',
    'enterprunership': 'enterprunership',
    'customer': 'costomer_understanding',
    'costomer': 'costomer_understanding',
    'bookkeeping': 'bookkeeping',
    'book': 'bookkeeping',
    'design': 'design_thinking',
    'decision': 'decision_making',
    'marketing': 'marketing',
    'negotiation': 'negotiations_skill',
    'negotiations': 'negotiations_skill',
    'legal': 'legal_foundation',
};

const answersDir = path.join(__dirname, 'answers');

function listAnswerFiles(): string[] {
    if (!fs.existsSync(answersDir)) return [];
    return fs.readdirSync(answersDir)
        .filter((f) => f.endsWith('.csv'))
        .map((f) => f.slice(0, -4));
}

function normalizeText(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractEnglishTitle(courseName: string): string {
    const paren = courseName.match(/\(([^)]+)\)/);
    if (paren) return normalizeText(paren[1]);
    return normalizeText(courseName.replace(/[\u1200-\u137F]/g, ' '));
}

function scoreCourseToFile(courseName: string, fileBase: string): number {
    const blob = normalizeText(courseName);
    const english = extractEnglishTitle(courseName);
    const fileNorm = normalizeText(fileBase.replace(/_/g, ' '));
    const fileSlug = fileBase.toLowerCase();
    let score = 0;

    const mapKeys = Object.keys(courseToFileMap).sort((a, b) => b.length - a.length);
    for (const key of mapKeys) {
        if (courseToFileMap[key] !== fileBase) continue;
        if (blob.includes(key) || english.includes(key)) score += 60 + key.length;
    }

    if (english && (english === fileNorm || fileNorm.includes(english) || english.includes(fileNorm))) {
        score += 90;
    }

    const englishSlug = english.replace(/\s+/g, '_');
    if (englishSlug && (englishSlug === fileSlug || fileSlug.includes(englishSlug) || englishSlug.includes(fileSlug))) {
        score += 85;
    }

    const blobWords = [...new Set([...blob.split(' '), ...english.split(' ')])].filter((w) => w.length > 2);
    const fileWords = fileSlug.replace(/_/g, ' ').split(' ').filter((w) => w.length > 2);
    for (const fw of fileWords) {
        if (blobWords.some((bw) => bw.includes(fw) || fw.includes(bw))) score += 18;
    }

    return score;
}

function resolveAnswerFileName(courseName: string): string | null {
    const files = listAnswerFiles();
    if (!files.length) return null;

    let bestFile = '';
    let bestScore = 0;
    for (const file of files) {
        const score = scoreCourseToFile(courseName, file);
        if (score > bestScore) {
            bestScore = score;
            bestFile = file;
        }
    }

    if (bestScore >= 20) return bestFile;
    return null;
}

async function loadCourseAnswers(courseName: string): Promise<CourseAnswers> {
    if (answersCache[courseName]) return answersCache[courseName];

    const fileName = resolveAnswerFileName(courseName);
    const available = listAnswerFiles();
    const empty: CourseAnswers = { chapters: [], final: [] };

    // #region agent log
    debugLog({
        hypothesisId: 'H1',
        location: 'bot.ts:loadCourseAnswers',
        message: 'resolve answers file',
        data: { courseName, fileName, available, scores: available.map((f) => ({ f, s: scoreCourseToFile(courseName, f) })) },
    });
    // #endregion

    if (!fileName) {
        console.log(`⚠️ No answer file matched for course: "${courseName}"`);
        console.log(`   Available: ${available.join(', ')}`);
        return empty;
    }

    const csvPath = path.join(answersDir, `${fileName}.csv`);
    if (!fs.existsSync(csvPath)) {
        console.log(`⚠️ Answers file missing on disk: ${fileName}.csv`);
        return empty;
    }

    return new Promise((resolve) => {
        const chapters: string[][] = [];
        const final: string[] = [];
        let chapterCols: { header: string; chapterIndex: number }[] = [];

        fs.createReadStream(csvPath)
            .pipe(csv())
            .on('headers', (headers: string[]) => {
                chapterCols = headers
                    .map((h) => ({ header: h, chapterIndex: chapterIndexFromHeader(h) }))
                    .filter((c): c is { header: string; chapterIndex: number } => c.chapterIndex != null)
                    .sort((a, b) => a.chapterIndex - b.chapterIndex);
            })
            .on('data', (row) => {
                if (!chapterCols.length) {
                    for (const key of Object.keys(row)) {
                        const idx = chapterIndexFromHeader(key);
                        if (idx != null) chapterCols.push({ header: key, chapterIndex: idx });
                    }
                    chapterCols.sort((a, b) => a.chapterIndex - b.chapterIndex);
                }
                for (const col of chapterCols) {
                    const v = (row[col.header] || '').toString().trim();
                    if (!v) continue;
                    const arrIdx = col.chapterIndex - 1;
                    while (chapters.length <= arrIdx) chapters.push([]);
                    chapters[arrIdx].push(v);
                }
                const total = (row['total'] || row['Total'] || '').toString().trim();
                if (total) final.push(total);
            })
            .on('end', () => {
                const ca = { chapters, final };
                answersCache[courseName] = ca;
                const summary = chapters.map((ch, i) => `ch${i + 1}:${ch.length}`).join(', ');
                console.log(`📋 Answers loaded from: ${fileName}.csv (${summary || 'no chapters'}; final:${final.length})`);
                // #region agent log
                debugLog({
                    hypothesisId: 'Q1',
                    runId: 'post-fix',
                    location: 'bot.ts:loadCourseAnswers',
                    message: 'parsed chapter columns',
                    data: { courseName, fileName, chapterCols: chapterCols.map((c) => c.header), chapters: chapters.map((ch) => ch.slice(0, 8)), finalCount: final.length },
                });
                // #endregion
                resolve(ca);
            });
    });
}

async function detectChapterNumberFromPage(page: any): Promise<number | null> {
    for (const frame of orderFramesForScorm(page)) {
        if (!/scormcontent/i.test(frame.url())) continue;
        try {
            const n = await frame.evaluate(() => {
                const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
                const m = t.match(/(?:ምዕራፍ|መዕራፍ|ምእራፍ)\s*(\d+)/i);
                return m ? parseInt(m[1], 10) : null;
            });
            if (n) return n;
        } catch {}
    }
    return null;
}

async function isFinalCourseExamPage(page: any): Promise<boolean> {
    for (const frame of orderFramesForScorm(page)) {
        if (!/scormcontent/i.test(frame.url())) continue;
        try {
            const r = await frame.evaluate(() => {
                const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
                const lesson = t.match(/Lesson\s+(\d+)\s+of\s+(\d+)/i);
                if (lesson && lesson[1] === lesson[2]) return { isFinal: true, reason: 'last-lesson' };
                if (/ማጠቃለያ/i.test(t) && /(?:ምዕራፍ|መዕራፍ|ምእራፍ)\s*\d+/i.test(t)) {
                    return { isFinal: false, reason: 'chapter-summary' };
                }
                if (/የኮርስ.*ፈተና|course.*exam|final\s*exam/i.test(t)) return { isFinal: true, reason: 'final-text' };
                return { isFinal: false, reason: 'default-chapter' };
            });
            // #region agent log
            debugLog({ hypothesisId: 'Q2', location: 'bot.ts:isFinalCourseExamPage', message: 'exam type', data: r });
            // #endregion
            return r.isFinal;
        } catch {}
    }
    return false;
}

function resolveExamQuizPlan(
    ca: CourseAnswers,
    chapterNum: number | null,
    chapterExamsDone: number,
    isFinal: boolean
): { answers: string[]; label: string; maxQ: number } {
    if (isFinal) {
        const answers = ca.final.length ? ca.final : flatFallbackAnswers(ca);
        return { answers, label: 'Final exam', maxQ: Math.min(Math.max(answers.length, 10), 50) };
    }
    const idx = chapterNum != null ? chapterNum - 1 : chapterExamsDone;
    const chAnswers = ca.chapters[idx] || ca.chapters[chapterExamsDone] || [];
    const answers = chAnswers.length ? chAnswers : flatFallbackAnswers(ca);
    const label = `Chapter ${chapterNum ?? chapterExamsDone + 1} exam`;
    const maxQ = Math.min(CHAPTER_QUIZ_MAX_Q, Math.max(answers.length, 1));
    return { answers, label, maxQ };
}

function sortFramesByContent(frames: any[]): any[] {
    const score = (url: string) => {
        if (!url || url === 'about:blank') return 0;
        if (/scormcontent/i.test(url)) return 5;
        if (/h5p|scorm|articulate|storyline|course|mod|content|player/i.test(url)) return 3;
        if (url.includes('learn.share.com.et')) return 2;
        return 1;
    };
    return [...frames].sort((a, b) => score(b.url()) - score(a.url()));
}

type ClickOpts = { examMode?: boolean; continueMode?: boolean };

function getScormContentFrame(page: any) {
    const frames = sortFramesByContent(page.frames());
    return frames.find((f: any) => /scormcontent/i.test(f.url())) || null;
}

async function waitForScormContentFrame(page: any, maxMs = 20000): Promise<any> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const frame = getScormContentFrame(page);
        if (frame) return frame;
        if (/view\.php/i.test(page.url())) {
            await launchScormFromView(page);
        }
        await safePageWait(page, 500);
    }
    return null;
}

type QuizStats = { radioCount: number; choiceCount: number; optionCount: number; hasNext: boolean };

async function getQuizStats(frame: any): Promise<QuizStats | null> {
    try {
        return await frame.evaluate(() => {
            let radioCount = 0;
            document.querySelectorAll('input[type="radio"]').forEach((r) => {
                const rect = r.getBoundingClientRect();
                const style = getComputedStyle(r);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none') radioCount++;
            });

            const seen = new Set<string>();
            let choiceCount = 0;
            document.querySelectorAll('label, button, [role="radio"], [role="button"], div, span, li, p').forEach((el) => {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!t || t.length > 6) return;
                if (!/^[ለሐመሀረA-Ca-cUu]$/.test(t)) return;
                const rect = el.getBoundingClientRect();
                if (rect.width < 12 || rect.height < 12) return;
                const key = `${t}:${Math.round(rect.top)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    choiceCount++;
                }
            });

            const hasNext = [...document.querySelectorAll('button, a, [role="button"]')].some((el) =>
                /ያስገቡ|ቀጣይ|Submit|Next|Check|Continue|SUBMIT/i.test((el.textContent || '').trim())
            );

            return {
                radioCount,
                choiceCount,
                optionCount: Math.max(radioCount, choiceCount),
                hasNext,
            };
        });
    } catch {
        return null;
    }
}

/** Single quiz detector — ignore hidden Storyline slides (viewport + visible submit). */
async function detectQuizScreen(frame: any): Promise<boolean> {
    try {
        const active = await frame.evaluate(() => {
            const isVisibleInViewport = (el: Element) => {
                const rect = el.getBoundingClientRect();
                if (rect.width < 8 || rect.height < 8) return false;
                if (rect.bottom < 2 || rect.top > window.innerHeight - 2) return false;
                if (rect.right < 2 || rect.left > window.innerWidth - 2) return false;
                let node: Element | null = el;
                while (node && node !== document.documentElement) {
                    const st = getComputedStyle(node);
                    if (st.display === 'none' || st.visibility === 'hidden') return false;
                    if (parseFloat(st.opacity) < 0.2) return false;
                    const h = node as HTMLElement;
                    if (h.offsetParent === null && st.position !== 'fixed' && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
                        return false;
                    }
                    node = node.parentElement;
                }
                return true;
            };

            const hasSubmit = [...document.querySelectorAll('button, a, [role="button"]')].some((el) => {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                return /ያስገቡ/i.test(t) && isVisibleInViewport(el);
            });
            if (!hasSubmit) return false;

            let visRadios = 0;
            document.querySelectorAll('input[type="radio"]').forEach((r) => {
                if (isVisibleInViewport(r)) visRadios++;
            });
            return visRadios >= 2;
        });
        if (active) return true;
    } catch {}

    const stats = await getQuizStats(frame);
    if (stats && stats.hasNext && (stats.optionCount >= 2 || stats.radioCount >= 2)) return true;
    try {
        if (await frame.locator('button:has-text("ያስገቡ")').first().isVisible({ timeout: 400 })) return true;
    } catch {}
    return false;
}

async function isQuizScreen(frame: any): Promise<boolean> {
    return detectQuizScreen(frame);
}

async function isQuizActive(page: any): Promise<boolean> {
    const frame = getScormContentFrame(page);
    if (!frame) return false;
    return await isQuizScreen(frame);
}

/** Fingerprint active quiz slide so we know when Q1 → Q2 actually happened. */
async function getQuizQuestionFingerprint(frame: any): Promise<string> {
    try {
        return await frame.evaluate(() => {
            const isVisibleInViewport = (el: Element) => {
                const rect = el.getBoundingClientRect();
                if (rect.width < 8 || rect.height < 5) return false;
                if (rect.bottom < 2 || rect.top > window.innerHeight - 2) return false;
                if (rect.right < 2 || rect.left > window.innerWidth - 2) return false;
                let node: Element | null = el;
                while (node && node !== document.documentElement) {
                    const st = getComputedStyle(node);
                    if (st.display === 'none' || st.visibility === 'hidden') return false;
                    if (parseFloat(st.opacity) < 0.2) return false;
                    const h = node as HTMLElement;
                    if (h.offsetParent === null && st.position !== 'fixed' && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
                        return false;
                    }
                    node = node.parentElement;
                }
                return true;
            };

            const chunks: string[] = [];
            document.querySelectorAll('h1, h2, h3, h4, p, legend, label, [class*="question"]').forEach((el) => {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (t.length >= 8 && t.length < 280 && isVisibleInViewport(el)) chunks.push(t.slice(0, 100));
            });
            let checked = 0;
            let visRadios = 0;
            document.querySelectorAll('input[type="radio"]').forEach((r) => {
                if (isVisibleInViewport(r)) {
                    visRadios++;
                    if ((r as HTMLInputElement).checked) checked++;
                }
            });
            return `${chunks.join('§').slice(0, 400)}::c${checked}::vr${visRadios}`;
        });
    } catch {
        return '';
    }
}

async function waitForQuizQuestionAdvance(page: any, frame: any, beforeFp: string, maxMs = 10000): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        await safePageWait(page, 450);
        const fp = await getQuizQuestionFingerprint(frame);
        if (fp && fp !== beforeFp) {
            // #region agent log
            debugLog({
                hypothesisId: 'Q3',
                runId: 'post-fix',
                location: 'bot.ts:waitForQuizQuestionAdvance',
                message: 'quiz advanced',
                data: { before: beforeFp.slice(0, 80), after: fp.slice(0, 80) },
            });
            // #endregion
            return true;
        }
    }
    // #region agent log
    debugLog({
        hypothesisId: 'Q3',
        runId: 'post-fix',
        location: 'bot.ts:waitForQuizQuestionAdvance',
        message: 'quiz did NOT advance',
        data: { before: beforeFp.slice(0, 120) },
    });
    // #endregion
    return false;
}

async function clickVisibleQuizButton(frame: any, needles: string[]): Promise<{ ok: boolean; text: string }> {
    try {
        const r = await frame.evaluate((patterns: string[]) => {
            const isVisibleInViewport = (el: Element) => {
                const rect = el.getBoundingClientRect();
                if (rect.width < 12 || rect.height < 8) return false;
                if (rect.bottom < 2 || rect.top > window.innerHeight - 2) return false;
                if (rect.right < 2 || rect.left > window.innerWidth - 2) return false;
                let node: Element | null = el;
                while (node && node !== document.documentElement) {
                    const st = getComputedStyle(node);
                    if (st.display === 'none' || st.visibility === 'hidden') return false;
                    if (parseFloat(st.opacity) < 0.2) return false;
                    const h = node as HTMLElement;
                    if (h.offsetParent === null && st.position !== 'fixed' && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
                        return false;
                    }
                    node = node.parentElement;
                }
                return true;
            };

            let best: { el: HTMLElement; score: number; text: string } | null = null;
            for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!patterns.some((p) => t.includes(p))) continue;
                if (!isVisibleInViewport(el)) continue;
                const rect = el.getBoundingClientRect();
                const area = rect.width * rect.height;
                if (area < 80 || area > 200000) continue;
                let score = rect.top;
                if (/ያስገቡ/i.test(t)) score += 3000;
                if (/ቀጣይ|ይቀጥሉ/i.test(t)) score += 2500;
                if (!best || score > best.score) best = { el: el as HTMLElement, score, text: t };
            }
            if (!best) return { ok: false, text: '' };
            best.el.scrollIntoView({ block: 'center', inline: 'center' });
            best.el.click();
            return { ok: true, text: best.text.slice(0, 50) };
        }, needles);
        return r?.ok ? r : { ok: false, text: '' };
    } catch {
        return { ok: false, text: '' };
    }
}

async function clickAnswerByLetter(frame: any, answer: string): Promise<boolean> {
    const letter = answer.trim().replace(/\s+/g, '');
    if (!letter) return false;

    try {
        const result = await frame.evaluate((ans) => {
            const norm = ans.trim().replace(/\s+/g, '');
            const isVisibleInViewport = (el: Element) => {
                const rect = el.getBoundingClientRect();
                if (rect.width < 8 || rect.height < 5) return false;
                if (rect.bottom < 2 || rect.top > window.innerHeight - 2) return false;
                if (rect.right < 2 || rect.left > window.innerWidth - 2) return false;
                let node: Element | null = el;
                while (node && node !== document.documentElement) {
                    const st = getComputedStyle(node);
                    if (st.display === 'none' || st.visibility === 'hidden') return false;
                    if (parseFloat(st.opacity) < 0.2) return false;
                    const h = node as HTMLElement;
                    if (h.offsetParent === null && st.position !== 'fixed' && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
                        return false;
                    }
                    node = node.parentElement;
                }
                return true;
            };

            for (const el of document.querySelectorAll('label, [role="radio"], button, span, div, li')) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!t || t.length > 30) continue;
                if ((t === norm || t.startsWith(norm + ' ') || t.startsWith(norm + '.')) && isVisibleInViewport(el)) {
                    (el as HTMLElement).click();
                    return { ok: true, via: `visible:${t}` };
                }
            }
            const radios = [...document.querySelectorAll('input[type="radio"]')].filter(isVisibleInViewport);
            const map: Record<string, number> = {
                'ለ': 0, 'ሀ': 0, 'A': 0, 'a': 0,
                'ሐ': 1, 'U': 1, 'B': 1, 'b': 1,
                'መ': 2, 'ረ': 2, 'C': 2, 'c': 2,
            };
            const idx = map[norm] ?? map[norm.charAt(0)];
            if (idx !== undefined && idx < radios.length) {
                const radio = radios[idx] as HTMLInputElement;
                radio.click();
                radio.closest('label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return { ok: true, via: `visible-radio:${idx}` };
            }
            return { ok: false };
        }, letter);
        if (result?.ok) {
            debugLog({ hypothesisId: 'H4', location: 'bot.ts:clickAnswerByLetter', message: 'visible click ok', data: { letter, via: result.via } });
            return true;
        }
    } catch {}

    try {
        const loc = frame.getByText(letter, { exact: true });
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
            const el = loc.nth(i);
            if (await el.isVisible({ timeout: 600 }).catch(() => false)) {
                await el.click({ force: true, timeout: 8000 });
                debugLog({ hypothesisId: 'H4', location: 'bot.ts:clickAnswerByLetter', message: 'playwright visible click ok', data: { letter, index: i } });
                return true;
            }
        }
    } catch {}

    return false;
}

function answerLetterToIndex(answer: string): number {
    const a = answer.trim();
    if (['ለ', 'ሀ', 'A', 'a'].includes(a)) return 0;
    if (['ሐ', 'U', 'B', 'b'].includes(a)) return 1;
    if (['መ', 'ረ', 'C', 'c'].includes(a)) return 2;
    return 0;
}

async function selectQuizAnswer(frame: any, answer: string): Promise<boolean> {
    if (await clickAnswerByLetter(frame, answer)) return true;

    const idx = answerLetterToIndex(answer);
    try {
        const clicked = await frame.evaluate((choiceIdx) => {
            const radios = [...document.querySelectorAll('input[type="radio"]')].filter((r) => {
                const rect = r.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
            if (radios.length >= 2 && choiceIdx < radios.length) {
                const radio = radios[choiceIdx] as HTMLInputElement;
                radio.click();
                radio.closest('label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                const row = radio.closest('[role="radio"], label, li, div');
                (row as HTMLElement | null)?.click();
                return true;
            }
            const rows = [...document.querySelectorAll('[role="radio"], label')].filter((el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 20 && rect.height > 12;
            });
            if (rows.length >= 2 && choiceIdx < rows.length) {
                (rows[choiceIdx] as HTMLElement).click();
                return true;
            }
            return false;
        }, idx);
        if (clicked) return true;
    } catch {}

    try {
        const radios = frame.locator('input[type="radio"]');
        const count = await radios.count();
        if (count >= 2) {
            await radios.nth(Math.min(idx, count - 1)).click({ force: true, timeout: 8000 });
            return true;
        }
    } catch {}

    try {
        const options = frame.locator('[role="radio"], label, div[tabindex="0"]');
        const count = await options.count();
        if (count >= 2) {
            await options.nth(Math.min(idx, count - 1)).click({ force: true, timeout: 8000 });
            return true;
        }
    } catch {}

    return false;
}

async function clickNextBekuty(page: any): Promise<boolean> {
    const frame = getScormContentFrame(page);
    if (!frame) return false;
    const r = await clickVisibleQuizButton(frame, ['ቀጣይ', 'ይቀጥሉ', 'Next']);
    if (r.ok) {
        debugLog({ hypothesisId: 'H4', location: 'bot.ts:clickNextBekuty', message: 'clicked visible next', data: { frameUrl: frame.url(), text: r.text } });
        return true;
    }
    return false;
}

async function clickSubmitYasebu(page: any): Promise<boolean> {
    const frame = getScormContentFrame(page);
    if (!frame) return false;
    const r = await clickVisibleQuizButton(frame, ['ያስገቡ']);
    if (r.ok) {
        debugLog({ hypothesisId: 'H4', location: 'bot.ts:clickSubmitYasebu', message: 'clicked visible submit', data: { frameUrl: frame.url(), text: r.text } });
        return true;
    }
    return false;
}

async function isChapterQuizScreen(frame: any): Promise<boolean> {
    return detectQuizScreen(frame);
}

async function quizScreenActive(page: any): Promise<boolean> {
    const frame = getScormContentFrame(page);
    return frame ? await isChapterQuizScreen(frame) : false;
}

async function scanTextInFrames(page: any, text: string) {
    const scan: { frameUrl: string; matchCount: number; visibleCount: number }[] = [];
    for (const frame of sortFramesByContent(page.frames())) {
        try {
            const stats = await frame.evaluate((searchText) => {
                let matchCount = 0;
                let visibleCount = 0;
                const isViewportVisible = (el: Element) => {
                    const rect = el.getBoundingClientRect();
                    const style = getComputedStyle(el);
                    if (rect.width < 8 || rect.height < 5) return false;
                    if (rect.bottom < 2 || rect.top > window.innerHeight - 2) return false;
                    if (rect.right < 2 || rect.left > window.innerWidth - 2) return false;
                    if (style.display === 'none' || style.visibility === 'hidden') return false;
                    if (parseFloat(style.opacity) < 0.2) return false;
                    const h = el as HTMLElement;
                    if (h.offsetParent === null && style.position !== 'fixed' && el.tagName !== 'BODY') return false;
                    return true;
                };
                document.querySelectorAll('button, a, [role="button"], div, span, p, label').forEach((el) => {
                    const t = (el.textContent || '').trim();
                    if (!t.includes(searchText)) return;
                    matchCount++;
                    if (isViewportVisible(el)) visibleCount++;
                });
                return { matchCount, visibleCount };
            }, text);
            scan.push({ frameUrl: frame.url(), ...stats });
        } catch {
            scan.push({ frameUrl: frame.url(), matchCount: -1, visibleCount: -1 });
        }
    }
    return scan;
}

async function findBestClickTarget(frame: any, text: string, opts?: ClickOpts) {
    try {
        return await frame.evaluate(({ searchText, examMode, continueMode }) => {
            const collect = (root: Document | ShadowRoot, out: Element[]) => {
                root.querySelectorAll('button, a, [role="button"], div, span, p, label, input').forEach((el) => {
                    out.push(el);
                    if ((el as HTMLElement).shadowRoot) collect((el as HTMLElement).shadowRoot!, out);
                });
            };
            const nodes: Element[] = [];
            collect(document, nodes);

            let best: { x: number; y: number; tag: string; sample: string; area: number } | null = null;
            for (const el of nodes) {
                const tag = el.tagName;
                if (continueMode && !['BUTTON', 'A', 'INPUT'].includes(tag)) continue;

                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (examMode) {
                    if (!t.includes(searchText)) continue;
                    if (t.length > searchText.length + 12) continue;
                } else if (!t.includes(searchText)) {
                    continue;
                }

                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                if (rect.width < 8 || rect.height < 8) continue;
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                if (parseFloat(style.opacity) < 0.1) continue;
                if (examMode) {
                    if (rect.bottom < 2 || rect.top > window.innerHeight - 2) continue;
                    if (rect.right < 2 || rect.left > window.innerWidth - 2) continue;
                    const h = el as HTMLElement;
                    if (h.offsetParent === null && style.position !== 'fixed' && el.tagName !== 'BODY') continue;
                }
                const area = rect.width * rect.height;
                if (area > 250000) continue;
                if (!best || area < best.area) {
                    best = {
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2,
                        tag,
                        sample: t.slice(0, 80),
                        area,
                    };
                }
            }
            return best;
        }, { searchText: text, examMode: !!opts?.examMode, continueMode: !!opts?.continueMode });
    } catch {
        return null;
    }
}

async function clickTargetInFrame(frame: any, target: { x: number; y: number; tag: string; sample: string }) {
    await frame.evaluate((t) => {
        const el = document.elementFromPoint(t.x, t.y) as HTMLElement | null;
        el?.scrollIntoView?.({ block: 'center', inline: 'center' });
    }, target);
    await frame.mouse.click(target.x, target.y);
    return { clicked: true, tag: target.tag, text: target.sample };
}

async function clickGreenStyledButton(page: any, textHint: string): Promise<{ clicked: boolean; frameUrl: string; method: string }> {
    for (const frame of orderFramesForScorm(page)) {
        const selectors = [
            `*:has-text("${textHint}")`,
            `a:has-text("${textHint}")`,
            `span:has-text("${textHint}")`,
            `button[style*="rgb(0, 166, 81)"]:has-text("${textHint}")`,
            `button[style*="0, 166, 81)"]:has-text("${textHint}")`,
            '[style*="rgb(0, 166, 81)"]',
            'button[style*="rgb(0, 166, 81)"]',
        ];
        for (const sel of selectors) {
            const btn = frame.locator(sel).first();
            if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ timeout: 15000, force: true });
                return { clicked: true, frameUrl: frame.url(), method: `green:${sel}` };
            }
        }
    }
    return { clicked: false, frameUrl: page.url(), method: 'none' };
}

async function clickTextInFrames(
    page: any,
    texts: string[],
    opts?: ClickOpts
): Promise<{ clicked: boolean; frameUrl: string; matchedText: string; method: string }> {
    for (const text of texts) {
        const scan = await scanTextInFrames(page, text);
        // #region agent log
        debugLog({ hypothesisId: opts?.examMode ? 'H3' : 'H2', location: 'bot.ts:scanTextInFrames', message: 'frame scan', data: { text, examMode: !!opts?.examMode, scan } });
        // #endregion

        if (!opts?.examMode || /ፈተና/.test(text)) {
            const green = await clickGreenStyledButton(page, text.slice(0, 8));
            if (green.clicked) {
                return { clicked: true, frameUrl: green.frameUrl, matchedText: text, method: green.method };
            }
        }

        for (const frame of sortFramesByContent(page.frames())) {
            const frameUrl = frame.url();
            const target = await findBestClickTarget(frame, text, opts);
            if (!target) continue;
            try {
                await clickTargetInFrame(frame, target);
                return { clicked: true, frameUrl, matchedText: text, method: `mouse:${target.tag}` };
            } catch {
                if (!opts?.continueMode) {
                    try {
                        await frame.evaluate((searchText) => {
                            const collect = (root: Document | ShadowRoot, out: Element[]) => {
                                root.querySelectorAll('button, a, [role="button"], div, span, p, label').forEach((el) => {
                                    out.push(el);
                                    if ((el as HTMLElement).shadowRoot) collect((el as HTMLElement).shadowRoot!, out);
                                });
                            };
                            const nodes: Element[] = [];
                            collect(document, nodes);
                            let best: HTMLElement | null = null;
                            let bestArea = Infinity;
                            for (const el of nodes) {
                                const t = (el.textContent || '').trim();
                                if (!t.includes(searchText)) continue;
                                const rect = el.getBoundingClientRect();
                                const area = rect.width * rect.height;
                                if (area < 8 || area > 250000 || area >= bestArea) continue;
                                best = el as HTMLElement;
                                bestArea = area;
                            }
                            best?.scrollIntoView({ block: 'center', inline: 'center' });
                            best?.click();
                        }, text);
                        return { clicked: true, frameUrl, matchedText: text, method: `evaluate:${target.tag}` };
                    } catch {}
                }
            }
        }

        for (const ctx of sortFramesByContent(page.frames())) {
            const frameUrl = ctx.url();
            const locators = opts?.examMode
                ? [
                    ctx.getByRole('button', { name: text, exact: true }),
                    ctx.locator(`button:has-text("${text}")`),
                    ctx.locator(`a:has-text("${text}")`),
                ]
                : [
                    ctx.getByRole('button', { name: new RegExp(text.slice(0, 6)) }),
                    ctx.getByRole('button', { name: text }),
                    ctx.getByText(text),
                    ctx.locator(`button:has-text("${text}")`),
                    ctx.locator(`a:has-text("${text}")`),
                ];
            for (const loc of locators) {
                const count = await loc.count().catch(() => 0);
                for (let i = 0; i < count; i++) {
                    const el = loc.nth(i);
                    const visTimeout = opts?.continueMode || opts?.examMode ? 500 : 1500;
                    if (!(await el.isVisible({ timeout: visTimeout }).catch(() => false))) continue;
                    await el.scrollIntoViewIfNeeded().catch(() => {});
                    await el.click({ timeout: 15000, force: true });
                    return { clicked: true, frameUrl, matchedText: text, method: 'playwright' };
                }
            }
        }
    }
    return { clicked: false, frameUrl: page.url(), matchedText: '', method: 'none' };
}

/** Click መማር ይቀጥሉ only inside SCORM lesson frames (not Moodle sidebar). */
async function waitAndClickContinue(page: any): Promise<{ clicked: boolean; frameUrl: string; matchedText: string; method: string }> {
    if (await isMoodleErrorPage(page)) {
        await launchScormFromView(page);
        return { clicked: false, frameUrl: page.url(), matchedText: '', method: 'error-recover' };
    }

    if (await quizScreenActive(page)) {
        return { clicked: false, frameUrl: page.url(), matchedText: '', method: 'quiz-active' };
    }

    await autoSkipVideo(page);

    const lessonFrames = orderFramesForScorm(page).filter(
        (f: any) => /scormcontent|player\.php/i.test(f.url())
    );

    for (const frame of lessonFrames) {
        const frameUrl = frame.url();
        const target = await findBestClickTarget(frame, 'መማር ይቀጥሉ', { continueMode: true });
        if (!target) continue;
        try {
            await clickTargetInFrame(frame, target);
            return { clicked: true, frameUrl, matchedText: 'መማር ይቀጥሉ', method: `lesson:${target.tag}` };
        } catch {}
        try {
            const ok = await frame.evaluate(() => {
                const needles = ['መማር ይቀጥሉ'];
                const nodes = [...document.querySelectorAll('button, a, span, p, div')];
                let best: HTMLElement | null = null;
                let bestArea = Infinity;
                for (const el of nodes) {
                    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!needles.some((n) => t.includes(n)) || t.length > 40) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 20 || rect.height < 8) continue;
                    const area = rect.width * rect.height;
                    if (area < bestArea) {
                        best = el as HTMLElement;
                        bestArea = area;
                    }
                }
                if (!best) return false;
                best.scrollIntoView({ block: 'center' });
                best.click();
                return true;
            });
            if (ok) return { clicked: true, frameUrl, matchedText: 'መማር ይቀጥሉ', method: 'lesson:evaluate' };
        } catch {}
    }

    return { clicked: false, frameUrl: page.url(), matchedText: '', method: 'none' };
}

// ====================== LOGIN ======================
async function isLoggedIn(page: any): Promise<boolean> {
    if (/login\/index\.php|login\.php\?/i.test(page.url())) return false;
    try {
        const courseBtns = await page.locator('a.view-course-btn').count();
        if (courseBtns > 0) return true;
    } catch {}
    try {
        const loginForm = await page.locator('form#login input[name="username"]').isVisible({ timeout: 800 });
        const welcome = await page.getByText(/Enter your details to log in/i).isVisible({ timeout: 800 }).catch(() => false);
        if (loginForm && welcome) return false;
    } catch {}
    return !/login\/index/i.test(page.url());
}

async function loginStudent(page: any, username: string, password: string): Promise<void> {
    console.log(`🔐 Logging in as ${username}...`);
    await page.goto('https://learn.share.com.et/login/index.php', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[name="username"]', { state: 'visible', timeout: 20000 });
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"], #loginbtn, input[type="submit"]', { timeout: 15000 });
    await safePageWait(page, 4000);
    try {
        await page.waitForFunction(
            () => !/login\/index\.php/i.test(window.location.href),
            { timeout: 45000 }
        );
    } catch {
        /* check URL below */
    }

    if (!/login\/index\.php/i.test(page.url())) {
        await page.goto('https://learn.share.com.et/my/courses.php', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        }).catch(() => {});
        await safePageWait(page, 4000);
    }
}

const VIEW_COURSE_LOCATORS = [
    'a.view-course-btn',
    'a[title="View Course"]',
    'a:has-text("View Course")',
    'button:has-text("View Course")',
    'a[href*="course/view.php?id="]',
];

async function countViewCourseButtons(page: any): Promise<number> {
    let max = 0;
    for (const sel of VIEW_COURSE_LOCATORS) {
        const n = await page.locator(sel).count().catch(() => 0);
        if (n > max) max = n;
    }
    return max;
}

async function scrollCoursesGrid(page: any): Promise<void> {
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await safePageWait(page, 1500);
    await page.evaluate(() => {
        window.scrollTo(0, 0);
    }).catch(() => {});
    await safePageWait(page, 800);
}

async function navigateToMyCourses(page: any): Promise<void> {
    if ((await countViewCourseButtons(page)) > 0) return;

    const urls = [
        'https://learn.share.com.et/my/courses.php',
        'https://learn.share.com.et/my/',
    ];

    for (const url of urls) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await safePageWait(page, 5000);
        await scrollCoursesGrid(page);
        if ((await countViewCourseButtons(page)) > 0) return;
    }

    for (const nav of [
        () => page.getByRole('link', { name: /my courses/i }).first(),
        () => page.locator('a[href*="my/courses"]').first(),
        () => page.getByText('My courses', { exact: false }).first(),
    ]) {
        try {
            const link = nav();
            if (await link.isVisible({ timeout: 2000 })) {
                await link.click({ timeout: 10000 });
                await safePageWait(page, 5000);
                await scrollCoursesGrid(page);
                if ((await countViewCourseButtons(page)) > 0) return;
            }
        } catch {}
    }
}

async function ensureLoggedIn(page: any, username: string, password: string): Promise<void> {
    await loginStudent(page, username, password); // Step 1 — login

    if (/login\/index\.php/i.test(page.url())) {
        const errMsg = await page
            .locator('.alert-danger, .loginerrors, #loginerrormessage, .invalid-feedback')
            .first()
            .innerText()
            .catch(() => '');
        throw new Error(
            `Login failed for ${username}${errMsg ? ` — ${errMsg.trim()}` : ' — still on login page (check password in data.csv)'}`
        );
    }

    await navigateToMyCourses(page);

    const cards = await waitForCoursesGrid(page);
    if (cards.length > 0) {
        console.log(`✅ Logged in (${cards.length} courses on grid)`);
        return;
    }

    const btnCount = await countViewCourseButtons(page);
    if (btnCount === 0 && /login/i.test(page.url())) {
        throw new Error(`Login failed for ${username} — My courses redirected to login`);
    }
    if (btnCount === 0) {
        throw new Error(`Logged in but no courses found on My courses (${page.url()})`);
    }

    console.log(`✅ Logged in (${btnCount} View Course buttons)`);
}

function isValidCourseCard(c: CourseCardInfo): boolean {
    if (!c.courseId || !/^\d+$/.test(c.courseId)) return false;
    if (!c.href || !/course\/view\.php\?id=\d+/i.test(c.href)) return false;
    const t = c.title;
    if (t.length > 150 || t.length < 5) return false;
    if (/welcome to share|enter your details|username|password|skip to main|cdata|jsenabled|forgot your password|log in english/i.test(t)) {
        return false;
    }
    if (/[\u1200-\u137F]{2,}/.test(t) && /\([^)]{2,80}\)/.test(t)) return true;
    if (/\([A-Za-z][^)]{2,80}\)/.test(t) && t.length >= 10) return true;
    return !/^Course \d+$/i.test(t.trim()) && t.length >= 12;
}

// ====================== COURSE PICKER (My courses grid) ======================
type CourseCardInfo = {
    title: string;
    percent: number;
    completed: boolean;
    index: number;
    buttonIndex: number;
    courseId: string;
    href: string;
};

async function listCoursesOnPage(page: any): Promise<CourseCardInfo[]> {
    return page.evaluate(() => {
        type Row = {
            title: string;
            percent: number;
            completed: boolean;
            index: number;
            buttonIndex: number;
            courseId: string;
            href: string;
        };
        const results: Row[] = [];

        const cardTextFromNode = (start: Element | null): string => {
            let node: Element | null = start?.parentElement ?? null;
            let best = '';
            while (node) {
                const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
                const viewInNode = [...node.querySelectorAll('a, button')].filter((el) =>
                    /view course/i.test((el.textContent || '').trim())
                ).length;
                if (
                    viewInNode <= 1 &&
                    text.includes('(') &&
                    /%\s*Course completed/i.test(text) &&
                    text.length > 35 &&
                    text.length < 900
                ) {
                    best = text;
                    break;
                }
                node = node.parentElement;
            }
            if (best) return best;
            node = start?.parentElement ?? null;
            for (let depth = 0; depth < 8 && node; depth++) {
                const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
                if (
                    /%\s*Course completed/i.test(text) &&
                    /[\u1200-\u137F]{2,}/.test(text) &&
                    /\([A-Za-z][^)]{2,80}\)/.test(text) &&
                    text.length > 35 &&
                    text.length < 900
                ) {
                    return text;
                }
                node = node.parentElement;
            }
            return '';
        };

        const pushCard = (
            cardText: string,
            titleFallback: string,
            buttonIndex: number,
            courseId: string,
            href: string
        ) => {
            let title = '';
            const titleMatch = cardText.match(/([\u1200-\u137F][\u1200-\u137F\s]*)\s*\(([^)]+)\)/);
            if (titleMatch) {
                title = `${titleMatch[1].trim()} (${titleMatch[2].trim()})`;
            } else {
                const eng = cardText.match(/\(([^)]+)\)/);
                title = eng ? eng[0].replace(/^\(/, '').replace(/\)$/, '').trim() : '';
                if (eng && cardText.includes('(')) {
                    const am = cardText.split('(')[0].trim();
                    if (am.length > 3) title = `${am} (${eng[1].trim()})`;
                }
            }
            if (!title || title.length < 5) title = titleFallback;
            if (!courseId || !/course\/view\.php/i.test(href)) return;
            if (/welcome to share|username|password|skip to main|cdata|jsenabled/i.test(cardText)) return;
            const hasTitle =
                (/[\u1200-\u137F]{2,}/.test(title) && /\([^)]{2,80}\)/.test(title)) ||
                (/\([A-Za-z][^)]{2,80}\)/.test(title) && title.length >= 10);
            if (!hasTitle && /^Course \d+$/i.test(title)) return;
            const pctMatch = cardText.match(/(\d+)%\s*Course completed/i);
            const percent = pctMatch ? parseInt(pctMatch[1], 10) : 0;
            const completed = percent >= 100 || /100%\s*Course completed/i.test(cardText);
            results.push({
                title,
                percent,
                completed,
                index: results.length,
                buttonIndex,
                courseId,
                href,
            });
        };

        const titleFromCard = (btn: Element): string => {
            const card = btn.closest('.card, article, [class*="course-card"], [class*="dashboard-card"], .col');
            if (!card) return '';
            const nameLink = card.querySelector(
                'a[href*="course/view.php"]:not(.view-course-btn), .coursename a, h3 a, h4 a'
            ) as HTMLAnchorElement | null;
            if (nameLink) {
                const t = (nameLink.textContent || '').replace(/\s+/g, ' ').trim();
                if (t.length > 8 && t.length < 220) return t;
            }
            const blob = (card.textContent || '').replace(/\s+/g, ' ').trim();
            const matches = [...blob.matchAll(/([\u1200-\u137F][\u1200-\u137F\s]{3,}?)\s*\(([^)]+)\)/g)];
            if (matches.length) {
                const last = matches[matches.length - 1];
                return `${last[1].trim()} (${last[2].trim()})`;
            }
            for (const sel of ['h3', 'h4', 'h5', '.coursename', '[class*="course-title"]']) {
                const t = (card.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
                if (t && /\(.+\)/.test(t) && t.length > 12 && t.length < 220) return t;
            }
            return '';
        };

        const viewButtons = [...document.querySelectorAll('a.view-course-btn, a[title="View Course"]')].filter((el) =>
            /view course/i.test((el.textContent || '').trim()) || (el as HTMLAnchorElement).href?.includes('course/view')
        );
        if (!viewButtons.length) {
            document.querySelectorAll('a, button').forEach((el) => {
                if (/view course/i.test((el.textContent || '').trim())) viewButtons.push(el);
            });
        }
        viewButtons.forEach((btn, buttonIndex) => {
            const anchor = btn as HTMLAnchorElement;
            const href = anchor.href || anchor.getAttribute('href') || '';
            const idMatch = href.match(/[?&]id=(\d+)/);
            const courseId = idMatch ? idMatch[1] : '';
            const cardTitle = titleFromCard(btn);
            const cardText = cardTitle || cardTextFromNode(btn);
            pushCard(cardText, `Course ${buttonIndex + 1}`, buttonIndex, courseId, href);
        });

        if (!results.length) {
            document.querySelectorAll('a[href*="course/view"], a[href*="/course/"]').forEach((link, buttonIndex) => {
                const cardText = cardTextFromNode(link);
                if (cardText) {
                    const href = (link as HTMLAnchorElement).href || '';
                    const idMatch = href.match(/[?&]id=(\d+)/);
                    pushCard(cardText, (link.textContent || '').trim().slice(0, 80) || `Course ${buttonIndex + 1}`, buttonIndex, idMatch?.[1] || '', href);
                }
            });
        }

        if (!results.length) {
            document.querySelectorAll('a[href*="course/view.php?id="]').forEach((link, buttonIndex) => {
                const anchor = link as HTMLAnchorElement;
                const href = anchor.href || '';
                const idMatch = href.match(/[?&]id=(\d+)/);
                if (!idMatch) return;
                const cardTitle = titleFromCard(link) || cardTextFromNode(link);
                const cardText = cardTitle || (link.textContent || '').replace(/\s+/g, ' ').trim();
                pushCard(cardText, `Course ${buttonIndex + 1}`, buttonIndex, idMatch[1], href);
            });
        }

        return results;
    });
}

async function waitForCoursesGrid(page: any): Promise<CourseCardInfo[]> {
    for (let attempt = 0; attempt < 12; attempt++) {
        if (attempt > 0) {
            await safePageWait(page, 3500);
            if (attempt === 3) await navigateToMyCourses(page);
        }

        for (const sel of VIEW_COURSE_LOCATORS) {
            await page.locator(sel).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        }
        await page.getByText(/Course completed|%\s*Course completed/i).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

        await scrollCoursesGrid(page);

        const raw = await listCoursesOnPage(page);
        let cards = raw.filter(isValidCourseCard);
        if (!cards.length) {
            cards = raw.filter((c) => c.courseId && c.href && /course\/view\.php/i.test(c.href));
        }
        debugLog({
            hypothesisId: 'H2',
            runId: 'pre-fix',
            location: 'bot.ts:waitForCoursesGrid',
            message: 'grid poll',
            data: {
                attempt,
                rawCount: raw.length,
                cardCount: cards.length,
                pageUrl: page.url(),
                titles: cards.map((c: CourseCardInfo) => ({ title: c.title, percent: c.percent, courseId: c.courseId })),
            },
        });
        if (cards.length) return cards;
        if (/login\/index/i.test(page.url())) {
            throw new Error('Not logged in — on login page instead of My courses');
        }
    }

    return [];
}

function courseMatchesPreference(cardTitle: string, preference: string): boolean {
    const pref = normalizeText(preference);
    const title = normalizeText(cardTitle);
    const english = extractEnglishTitle(cardTitle);
    return title.includes(pref) || pref.includes(english) || english.includes(pref)
        || pref.split(' ').filter((w) => w.length > 3).every((w) => title.includes(w) || english.includes(w));
}

function pickRandomCourseCard(
    cards: CourseCardInfo[],
    student: any,
    usedIndices: Set<number>,
    studentOrdinal: number
): CourseCardInfo {
    const withLink = cards.filter(
        (c) => c.courseId && c.href && !/^Course \d+$/i.test(c.title.trim())
    );
    const named = withLink;
    const incomplete = named.filter((c) => !c.completed && c.percent < 100);
    if (!incomplete.length) {
        throw new Error(`All courses are 100% complete for this user — nothing to do`);
    }
    const pool = incomplete;

    let available = pool.filter((c) => !usedIndices.has(c.index));
    if (!available.length && pool.length > 1) {
        usedIndices.clear();
        available = pool.filter((c) => !usedIndices.has(c.index));
    }
    if (!available.length) available = pool;

    const username = (student.username || '').toString();
    const hash = username.split('').reduce((n, ch) => n + ch.charCodeAt(0), 0);
    const pickSlot = (hash + studentOrdinal * 17) % available.length;
    const rotated = [...available.slice(pickSlot), ...available.slice(0, pickSlot)];
    const jitter = (hash + studentOrdinal) % rotated.length;
    const picked = rotated[jitter];

    usedIndices.add(picked.index);
    return picked;
}

/** True when we left My courses and opened a course or SCORM shell. */
function isCourseOpenedUrl(url: string): boolean {
    if (/my\/courses\.php/i.test(url)) return false;
    return /course\/view\.php|mod\/scorm\/view\.php|mod\/scorm\/player\.php/i.test(url);
}

async function waitForOpenedCourse(page: any, timeoutMs = 45000): Promise<boolean> {
    try {
        await page.waitForFunction(() => {
            const h = window.location.href;
            if (/my\/courses\.php/i.test(h)) return false;
            return /course\/view\.php|mod\/scorm/i.test(h);
        }, { timeout: timeoutMs });
        return isCourseOpenedUrl(page.url());
    } catch {
        return isCourseOpenedUrl(page.url());
    }
}

async function goToMyCourses(page: any): Promise<void> {
    await navigateToMyCourses(page);
}

/** Navigate without waiting for commit (Moodle often never fires it). */
async function navigateToCourseUrl(page: any, fullHref: string): Promise<boolean> {
    if (isCourseOpenedUrl(page.url())) return true;

    await page.evaluate((u: string) => window.location.assign(u), fullHref).catch(() => {});
    if (await waitForOpenedCourse(page, 35000)) return true;

    try {
        await page.goto(fullHref, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
        /* partial load may still have navigated */
    }
    await safePageWait(page, 2000);
    return isCourseOpenedUrl(page.url());
}

/** Click View Course on My courses, then enter the lesson via መማር ይቀጥሉ (not direct SCORM link). */
async function clickViewCourseButton(page: any, picked: CourseCardInfo): Promise<boolean> {
    const urlBefore = page.url();
    const fullHref = picked.href.startsWith('http')
        ? picked.href
        : `https://learn.share.com.et${picked.href}`;

    console.log(`🔗 View Course: ${picked.title}`);

    let method = 'dom-click';
    const clickedInDom = await page.evaluate(
        ({ courseId, buttonIndex }: { courseId: string; buttonIndex: number }) => {
            const buttons = [
                ...document.querySelectorAll('a.view-course-btn, a[title="View Course"]'),
            ].filter((el) => /view course/i.test((el.textContent || '').trim()) || (el as HTMLAnchorElement).href?.includes('course/view'));
            let btn: HTMLAnchorElement | null = null;
            if (courseId) {
                btn = buttons.find((b) => (b as HTMLAnchorElement).href?.includes(`id=${courseId}`)) as HTMLAnchorElement | null;
            }
            if (!btn && buttons[buttonIndex]) btn = buttons[buttonIndex] as HTMLAnchorElement;
            if (!btn) return false;
            btn.scrollIntoView({ block: 'center', inline: 'center' });
            btn.click();
            return true;
        },
        { courseId: picked.courseId, buttonIndex: picked.buttonIndex }
    ).catch(() => false);

    if (clickedInDom && (await waitForOpenedCourse(page, 25000))) {
        debugLog({
            hypothesisId: 'H1',
            runId: 'post-fix',
            location: 'bot.ts:clickViewCourseButton',
            message: 'opened course',
            data: { method, urlBefore, pageUrl: page.url(), fullHref, courseId: picked.courseId },
        });
        return true;
    }

    let viewBtn = page.locator(`a.view-course-btn[href*="id=${picked.courseId}"]`).first();
    if ((await viewBtn.count().catch(() => 0)) === 0) {
        viewBtn = page.locator('a.view-course-btn').nth(picked.buttonIndex);
    }
    await viewBtn.scrollIntoViewIfNeeded({ timeout: 15000 }).catch(() => {});

    method = 'playwright-click';
    try {
        await viewBtn.click({ timeout: 12000, noWaitAfter: true });
        if (await waitForOpenedCourse(page, 25000)) {
            debugLog({
                hypothesisId: 'H1',
                runId: 'post-fix',
                location: 'bot.ts:clickViewCourseButton',
                message: 'opened course',
                data: { method, urlBefore, pageUrl: page.url(), fullHref, courseId: picked.courseId },
            });
            return true;
        }
    } catch {
        /* fall through to assign href */
    }

    method = 'location-assign';
    let opened = await navigateToCourseUrl(page, fullHref);
    if (!opened && isCourseOpenedUrl(page.url())) opened = true;

    debugLog({
        hypothesisId: 'H1',
        runId: 'post-fix',
        location: 'bot.ts:clickViewCourseButton',
        message: 'opened course',
        data: { method, opened, urlBefore, pageUrl: page.url(), fullHref, courseId: picked.courseId },
    });

    return opened;
}

async function openCourseFromGrid(
    page: any,
    student: any,
    usedIndices: Set<number>,
    studentOrdinal: number
): Promise<string> {
    await goToMyCourses(page);
    const cards = await waitForCoursesGrid(page);

    // #region agent log
    debugLog({ hypothesisId: 'H6', location: 'bot.ts:listCoursesOnPage', message: 'courses grid', data: { count: cards.length, cards, usedIndices: [...usedIndices] } });
    // #endregion

    if (!cards.length) {
        if (/login\/index/i.test(page.url())) {
            throw new Error('No courses — still on login page (login did not succeed)');
        }
        const btnCount = await countViewCourseButtons(page);
        if (btnCount > 0) {
            throw new Error(`Found ${btnCount} View Course buttons but could not read course names`);
        }
        throw new Error(`No courses on My courses (${page.url()})`);
    }

    const preference = (student.course || student.coursename || '').toString().trim();
    let picked: CourseCardInfo | null = null;

    if (preference) {
        picked = cards.find((c) => courseMatchesPreference(c.title, preference)) ?? null;
        if (picked) console.log(`🎯 Matched CSV course preference: "${preference}"`);
    }

    if (!picked) {
        picked = pickRandomCourseCard(cards, student, usedIndices, studentOrdinal);
        const username = (student.username || student.firstname || 'student').toString();
        console.log(`🎲 Random course for ${username}: ${picked.title}`);
        // #region agent log
        debugLog({
            hypothesisId: 'H6',
            location: 'bot.ts:openCourseFromGrid',
            message: 'random course pick',
            data: {
                studentOrdinal,
                cardIndex: picked.index,
                buttonIndex: picked.buttonIndex,
                username,
                title: picked.title,
                usedIndices: [...usedIndices],
                pool: cards.filter((c) => !c.completed).map((c) => ({ title: c.title, index: c.index })),
            },
        });
        // #endregion
    }

    console.log(`📗 Opening [${picked.index + 1}/${cards.length}]: ${picked.title} (${picked.percent}% done)`);

    if (!picked.href || !picked.courseId) {
        throw new Error(`View Course link missing for "${picked.title}"`);
    }

    const opened = await clickViewCourseButton(page, picked);
    const onCourse = opened || isCourseOpenedUrl(page.url());

    debugLog({
        hypothesisId: 'H1',
        runId: 'post-fix',
        location: 'bot.ts:openCourseFromGrid',
        message: 'after view course click',
        data: {
            courseId: picked.courseId,
            href: picked.href,
            pageUrl: page.url(),
            opened,
            onCourse,
        },
    });

    if (!onCourse) {
        throw new Error(`View Course did not open course (still on ${page.url()})`);
    }

    console.log(`✅ Course page open: ${page.url()}`);
    await safePageWait(page, 3000);
    const h1Title = await page.locator('h1').first().innerText().catch(() => '');
    if (h1Title && normalizeText(h1Title) !== normalizeText(picked.title)) {
        console.log(`📌 Grid title for answers: "${picked.title}" (page H1: "${h1Title.trim()}")`);
    }
    return picked.title;
}

// ====================== MAIN BOT ======================
async function main() {
    const availableCourses = listAnswerFiles();
    console.log(`🚀 Share eLearning Bot ${BOT_VERSION}`);
    console.log('📋 Workflow: 1 Login → 2 View Course → 3 Start → 4 Continue loop → 5 Exam → 6 Answer → 7 Continue → 8 Certified → 9 Logout');
    console.log(`📂 Running: ${__filename}`);
    console.log(`📂 CWD: ${process.cwd()}`);
    console.log(`📚 Answer files for any course: ${availableCourses.join(', ') || '(none)'}\n`);
    debugLog({
        hypothesisId: 'H0',
        location: 'bot.ts:main',
        message: 'bot started',
        data: { version: BOT_VERSION, file: __filename, cwd: process.cwd(), availableCourses },
    });

    const students: any[] = [];
    fs.createReadStream('data.csv')
        .pipe(csv())
        .on('data', (row) => students.push(row))
        .on('end', async () => {
            const usedCourseIndices = new Set<number>();
            let studentOrdinal = 0;
            for (const student of students) {
                await processStudent(student, usedCourseIndices, studentOrdinal);
                studentOrdinal++;
                await new Promise(r => setTimeout(r, 15000));
            }
        });
}

async function processStudent(student: any, usedCourseIndices: Set<number>, studentOrdinal: number) {
    if (!student.username) return;

    let username = student.username.toString().trim();
    if (!username.startsWith('0')) username = '0' + username;

    console.log(`\n👤 Processing: ${student.firstname || ''} ${student.lastname || ''} (${username})`);

    const browser = await chromium.launch({ headless: false, slowMo: 150 });
    const page = await browser.newPage();

    try {
        const password = (student.password || `${username}@R&D`).toString();

        stepLog(1, 'Login from data.csv');
        await ensureLoggedIn(page, username, password);

        stepLog(2, 'My courses → pick random course → click View Course');
        const courseTitle = await openCourseFromGrid(page, student, usedCourseIndices, studentOrdinal);
        console.log(`📘 Course: ${courseTitle}`);

        if (/my\/courses\.php/i.test(page.url())) {
            throw new Error('Still on My courses — View Course did not open the course');
        }

        const courseAnswers = await loadCourseAnswers(courseTitle);

        if (await isCourseCertified(page) || (await isCourseAlreadyComplete(page))) {
            stepLog(8, 'Course already certified');
        } else {
            await runCourseFlow(page, courseAnswers);
        }

    } catch (e: any) {
        const msg = e.message || String(e);
        if (/100% complete|already complete|nothing to do/i.test(msg)) {
            console.log(`ℹ️ ${msg}`);
        } else {
            console.log(`❌ Error: ${msg}`);
        }
    } finally {
        stepLog(9, 'Logout → next student');
        await logoutUser(page).catch(() => {});
        await browser.close();
    }
}

/** Step 3 or 7: single መማር ይቀጥሉ click (not a poll loop). */
async function clickContinueOnce(page: any, label: string): Promise<boolean> {
    const result = await waitAndClickContinue(page);
    if (result.clicked) {
        console.log(`   ✅ ${label} — መማር ይቀጥሉ (${result.method})`);
        await safePageWait(page, CONTINUE_POST_CLICK_MS);
    }
    return result.clicked;
}

async function logoutUser(page: any): Promise<void> {
    if (!page || page.isClosed()) return;
    console.log('🚪 Logging out → next user...');
    const logoutUrls = [
        'https://learn.share.com.et/login/logout.php',
        'https://learn.share.com.et/logout.php',
    ];
    for (const url of logoutUrls) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await safePageWait(page, 2000);
            if (/login/i.test(page.url())) {
                console.log('✅ Logged out');
                return;
            }
        } catch {}
    }
    try {
        await page.getByRole('link', { name: /log out|logout|ውጣ/i }).first().click({ timeout: 5000 });
        await page.waitForURL(/login/i, { timeout: 15000 }).catch(() => {});
        console.log('✅ Logged out');
    } catch {
        console.log('⚠️ Logout link not found — closing browser for next user');
    }
}

/** Answer one question: pick letter → ያስገቡ → ይቀጥሉ */
async function answerOneQuizQuestion(
    page: any,
    answers: string[],
    answerIndex: number,
    qNum: number,
    label: string
): Promise<{ ok: boolean; nextIndex: number }> {
    const frame = getScormContentFrame(page);
    if (!frame || !(await isQuizScreen(frame))) {
        return { ok: false, nextIndex: answerIndex };
    }

    if (answerIndex >= answers.length) {
        return { ok: false, nextIndex: answerIndex };
    }

    const answer = answers[answerIndex] ?? 'ለ';
    const beforeFp = await getQuizQuestionFingerprint(frame);
    const selected = await selectQuizAnswer(frame, answer);
    if (!selected) return { ok: false, nextIndex: answerIndex };

    // #region agent log
    debugLog({
        hypothesisId: 'Q1',
        location: 'bot.ts:answerOneQuizQuestion',
        message: 'answer picked',
        data: { label, qNum, answerIndex, answer, poolSize: answers.length, beforeFp: beforeFp.slice(0, 80) },
    });
    // #endregion
    console.log(`  📝 ${label} Q${qNum} → ${answer} ✓`);
    await safePageWait(page, 500);

    if (!(await clickSubmitYasebu(page))) {
        console.log(`   ⚠️ ${label} Q${qNum}: ያስገቡ not clicked`);
        return { ok: false, nextIndex: answerIndex };
    }
    await safePageWait(page, 1200);

    let advanced = await waitForQuizQuestionAdvance(page, frame, beforeFp, 5000);
    if (!advanced) {
        await clickNextBekuty(page);
        await safePageWait(page, 600);
        advanced = await waitForQuizQuestionAdvance(page, frame, beforeFp, 8000);
    }
    if (!advanced) {
        await clickNextBekuty(page);
        advanced = await waitForQuizQuestionAdvance(page, frame, beforeFp, 5000);
    }
    if (!advanced) {
        console.log(`   ⚠️ ${label} Q${qNum}: UI did not advance to next question — retrying same index`);
        return { ok: false, nextIndex: answerIndex };
    }

    return { ok: true, nextIndex: answerIndex + 1 };
}

async function runQuizBlock(
    page: any,
    answers: string[],
    startIndex: number,
    maxQuestions: number,
    label: string
): Promise<number> {
    let idx = startIndex;
    let answered = 0;

    const questionLimit = answers.length > 0 ? Math.min(maxQuestions, answers.length) : maxQuestions;
    console.log(`   ▶️ ${label}: answer up to ${questionLimit} questions (CSV has ${answers.length})`);

    for (let q = 0; q < questionLimit; q++) {
        await safePageWait(page, 700);

        const frame = getScormContentFrame(page);
        if (!frame) {
            console.log(`   ⏹️ ${label}: no SCORM frame — stopping`);
            break;
        }

        const stillQuiz = await isQuizScreen(frame);
        if (!stillQuiz) {
            console.log(`   ⏹️ ${label}: quiz screen gone — done after ${answered} answered`);
            break;
        }

        // Step 6: answer → ያስገቡ → ይቀጥሉ
        const result = await answerOneQuizQuestion(page, answers, idx, q + 1, label);
        if (!result.ok) {
            console.log(`   ⚠️ ${label}: failed to answer Q${q + 1} — stopping`);
            break;
        }

        idx = result.nextIndex;
        answered++;

        await safePageWait(page, 900);

        const afterFrame = getScormContentFrame(page);
        if (!afterFrame) break;
        if (!(await isQuizScreen(afterFrame))) {
            console.log(`   ✅ ${label}: quiz finished after ${answered} questions`);
            break;
        }
    }

    if (answered > 0) {
        console.log(`✅ ${label} completed: ${answered} questions answered`);
    } else {
        console.log(`⚠️ ${label}: no questions were answered`);
    }
    return idx;
}

async function isMoodleErrorPage(page: any): Promise<boolean> {
    try {
        const text = (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')) || '';
        return /required parameter|missingparam|scoid.*missing|moodle_exception/i.test(text);
    } catch {
        return false;
    }
}

function scormViewUrlFromPage(page: any): string | null {
    const id = page.url().match(/[?&]id=(\d+)/)?.[1];
    return id ? `https://learn.share.com.et/mod/scorm/view.php?id=${id}` : null;
}

/** Find player.php link that includes scoid (required by Moodle). */
async function findScormLaunchHref(page: any): Promise<string | null> {
    try {
        return await page.evaluate(() => {
            const links = [...document.querySelectorAll('a[href*="player.php"]')] as HTMLAnchorElement[];
            let best = '';
            for (const a of links) {
                const h = a.href || '';
                if (!h.includes('mod/scorm/player') || !h.includes('scoid=')) continue;
                if (!best || h.length < best.length) best = h;
            }
            return best || null;
        });
    } catch {
        return null;
    }
}

/** Launch SCORM correctly from view.php — click Enter/Launch button or any link to player.php. */
async function launchScormFromView(page: any): Promise<boolean> {
    if (await isMoodleErrorPage(page)) {
        const viewUrl = scormViewUrlFromPage(page);
        if (viewUrl) {
            console.log('⚠️ SCORM error page — returning to view.php...');
            await page.goto(viewUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await safePageWait(page, 2500);
        }
    }

    // Already on player.php with scoid — good
    if (/mod\/scorm\/player\.php/i.test(page.url()) && /scoid=/i.test(page.url())) {
        if (!(await isMoodleErrorPage(page))) {
            return true;
        }
    }

    // Already on player.php without scoid but no error — still good (some Moodle versions)
    if (/mod\/scorm\/player\.php/i.test(page.url()) && !(await isMoodleErrorPage(page))) {
        return true;
    }

    // If we have a scorm content iframe already loaded, we're good
    const existingScorm = getScormContentFrame(page);
    if (existingScorm) {
        console.log('📦 SCORM content frame already loaded');
        return true;
    }

    if (!/view\.php|course\/view\.php/i.test(page.url())) {
        return /player\.php/i.test(page.url()) && !(await isMoodleErrorPage(page));
    }

    // Strategy 1: Find player.php link with scoid
    let launchHref = await findScormLaunchHref(page);
    if (launchHref) {
        console.log(`📦 Launching SCORM (scoid link): ${launchHref.slice(0, 90)}...`);
        await page.goto(launchHref, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await safePageWait(page, 3500);
        if (/player\.php/i.test(page.url()) && !(await isMoodleErrorPage(page))) {
            console.log('📦 SCORM player ready');
            return true;
        }
    }

    // Strategy 2: Click any Enter/Launch/Start button or link on the view page
    const launched = await page.evaluate(() => {
        // Look for forms submitting to player.php
        const forms = [...document.querySelectorAll('form[action*="player.php"]')];
        if (forms.length > 0) {
            (forms[0] as HTMLFormElement).submit();
            return 'form-submit';
        }

        // Look for any button/link with Enter/Launch/Start text
        const clickables = [...document.querySelectorAll('a, button, input[type="submit"], input[type="button"]')];
        for (const el of clickables) {
            const t = ((el as HTMLElement).textContent || (el as HTMLInputElement).value || '').trim();
            const href = (el as HTMLAnchorElement).href || '';
            // Click links to player.php (even without scoid — server may handle it)
            if (href.includes('player.php')) {
                (el as HTMLElement).click();
                return `link:${t.slice(0, 30)}`;
            }
            // Click "Enter" / "Launch" / "Start" buttons
            if (/^(enter|launch|start|preview|attempt)$/i.test(t) || /enter course|launch course|start course/i.test(t)) {
                (el as HTMLElement).click();
                return `button:${t.slice(0, 30)}`;
            }
        }

        // Look for any submit button inside a form on the page
        const submitBtns = [...document.querySelectorAll('form input[type="submit"], form button[type="submit"]')];
        for (const btn of submitBtns) {
            const t = ((btn as HTMLElement).textContent || (btn as HTMLInputElement).value || '').trim();
            if (t && !/login|log in|search/i.test(t)) {
                (btn as HTMLElement).click();
                return `form-btn:${t.slice(0, 30)}`;
            }
        }

        return null;
    }).catch(() => null);

    if (launched) {
        console.log(`📦 SCORM launch attempt: ${launched}`);
        await safePageWait(page, 5000);
        // Wait for navigation to player.php or for SCORM iframe to appear
        for (let i = 0; i < 10; i++) {
            if (/player\.php/i.test(page.url()) && !(await isMoodleErrorPage(page))) {
                console.log('📦 SCORM player ready');
                return true;
            }
            if (getScormContentFrame(page)) {
                console.log('📦 SCORM content frame loaded');
                return true;
            }
            await safePageWait(page, 1000);
        }
    }

    // Strategy 3: Playwright locator-based clicks
    const enterSelectors = [
        'a[href*="player.php"]',
        'button:has-text("Enter")',
        'input[value="Enter"]',
        'button:has-text("Launch")',
        'button:has-text("Start")',
        'input[value="Launch"]',
        'input[value="Start"]',
        'a:has-text("Enter")',
        'a:has-text("Launch")',
        '#scormviewform input[type="submit"]',
        'form[action*="player"] input[type="submit"]',
        'form[action*="player"] button',
    ];

    for (const sel of enterSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1500 })) {
                console.log(`📦 Clicking SCORM launch: ${sel}`);
                await btn.click({ timeout: 15000 });
                await safePageWait(page, 5000);
                if (/player\.php/i.test(page.url()) && !(await isMoodleErrorPage(page))) {
                    console.log('📦 SCORM player ready');
                    return true;
                }
                if (getScormContentFrame(page)) {
                    console.log('📦 SCORM content frame loaded');
                    return true;
                }
            }
        } catch {}
    }

    console.log('⚠️ No SCORM launch button found on view page');
    return false;
}

async function isCourseAlreadyComplete(page: any): Promise<boolean> {
    if (await isMoodleErrorPage(page)) return false;
    if (await isCourseCertified(page)) return true;
    for (const frame of page.frames()) {
        try {
            const done = await frame.evaluate(() => {
                const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
                return /100%\s*Course completed|100%\s*አጠናቅቋል|Course completed/i.test(t)
                    && !/0%\s*Course completed/i.test(t);
            });
            if (done) return true;
        } catch {}
    }
    return false;
}

/** Steps 3–8: start course → loop lessons → chapter exams → final exam → certified. */
async function runCourseFlow(page: any, courseAnswers: CourseAnswers = { chapters: [], final: [] }) {
    let loop = 0;
    let chapterExamsDone = 0;

    await launchScormFromView(page);
    await waitForScormContentFrame(page, 25000);

    stepLog(3, 'Click መማር ይቀጥሉ once to start course (if visible)');
    await clickContinueOnce(page, 'Start course');

    while (loop < 150) {
        loop++;
        await safePageWait(page, 400);

        // Step 8: repeat until certified
        if (await isCourseCertified(page) || (await isCourseAlreadyComplete(page))) {
            stepLog(8, 'Course certified — እንኳን ደስ');
            break;
        }

        if (await page.locator('text=Your content is loading').isVisible({ timeout: 800 }).catch(() => false)) {
            await safePageWait(page, 5000);
        }

        if (await isMoodleErrorPage(page)) {
            await launchScormFromView(page);
        } else if (/view\.php/i.test(page.url()) || !getScormContentFrame(page)) {
            await launchScormFromView(page);
            await waitForScormContentFrame(page, 15000);
        }

        // Step 5 + 6 + 7: exam (ፈተናውን ይጀምሩ) — check before quiz (summary page has no active quiz)
        const examVisible = await findExamStartButton(page);
        if (examVisible) {
            stepLog(5, 'Click ፈተናውን ይጀምሩ → start exam');
            const examResult = await clickExamStartButton(page);
            debugLog({
                hypothesisId: 'H3',
                location: 'bot.ts:examCheck',
                message: 'exam click attempt',
                data: { loop, clicked: examResult.clicked, frameUrl: examResult.frameUrl, method: examResult.method },
            });
            if (examResult.clicked) {
                await safePageWait(page, 2500);
                await waitForScormContentFrame(page, 12000);
                if (await waitForQuizAfterExamStart(page)) {
                    const chapterNum = await detectChapterNumberFromPage(page);
                    const isFinal = await isFinalCourseExamPage(page);
                    const plan = resolveExamQuizPlan(courseAnswers, chapterNum, chapterExamsDone, isFinal);
                    // #region agent log
                    debugLog({
                        hypothesisId: 'Q1',
                        runId: 'post-fix',
                        location: 'bot.ts:runCourseFlow:examQuiz',
                        message: 'exam answer plan',
                        data: {
                            loop,
                            chapterNum,
                            isFinal,
                            label: plan.label,
                            maxQ: plan.maxQ,
                            chapterExamsDone,
                            answersPreview: plan.answers.slice(0, 8),
                        },
                    });
                    // #endregion
                    stepLog(6, `Answer ${plan.label} (answer → ያስገቡ → ይቀጥሉ) from CSV`);
                    await runQuizBlock(page, plan.answers, 0, plan.maxQ, plan.label);
                    if (!isFinal) chapterExamsDone++;
                    stepLog(7, 'After test → click መማር ይቀጥሉ');
                    await clickContinueOnce(page, 'After chapter exam');
                    await waitForScormContentFrame(page, 10000);
                    if (await isCourseCertified(page)) continue;
                    continue;
                }
                console.log('   ⚠️ Exam started but quiz UI not detected yet — continuing loop');
            } else {
                console.log('   ⚠️ ፈተናውን ይጀምሩ visible on screen but click failed — will retry');
            }
        }

        const scorm = getScormContentFrame(page);
        const inQuiz = scorm ? await isQuizScreen(scorm) : false;

        // Mid-course quiz (steps 4–6, smaller tests)
        if (scorm && inQuiz) {
            const chapterNum = await detectChapterNumberFromPage(page);
            const plan = resolveExamQuizPlan(courseAnswers, chapterNum, chapterExamsDone, false);
            stepLog(6, `Mid-course quiz (${plan.label}) — answer → ያስገቡ → ይቀጥሉ`);
            const nextIdx = await runQuizBlock(page, plan.answers, 0, plan.maxQ, plan.label);
            if (nextIdx > 0) {
                stepLog(7, 'After quiz → መማር ይቀጥሉ');
                await clickContinueOnce(page, 'After chapter test');
                if (await waitForExamStartButton(page, 12000)) {
                    console.log('   📋 Chapter summary ready — ፈተናውን ይጀምሩ detected');
                }
                continue;
            }
        }

        // Step 4: skip videos + መማር ይቀጥሉ until ፈተናውን ይጀምሩ
        console.log(`   Step 4 (loop ${loop}): skip video + መማር ይቀጥሉ...`);
        await autoSkipVideo(page);
        const continueResult = await waitAndClickContinue(page);
        const continued = continueResult.clicked;
        if (continued) {
            console.log(`   ✅ Continue lesson — መማር ይቀጥሉ (${continueResult.method})`);
            await safePageWait(page, CONTINUE_POST_CLICK_MS);
        }

        const examNow = await findExamStartButton(page);
        const quizNow = scorm ? await isQuizScreen(scorm) : false;

        if (!continued && !examNow && !quizNow) {
            if (loop <= 3 || loop % 4 === 0) {
                await debugProbePageState(page, loop, continueResult);
            }
            if (loop % 8 === 0) {
                await launchScormFromView(page);
                await waitForScormContentFrame(page, 12000);
                await page.screenshot({ path: `debug-stuck-${loop}.png` }).catch(() => {});
                console.log(`   ⚠️ Stuck at loop ${loop} — no continue, no exam, no quiz (see debug-stuck-${loop}.png)`);
            }
        }
    }
}

/** Share shows this when the user is certified (course fully completed). */
async function isCourseCertified(page: any): Promise<boolean> {
    if (await isMoodleErrorPage(page)) return false;

    const certPhrases = [
        'እንኳን ደስ',
        'አጠናቀሃል',
        'አጠናቀሻል',
        'በስኬት አጠናቀሃል',
        'በስኬት አጠናቀሻል',
        'ሰርተፊኬት',
        'የኮርሱን ሰርተፊኬት',
    ];

    for (const frame of page.frames()) {
        try {
            const found = await frame.evaluate((phrases: string[]) => {
                const text = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ');
                if (!text) return false;
                const hasCongrats = /እንኳን ደስ/i.test(text);
                const hasCompleted = /አጠናቀሃል|አጠናቀሻል|በስኬት.*ኮርስ/i.test(text);
                const hasCertificate = /ሰርተፊኬት|certificate/i.test(text);
                if (hasCongrats && (hasCompleted || hasCertificate)) return true;
                return phrases.some((p) => text.includes(p)) && (hasCompleted || hasCertificate || hasCongrats);
            }, certPhrases);
            if (found) return true;
        } catch {
            /* frame detached */
        }
    }

    try {
        const n = await page.getByText(/እንኳን ደስ|አጠናቀሃል|አጠናቀሻል|ሰርተፊኬት|Course completed|certified/i).count();
        return n > 0;
    } catch {
        return false;
    }
}

const EXAM_START_TEXTS = ['ፈተናውን ይጀምሩ', 'ፈተና ይጀምሩ'];

async function waitForExamStartButton(page: any, maxMs = 12000): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (await findExamStartButton(page)) return true;
        if (await page.locator('text=Your content is loading').isVisible({ timeout: 400 }).catch(() => false)) {
            await safePageWait(page, 1500);
            continue;
        }
        await safePageWait(page, 500);
    }
    return false;
}

function orderFramesForScorm(page: any): any[] {
    const frames = page.frames();
    const scormContent = frames.filter((f: any) => /scormcontent/i.test(f.url()));
    const scormPlayer = frames.filter((f: any) => /scorm|player/i.test(f.url()) && !/scormcontent/i.test(f.url()));
    const rest = frames.filter((f: any) => !/scorm/i.test(f.url()));
    return [...scormContent, ...scormPlayer, ...rest];
}

async function findExamStartButton(page: any): Promise<boolean> {
    for (const frame of orderFramesForScorm(page)) {
        if (!/scormcontent/i.test(frame.url())) continue;
        try {
            const found = await frame.evaluate(() => {
                const needles = ['ፈተናውን ይጀምሩ', 'ፈተና ይጀምሩ'];
                const isVisibleInViewport = (el: Element) => {
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 12 || rect.height < 5) return false;
                    if (rect.bottom < 2 || rect.top > window.innerHeight - 2) return false;
                    if (rect.right < 2 || rect.left > window.innerWidth - 2) return false;
                    let node: Element | null = el;
                    while (node && node !== document.documentElement) {
                        const st = getComputedStyle(node);
                        if (st.display === 'none' || st.visibility === 'hidden') return false;
                        if (parseFloat(st.opacity) < 0.2) return false;
                        const h = node as HTMLElement;
                        if (h.offsetParent === null && st.position !== 'fixed' && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
                            return false;
                        }
                        node = node.parentElement;
                    }
                    return true;
                };
                const nodes = [...document.querySelectorAll('a, button, span, p, div, label, [role="button"], [role="link"]')];
                return nodes.some((el) => {
                    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!needles.some((n) => t.includes(n)) || t.length > 55) return false;
                    return isVisibleInViewport(el);
                });
            });
            if (found) return true;
        } catch {}
    }
    return false;
}

/** Click green "ፈተናውን ይጀምሩ >" link inside SCORM — only the viewport-visible slide (not hidden Storyline layers). */
async function clickExamStartButton(page: any): Promise<{ clicked: boolean; frameUrl: string; method: string }> {
    for (const frame of orderFramesForScorm(page)) {
        if (!/scormcontent/i.test(frame.url())) continue;
        const frameUrl = frame.url();

        for (const text of EXAM_START_TEXTS) {
            try {
                const loc = frame.getByText(text, { exact: false });
                const count = await loc.count();
                for (let i = 0; i < count; i++) {
                    const el = loc.nth(i);
                    if (!(await el.isVisible({ timeout: 800 }).catch(() => false))) continue;
                    const box = await el.boundingBox().catch(() => null);
                    if (!box || box.width < 12 || box.height < 5) continue;
                    await el.scrollIntoViewIfNeeded().catch(() => {});
                    await el.click({ force: true, timeout: 12000 });
                    console.log(`✅ Clicked ፈተናውን ይጀምሩ via getByText[${i}] in ${frameUrl}`);
                    return { clicked: true, frameUrl, method: `getByText:${i}` };
                }
            } catch {}
        }

        try {
            const target = await frame.evaluate(() => {
                const needles = ['ፈተናውን ይጀምሩ', 'ፈተና ይጀምሩ'];
                const isVisibleInViewport = (el: Element) => {
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 12 || rect.height < 5) return false;
                    if (rect.bottom < 2 || rect.top > window.innerHeight - 2) return false;
                    if (rect.right < 2 || rect.left > window.innerWidth - 2) return false;
                    let node: Element | null = el;
                    while (node && node !== document.documentElement) {
                        const st = getComputedStyle(node);
                        if (st.display === 'none' || st.visibility === 'hidden') return false;
                        if (parseFloat(st.opacity) < 0.2) return false;
                        const h = node as HTMLElement;
                        if (h.offsetParent === null && st.position !== 'fixed' && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
                            return false;
                        }
                        node = node.parentElement;
                    }
                    return true;
                };

                const nodes = [...document.querySelectorAll('a, button, span, p, div, label, [role="button"], [role="link"]')];
                let bestEl: HTMLElement | null = null;
                let bestScore = -1;
                for (const el of nodes) {
                    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!needles.some((n) => t.includes(n)) || t.length > 55) continue;
                    if (!isVisibleInViewport(el)) continue;

                    let score = 100;
                    if (el.tagName === 'A') score += 40;
                    const anchor = el.closest('a') as HTMLElement | null;
                    if (anchor && anchor !== el && isVisibleInViewport(anchor)) score += 25;
                    const color = getComputedStyle(el).color;
                    if (/rgb\(\s*0\s*,\s*166\s*,\s*81|#00a651/i.test(color)) score += 50;
                    const rect = el.getBoundingClientRect();
                    score -= (rect.width * rect.height) / 8000;

                    if (score > bestScore) {
                        bestScore = score;
                        bestEl = (anchor && isVisibleInViewport(anchor) ? anchor : el) as HTMLElement;
                    }
                }
                if (!bestEl) return null;

                bestEl.scrollIntoView({ block: 'center', inline: 'center' });
                bestEl.click();
                const rect = bestEl.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    tag: bestEl.tagName,
                    text: (bestEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
                };
            });
            if (target) {
                try {
                    await frame.mouse.click(target.x, target.y);
                } catch {}
                console.log(`✅ Clicked ፈተናውን ይጀምሩ via DOM (${target.tag}: "${target.text}")`);
                return { clicked: true, frameUrl, method: `evaluate:${target.tag}` };
            }
        } catch {}
    }

    const fallback = await clickTextInFrames(page, EXAM_START_TEXTS, { examMode: true });
    if (fallback.clicked) {
        console.log(`✅ Clicked ፈተናውን ይጀምሩ via ${fallback.method}`);
    }
    return fallback;
}

async function waitForQuizAfterExamStart(page: any, maxWaitMs = 15000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const sc = getScormContentFrame(page);
        if (sc && (await isQuizScreen(sc))) return true;
        await safePageWait(page, 600);
    }
    return false;
}

async function autoSkipVideo(page: any) {
    let mainVideos = 0;
    try {
        mainVideos = await page.evaluate(() => document.querySelectorAll('video').length);
    } catch {}
    let frameVideos = 0;
    let ytIframes = 0;
    for (const frame of page.frames()) {
        try {
            const c = await frame.evaluate(() => ({
                videos: document.querySelectorAll('video').length,
                yt: document.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu.be"]').length,
            }));
            frameVideos += c.videos;
            ytIframes += c.yt;
        } catch {}
    }
    // #region agent log
    if (frameVideos === 0 && ytIframes > 0) {
        debugLog({
            runId: 'stuck-probe',
            hypothesisId: 'H2',
            location: 'bot.ts:autoSkipVideo',
            message: 'youtube iframe only — cannot skip via video tag',
            data: { mainVideos, frameVideos, ytIframes },
        });
    }
    // #endregion
    await page.evaluate(() => {
        document.querySelectorAll('video').forEach((v: any) => {
            v.muted = true;
            v.playbackRate = 16;
            if (v.duration) v.currentTime = v.duration - 5;
        });
    });
    for (const frame of page.frames()) {
        try {
            await frame.evaluate(() => {
                document.querySelectorAll('video').forEach((v: any) => {
                    v.muted = true;
                    v.playbackRate = 16;
                    if (v.duration) v.currentTime = v.duration - 5;
                });
            });
        } catch {}
    }
}

main().catch(console.error);