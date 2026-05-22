import { chromium } from 'playwright';
import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOT_VERSION = 'v8-unique-random-course';
const CONTINUE_POLL_MS = 350;
const CONTINUE_POST_CLICK_MS = 1500;
const CHAPTER_QUIZ_MAX_Q = 6;
const DEBUG_LOG = path.join(__dirname, 'debug-93bca3.log');

function debugLog(payload: Record<string, unknown>) {
    const line = JSON.stringify({ sessionId: '93bca3', timestamp: Date.now(), ...payload }) + '\n';
    for (const logPath of [DEBUG_LOG, path.join(process.cwd(), 'debug-93bca3.log')]) {
        try { fs.appendFileSync(logPath, line); } catch {}
    }
    fetch('http://127.0.0.1:7785/ingest/033e1045-1a8d-439a-aec7-78fd76285c5f', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '93bca3' },
        body: line.trim(),
    }).catch(() => {});
}

// ====================== ANSWERS ======================
const answersCache: any = {};

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

async function loadAnswers(courseName: string): Promise<string[]> {
    if (answersCache[courseName]?.length) return answersCache[courseName];

    const fileName = resolveAnswerFileName(courseName);
    const available = listAnswerFiles();

    // #region agent log
    debugLog({
        hypothesisId: 'H1',
        location: 'bot.ts:loadAnswers',
        message: 'resolve answers file',
        data: { courseName, fileName, available, scores: available.map((f) => ({ f, s: scoreCourseToFile(courseName, f) })) },
    });
    // #endregion

    if (!fileName) {
        console.log(`⚠️ No answer file matched for course: "${courseName}"`);
        console.log(`   Available: ${available.join(', ')}`);
        console.log(`   Exam will use default answers (ለ, ሐ, …)`);
        return [];
    }

    const csvPath = path.join(answersDir, `${fileName}.csv`);
    if (!fs.existsSync(csvPath)) {
        console.log(`⚠️ Answers file missing on disk: ${fileName}.csv`);
        return [];
    }

    console.log(`📋 Answers loaded from: ${fileName}.csv (matched "${courseName}")`);

    return new Promise((resolve) => {
        const answers: string[] = [];
        fs.createReadStream(csvPath)
            .pipe(csv())
            .on('data', (row) => {
                const ans = row['total'] || row['answer'] || Object.values(row)[0];
                if (ans) answers.push(ans.toString().trim());
            })
            .on('end', () => {
                answersCache[courseName] = answers;
                resolve(answers);
            });
    });
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
    return sortFramesByContent(page.frames()).find((f: any) => /scormcontent/i.test(f.url())) || null;
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

async function isQuizScreen(frame: any): Promise<boolean> {
    return isChapterQuizScreen(frame);
}

async function clickAnswerByLetter(frame: any, answer: string): Promise<boolean> {
    const letter = answer.trim().replace(/\s+/g, '');
    if (!letter) return false;

    const playwrightAttempts = [
        () => frame.getByText(letter, { exact: true }).first().click({ force: true, timeout: 8000 }),
        () => frame.locator('label').filter({ hasText: letter }).first().click({ force: true, timeout: 8000 }),
        () => frame.locator(`[role="radio"]:has-text("${letter}")`).first().click({ force: true, timeout: 8000 }),
        () => frame.locator(`button:has-text("${letter}")`).first().click({ force: true, timeout: 8000 }),
    ];

    for (let i = 0; i < playwrightAttempts.length; i++) {
        try {
            await playwrightAttempts[i]();
            debugLog({ hypothesisId: 'H4', location: 'bot.ts:clickAnswerByLetter', message: 'playwright click ok', data: { letter, attempt: i } });
            return true;
        } catch {}
    }

    try {
        const result = await frame.evaluate((ans) => {
            const norm = ans.trim().replace(/\s+/g, '');
            const clickables = [...document.querySelectorAll('label, button, [role="radio"], div, span, li')];
            for (const el of clickables) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!t || t.length > 30) continue;
                if (t === norm || t.startsWith(norm + ' ') || t.startsWith(norm + '.') || t.startsWith(norm + ')')) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 5 && rect.height > 5) {
                        (el as HTMLElement).click();
                        return { ok: true, via: `label:${t}` };
                    }
                }
            }
            const radios = [...document.querySelectorAll('input[type="radio"]')].filter((r) => {
                const rect = r.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
            const map: Record<string, number> = {
                'ለ': 0, 'ሀ': 0, 'A': 0, 'a': 0,
                'ሐ': 1, 'U': 1, 'B': 1, 'b': 1,
                'መ': 2, 'ረ': 2, 'C': 2, 'c': 2,
            };
            const idx = map[norm] ?? map[norm.charAt(0)];
            if (idx !== undefined && radios[idx]) {
                radios[idx].click();
                radios[idx].closest('label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return { ok: true, via: `radio:${idx}` };
            }
            return { ok: false };
        }, letter);
        return !!result?.ok;
    } catch {
        return false;
    }
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

async function clickSubmitYasebu(page: any): Promise<boolean> {
    for (const frame of sortFramesByContent(page.frames())) {
        try {
            const exact = frame.getByRole('button', { name: 'ያስገቡ', exact: true });
            if (await exact.isVisible({ timeout: 500 })) {
                await exact.click({ force: true, timeout: 8000 });
                debugLog({ hypothesisId: 'H4', location: 'bot.ts:clickSubmitYasebu', message: 'clicked ያስገቡ', data: { frameUrl: frame.url(), method: 'role' } });
                return true;
            }
        } catch {}
        try {
            const btn = frame.locator('button:has-text("ያስገቡ")').first();
            if (await btn.isVisible({ timeout: 500 })) {
                await btn.click({ force: true, timeout: 8000 });
                debugLog({ hypothesisId: 'H4', location: 'bot.ts:clickSubmitYasebu', message: 'clicked ያስገቡ', data: { frameUrl: frame.url(), method: 'has-text' } });
                return true;
            }
        } catch {}
    }
    return false;
}

async function isChapterQuizScreen(frame: any): Promise<boolean> {
    if (await isQuizScreen(frame)) return true;
    try {
        return await frame.locator('button:has-text("ያስገቡ")').first().isVisible({ timeout: 400 });
    } catch {
        return false;
    }
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
                document.querySelectorAll('button, a, [role="button"], div, span, p, label').forEach((el) => {
                    const t = (el.textContent || '').trim();
                    if (!t.includes(searchText)) return;
                    matchCount++;
                    const rect = el.getBoundingClientRect();
                    const style = getComputedStyle(el);
                    if (rect.width > 5 && rect.height > 5 && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.1) {
                        visibleCount++;
                    }
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
                if ((examMode || continueMode) && !['BUTTON', 'A', 'INPUT'].includes(tag)) continue;

                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (examMode) {
                    if (t !== searchText && !t.endsWith(searchText)) continue;
                    if (t.length > searchText.length + 8) continue;
                } else if (!t.includes(searchText)) {
                    continue;
                }

                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                if (rect.width < 8 || rect.height < 8) continue;
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                if (parseFloat(style.opacity) < 0.1) continue;
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
    for (const frame of sortFramesByContent(page.frames())) {
        const selectors = [
            `button[style*="rgb(0, 166, 81)"]:has-text("${textHint}")`,
            `button[style*="0, 166, 81)"]:has-text("${textHint}")`,
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

        if (!opts?.examMode) {
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
                if (!opts?.examMode && !opts?.continueMode) {
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

async function waitAndClickContinue(page: any): Promise<{ clicked: boolean; frameUrl: string; matchedText: string; method: string }> {
    const maxAttempts = 40;
    const t0 = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) await page.waitForTimeout(CONTINUE_POLL_MS);

        if (await quizScreenActive(page)) {
            continue;
        }

        await autoSkipVideo(page);

        const result = await clickTextInFrames(page, ['መማር ይቀጥሉ'], { continueMode: true });
        if (result.clicked) {
            // #region agent log
            debugLog({
                hypothesisId: 'H2',
                location: 'bot.ts:waitAndClickContinue',
                message: 'continue clicked',
                data: { attempt, elapsedMs: Date.now() - t0, ...result },
            });
            // #endregion
            return result;
        }
    }

    return { clicked: false, frameUrl: page.url(), matchedText: '', method: 'none' };
}

// ====================== COURSE PICKER (My courses grid) ======================
type CourseCardInfo = { title: string; percent: number; completed: boolean; index: number };

async function listCoursesOnPage(page: any): Promise<CourseCardInfo[]> {
    return page.evaluate(() => {
        const results: { title: string; percent: number; completed: boolean; index: number }[] = [];
        const viewButtons = [...document.querySelectorAll('a, button')].filter((el) =>
            /view course/i.test((el.textContent || '').trim())
        );

        viewButtons.forEach((btn, index) => {
            let cardText = '';
            let node: Element | null = btn;
            for (let depth = 0; depth < 10 && node; depth++) {
                node = node.parentElement;
                if (!node) break;
                const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
                if (text.includes('(') && text.includes(')') && text.length > 40) {
                    cardText = text;
                }
            }

            const titleMatch = cardText.match(/([\u1200-\u137F][\u1200-\u137F\s]*)\s*\(([^)]+)\)/);
            const title = titleMatch
                ? `${titleMatch[1].trim()} (${titleMatch[2].trim()})`
                : (cardText.match(/\(([^)]+)\)/)?.[0] ? cardText.slice(0, 120) : `Course ${index + 1}`);

            const pctMatch = cardText.match(/(\d+)%\s*Course completed/i);
            const percent = pctMatch ? parseInt(pctMatch[1], 10) : 0;
            const completed = percent >= 100 || /100%\s*Course completed/i.test(cardText);

            results.push({ title, percent, completed, index });
        });

        return results;
    });
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
    usedIndices: Set<number>
): CourseCardInfo {
    const incomplete = cards.filter((c) => !c.completed && c.percent < 100);
    const pool = incomplete.length ? incomplete : cards;

    let available = pool.filter((c) => !usedIndices.has(c.index));
    if (!available.length) {
        usedIndices.clear();
        available = pool;
    }

    const username = (student.username || '').toString();
    const hash = username.split('').reduce((n, ch) => n + ch.charCodeAt(0), 0);
    const start = hash % available.length;
    const rotated = [...available.slice(start), ...available.slice(0, start)];
    const jitter = Math.floor(Math.random() * rotated.length);
    const picked = rotated[jitter];

    usedIndices.add(picked.index);
    return picked;
}

async function openCourseFromGrid(page: any, student: any, usedIndices: Set<number>): Promise<string> {
    await page.waitForSelector('text=View Course', { timeout: 20000 });
    const cards = await listCoursesOnPage(page);

    // #region agent log
    debugLog({ hypothesisId: 'H6', location: 'bot.ts:listCoursesOnPage', message: 'courses grid', data: { count: cards.length, cards } });
    // #endregion

    if (!cards.length) {
        console.log('⚠️ No courses found on My courses page');
        return 'Unknown';
    }

    const preference = (student.course || student.coursename || '').toString().trim();
    let pickIndex = -1;

    if (preference) {
        pickIndex = cards.findIndex((c) => courseMatchesPreference(c.title, preference));
        if (pickIndex >= 0) console.log(`🎯 Matched CSV course preference: "${preference}"`);
    }

    if (pickIndex < 0) {
        const randomCard = pickRandomCourseCard(cards, student, usedIndices);
        pickIndex = randomCard.index;
        const username = (student.username || student.firstname || 'student').toString();
        console.log(`🎲 Random course for ${username}: ${randomCard.title}`);
        // #region agent log
        debugLog({
            hypothesisId: 'H6',
            location: 'bot.ts:openCourseFromGrid',
            message: 'random course pick',
            data: {
                pickIndex,
                username,
                title: randomCard.title,
                usedCount: usedIndices.size,
                pool: cards.filter((c) => !c.completed).map((c) => c.title),
            },
        });
        // #endregion
    }

    const picked = cards[pickIndex];
    console.log(`📗 Opening [${pickIndex + 1}/${cards.length}]: ${picked.title} (${picked.percent}% done)`);

    const viewButtons = page.locator('a:has-text("View Course"), button:has-text("View Course")');
    await viewButtons.nth(pickIndex).scrollIntoViewIfNeeded().catch(() => {});
    await viewButtons.nth(pickIndex).click({ force: true, timeout: 20000 });

    await page.waitForTimeout(10000);
    const h1Title = await page.locator('h1').first().innerText().catch(() => picked.title);
    return h1Title || picked.title;
}

// ====================== MAIN BOT ======================
async function main() {
    const availableCourses = listAnswerFiles();
    console.log(`🚀 Share eLearning Bot ${BOT_VERSION}`);
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
            for (const student of students) {
                await processStudent(student, usedCourseIndices);
                await new Promise(r => setTimeout(r, 15000));
            }
        });
}

async function processStudent(student: any, usedCourseIndices: Set<number>) {
    if (!student.username) return;

    let username = student.username.toString().trim();
    if (!username.startsWith('0')) username = '0' + username;

    console.log(`\n👤 Processing: ${student.firstname || ''} ${student.lastname || ''} (${username})`);

    const browser = await chromium.launch({ headless: false, slowMo: 150 });
    const page = await browser.newPage();

    try {
        await page.goto('https://learn.share.com.et/login/index.php', { waitUntil: 'domcontentloaded' });
        await page.fill('input[name="username"]', username);
        await page.fill('input[name="password"]', student.password || `${username}@R&D`);
        await page.click('button[type="submit"]');

        await page.waitForTimeout(7000);
        await page.goto('https://learn.share.com.et/my/courses.php', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(8000);

        const courseTitle = await openCourseFromGrid(page, student, usedCourseIndices);
        console.log(`📘 Course: ${courseTitle}`);

        const answers = await loadAnswers(courseTitle);
        await startCourseProgress(page, answers);

    } catch (e: any) {
        console.log(`❌ Error: ${e.message}`);
    } finally {
        await browser.close();
    }
}

async function runChapterQuiz(
    page: any,
    answers: string[],
    answerIndex: number,
    maxQuestions: number = CHAPTER_QUIZ_MAX_Q
): Promise<number> {
    let idx = answerIndex;
    let answered = 0;

    console.log(`📋 Chapter test started (up to ${maxQuestions} questions)...`);

    for (let q = 0; q < maxQuestions; q++) {
        await page.waitForTimeout(500);
        const frame = getScormContentFrame(page);
        if (!frame || !(await isChapterQuizScreen(frame))) break;

        const answer = answers[idx] ?? answers[idx % Math.max(answers.length, 1)] ?? 'ለ';
        const selected = await selectQuizAnswer(frame, answer);
        // #region agent log
        debugLog({
            hypothesisId: 'H4',
            location: 'bot.ts:runChapterQuiz',
            message: 'chapter quiz answer',
            data: { q: q + 1, qIndex: idx + 1, answer, selected, frameUrl: frame.url() },
        });
        // #endregion

        if (!selected) break;

        console.log(`  📝 Q${q + 1} → ${answer} ✓`);
        idx++;
        answered++;

        await page.waitForTimeout(400);
        const submitted = await clickSubmitYasebu(page);
        // #region agent log
        debugLog({ hypothesisId: 'H4', location: 'bot.ts:runChapterQuiz', message: 'submit ያስገቡ', data: { q: q + 1, submitted } });
        // #endregion

        if (!submitted) {
            console.log('  ⚠️ ያስገቡ not found after answer');
            break;
        }
        await page.waitForTimeout(700);
    }

    if (answered > 0) {
        console.log(`✅ Chapter test done (${answered} questions) — looking for መማር ይቀጥሉ...`);
        for (let i = 0; i < 25; i++) {
            await page.waitForTimeout(CONTINUE_POLL_MS);
            if (await quizScreenActive(page)) continue;
            const cont = await waitAndClickContinue(page);
            if (cont.clicked) {
                console.log('✅ መማር ይቀጥሉ after chapter test');
                await page.waitForTimeout(CONTINUE_POST_CLICK_MS);
                break;
            }
        }
    }

    return idx;
}

async function startCourseProgress(page: any, answers: string[] = []) {
    let loop = 0;
    let answerIndex = 0;

    while (loop < 120) {
        loop++;
        if (loop > 1) await page.waitForTimeout(400);

        const frameCount = page.frames().length;
        const pageUrl = page.url();
        const scorm = getScormContentFrame(page);
        const quizStats = scorm ? await getQuizStats(scorm) : null;
        const quizActive = scorm ? await isChapterQuizScreen(scorm) : false;

        // #region agent log
        debugLog({
            hypothesisId: 'H2',
            location: 'bot.ts:startCourseProgress',
            message: 'loop start',
            data: { loop, frameCount, pageUrl, answersCount: answers.length, answerIndex, quizActive, quizStats },
        });
        // #endregion

        if (await page.locator('text=Your content is loading').isVisible({ timeout: 1000 }).catch(() => false)) {
            console.log("⏳ Waiting for content to load...");
            await page.waitForTimeout(5000);
        }

        if (quizActive) {
            console.log(`🔄 Loop ${loop} - Chapter quiz detected...`);
            const before = answerIndex;
            answerIndex = await runChapterQuiz(page, answers, answerIndex);
            if (answerIndex > before) continue;
        }

        console.log(`🔄 Loop ${loop} - Waiting for መማር ይቀጥሉ (${frameCount} frames)...`);
        const continueResult = await waitAndClickContinue(page);
        // #region agent log
        debugLog({ hypothesisId: 'H2', location: 'bot.ts:continueClick', message: 'continue click attempt', data: { loop, ...continueResult } });
        // #endregion

        if (continueResult.clicked) {
            console.log(`✅ Clicked መማር ይቀጥሉ via ${continueResult.method} (${continueResult.frameUrl})`);
            await page.waitForTimeout(CONTINUE_POST_CLICK_MS);
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        } else {
            const scorm2 = getScormContentFrame(page);
            const stats2 = scorm2 ? await getQuizStats(scorm2) : null;
            // #region agent log
            debugLog({ hypothesisId: 'H4', location: 'bot.ts:noContinue', message: 'continue missing', data: { loop, stats2 } });
            // #endregion

            if (scorm2 && (await isChapterQuizScreen(scorm2))) {
                console.log(`🔄 Loop ${loop} - Chapter quiz (${stats2?.optionCount ?? '?'} options)...`);
                answerIndex = await runChapterQuiz(page, answers, answerIndex);
                continue;
            }

            console.log("⚠️ Continue not found — checking for FINAL exam start button...");
            const examResult = await clickTextInFrames(page, ['ፈተናውን ይጀምሩ'], { examMode: true });
            // #region agent log
            debugLog({ hypothesisId: 'H3', location: 'bot.ts:examCheck', message: 'final exam click', data: { loop, ...examResult } });
            // #endregion

            if (examResult.clicked) {
                await page.waitForTimeout(8000);
                const scorm3 = getScormContentFrame(page);
                const stats3 = scorm3 ? await getQuizStats(scorm3) : null;
                debugLog({ hypothesisId: 'H3', location: 'bot.ts:postExamStart', message: 'quiz stats after exam start', data: { stats3 } });

                console.log('📝 FINAL exam (ፈተናውን ይጀምሩ clicked) — up to 14 questions');
                await takeQuiz(page, answers, { maxQuestions: 14, startIndex: answerIndex, label: 'Final exam' });
                break;
            }
            await page.screenshot({ path: `debug-no-btn-${loop}.png` }).catch(() => {});
        }

        if (await page.locator('text=እንኳን ደስ, Completed, አልቋል').count() > 0) {
            console.log("🎉 Course Completed!");
            break;
        }
    }
}

async function autoSkipVideo(page: any) {
    await page.evaluate(() => {
        document.querySelectorAll('video').forEach((v: any) => {
            v.muted = true;
            v.playbackRate = 16;
            if (v.duration) v.currentTime = v.duration - 5;
        });
    });
}

async function takeQuiz(
    page: any,
    answers: string[],
    opts: { maxQuestions: number; startIndex: number; label: string } = { maxQuestions: 14, startIndex: 0, label: 'Final exam' }
) {
    console.log(`🧠 ${opts.label} — up to ${opts.maxQuestions} questions (${answers.length} answers in CSV)...`);
    let idx = opts.startIndex;
    let failStreak = 0;

    for (let q = 0; q < opts.maxQuestions; q++) {
        await page.waitForTimeout(3000);
        const frame = getScormContentFrame(page);
        if (!frame || !(await isQuizScreen(frame))) {
            failStreak++;
            if (failStreak >= 3) {
                console.log(`⚠️ No quiz UI after Q${q} — stopping ${opts.label}`);
                break;
            }
            await page.waitForTimeout(2000);
            continue;
        }
        failStreak = 0;

        const stats = await getQuizStats(frame);
        const answer = answers[idx] ?? answers[idx % Math.max(answers.length, 1)] ?? 'ለ';
        const ok = await selectQuizAnswer(frame, answer);
        // #region agent log
        debugLog({
            hypothesisId: 'H3',
            location: 'bot.ts:takeQuiz',
            message: 'final exam answer',
            data: { q: q + 1, answerIndex: idx, answer, ok, frameUrl: frame.url(), stats },
        });
        // #endregion

        console.log(`  Q${q + 1} → ${answer} ${ok ? '✓' : '✗'}`);
        if (!ok) break;

        idx++;
        await page.waitForTimeout(400);
        await clickSubmitYasebu(page);
        await page.waitForTimeout(700);
    }

    if (!(await quizScreenActive(page))) {
        await waitAndClickContinue(page);
    }
    console.log(`✅ ${opts.label} completed`);
}

main().catch(console.error);