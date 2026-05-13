import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const excelFilePath = path.join(__dirname, 'answers', 'share questions and answers final.xlsx');

if (!fs.existsSync(excelFilePath)) {
    console.error("❌ Excel file not found at:", excelFilePath);
    console.error("Please make sure the file is inside the 'answer' folder.");
    process.exit(1);
}

const workbook = XLSX.readFile(excelFilePath);

const answersDir = path.join(__dirname, 'answers');
if (!fs.existsSync(answersDir)) {
    fs.mkdirSync(answersDir);
}

console.log("🔄 Converting Excel sheets to CSV...\n");

workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const jsonData: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    // Clean sheet name for filename
    let fileName = sheetName.trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s_]/g, '')
        .replace(/\s+/g, '_');

    // Convert to CSV format
    const csvContent = jsonData
        .map(row => 
            row.map(cell => {
                const str = (cell ?? '').toString().replace(/"/g, '""');
                return `"${str}"`;
            }).join(',')
        )
        .join('\n');

    const outputPath = path.join(answersDir, `${fileName}.csv`);
    fs.writeFileSync(outputPath, csvContent);

    console.log(`✅ Created: answers/${fileName}.csv`);
});

console.log("\n🎉 All sheets converted successfully!");
console.log(`📁 Files saved in: ${answersDir}`);