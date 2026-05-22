import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const answersDir = path.join(__dirname, 'answers');

const courseToFileMap = {
    'financial literacy': 'finacial_litrecy',
    'customer understanding': 'costomer_understanding',
    'design thinking': 'design_thinking',
    'decision making': 'decision_making',
    'legal foundation': 'legal_foundation',
    'financial': 'finacial_litrecy',
    'communication': 'communications',
    'entrepreneurial': 'enterprunership',
    'customer': 'costomer_understanding',
    'bookkeeping': 'bookkeeping',
    'book': 'bookkeeping',
    'design': 'design_thinking',
    'decision': 'decision_making',
    'marketing': 'marketing',
    'negotiation': 'negotiations_skill',
    'legal': 'legal_foundation',
};

function listAnswerFiles() {
    return fs.readdirSync(answersDir).filter((f) => f.endsWith('.csv')).map((f) => f.slice(0, -4));
}

function normalizeText(s) {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractEnglishTitle(courseName) {
    const paren = courseName.match(/\(([^)]+)\)/);
    if (paren) return normalizeText(paren[1]);
    return normalizeText(courseName.replace(/[\u1200-\u137F]/g, ' '));
}

function scoreCourseToFile(courseName, fileBase) {
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
    if (english && (english === fileNorm || fileNorm.includes(english) || english.includes(fileNorm))) score += 90;
    const englishSlug = english.replace(/\s+/g, '_');
    if (englishSlug && (englishSlug === fileSlug || fileSlug.includes(englishSlug) || englishSlug.includes(fileSlug))) score += 85;
    const blobWords = [...new Set([...blob.split(' '), ...english.split(' ')])].filter((w) => w.length > 2);
    const fileWords = fileSlug.replace(/_/g, ' ').split(' ').filter((w) => w.length > 2);
    for (const fw of fileWords) {
        if (blobWords.some((bw) => bw.includes(fw) || fw.includes(bw))) score += 18;
    }
    return score;
}

function resolveAnswerFileName(courseName) {
    const files = listAnswerFiles();
    let bestFile = '';
    let bestScore = 0;
    for (const file of files) {
        const score = scoreCourseToFile(courseName, file);
        if (score > bestScore) {
            bestScore = score;
            bestFile = file;
        }
    }
    return bestScore >= 20 ? bestFile : null;
}

const tests = [
    'መሠረታዊ የፋይናንስ እውቀት (Financial Literacy)',
    'Introduction (Marketing)',
    'Design Thinking (Design Thinking)',
    'Legal Basics (Legal Foundation)',
    'Communications (Communications)',
    'Random New Course (Agriculture)',
];

for (const t of tests) {
    const scores = listAnswerFiles().map((f) => ({ f, s: scoreCourseToFile(t, f) }));
    console.log(t, '=>', resolveAnswerFileName(t), scores.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3));
}
