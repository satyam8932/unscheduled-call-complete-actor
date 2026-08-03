import { Actor, log } from 'apify';
import { chromium, BrowserContext, Page } from 'playwright';
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

interface ActorInput {
    subAccountUrl: string;
    leadName: string;
    storageState?: any;
    loginMode?: boolean;
}

interface CallInfo {
    callFound: boolean;
    duration: string | null;
    durationSeconds: number;
    meetsThreshold: boolean;
    screenshotUrl: string | null;
}

interface ActorOutput {
    leadFound: boolean;
    leadName: string;
    callFound: boolean;
    duration: string | null;
    durationSeconds: number;
    meetsThreshold: boolean;
    screenshotUrl: string | null;
    error: string | null;
}

const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const LOCAL_STORAGE_STATE = resolve(process.cwd(), 'storage-state.json');
const CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DURATION_THRESHOLD_SECONDS = 300;

async function retry<T>(
    fn: () => Promise<T>,
    { attempts = 3, delayMs = 1000, label = 'operation' } = {}
): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err: any) {
            if (i === attempts - 1) throw err;
            log.warning(`${label} failed (attempt ${i + 1}/${attempts}): ${err.message}. Retrying in ${delayMs}ms...`);
            await new Promise(r => setTimeout(r, delayMs));
            delayMs *= 2;
        }
    }
    throw new Error('Unreachable');
}

function parseDuration(timeStr: string): { duration: string; seconds: number } | null {
    const match = timeStr.match(/(\d+):(\d{2})/);
    if (!match) return null;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    return { duration: `${minutes}:${seconds.toString().padStart(2, '0')}`, seconds: minutes * 60 + seconds };
}

async function getContext(input: ActorInput): Promise<{ context: BrowserContext; persistent: boolean }> {
    const isCloud = Actor.isAtHome();

    if (!isCloud) {
        try {
            log.info('Connecting to Brave via CDP on port 9222...');
            const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
            const contexts = browser.contexts();
            if (contexts.length > 0) {
                return { context: contexts[0], persistent: true };
            }
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            return { context, persistent: false };
        } catch {
            log.warning('CDP connection failed. Start Brave with: open -a "Brave Browser" --args --remote-debugging-port=9222');
        }

        if (existsSync(LOCAL_STORAGE_STATE)) {
            log.info('Using local storage-state.json (headless)');
            const browser = await chromium.launch({
                executablePath: BRAVE_PATH,
                headless: true,
                args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
            });
            const context = await browser.newContext({
                storageState: LOCAL_STORAGE_STATE,
                viewport: { width: 1440, height: 900 },
            });
            return { context, persistent: false };
        }

        throw new Error('Cannot authenticate. Start Brave with CDP or run with loginMode=true');
    }

    log.info('Running on Apify cloud...');
    if (!input.storageState) {
        throw new Error('No storageState in input. Pass browser session JSON as "storageState" field.');
    }

    const browser = await chromium.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
            '--disable-software-rasterizer',
            '--disable-translate',
            '--disable-hang-monitor',
        ],
    });
    const context = await browser.newContext({
        storageState: input.storageState as any,
        viewport: { width: 1440, height: 900 },
    });

    // Block non-essential resources on cloud to save RAM (keep CSS — SPA needs it to render)
    await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['font', 'media', 'image'].includes(type)) {
            return route.abort();
        }
        return route.continue();
    });

    return { context, persistent: false };
}

async function runLoginMode(): Promise<void> {
    log.info('=== LOGIN MODE ===');
    const browser = await chromium.launch({
        executablePath: Actor.isAtHome() ? undefined : BRAVE_PATH,
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('https://app.tjbdigitalservices.com/');

    log.info('Waiting for login... navigate to dashboard to save session.');
    await page.waitForURL('**/v2/location/**', { timeout: 300000 });

    const state = await context.storageState();
    writeFileSync(LOCAL_STORAGE_STATE, JSON.stringify(state, null, 2));
    log.info(`Storage state saved to ${LOCAL_STORAGE_STATE}`);

    await browser.close();
    log.info('Login mode complete.');
}

async function searchAndClickLead(page: Page, leadName: string): Promise<boolean> {
    await page.waitForSelector('#globalSearchOpener', { state: 'visible', timeout: 60000 });
    await page.waitForTimeout(1000);

    await retry(async () => {
        log.info('Clicking global search...');
        await page.locator('#globalSearchOpener').click();
        await page.waitForTimeout(1000);
        await page.locator('#global-search-input').waitFor({ state: 'visible', timeout: 15000 });
    }, { attempts: 3, delayMs: 2000, label: 'open search popup' });

    log.info('Search popup visible, typing lead name...');
    await page.click('#global-search-input');
    await page.keyboard.type(leadName, { delay: 30 });

    log.info('Waiting for search results...');
    await page.waitForTimeout(3500);

    const noResult = page.getByText('No matching result', { exact: false });
    if (await noResult.count() > 0 && await noResult.first().isVisible()) {
        log.warning(`Lead not found: "${leadName}" — no matching result.`);
        return false;
    }

    // Strong name matching: find best result excluding "(2)", "(3)" suffixed duplicates
    async function findBestResult(): Promise<{ found: boolean; index: number }> {
        const allMatches = page.getByText(leadName, { exact: false });
        const count = await allMatches.count();
        if (count === 0) return { found: false, index: -1 };

        // Evaluate all visible matches and pick best one
        let bestIndex = 0;
        for (let i = 0; i < count; i++) {
            const el = allMatches.nth(i);
            if (!await el.isVisible().catch(() => false)) continue;
            const text = (await el.innerText().catch(() => '') || '').trim();
            log.info(`Search result [${i}]: "${text.substring(0, 60)}"`);
            // Reject results with "(2)", "(3)" etc — duplicate contact indicators
            const firstLine = text.split('\n')[0].trim();
            if (firstLine === leadName) {
                log.info(`Exact match found at index ${i}`);
                return { found: true, index: i };
            }
            // If first line has parenthetical suffix like "Name (2)", skip it
            if (/\(\d+\)/.test(firstLine)) {
                log.info(`Skipping duplicate indicator: "${firstLine}"`);
                continue;
            }
            bestIndex = i;
        }
        return { found: true, index: bestIndex };
    }

    const { found: resultFound, index: bestIdx } = await findBestResult();
    if (!resultFound) {
        log.warning(`Lead not found: "${leadName}" — no result appeared.`);
        return false;
    }

    await retry(async () => {
        const allResults = page.getByText(leadName, { exact: false });
        const target = allResults.nth(bestIdx);
        await target.waitFor({ state: 'visible', timeout: 15000 });
        log.info(`Clicking search result at index ${bestIdx}...`);
        await target.click();
        await page.waitForTimeout(2000);

        const url = page.url();
        if (url.includes('/dashboard') && !url.includes('/contacts/')) {
            const parentItem = page.locator('.search-item, .hl_contact-search-result, [class*="search-result"]').first();
            if (await parentItem.count() > 0) {
                await parentItem.click();
                await page.waitForTimeout(1500);
            } else {
                await page.keyboard.press('Enter');
                await page.waitForTimeout(1500);
            }
            if (page.url().includes('/dashboard') && !page.url().includes('/contacts/')) {
                throw new Error('Navigation did not happen after clicking search result');
            }
        }
    }, { attempts: 2, delayMs: 3000, label: 'click search result' });

    log.info('Lead page opened.');
    return true;
}

async function findCallCompleted(page: Page): Promise<CallInfo> {
    log.info('Waiting for conversation to load...');

    const panelSelectors = [
        '.conversation-panel',
        '[class*="conversation-panel"]',
        '.chat-content',
        '[class*="chat-content"]',
        '.conversation-body',
        '[class*="conversation"]',
    ];

    let panelSelector = '';
    const maxWait = Actor.isAtHome() ? 40000 : 10000;
    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
        for (const sel of panelSelectors) {
            if (await page.locator(sel).count() > 0) {
                panelSelector = sel;
                break;
            }
        }
        if (panelSelector) break;
        await page.waitForTimeout(1000);
    }

    if (panelSelector) {
        log.info(`Conversation panel found: ${panelSelector}`);
    } else {
        log.warning('No conversation panel found after waiting.');
        if (Actor.isAtHome()) {
            const store = await Actor.openKeyValueStore();
            await store.setValue('debug-no-panel', await page.screenshot({ type: 'jpeg', quality: 50 }), { contentType: 'image/jpeg' });
        }
        return { callFound: false, duration: null, durationSeconds: 0, meetsThreshold: false, screenshotUrl: null };
    }

    let callCount = await page.getByText('Call completed', { exact: false }).count();
    log.info(`"Call completed" in DOM: ${callCount}`);

    if (callCount === 0) {
        log.info('Scrolling to find "Call completed"...');
        const panel = page.locator(panelSelector).first();
        let found = false;

        // Scroll UP first (calls usually above)
        for (let i = 0; i < 20; i++) {
            await panel.evaluate((el) => el.scrollBy(0, -500));
            await page.waitForTimeout(400);
            if (await page.getByText('Call completed', { exact: false }).count() > 0) {
                found = true;
                log.info(`Found after scrolling up ${i + 1} times`);
                break;
            }
        }

        if (!found) {
            await panel.evaluate((el) => el.scrollTop = 0);
            await page.waitForTimeout(300);
            for (let i = 0; i < 30; i++) {
                await panel.evaluate((el) => el.scrollBy(0, 500));
                await page.waitForTimeout(400);
                if (await page.getByText('Call completed', { exact: false }).count() > 0) {
                    found = true;
                    log.info(`Found after scrolling down ${i + 1} times`);
                    break;
                }
            }
        }

        if (!found) {
            log.warning('No "Call completed" found after scrolling.');
            return { callFound: false, duration: null, durationSeconds: 0, meetsThreshold: false, screenshotUrl: null };
        }
    }

    const callCompleted = page.getByText('Call completed', { exact: false }).first();
    try {
        await callCompleted.scrollIntoViewIfNeeded({ timeout: 10000 });
    } catch {
        log.warning('scrollIntoView timed out, proceeding with extraction.');
    }
    await page.waitForTimeout(800);
    log.info('"Call completed" visible in viewport.');

    // Extract duration from ancestor elements (audio player pattern: "0:00 / 5:23")
    let duration: string | null = null;
    let durationSeconds = 0;

    const ancestors = [
        callCompleted.locator('..'),
        callCompleted.locator('../..'),
        callCompleted.locator('../../..'),
        callCompleted.locator('../../../..'),
        callCompleted.locator('../../../../..'),
    ];

    for (const ancestor of ancestors) {
        if (duration) break;
        const text = await ancestor.textContent().catch(() => '') || '';
        const timeMatch = text.match(/(\d+:\d{2})\s*\/\s*(\d+:\d{2})/);
        if (timeMatch) {
            const parsed = parseDuration(timeMatch[2]);
            if (parsed) {
                duration = parsed.duration;
                durationSeconds = parsed.seconds;
                log.info(`Duration extracted: ${duration} (${durationSeconds}s)`);
            }
        }
    }

    if (!duration) {
        log.warning('Could not extract call duration from page.');
    }

    const meetsThreshold = durationSeconds >= DURATION_THRESHOLD_SECONDS;
    log.info(`Duration: ${duration || 'unknown'}, meets 5:00 threshold: ${meetsThreshold}`);

    let screenshotUrl: string | null = null;
    if (meetsThreshold) {
        log.info('Call meets threshold — taking screenshot...');
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if (attempt > 0) await page.waitForTimeout(2000);
                const screenshot = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 30000 });
                const store = await Actor.openKeyValueStore();
                await store.setValue('call-screenshot', screenshot, { contentType: 'image/jpeg' });
                screenshotUrl = `https://api.apify.com/v2/key-value-stores/${store.id}/records/call-screenshot`;
                log.info(`Screenshot saved: ${screenshotUrl}`);
                break;
            } catch (err: any) {
                log.warning(`Screenshot attempt ${attempt + 1} failed: ${err.message}`);
                if (err.message.includes('closed') || err.message.includes('crashed')) break;
            }
        }
    }

    return { callFound: true, duration, durationSeconds, meetsThreshold, screenshotUrl };
}

// --- Main execution ---
await Actor.init();

const input = await Actor.getInput<ActorInput>();

if (input?.loginMode) {
    await runLoginMode();
    await Actor.exit();
}

if (!input?.subAccountUrl || !input?.leadName) {
    throw new Error('Input must contain "subAccountUrl" and "leadName"');
}

log.info('Starting Unscheduled Call Complete automation', {
    url: input.subAccountUrl,
    leadName: input.leadName,
});

const { context, persistent } = await getContext(input);

try {
    const page = persistent ? context.pages()[0] || await context.newPage() : await context.newPage();

    log.info('Navigating to sub-account...');
    await page.goto(input.subAccountUrl, { waitUntil: 'load', timeout: 120000 });

    // Detect login page
    const loginDetected = await page.locator('input[type="email"], input[type="password"], button:has-text("Login"), button:has-text("Sign in")').first().isVisible({ timeout: 5000 }).catch(() => false);

    if (loginDetected || page.url().includes('/login') || page.url().includes('/oauth')) {
        log.warning('Session expired — login page detected.');
        await Actor.pushData({
            leadFound: false,
            leadName: input.leadName,
            callFound: false,
            duration: null,
            durationSeconds: 0,
            meetsThreshold: false,
            screenshotUrl: null,
            error: 'LOGIN_REQUIRED: Cookies expired. Run locally with loginMode=true to refresh storage-state.json',
        });
        await context.close();
        await Actor.exit();
    }

    // Wait for dashboard (generous timeout for 1024MB cloud)
    await retry(async () => {
        await page.waitForSelector('#globalSearchOpener', { state: 'visible', timeout: 90000 });
    }, { attempts: 2, delayMs: 5000, label: 'wait for dashboard' });

    log.info('Dashboard loaded.');

    const leadFound = await searchAndClickLead(page, input.leadName);

    const output: ActorOutput = {
        leadFound,
        leadName: input.leadName,
        callFound: false,
        duration: null,
        durationSeconds: 0,
        meetsThreshold: false,
        screenshotUrl: null,
        error: null,
    };

    if (!leadFound) {
        output.error = `Lead "${input.leadName}" not found in search.`;
        log.info(output.error);
    } else {
        log.info('Phase 1 complete: Lead found and opened.');

        const callResult = await findCallCompleted(page);
        output.callFound = callResult.callFound;
        output.duration = callResult.duration;
        output.durationSeconds = callResult.durationSeconds;
        output.meetsThreshold = callResult.meetsThreshold;
        output.screenshotUrl = callResult.screenshotUrl;

        if (!callResult.callFound) {
            output.error = 'No "Call completed" entry found for this lead.';
            log.info(output.error);
        } else {
            log.info(`Result — duration: ${output.duration}, meets threshold: ${output.meetsThreshold}`);
        }
    }

    await Actor.pushData(output);
} finally {
    await context.close();
}

await Actor.exit();
