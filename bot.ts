import { chromium } from 'playwright';
import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====================== ANSWERS LOADER ======================
const answersCache: any = {};

const courseToFileMap: { [key: string]: string } = {
    'financial': 'finacial_litrecy',        // Fixed spelling
    'communication': 'communications',
    'entrepreneurial': 'enterprunership',
    'customer': 'costomer_understanding',
    'book': 'bookkeeping',
    'design': 'design_thinking',
    'decision': 'decision_making',
    'marketing': 'marketing',
    'negotiation': 'negotiations_skill',
    'legal': 'legal_foundation'
};

function loadAnswers(courseName: string): string[] {
    if (answersCache[courseName]) return answersCache[courseName];

    const key = courseName.toLowerCase();
    let fileName = courseToFileMap[key] || key.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_');

    const csvPath = path.join(__dirname, 'answers', `${fileName}.csv`);
    
    if (!fs.existsSync(csvPath)) {
        console.log(`⚠️ Answers file not found: ${fileName}.csv`);
        return [];
    }

    const answers: string[] = [];
    fs.createReadStream(csvPath)
        .pipe(csv())
        .on('data', (row) => {
            const ans = row['total'] || row['answer'] || Object.values(row)[0];
            if (ans) answers.push(ans.toString().trim());
        })
        .on('end', () => answersCache[courseName] = answers);

    return answers;
}

// ====================== MAIN BOT ======================
async function main() {
    console.log("🚀 Share eLearning Bot Started...\n");

    const students: any[] = [];
    fs.createReadStream('data.csv')
        .pipe(csv())
        .on('data', (row) => students.push(row))
        .on('end', async () => {
            for (const student of students) {
                await processStudent(student);
                await new Promise(r => setTimeout(r, 15000));
            }
        });
}

async function processStudent(student: any) {
    if (!student.username) return;

    let username = student.username.toString().trim();
    if (!username.startsWith('0')) username = '0' + username;

    console.log(`\n👤 Processing: ${student.firstname || ''} ${student.lastname || ''} (${username})`);

    const browser = await chromium.launch({ headless: false, slowMo: 700 });
    const page = await browser.newPage();

    try {
        await page.goto('https://learn.share.com.et/login/index.php', { waitUntil: 'domcontentloaded' });
        await page.fill('input[name="username"]', username);
        await page.fill('input[name="password"]', student.password || `${username}@R&D`);
        await page.click('button[type="submit"]');

        await page.waitForTimeout(6000);
        await page.goto('https://learn.share.com.et/my/courses.php', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(8000);

        const viewBtn = page.locator('button:has-text("View Course"), a:has-text("View Course")').first();
        await viewBtn.click({ force: true }).catch(() => {});

        await page.waitForTimeout(8000);

        const courseTitle = await page.locator('h1').first().innerText().catch(() => 'Unknown');
        console.log(`📘 Course: ${courseTitle}`);

        const answers = loadAnswers(courseTitle);
        await startCourseProgress(page, answers);

    } catch (e: any) {
        console.log(`❌ Error: ${e.message}`);
    } finally {
        await browser.close();
    }
}

async function startCourseProgress(page: any, answers: string[] = []) {
    let loop = 0;

    while (loop < 70) {
        loop++;
        await page.waitForTimeout(4000);

        console.log(`🔄 Loop ${loop} - Looking for main መማር ይቀጥሉ...`);

        // === BETTER SELECTORS - Prioritize the main bottom button ===
        const mainContinueSelectors = [
            'button:has-text("መማር ይቀጥሉ"):visible',           // Most important
            'div.green-button:has-text("መማር ይቀጥሉ")',
            'button[style*="background-color: rgb(0, 166, 81)"]', 
            'text=መማር ይቀጥሉ >> xpath=//button',
            'button:has-text("መማር ይቀጥሉ")',
            '*:has-text("መማር ይቀጥሉ")'  // Fallback: any element with the text
        ];

        let clicked = false;

        for (const sel of mainContinueSelectors) {
            try {
                const btn = page.locator(sel).first();
                const isVisible = await btn.isVisible({ timeout: 3500 }).catch(() => false);
                
                if (isVisible) {
                    console.log(`✅ Clicking MAIN button: ${sel}`);
                    await btn.scrollIntoViewIfNeeded();
                    await btn.click({ timeout: 12000 });
                    clicked = true;
                    await page.waitForTimeout(7000);
                    break;
                }
            } catch (e) {
                console.log(`  ❌ Selector failed: ${sel} - ${e.message}`);
            }
        }

        if (!clicked) {
            console.log("⚠️ Main continue button not found");
        }

        await autoSkipVideo(page);

        // Check for Exam Button
        const examBtn = page.locator('text=ፈተናውን ይጀምሩ, button:has-text("ፈተና")').first();
        if (await examBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log("📝 Starting Exam...");
            await examBtn.click();
            await page.waitForTimeout(5000);
            await takeQuiz(page, answers);
            break;
        }

        if (await page.locator('text=እንኳን ደስ, Completed').count() > 0) {
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

async function takeQuiz(page: any, answers: string[]) {
    console.log("🧠 Taking 3-question test...");
    for (let q = 0; q < 3; q++) {
        await page.waitForTimeout(3500);
        const answer = answers[q] || 'ለ';
        console.log(`Q${q+1} → ${answer}`);

        const options = page.locator('label, .option, input[type="radio"]');
        const idx = ['ለ','ሀ','A'].includes(answer) ? 0 : 
                    ['ሐ','U','B'].includes(answer) ? 1 : 2;

        await options.nth(idx).click().catch(() => options.first().click().catch(() => {}));
        await page.click('text=ቀጣይ, button:has-text("Submit"), button:has-text("Next")').catch(() => {});
    }
    console.log("✅ Test Completed!");
}

main().catch(console.error);