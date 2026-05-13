import { chromium } from 'playwright';
import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load answers from CSV
const answersCache: any = {};

// Map course names to CSV file names
const courseToFileMap: { [key: string]: string } = {
    'communication skill': 'communications',
    'entrepreneurial mindset': 'enterprunership',
    'financial literacy': 'finacial_litrecy',
    'customer understanding': 'costomer_understanding',
    'book keeping': 'bookkeeping',
    'design thinking': 'design_thinking',
    'decision making': 'decision_making',
    'marketing': 'marketing',
    'negotiations skill': 'negotiations_skill',
    'legal foundation': 'legal_foundation'
};

function loadAnswers(courseName: string): string[] {
    if (answersCache[courseName]) return answersCache[courseName];

    // Normalize course name to match CSV file
    const normalizedCourse = courseName
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim();

    // Use mapping if available, otherwise use normalized name
    const csvFileName = courseToFileMap[normalizedCourse] || normalizedCourse.replace(/\s+/g, '_');

    const csvPath = path.join(__dirname, 'answers', `${csvFileName}.csv`);

    if (!fs.existsSync(csvPath)) {
        console.log(`⚠️ No answers file found for: ${normalizedCourse}.csv`);
        return [];
    }

    const answers: string[] = [];
    fs.createReadStream(csvPath)
        .pipe(csv())
        .on('data', (row) => {
            // Get answers from 'total' column or first available column
            const answer = row['total'] || row['ምእ ራፍ 1'] || Object.values(row)[0];
            if (answer && answer.trim()) {
                answers.push(answer.trim());
            }
        })
        .on('end', () => {
            answersCache[courseName] = answers;
            console.log(`📝 Loaded ${answers.length} answers for ${courseName}`);
        });

    return answersCache[courseName] || [];
}

async function processStudent(student: any) {
    if (!student.username) return;

    let username = student.username.toString().trim();
    if (!username.startsWith('0')) username = '0' + username;

    console.log(`\n👤 Processing: ${student.firstname || ''} ${student.lastname || ''} (${username})`);

    const browser = await chromium.launch({ 
        headless: false, 
        channel: 'chrome',
        slowMo: 1000 
    });

    const page = await browser.newPage();

    try {
        await page.goto('https://learn.share.com.et/login/index.php', { waitUntil: 'domcontentloaded' });
        await page.fill('input[name="username"]', username);
        await page.fill('input[name="password"]', student.password || `${username}@R&D`);
        await page.click('button[type="submit"]');

        await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
        console.log("✅ Login successful");

        await page.goto('https://learn.share.com.et/my/courses.php', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(8000);

        console.log("🔍 Looking for 'View Course' buttons...");

        const viewButtons = await page.locator('button:has-text("View Course"):visible, a:has-text("View Course"):visible').all();

        console.log(`📚 Found ${viewButtons.length} buttons`);

        if (viewButtons.length === 0) {
            await page.screenshot({ path: 'debug-no-button.png' });
            return;
        }

        // Click random button with better handling
        const randomIndex = Math.floor(Math.random() * viewButtons.length);
        const selectedButton = viewButtons[randomIndex];

        console.log(`🎲 Clicking View Course button #${randomIndex + 1}...`);

        await selectedButton.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);

        await selectedButton.click({ force: true }).catch(async () => {
            await selectedButton.click(); // retry without force
        });

        await page.waitForTimeout(7000);

        const courseTitle = await page.locator('h1').first().innerText().catch(() => 'Current Course');
        console.log(`📘 Opened Course: ${courseTitle}`);

        // Load answers for this course
        const courseAnswers = loadAnswers(courseTitle);

        await startCourseFlow(page, courseAnswers);

    } catch (error: any) {
        console.log(`❌ Error: ${error.message}`);
    } finally {
        await browser.close();
    }
}

async function startCourseFlow(page: any, courseAnswers: string[] = []) {
    console.log("🚀 Starting course completion flow...");

    let questionIndex = 0;

    for (let i = 0; i < 60; i++) {
        try {
            // Wait a bit for the page to load after entering course
            await page.waitForTimeout(3000);

            // Keep clicking "Continue Learning" until quiz appears
            let continueButtonClicked = true;
            let clickAttempts = 0;
            const maxClickAttempts = 20;

            while (continueButtonClicked && clickAttempts < maxClickAttempts) {
                // Try multiple selectors for the button
                const selectors = [
                    'button:has-text("መማር ይቀጥሉ"):visible',
                    'button:has-text("መማር ይቀጥሉ")',
                    '*:has-text("መማር ይቀጥሉ"):visible',
                    'text=መማር ይቀጥሉ'
                ];

                let buttonFound = false;
                for (const selector of selectors) {
                    const continueLearningButton = await page.locator(selector).first();
                    const isVisible = await continueLearningButton.isVisible().catch(() => false);

                    if (isVisible) {
                        console.log(`➡️ Clicking 'Continue Learning' with selector: ${selector} (Attempt ${clickAttempts + 1})...`);
                        await continueLearningButton.click();
                        clickAttempts++;
                        buttonFound = true;
                        await page.waitForTimeout(5000); // Give more time for the page to load after clicking
                        break;
                    }
                }

                if (!buttonFound) {
                    console.log(`⚠️ No 'Continue Learning' button found (Attempt ${clickAttempts + 1})`);
                    // Take screenshot for debugging
                    await page.screenshot({ path: `debug-no-continue-button-${i}-${clickAttempts}.png` }).catch(() => {});
                    // Don't exit immediately - give it more chances
                    if (clickAttempts > 5) {
                        continueButtonClicked = false;
                    } else {
                        await page.waitForTimeout(2000); // Wait before retrying
                    }
                }
            }

            await autoSkipVideo(page);

            // Answer quiz if present
            const hasQuiz = await page.locator('label, input[type="radio"]').count();
            if (hasQuiz > 2) {
                console.log("❓ Answering question...");

                // Get correct answer from CSV if available
                const correctAnswer = courseAnswers[questionIndex] || null;
                questionIndex++;

                if (correctAnswer) {
                    console.log(`📝 Using answer: ${correctAnswer} (Question ${questionIndex})`);
                    // Map Amharic characters to option indices (0-based)
                    const answerMap: { [key: string]: number } = {
                        'ለ': 0,  // Option A
                        'U': 1,  // Option B
                        'ሐ': 2,  // Option C
                        'መ': 3,  // Option D
                        'u': 1,  // Option B (lowercase)
                        'ሀ': 0,  // Option A (variant)
                    };
                    const optionIndex = answerMap[correctAnswer] ?? 0;
                    await page.locator('label').nth(optionIndex).click().catch(() => {});
                } else {
                    console.log(`⚠️ No answer found for question ${questionIndex}, using first option`);
                    await page.locator('label').first().click().catch(() => {});
                }

                await page.click('text=ቀጣይ, button:has-text("Next")').catch(() => {});
            }

            // Start Exam
            if (await page.locator('text=ፈተና ጀምር').count() > 0) {
                console.log("📝 Starting Final Exam...");
                await page.click('text=ፈተና ጀምር');
            }

            if (await page.locator('text=እንኳን ደስ አላችሁ').count() > 0) {
                console.log("🎉 Certificate Achieved!");
                break;
            }

            await page.waitForTimeout(4000);
        } catch (e) {}
    }
}

async function autoSkipVideo(page: any) {
    await page.evaluate(() => {
        document.querySelectorAll('video').forEach((v: any) => {
            v.muted = true;
            v.playbackRate = 16;
            if (v.duration) v.currentTime = v.duration - 1;
        });
    });
}

// ============= MAIN =============
async function main() {
    console.log("🚀 Share eLearning Bot Started...\n");

    const students: any[] = [];

    fs.createReadStream('data.csv')
        .pipe(csv())
        .on('data', (row) => students.push(row))
        .on('end', async () => {
            console.log(`📋 Loaded ${students.length} students\n`);

            for (const student of students) {
                await processStudent(student);
                await new Promise(r => setTimeout(r, 35000));
            }
        });
}

main().catch(console.error);