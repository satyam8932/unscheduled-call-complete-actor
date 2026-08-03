/**
 * One-time script to export Brave browser session (cookies + localStorage) for GHL.
 * Run: npm run export-cookies
 *
 * Prerequisites: Close Brave browser before running (Chrome locks the profile).
 * Output: storage-state.json in project root — upload to Apify KV store as "ghl-storage-state".
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const BRAVE_USER_DATA = resolve(
    process.env.HOME || '/Users/satyam',
    'Library/Application Support/BraveSoftware/Brave-Browser'
);

async function exportState() {
    console.log('Launching Brave with existing profile...');
    console.log('NOTE: Brave must be fully closed before running this.');

    const browser = await chromium.launchPersistentContext(
        BRAVE_USER_DATA,
        {
            executablePath: BRAVE_PATH,
            headless: false,
            args: ['--no-sandbox', '--profile-directory=Default'],
        }
    );

    const page = await browser.newPage();
    await page.goto('https://app.gohighlevel.com/v2/location', { waitUntil: 'networkidle' });

    console.log('Waiting 5 seconds for session to stabilize...');
    await page.waitForTimeout(5000);

    const state = await browser.storageState();
    const outPath = resolve(process.cwd(), 'storage-state.json');
    writeFileSync(outPath, JSON.stringify(state, null, 2));

    console.log(`Storage state exported to: ${outPath}`);
    console.log(`Contains ${state.cookies.length} cookies`);
    console.log('Upload this file to your Apify KV store with key "ghl-storage-state"');

    await browser.close();
}

exportState().catch(err => {
    console.error('Export failed:', err.message);
    process.exit(1);
});
